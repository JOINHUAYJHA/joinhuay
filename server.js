require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron'); 
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const mongoose = require('mongoose'); // <--- เพิ่มบรรทัดนี้เข้าไปครับ
// ==========================================
// 💽 เชื่อมต่อฐานข้อมูล MongoDB ของจริง
// ==========================================
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
    })
    .then(() => console.log('✅ เชื่อมต่อ MongoDB สำเร็จ!'))
    .catch(err => console.log('❌ เชื่อมต่อ MongoDB ล้มเหลว:', err));
} else {
    console.log('⚠️ ยังไม่ได้ใส่ลิงก์ฐานข้อมูล (ใช้โหมดจำลองชั่วคราว)');
}
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] } 
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/keep-awake', (req, res) => res.status(200).send('I am awake!'));

// ==========================================
// 📦 ฐานข้อมูลจำลอง (ใช้ RAM ชั่วคราวในการเทส)
// ==========================================
let usersDB = [];        // เก็บข้อมูลลูกค้า
let billsDB = [];        // เก็บข้อมูลโพยหวย
let archiveBillsDB = []; // เก็บข้อมูลตัดรอบ
let appDataDB = {};      // เก็บการตั้งค่าต่างๆ (เรตจ่าย, เลขอั้น, บัญชีแอดมิน)
let auditLogDB = [];     // เก็บประวัติการแก้ไข
let depositsDB = []; 
  let withdrawalsDB = [];  // 🟢 เพิ่มบรรทัดนี้ เก็บรายการแจ้งถอนเงิน  // 🟢 เก็บรายการแจ้งฝากเงิน (สลิป)

// ==========================================
// 📢 ระบบส่งแจ้งเตือน Telegram
// ==========================================
const sendTelegramNotify = async (message) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
      console.log(`[Telegram (จำลอง)]:\n${message.replace(/<[^>]*>?/gm, '')}`);
      return; 
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
  } catch (error) { console.error('❌ ส่ง Telegram ไม่สำเร็จ:', error.message); }
};

// ==========================================
// 🔐 ระบบยืนยันตัวตนพื้นฐาน (Token)
// ==========================================
const checkAuth = (req, res, next) => {
  const pin = req.headers['authorization'];
  if (pin === (process.env.ADMIN_PIN || "1234")) {
    next();
  } else {
    res.status(403).json({ status: 'error', message: 'Unauthorized: ปฏิเสธการเข้าถึง' });
  }
};

// ==========================================
// 👤 API ระบบสมาชิกลูกค้า (สมัคร & ล็อกอิน)
// ==========================================
app.post('/api/register', (req, res) => {
    try {
        const { firstName, lastName, phone, bankName, bankAccount, password } = req.body;
        if (!firstName || !lastName || !phone || !bankName || !bankAccount || !password) {
            return res.status(400).json({ status: 'error', message: 'กรุณากรอกข้อมูลให้ครบถ้วนทุกช่อง' });
        }
        const existingUser = usersDB.find(u => u.phone === phone);
        if (existingUser) return res.status(400).json({ status: 'error', message: 'เบอร์โทรศัพท์นี้ถูกใช้งานแล้ว' });
        
        const newUser = { id: Date.now().toString(), firstName, lastName, phone, bankName, bankAccount, password, credit: 0, createdAt: new Date(), isBanned: false };
        usersDB.push(newUser);

        sendTelegramNotify(`🎉 มีสมาชิกลูกค้าใหม่สมัครเข้ามา!\nชื่อ: ${firstName} ${lastName}\nเบอร์: ${phone}\nธนาคาร: ${bankName} (${bankAccount})`);
        res.json({ status: 'success', message: 'สมัครสมาชิกสำเร็จ!' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/login', (req, res) => {
    const { phone, password } = req.body;
    const userIndex = usersDB.findIndex(u => u.phone === phone);
    if (userIndex === -1) return res.json({ status: 'error', message: 'ไม่พบเบอร์โทรศัพท์นี้ในระบบ' });

    const user = usersDB[userIndex];
    if (user.password !== password) return res.json({ status: 'error', message: 'รหัสผ่านไม่ถูกต้อง' });
    if (user.isBanned) return res.json({ status: 'error', message: '🚫 บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อแอดมิน' });

    res.json({ 
        status: 'success', message: 'เข้าสู่ระบบสำเร็จ',
        data: { phone: user.phone, name: `${user.firstName} ${user.lastName}`, credit: user.credit || 0 }
    });
});

app.post('/api/verify_pin', (req, res) => {
  const { pin } = req.body;
  if (pin === (process.env.ADMIN_PIN || "1234")) {
    res.json({ status: 'success', message: 'เข้าสู่ระบบสมบูรณ์' });
  } else {
    res.status(401).json({ status: 'error', message: 'รหัส PIN ไม่ถูกต้อง' });
  }
});

app.get('/api/user/profile/:phone', (req, res) => {
    try {
        const { phone } = req.params;
        const user = usersDB.find(u => u.phone === phone);
        if (!user) return res.status(404).json({ status: 'error', message: 'ไม่พบผู้ใช้งาน' });
        
        // 🟢 เพิ่มข้อมูล bankName และ bankAccount ส่งกลับไปให้หน้าเว็บด้วย
        res.json({ 
            status: 'success', 
            data: { 
                name: `${user.firstName} ${user.lastName}`, 
                phone: user.phone, 
                credit: user.credit || 0,
                bankName: user.bankName,
                bankAccount: user.bankAccount
            } 
        });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.get('/api/users', checkAuth, (req, res) => {
    try { res.json({ status: 'success', data: usersDB }); } 
    catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.put('/api/users/:phone/credit', checkAuth, (req, res) => {
    try {
        const { phone } = req.params;
        const { amount } = req.body;
        let userIndex = usersDB.findIndex(u => u.phone === phone);
        
        if (userIndex === -1) return res.status(404).json({ status: 'error', message: 'ไม่พบผู้ใช้งาน' });
        
        if (usersDB[userIndex].credit === undefined) usersDB[userIndex].credit = 0;
        usersDB[userIndex].credit += parseFloat(amount);
        const customerName = `${usersDB[userIndex].firstName} ${usersDB[userIndex].lastName}`;

        sendTelegramNotify(`💰 แอดมินจัดการเครดิตลูกค้า:\n👤 ${customerName}\n📞 ${phone}\nยอด: ${amount} ฿\n💳 คงเหลือ: ${usersDB[userIndex].credit} ฿`);
        io.emit('data_updated', { message: `🎉 ยอดเงินของ ${customerName} อัปเดตแล้ว`, targetPhone: phone });

        res.json({ status: 'success', message: 'อัปเดตเครดิตสำเร็จ', newCredit: usersDB[userIndex].credit });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// ==========================================
// 💸 API จัดการระบบฝากเงิน (อัปโหลดสลิป)
// ==========================================
app.get('/api/admin/bank-info', (req, res) => {
    const adminBank = appDataDB.adminBank || {
        bankName: "ธนาคารกสิกรไทย",
        accountName: "กรุณาตั้งค่าเลขบัญชีที่หน้าแอดมิน",
        accountNumber: "-"
    };
    res.json({ status: 'success', data: adminBank });
});

app.post('/api/deposit', (req, res) => {
    try {
        const { phone, amount, slipImage } = req.body;
        const user = usersDB.find(u => u.phone === phone);
        
        if (!user) return res.status(404).json({ status: 'error', message: 'ไม่พบข้อมูลผู้ใช้' });
        if (!amount || amount < 50) return res.status(400).json({ status: 'error', message: 'ขั้นต่ำการฝาก 50 บาท' });

        const newDeposit = {
            id: 'DP' + Date.now().toString().slice(-6), phone: user.phone, name: `${user.firstName} ${user.lastName}`,
            amount: parseFloat(amount), slipImage: slipImage, status: 'pending', createdAt: new Date()
        };

        depositsDB.push(newDeposit);
        io.emit('data_updated', { message: `💸 แจ้งฝากใหม่: คุณ ${user.firstName} ยอด ${amount} บาท` });
        sendTelegramNotify(`💸 <b>แจ้งฝากเงินใหม่!</b>\nจาก: ${newDeposit.name}\nยอด: ${amount} บาท\nรอตรวจสอบสลิป`);

        res.json({ status: 'success', message: 'ส่งรายการแจ้งฝากเรียบร้อย รอแอดมินตรวจสอบนะคะ' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.get('/api/admin/deposits', checkAuth, (req, res) => {
    try {
        let sortedDeposits = [...depositsDB].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ status: 'success', data: sortedDeposits });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/admin/approve-deposit', checkAuth, (req, res) => {
    try {
        const { depositId } = req.body;
        const depositIndex = depositsDB.findIndex(d => d.id === depositId);
        if (depositIndex === -1) return res.status(404).json({ status: 'error', message: 'ไม่พบรายการนี้' });
        
        const deposit = depositsDB[depositIndex];
        if (deposit.status !== 'pending') return res.status(400).json({ status: 'error', message: 'ทำรายการไปแล้ว' });

        let userIndex = usersDB.findIndex(u => u.phone === deposit.phone);
        if (userIndex === -1) return res.status(404).json({ status: 'error', message: 'ไม่พบบัญชีลูกค้า' });

        depositsDB[depositIndex].status = 'approved';
        if (usersDB[userIndex].credit === undefined) usersDB[userIndex].credit = 0;
        usersDB[userIndex].credit += deposit.amount;

        io.emit('data_updated', { message: `✅ อนุมัติยอดฝาก ${deposit.amount} ฿ เรียบร้อย`, targetPhone: deposit.phone });
        res.json({ status: 'success', message: 'อนุมัติยอดฝากและเติมเครดิตเรียบร้อย' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/admin/reject-deposit', checkAuth, (req, res) => {
    try {
        const { depositId } = req.body;
        const depositIndex = depositsDB.findIndex(d => d.id === depositId);
        if (depositIndex === -1) return res.status(404).json({ status: 'error', message: 'ไม่พบรายการนี้' });
        
        depositsDB[depositIndex].status = 'rejected';
        res.json({ status: 'success', message: 'ยกเลิกรายการฝากสำเร็จ' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// ==========================================
// 💳 API จัดการระบบถอนเงิน
// ==========================================

// 1. ลูกค้าส่งคำขอถอนเงิน
app.post('/api/withdraw', (req, res) => {
    try {
        const { phone, amount } = req.body;
        let userIndex = usersDB.findIndex(u => u.phone === phone);
        
        if (userIndex === -1) return res.status(404).json({ status: 'error', message: 'ไม่พบข้อมูลผู้ใช้' });
        if (!amount || amount < 100) return res.status(400).json({ status: 'error', message: 'ขั้นต่ำการถอน 100 บาท' });
        if (usersDB[userIndex].credit < amount) return res.status(400).json({ status: 'error', message: 'ยอดเงินไม่เพียงพอ' });

        // หักเงินลูกค้าออกทันที เพื่อกันกดถอนรัวๆ (ถ้าแอดมินปฏิเสธ ค่อยคืนเงินให้ทีหลัง)
        usersDB[userIndex].credit -= parseFloat(amount);

        const newWithdraw = {
            id: 'WD' + Date.now().toString().slice(-6), 
            phone: usersDB[userIndex].phone, 
            name: `${usersDB[userIndex].firstName} ${usersDB[userIndex].lastName}`,
            bankName: usersDB[userIndex].bankName,
            bankAccount: usersDB[userIndex].bankAccount,
            amount: parseFloat(amount), 
            status: 'pending', 
            createdAt: new Date()
        };

        withdrawalsDB.push(newWithdraw);
        
        // 🟢 ส่งสัญญาณ Real-time ไปให้แอดมิน (หน้าแอดมินจะเด้งแจ้งเตือนมุมขวาบน)
        io.emit('data_updated', { message: `💳 แจ้งถอนเงินใหม่: คุณ ${usersDB[userIndex].firstName} ยอด ${amount.toLocaleString()} บาท` });
        
        // ส่ง Telegram
        sendTelegramNotify(`💳 <b>แจ้งถอนเงิน!</b>\nจาก: ${newWithdraw.name}\nยอด: ${amount.toLocaleString()} บาท\nธนาคาร: ${newWithdraw.bankName} (${newWithdraw.bankAccount})`);

        res.json({ status: 'success', message: 'ส่งรายการแจ้งถอนเรียบร้อย รอแอดมินตรวจสอบนะคะ' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// 2. แอดมินดึงรายการถอนเงินไปแสดงผล
app.get('/api/admin/withdrawals', checkAuth, (req, res) => {
    try {
        let sortedWithdrawals = [...withdrawalsDB].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ status: 'success', data: sortedWithdrawals });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// 3. แอดมินกดอนุมัติถอนเงิน (โอนเงินให้ลูกค้าแล้ว)
app.post('/api/admin/approve-withdraw', checkAuth, (req, res) => {
    try {
        const { withdrawId } = req.body;
        const wdIndex = withdrawalsDB.findIndex(w => w.id === withdrawId);
        if (wdIndex === -1) return res.status(404).json({ status: 'error', message: 'ไม่พบรายการนี้' });
        
        if (withdrawalsDB[wdIndex].status !== 'pending') return res.status(400).json({ status: 'error', message: 'ทำรายการไปแล้ว' });

        withdrawalsDB[wdIndex].status = 'approved';
        
        // แจ้งลูกค้าว่าเงินเข้าแล้ว
        io.emit('data_updated', { message: `✅ อนุมัติยอดถอน ${withdrawalsDB[wdIndex].amount} ฿ เรียบร้อย แอดมินโอนเงินแล้วค่ะ`, targetPhone: withdrawalsDB[wdIndex].phone });
        
        res.json({ status: 'success', message: 'อนุมัติการถอนเงินเรียบร้อย' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// 4. แอดมินกดปฏิเสธ (คืนเงินให้ลูกค้า)
app.post('/api/admin/reject-withdraw', checkAuth, (req, res) => {
    try {
        const { withdrawId } = req.body;
        const wdIndex = withdrawalsDB.findIndex(w => w.id === withdrawId);
        if (wdIndex === -1) return res.status(404).json({ status: 'error', message: 'ไม่พบรายการนี้' });
        
        if (withdrawalsDB[wdIndex].status !== 'pending') return res.status(400).json({ status: 'error', message: 'ทำรายการไปแล้ว' });

        withdrawalsDB[wdIndex].status = 'rejected';

        // คืนเงินให้ลูกค้า
        let userIndex = usersDB.findIndex(u => u.phone === withdrawalsDB[wdIndex].phone);
        if (userIndex !== -1) {
            usersDB[userIndex].credit += withdrawalsDB[wdIndex].amount;
        }

        io.emit('data_updated', { message: `❌ ยอดถอน ${withdrawalsDB[wdIndex].amount} ฿ ถูกปฏิเสธ ระบบคืนเครดิตให้แล้วค่ะ`, targetPhone: withdrawalsDB[wdIndex].phone });
        
        res.json({ status: 'success', message: 'ยกเลิกรายการถอนและคืนเครดิตสำเร็จ' });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});
// ==========================================
// 🧾 API จัดการบิลและประวัติการแทง
// ==========================================
app.post('/api/bills', (req, res) => {
    try {
        const { customerName, lineUserId, items } = req.body;
        if (!items || !Array.isArray(items)) return res.status(400).json({ status: 'error', message: 'ข้อมูลรายการไม่ถูกต้อง' });

        let totalPrice = 0; 
        let validItems = [];
        items.forEach(i => {
            let p = parseFloat(i.price);
            if (!isNaN(p) && p > 0) {
                totalPrice += p;
                validItems.push({ category: i.category || "ทั่วไป", type: i.type, number: String(i.number).trim(), price: p, status: 'pending', winAmount: 0 });
            }
        });

        if (validItems.length === 0) throw new Error("ไม่มีรายการที่สามารถบันทึกได้");

        if (lineUserId) {
            let userIndex = usersDB.findIndex(u => u.phone === lineUserId);
            if (userIndex !== -1) {
                if ((usersDB[userIndex].credit || 0) < totalPrice) {
                    return res.status(400).json({ status: 'error', message: 'ยอดเครดิตไม่พอ กรุณาเติมเงินค่ะ' });
                }
                usersDB[userIndex].credit -= totalPrice;
                io.emit('data_updated', { message: `อัปเดตเครดิต`, targetPhone: lineUserId });
            }
        }

        const d = new Date();
        const shortDate = String(d.getDate()).padStart(2, '0') + String(d.getMonth() + 1).padStart(2, '0');
        const billIdNew = `B${shortDate}-${Date.now().toString().slice(-3)}${Math.floor(1000 + Math.random() * 9000)}`;

        billsDB.push({ billId: billIdNew, customerName: customerName || "ลูกค้าทั่วไป", totalAmount: totalPrice, items: validItems, createdAt: d });

        sendTelegramNotify(`🧾 โพยใหม่!\nลูกค้า: ${customerName}\nยอดรวม: ${totalPrice} ฿`);
        io.emit('data_updated', { message: `📥 มีโพยใหม่เข้า: ${customerName} (${totalPrice} ฿)` });

        res.json({ status: 'success', billId: billIdNew });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.get('/api/history/:phone', (req, res) => {
    try {
        const { phone } = req.params;
        const user = usersDB.find(u => u.phone === phone);
        if (!user) return res.status(404).json({ status: 'error', message: 'ไม่พบผู้ใช้งาน' });

        const fullName = `${user.firstName} ${user.lastName}`;
        const userBills = billsDB.filter(b => b.customerName === fullName);

        let historyData = userBills.map(bill => {
            let billStatus = 'รอผลรางวัล';
            let totalWinAmount = bill.items.reduce((sum, item) => sum + (item.winAmount || 0), 0);
            
            if (bill.items.some(i => i.status === 'win')) billStatus = 'ถูกรางวัล';
            else if (bill.items.every(i => i.status === 'lose')) billStatus = 'ไม่ถูกรางวัล';

            return { ...bill, status: billStatus, totalWinAmount };
        });

        historyData.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ status: 'success', data: historyData });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.get('/api/bills', checkAuth, (req, res) => {
    let flatData = [];
    billsDB.forEach(b => {
        b.items.forEach(i => {
            flatData.push({
                category: i.category, billId: b.billId, timestamp: b.createdAt,
                customer: b.customerName, type: i.type, number: i.number, price: i.price, status: i.status
            });
        });
    });
    res.json({ status: 'success', data: flatData.reverse() });
});

// ✏️ API แก้ไขบิล
app.put('/api/bills/:billId', checkAuth, (req, res) => {
    const targetBillId = req.params.billId;
    const { customerName, items } = req.body;
    
    let billIndex = billsDB.findIndex(b => b.billId === targetBillId);
    if (billIndex === -1) return res.status(404).json({ status: 'error', message: 'ไม่พบบิล' });

    let newTotal = 0; 
    let validItems = [];
    if (items && Array.isArray(items)) {
        items.forEach(i => {
            let p = parseFloat(i.price);
            if (!isNaN(p) && p > 0) {
                newTotal += p;
                validItems.push({ category: i.category || "ทั่วไป", type: i.type, number: String(i.number).trim(), price: p, status: i.status || 'pending', winAmount: i.winAmount || 0 });
            }
        });
    }

    billsDB[billIndex] = { ...billsDB[billIndex], customerName: customerName || billsDB[billIndex].customerName, items: validItems, totalAmount: newTotal };
    io.emit('data_updated', { message: `✏️ บิล ${targetBillId} ถูกแก้ไขข้อมูล` });
    res.json({ status: 'success', message: 'แก้ไขสำเร็จ' });
});

// 🗑️ API ลบบิล
app.delete('/api/bills/:billId', checkAuth, (req, res) => {
    const targetBillId = req.params.billId;
    const initialLength = billsDB.length;
    billsDB = billsDB.filter(b => b.billId !== targetBillId);
    
    if (billsDB.length < initialLength) {
        io.emit('data_updated', { message: `🗑️ บิล ${targetBillId} ถูกลบออกจากระบบ` });
        res.json({ status: 'success', message: 'ลบสำเร็จ' });
    } else {
        res.status(404).json({ status: 'error', message: 'ไม่พบบิลที่ต้องการลบ' });
    }
});

// ==========================================
// 🚀 API ROUTES (ระบบจัดการ AppData)
// ==========================================
app.get('/api/appdata', (req, res) => res.json({ status: 'success', data: appDataDB }));

app.post('/api/appdata', checkAuth, (req, res) => {
    const { key, value } = req.body;
    if (key) {
        appDataDB[key] = value;
        io.emit('data_updated', { message: `อัปเดตข้อมูล ${key} แบบ Real-time 🔄` });
    }
    res.json({ status: 'success', message: 'ซิงค์ข้อมูลสำเร็จ' });
});

// ==========================================
// 🏆 API ตรวจผลรางวัล (เมื่อแอดมินกรอกผล)
// ==========================================
app.post('/api/admin/process-results', checkAuth, (req, res) => {
    try {
        const { category, top3, top2, bot2 } = req.body;
        
        billsDB.forEach(bill => {
            let billTotalWin = 0;
            let hasUpdate = false;

            bill.items.forEach(item => {
                if ((!category || item.category === category) && item.status === 'pending') {
                    let isWin = false;
                    let rate = 0;

                    if (item.type === '3 บน' && item.number === top3) { isWin = true; rate = 800; }
                    else if (item.type === '3 โต๊ด' && top3) {
                        let inputArr = item.number.split('').sort().join('');
                        let winArr = top3.split('').sort().join('');
                        if (inputArr === winArr) { isWin = true; rate = 130; }
                    }
                    else if (item.type === '2 บน' && item.number === top2) { isWin = true; rate = 90; }
                    else if (item.type === '2 ล่าง' && item.number === bot2) { isWin = true; rate = 90; }
                    else if (item.type === 'วิ่งบน' && top3 && top3.includes(item.number)) { isWin = true; rate = 3.2; }
                    else if (item.type === 'วิ่งล่าง' && bot2 && bot2.includes(item.number)) { isWin = true; rate = 4.2; }

                    if (isWin) {
                        item.status = 'win';
                        item.winAmount = item.price * rate; 
                        billTotalWin += item.winAmount;
                    } else {
                        item.status = 'lose';
                        item.winAmount = 0;
                    }
                    hasUpdate = true;
                }
            });

            if (billTotalWin > 0 && hasUpdate) {
                let userIndex = usersDB.findIndex(u => `${u.firstName} ${u.lastName}` === bill.customerName);
                if (userIndex !== -1) {
                    usersDB[userIndex].credit = (usersDB[userIndex].credit || 0) + billTotalWin;
                }
            }
        });

        io.emit('data_updated', { message: `🏆 ประกาศผลรางวัลแล้ว! ระบบได้ปรับยอดเงินให้ผู้โชคดีเรียบร้อยค่ะ` });
        res.json({ status: 'success', message: 'ตรวจผลรางวัลและจ่ายเงินสำเร็จ' });
    } catch (error) { 
        res.status(500).json({ status: 'error', message: error.message }); 
    }
});
// --- สร้างตัวแปรเก็บการตั้งค่าป๊อปอัป (ถ้ามี Database ให้แก้ไปเซฟลง DB แทน) ---
let popupSettings = {
    isEnabled: false,
    imageUrl: "",
    text: ""
};

// 🟢 1. API ดึงข้อมูลการตั้งค่า (ส่งไปให้แอดมินดู และส่งไปให้หน้าเว็บลูกค้า)
app.get('/api/admin/popup-setting', (req, res) => {
    res.json({ 
        status: 'success', 
        data: popupSettings 
    });
});

// 🟢 2. API รับข้อมูลจากหน้าแอดมิน (เมื่อแอดมินกดปุ่มบันทึก)
app.post('/api/admin/popup-setting', (req, res) => {
    const { isEnabled, imageUrl, text } = req.body;
    
    // อัปเดตข้อมูลการตั้งค่า
    popupSettings.isEnabled = isEnabled;
    popupSettings.imageUrl = imageUrl || "";
    popupSettings.text = text || "";

    console.log("อัปเดตป๊อปอัปสำเร็จ:", popupSettings);

    // ตอบกลับหน้าเว็บว่าบันทึกผ่านแล้ว
    res.json({ 
        status: 'success', 
        message: 'บันทึกการตั้งค่าป๊อปอัปสำเร็จ' 
    });
});
// --- ฐานข้อมูลจำลองเก็บผลรางวัลในหน่วยความจำ ---
let lottoResultsDB = [
    {
        category: "กลุ่มหวยไทย", flag: "🇹🇭", lotteryName: "หวยรัฐบาลไทย", drawDate: "01/09/26",
        iconUrl: "https://flagcdn.com/w80/th.png",
        prizes: {
            top1: ["4", "1", "7", "2", "1", "2"],
            front3: [["2", "5", "7"], ["3", "4", "6"]],
            bottom3: [["1", "3", "6"], ["7", "4", "0"]],
            bottom2: ["0", "4"]
        }
    },
    {
        category: "กลุ่มหวยลาว", flag: "🇱🇦", lotteryName: "หวยลาวพัฒนา (จ - ศ)", drawDate: "05/09/26",
        iconUrl: "https://flagcdn.com/w80/la.png",
        prizes: { top1: ["8", "5", "2", "9"], bottom2: ["2", "9"] }
    }
];

// 🟢 API ที่ 1: สำหรับหน้าลูกค้า วิ่งมาดึงผลรางวัลไปโชว์
app.get('/api/results', (req, res) => {
    res.json({ status: 'success', data: lottoResultsDB });
});

// 🟢 API ที่ 2: สำหรับหน้าแอดมิน ส่งผลรางวัลใหม่เข้ามาบันทึก
app.post('/api/admin/results', (req, res) => {
    const newResult = req.body;
    
    // ค้นหาว่ามีหวยหมวดหมู่นี้อยู่แล้วหรือไม่
    const index = lottoResultsDB.findIndex(item => item.category === newResult.category);
    
    if (index !== -1) {
        lottoResultsDB[index] = newResult; // ถ้ามีอยู่แล้วให้อัปเดตของเดิม
    } else {
        lottoResultsDB.push(newResult); // ถ้ายังไม่มีให้เพิ่มใหม่
    }
    
    res.json({ status: 'success', message: 'บันทึกสำเร็จ' });
});
// ==========================================
// 🎨 API ตั้งค่าเว็บไซต์ (Dynamic Theme & Banners)
// ==========================================
let webSettingsDB = {
    themeColor: "#0ea5e9", // สีฟ้า (ค่าเริ่มต้น)
    banners: [
        "https://via.placeholder.com/800x250/0ea5e9/ffffff?text=Welcome+to+JOIN+HUAY" // รูปแบนเนอร์เริ่มต้น
    ] 
};

// 🟢 1. API ดึงค่าสีและแบนเนอร์ (ใช้ได้ทั้งหน้าลูกค้าและแอดมิน)
app.get('/api/web-settings', (req, res) => {
    res.json({ status: 'success', data: webSettingsDB });
});

// 🟢 2. API บันทึกการตั้งค่าเว็บ (รับข้อมูลจากหน้าแอดมิน)
app.post('/api/admin/web-settings', (req, res) => {
    const { themeColor, banners } = req.body;
    
    if (themeColor) webSettingsDB.themeColor = themeColor;
    if (banners && Array.isArray(banners)) webSettingsDB.banners = banners;

    // แจ้งเตือนให้ทุกหน้าจอ (รวมถึงลูกค้าที่กำลังเปิดเว็บอยู่) เปลี่ยนสีตามทันที
    io.emit('data_updated', { message: '🎨 มีการอัปเดตหน้าตาเว็บไซต์' });
    
    res.json({ status: 'success', message: 'บันทึกการตั้งค่าเว็บไซต์เรียบร้อย' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 [โหมดจำลอง DB] Server เปิดรันอยู่ที่พอร์ต ${PORT}`);
});