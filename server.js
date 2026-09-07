require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] } 
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/keep-awake', (req, res) => res.status(200).send('I am awake!'));

// ==========================================
// 💽 เชื่อมต่อฐานข้อมูล MongoDB
// ==========================================
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
    })
    .then(() => console.log('✅ เชื่อมต่อ MongoDB สำเร็จ!'))
    .catch(err => console.log('❌ เชื่อมต่อ MongoDB ล้มเหลว:', err));
} else {
    console.log('⚠️ ไม่พบ MONGODB_URI ใน Environment Variables');
}

// ==========================================
// 📦 สร้าง Schema (โครงสร้างฐานข้อมูล)
// ==========================================
const userSchema = new mongoose.Schema({
    id: String, firstName: String, lastName: String, phone: String, 
    bankName: String, bankAccount: String, password: String, 
    credit: { type: Number, default: 0 }, 
    isBanned: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const billSchema = new mongoose.Schema({
    billId: String, customerName: String, totalAmount: Number, 
    items: Array, 
    status: { type: String, default: 'pending' }, 
    winAmount: { type: Number, default: 0 }, 
    createdAt: { type: Date, default: Date.now }
});
const Bill = mongoose.model('Bill', billSchema);

const depositSchema = new mongoose.Schema({
    id: String, phone: String, name: String, amount: Number, 
    slipImage: String, status: String, createdAt: { type: Date, default: Date.now }
});
const Deposit = mongoose.model('Deposit', depositSchema);

const withdrawalSchema = new mongoose.Schema({
    id: String, phone: String, name: String, bankName: String, 
    bankAccount: String, amount: Number, status: String, 
    createdAt: { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

const appDataSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed
});
const AppData = mongoose.model('AppData', appDataSchema);

// ==========================================
// 📢 ระบบส่งแจ้งเตือน Telegram
// ==========================================
const sendTelegramNotify = async (message) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
      console.log(`[Telegram]:\n${message.replace(/<[^>]*>?/gm, '')}`);
      return; 
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
  } catch (error) { console.error('❌ ส่ง Telegram ไม่สำเร็จ'); }
};

// ==========================================
// 🔐 ระบบยืนยันตัวตนพื้นฐาน (Token)
// ==========================================
const checkAuth = (req, res, next) => {
  const pin = req.headers['authorization'];
  if (pin === (process.env.ADMIN_PIN || "1234")) next();
  else res.status(403).json({ status: 'error', message: 'Unauthorized: ปฏิเสธการเข้าถึง' });
};

app.post('/api/verify_pin', (req, res) => {
  if (req.body.pin === (process.env.ADMIN_PIN || "1234")) res.json({ status: 'success', message: 'OK' });
  else res.status(401).json({ status: 'error', message: 'รหัส PIN ไม่ถูกต้อง' });
});

// ==========================================
// 👤 API ระบบสมาชิกลูกค้า
// ==========================================
app.post('/api/register', async (req, res) => {
    try {
        const { firstName, lastName, phone, bankName, bankAccount, password } = req.body;
        if (!firstName || !phone || !password) return res.status(400).json({ status: 'error', message: 'ข้อมูลไม่ครบถ้วน' });
        
        const existingUser = await User.findOne({ phone: phone });
        if (existingUser) return res.status(400).json({ status: 'error', message: 'เบอร์โทรศัพท์นี้ถูกใช้งานแล้ว' });
        
        const newUser = new User({ id: Date.now().toString(), firstName, lastName, phone, bankName, bankAccount, password, credit: 0, isBanned: false });
        await newUser.save();

        sendTelegramNotify(`🎉 สมาชิกลูกค้าใหม่!\nชื่อ: ${firstName} ${lastName}\nเบอร์: ${phone}`);
        res.json({ status: 'success', message: 'สมัครสมาชิกสำเร็จ!' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const user = await User.findOne({ phone: phone });
        
        if (!user) return res.json({ status: 'error', message: 'ไม่พบเบอร์โทรศัพท์นี้ในระบบ' });
        if (user.password !== password) return res.json({ status: 'error', message: 'รหัสผ่านไม่ถูกต้อง' });
        if (user.isBanned) return res.json({ status: 'error', message: '🚫 บัญชีนี้ถูกระงับการใช้งาน' });

        res.json({ status: 'success', data: { phone: user.phone, name: `${user.firstName} ${user.lastName}`, credit: user.credit } });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.get('/api/user/profile/:phone', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        if (!user) return res.status(404).json({ status: 'error', message: 'ไม่พบผู้ใช้งาน' });
        res.json({ status: 'success', data: { name: `${user.firstName} ${user.lastName}`, phone: user.phone, credit: user.credit, bankName: user.bankName, bankAccount: user.bankAccount } });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.get('/api/users', checkAuth, async (req, res) => {
    try { 
        const users = await User.find().sort({ createdAt: -1 });
        res.json({ status: 'success', data: users }); 
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.put('/api/users/:phone/credit', checkAuth, async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        if (!user) return res.status(404).json({ status: 'error', message: 'ไม่พบผู้ใช้งาน' });
        
        user.credit += parseFloat(req.body.amount);
        await user.save();
        
        io.emit('data_updated', { message: `🎉 อัปเดตเครดิตลูกค้าแล้ว` });
        
        // 🟢 เพิ่มคำสั่งนี้: ส่งสัญญาณเตือนไปที่หน้าจอลูกค้าคนนี้โดยเฉพาะ
        io.emit('credit_updated', { phone: user.phone, newCredit: user.credit, type: 'add' });

        res.json({ status: 'success', message: 'อัปเดตเครดิตสำเร็จ', newCredit: user.credit });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.put('/api/users/:phone/reduce-credit', checkAuth, async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        if (!user) return res.status(404).json({ status: 'error', message: 'ไม่พบผู้ใช้งาน' });
        
        const amount = parseFloat(req.body.amount);
        if (user.credit < amount) return res.status(400).json({ status: 'error', message: 'เครดิตไม่พอให้หัก' });

        user.credit -= amount;
        await user.save();
        
        io.emit('data_updated', { message: `📉 หักเครดิตลูกค้าเรียบร้อย` });

        // 🟢 เพิ่มคำสั่งนี้: แจ้งเตือนลดเครดิต
        io.emit('credit_updated', { phone: user.phone, newCredit: user.credit, type: 'reduce' });

        res.json({ status: 'success', message: 'ลดเครดิตสำเร็จ' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.delete('/api/users/:phone', checkAuth, async (req, res) => {
    try {
        const result = await User.deleteOne({ phone: req.params.phone });
        if (result.deletedCount === 0) return res.status(404).json({ status: 'error', message: 'ไม่พบข้อมูลลูกค้านี้' });
        res.json({ status: 'success', message: 'ลบข้อมูลสำเร็จ' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/user/updateBank/:phone', checkAuth, async (req, res) => {
    try {
        const { bankName, bankAccount } = req.body;
        await User.updateOne({ phone: req.params.phone }, { bankName, bankAccount });
        res.json({ status: 'success', message: 'อัปเดตบัญชีสำเร็จ' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/user/ban/:phone', checkAuth, async (req, res) => {
    try {
        await User.updateOne({ phone: req.params.phone }, { isBanned: true });
        res.json({ status: 'success', message: 'แบนสำเร็จ' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/user/unban/:phone', checkAuth, async (req, res) => {
    try {
        await User.updateOne({ phone: req.params.phone }, { isBanned: false });
        res.json({ status: 'success', message: 'ปลดแบนสำเร็จ' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// ==========================================
// 💸 API ฝาก / ถอนเงิน
// ==========================================
app.get('/api/admin/bank-info', async (req, res) => {
    try {
        const doc = await AppData.findOne({ key: 'adminBank' });
        const adminBank = doc ? doc.value : {
            bankName: "ธนาคารกสิกรไทย",
            accountName: "กรุณาตั้งค่าเลขบัญชีที่หน้าแอดมิน",
            accountNumber: "-"
        };
        res.json({ status: 'success', data: adminBank });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/deposit', async (req, res) => {
    try {
        const { phone, amount, slipImage } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ status: 'error', message: 'ไม่พบผู้ใช้' });
        
        await Deposit.create({ id: 'DP' + Date.now().toString().slice(-6), phone, name: `${user.firstName} ${user.lastName}`, amount, slipImage, status: 'pending' });
        
        io.emit('data_updated', { message: `💸 แจ้งฝากใหม่: ยอด ${amount} บาท` });
        sendTelegramNotify(`💸 <b>แจ้งฝากเงินใหม่!</b>\nจาก: ${user.firstName} ${user.lastName}\nยอด: ${amount} บาท\nรอตรวจสอบสลิป`);

        res.json({ status: 'success', message: 'ส่งรายการแจ้งฝากเรียบร้อย' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.get('/api/admin/deposits', checkAuth, async (req, res) => {
    try {
        const deposits = await Deposit.find().sort({ createdAt: -1 });
        res.json({ status: 'success', data: deposits });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/admin/approve-deposit', checkAuth, async (req, res) => {
    try {
        const dp = await Deposit.findOne({ id: req.body.depositId });
        if (!dp || dp.status !== 'pending') return res.status(400).json({ status: 'error', message: 'รายการไม่ถูกต้อง' });
        
        dp.status = 'approved';
        await dp.save();
        
        const user = await User.findOne({ phone: dp.phone });
        if (user) {
            user.credit += dp.amount;
            await user.save();
            
            // 🟢 เพิ่มคำสั่งนี้: แจ้งเตือนลูกค้าว่าเงินฝากเข้าแล้ว!
            io.emit('credit_updated', { phone: user.phone, newCredit: user.credit, type: 'add' });
        }
        
        io.emit('data_updated', { message: `✅ อนุมัติยอดฝากแล้ว` });
        res.json({ status: 'success', message: 'อนุมัติเรียบร้อย' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/admin/reject-deposit', checkAuth, async (req, res) => {
    try {
        await Deposit.updateOne({ id: req.body.depositId }, { status: 'rejected' });
        res.json({ status: 'success', message: 'ยกเลิกรายการสำเร็จ' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { phone, amount } = req.body;
        const user = await User.findOne({ phone });
        if (!user || user.credit < amount) return res.status(400).json({ status: 'error', message: 'ยอดเงินไม่พอ' });

        user.credit -= amount; // หักเงินทันที
        await user.save();

        await Withdrawal.create({ id: 'WD' + Date.now().toString().slice(-6), phone, name: `${user.firstName} ${user.lastName}`, bankName: user.bankName, bankAccount: user.bankAccount, amount, status: 'pending' });
        
        io.emit('data_updated', { message: `💳 แจ้งถอนเงินใหม่` });
        sendTelegramNotify(`💳 <b>แจ้งถอนเงิน!</b>\nจาก: ${user.firstName} ${user.lastName}\nยอด: ${amount} บาท\nธนาคาร: ${user.bankName} (${user.bankAccount})`);

        res.json({ status: 'success', message: 'แจ้งถอนเรียบร้อย' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.get('/api/admin/withdrawals', checkAuth, async (req, res) => {
    const wd = await Withdrawal.find().sort({ createdAt: -1 });
    res.json({ status: 'success', data: wd });
});

app.post('/api/admin/approve-withdraw', checkAuth, async (req, res) => {
    await Withdrawal.updateOne({ id: req.body.withdrawId }, { status: 'approved' });
    io.emit('data_updated', { message: `✅ โอนเงินให้ลูกค้าแล้ว` });
    res.json({ status: 'success', message: 'อนุมัติเรียบร้อย' });
});

app.post('/api/admin/reject-withdraw', checkAuth, async (req, res) => {
    const wd = await Withdrawal.findOne({ id: req.body.withdrawId });
    if(wd && wd.status === 'pending') {
        wd.status = 'rejected';
        await wd.save();
        await User.updateOne({ phone: wd.phone }, { $inc: { credit: wd.amount } }); 
        res.json({ status: 'success', message: 'คืนเงินเรียบร้อย' });
    }
});

// ==========================================
// 🧾 API จัดการบิลและประวัติการแทง
// ==========================================
app.post('/api/bills', async (req, res) => {
    try {
        const { customerName, lineUserId, items } = req.body;
        
        if (!items || !Array.isArray(items)) {
            return res.status(400).json({ status: 'error', message: 'ข้อมูลรายการไม่ถูกต้อง' });
        }

        let totalAmount = 0; 
        let validItems = [];
        items.forEach(i => {
            let p = parseFloat(i.price);
            if (!isNaN(p) && p > 0) {
                totalAmount += p;
                validItems.push({ 
                    category: i.category || "ทั่วไป", 
                    type: i.type, 
                    number: String(i.number).trim(), 
                    price: p, 
                    rate: parseFloat(i.rate) || 0,
                    status: 'pending', 
                    winAmount: 0 
                });
            }
        });

        if (validItems.length === 0) throw new Error("ไม่มีรายการที่สามารถบันทึกได้");

        if (lineUserId) {
            const user = await User.findOne({ phone: lineUserId });
            if (user && user.credit >= totalAmount) {
                user.credit -= totalAmount;
                await user.save();
                io.emit('data_updated', { message: `อัปเดตเครดิต`, targetPhone: lineUserId });
            } else {
                return res.status(400).json({ status: 'error', message: 'เครดิตไม่พอ' });
            }
        }

        const d = new Date();
        const shortDate = String(d.getDate()).padStart(2, '0') + String(d.getMonth() + 1).padStart(2, '0');
        const billIdNew = `B${shortDate}-${Date.now().toString().slice(-3)}${Math.floor(1000 + Math.random() * 9000)}`;

        await Bill.create({ 
            billId: billIdNew, 
            customerName: customerName || "ลูกค้าทั่วไป", 
            totalAmount, 
            items: validItems,
            status: 'pending',
            winAmount: 0
        });

        sendTelegramNotify(`🧾 โพยใหม่!\nลูกค้า: ${customerName || "ลูกค้าทั่วไป"}\nยอดรวม: ${totalAmount} ฿`);
        io.emit('data_updated', { message: `📥 มีบิลใหม่เข้า: ${customerName || "ลูกค้าทั่วไป"} (${totalAmount} ฿)` });

        res.json({ status: 'success', billId: billIdNew });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.get('/api/bills', checkAuth, async (req, res) => {
    try {
        const bills = await Bill.find().sort({ createdAt: -1 });
        let flatData = [];
        bills.forEach(b => {
            b.items.forEach(i => {
                flatData.push({ category: i.category, billId: b.billId, timestamp: b.createdAt, customer: b.customerName, type: i.type, number: i.number, price: i.price, status: i.status });
            });
        });
        res.json({ status: 'success', data: flatData });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.put('/api/bills/:billId', checkAuth, async (req, res) => {
    await Bill.updateOne({ billId: req.params.billId }, { items: req.body.items, customerName: req.body.customerName });
    res.json({ status: 'success', message: 'แก้ไขสำเร็จ' });
});

app.delete('/api/bills/:billId', checkAuth, async (req, res) => {
    await Bill.deleteOne({ billId: req.params.billId });
    res.json({ status: 'success', message: 'ลบสำเร็จ' });
});

app.get('/api/history/:phone', async (req, res) => {
    const user = await User.findOne({ phone: req.params.phone });
    if (!user) return res.status(404).json({ status: 'error', message: 'ไม่พบผู้ใช้' });
    const fullName = `${user.firstName} ${user.lastName}`;
    const userBills = await Bill.find({ customerName: fullName }).sort({ createdAt: -1 });
    res.json({ status: 'success', data: userBills });
});

// ==========================================
// 🚀 API AppData (เก็บการตั้งค่าทุกอย่าง)
// ==========================================
app.get('/api/appdata', async (req, res) => {
    const allData = await AppData.find();
    let result = {};
    allData.forEach(d => result[d.key] = d.value);
    res.json({ status: 'success', data: result });
});

app.post('/api/appdata', checkAuth, async (req, res) => {
    const { key, value } = req.body;
    await AppData.updateOne({ key }, { value }, { upsert: true });
    io.emit('data_updated', { message: `อัปเดตข้อมูล ${key} แล้ว 🔄` });
    res.json({ status: 'success', message: 'ซิงค์ข้อมูลสำเร็จ' });
});

// ==========================================
// 🏆 API ตรวจผลรางวัล
// ==========================================
app.post('/api/admin/process-results', checkAuth, async (req, res) => {
    try {
        const { category, top3, top2, bot2 } = req.body;
        const bills = await Bill.find();
        
        for (let bill of bills) {
            let billTotalWin = 0;
            let hasUpdate = false;
            let newItems = [];

            for (let item of bill.items) {
                if ((!category || item.category === category) && item.status === 'pending') {
                    let isWin = false;

                    if (item.type === '3 บน' && item.number === top3) { isWin = true; }
                    else if (item.type === '3 โต๊ด' && top3) {
                        let inputArr = item.number.split('').sort().join('');
                        let winArr = top3.split('').sort().join('');
                        if (inputArr === winArr) { isWin = true; }
                    }
                    else if (item.type === '2 บน' && item.number === top2) { isWin = true; }
                    else if (item.type === '2 ล่าง' && item.number === bot2) { isWin = true; }
                    else if (item.type === 'วิ่งบน' && top3 && top3.includes(item.number)) { isWin = true; }
                    else if (item.type === 'วิ่งล่าง' && bot2 && bot2.includes(item.number)) { isWin = true; }

                    if (isWin) {
                        item.status = 'win';
                        item.winAmount = item.price * (item.rate || 0); 
                        billTotalWin += item.winAmount;
                    } else {
                        item.status = 'lose';
                        item.winAmount = 0;
                    }
                    hasUpdate = true;
                }
                newItems.push(item);
            }

            if (hasUpdate) {
                let isAllProcessed = newItems.every(i => i.status !== 'pending');
                let finalStatus = bill.status || 'pending';
                
                if (isAllProcessed) {
                    let hasWin = newItems.some(i => i.status === 'win');
                    finalStatus = hasWin ? 'win' : 'lose';
                }

                await Bill.updateOne(
                    { _id: bill._id }, 
                    { 
                        items: newItems,
                        status: finalStatus, 
                        winAmount: (bill.winAmount || 0) + billTotalWin 
                    }
                );
            }

            if (billTotalWin > 0 && hasUpdate) {
                let allUsers = await User.find();
                let targetUser = allUsers.find(u => `${u.firstName} ${u.lastName}` === bill.customerName);
                if (targetUser) {
                    targetUser.credit = (targetUser.credit || 0) + billTotalWin;
                    await targetUser.save();
                }
            }
        }
        io.emit('data_updated', { message: `🏆 ประกาศผลรางวัลแล้ว! ระบบได้ปรับยอดเงินให้ผู้โชคดีเรียบร้อยค่ะ` });
        res.json({ status: 'success', message: 'ตรวจผลรางวัลและจ่ายเงินสำเร็จ' });
    } catch(err) { res.status(500).json({ status:'error', message: err.message }); }
});

app.get('/api/admin/popup-setting', async (req, res) => {
    const doc = await AppData.findOne({ key: 'popupSetting' });
    res.json({ status: 'success', data: doc ? doc.value : { isEnabled: false, imageUrl: "", text: "" } });
});

app.post('/api/admin/popup-setting', async (req, res) => {
    await AppData.updateOne({ key: 'popupSetting' }, { value: req.body }, { upsert: true });
    res.json({ status: 'success', message: 'บันทึกป๊อปอัปสำเร็จ' });
});

app.get('/api/web-settings', async (req, res) => {
    const doc = await AppData.findOne({ key: 'webSettings' });
    res.json({ status: 'success', data: doc ? doc.value : { themeColor: "#0ea5e9", banners: [] } });
});

app.post('/api/admin/web-settings', checkAuth, async (req, res) => {
    await AppData.updateOne({ key: 'webSettings' }, { value: req.body }, { upsert: true });
    io.emit('data_updated', { message: '🎨 มีการอัปเดตหน้าตาเว็บไซต์' });
    res.json({ status: 'success', message: 'บันทึกสำเร็จ' });
});

app.get('/api/results', async (req, res) => {
    const doc = await AppData.findOne({ key: 'lottoResults' });
    res.json({ status: 'success', data: doc ? doc.value : [] });
});

app.post('/api/admin/results', async (req, res) => {
    let doc = await AppData.findOne({ key: 'lottoResults' });
    let arr = doc ? doc.value : [];
    const index = arr.findIndex(item => item.category === req.body.category);
    if (index !== -1) arr[index] = req.body;
    else arr.push(req.body);
    await AppData.updateOne({ key: 'lottoResults' }, { value: arr }, { upsert: true });
    res.json({ status: 'success', message: 'บันทึกผลสำเร็จ' });
});

app.post('/api/archive', checkAuth, async (req, res) => {
    await Bill.deleteMany({});
    res.json({ status: 'success', message: 'ตัดรอบบิลเรียบร้อยแล้ว' });
});
// ตัวอย่างโค้ดหลังบ้านตอนลูกค้ากดส่งโพย หรือ ทำรายการฝาก/ถอนสำเร็จ
// ... (โค้ดบันทึกลง Database ของคุณ) ...

// 🟢 เพิ่มบรรทัดนี้ลงไปเพื่อยิงสัญญาณไปที่หน้าแอดมิน
io.emit('data_updated', { action: 'new_bill', message: 'มีโพยใหม่เข้า' });
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 [MongoDB Production] Server เปิดรันอยู่ที่พอร์ต ${PORT}`);
});
