// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
// const tows = new Set(); // قدیمی
const tows = new Map(); // towId => { socketId, location }

const drivers = new Map(); // driverId => socket.id
// اجازه ندادن به یدکش بعدی وقتی که یدکش قبلی قبول کرده
// ذخیره درخواست‌های در حال اجرا
const requests = new Map(); // requestId => { requestId, driverId, origin, dest, status, assignedTow, timeout }

// تنظیم زمان انقضا (می‌تونی مقدار را تغییر بدی)
const REQUEST_TIMEOUT_MS = 30000; // 30 ثانیه

function generateRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}
// .................................................................................................


// بارگذاری متغیرهای محیطی
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
// socket.IO
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }  // یا محدود به دامنه فرانت شما
});



io.on("connection", (socket) => {
  console.log("یک یدک‌کش یا راننده متصل شد:", socket.id);

  // ثبت یدک‌کش
  
socket.on("registerTow", () => {
    tows.set(socket.id, { socketId: socket.id, location: null });
    console.log("یدک‌کش ثبت شد:", socket.id);
});


socket.on('updateTowLocation', (loc) => {
    // loc = { lat, lng } از فرانت یدک‌کش
    if(tows.has(socket.id)){
        const tow = tows.get(socket.id);
        tow.location = loc;
        tows.set(socket.id, tow);
    }
});



  // راننده درخواست سرویس می‌فرسته
  



  socket.on("requestService", (data) => {
  console.log("📌 درخواست سرویس راننده:", data);

  // ایجاد شناسه درخواست و ذخیره اولیه
  const requestId = generateRequestId();
  const request = {
    requestId,
    driverId: socket.id,
    origin: data.origin,
    dest: data.dest,
    status: 'pending',
    assignedTow: null,
    timeout: null
  };

  // ست کردن تایم‌اوت تا در صورت عدم پاسخ، درخواست منقضی شود
  request.timeout = setTimeout(() => {
    const r = requests.get(requestId);
    if (r && r.status === 'pending') {
      r.status = 'expired';
      requests.delete(requestId);
      io.to(r.driverId).emit('requestUpdate', { requestId, status: 'expired' });
    }
  }, REQUEST_TIMEOUT_MS);

  requests.set(requestId, request);

  // انتخاب نزدیک‌ترین یدک‌کش‌ها (فقط آن‌هایی که موقعیت دارند)
  const allTows = Array.from(tows.values()).filter(t => t.location);
  allTows.sort((a, b) => {
    const dA = haversineDistance(a.location, data.origin);
    const dB = haversineDistance(b.location, data.origin);
    return dA - dB;
  });

  // ارسال فقط به نزدیک‌ترین 3 یدک‌کش (در صورت وجود)
  const targets = allTows.slice(0, 3);
  targets.forEach(tow => {
    io.to(tow.socketId).emit('receiveRequest', {
      requestId,
      driverId: socket.id,
      origin: data.origin,
      dest: data.dest
    });
  });

  // اطلاع به راننده که درخواست ساخته شد و id آن
  io.to(socket.id).emit('requestCreated', { requestId, status: 'pending' });
});





// تابع محاسبه فاصله جغرافیایی بین دو مختصات
function haversineDistance(loc1, loc2) {
  if(!loc1 || !loc2) return Infinity;
  const R = 6371; // شعاع زمین به کیلومتر
  const dLat = (loc2.lat - loc1.lat) * Math.PI / 180;
  const dLon = (loc2.lng - loc1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(loc1.lat * Math.PI/180) *
            Math.cos(loc2.lat * Math.PI/180) *
            Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}



  // یدک‌کش پاسخ می‌ده
  
socket.on("requestUpdate", (data) => {
  // data باید شامل { requestId, status } باشد
  const { requestId, status } = data || {};
  if (!requestId) {
    socket.emit('requestClosed', { message: 'requestId لازم است.' });
    return;
  }

  const request = requests.get(requestId);
  if(!request){
    // درخواست پیدا نشد یا منقضی شده
    socket.emit('requestClosed', { requestId, message: 'درخواست موجود نیست یا منقضی شده.' });
    return;
  }

  // اگر هنوز pending است می‌توانیم پردازش کنیم
  if (request.status === 'pending') {
    if (status === 'accepted') {
      // قفل کردن درخواست به این یدک‌کش
      request.status = 'accepted';
      request.assignedTow = socket.id;
      clearTimeout(request.timeout);
      requests.set(requestId, request);

      // اطلاع به راننده که این یدک‌کش درخواست را قبول کرد
      io.to(request.driverId).emit('requestUpdate', { requestId, status: 'accepted', towId: socket.id });

      // اطلاع به بقیه یدک‌کش‌ها که این درخواست بسته شده
      tows.forEach(tow => {
        if (tow.socketId !== socket.id) {
          io.to(tow.socketId).emit('requestClosed', { requestId, driverId: request.driverId, message: 'این درخواست توسط یدک‌کش دیگری پذیرفته شد.' });
        }
      });

    } else if (status === 'rejected') {
      // یک یدک‌کش رد کرده — اطلاع اختیاری به راننده
      io.to(request.driverId).emit('requestUpdate', { requestId, status: 'rejected', towId: socket.id });
      // هنوز pending می‌ماند تا یدک‌کش دیگری قبول کند یا تایم‌اوت بخورد
    } else {
      socket.emit('requestClosed', { requestId, message: 'status نامعتبر است.' });
    }
  } else {
    // درخواست قبلاً accepted یا expired شده
    socket.emit('requestClosed', { requestId, message: 'این درخواست دیگر در دسترس نیست.' });
  }
});





  // live marker
socket.on('driverLocation', (data) => {
  tows.forEach(tow => {
    io.to(tow.socketId).emit('updateDriverLocation', data);
  });
});

  // قطع اتصال
  socket.on("disconnect", () => {
    tows.delete(socket.id);
    console.log("❌ کاربر قطع شد:", socket.id);
  });
});



// اتصال به MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// مدل راننده
const driverSchema = new mongoose.Schema({
  fullName: String,
  birthDate: String,
  nationalId: String,
  licensePlate: String,
  phone: String,
  carType: String,
  carColor: String,
  carModel: String,
  password: String
});
const Driver = mongoose.model("Driver", driverSchema);

// مدل یدک‌کش
const towSchema = new mongoose.Schema({
  fullName: String,
  birthDate: String,
  nationalId: String,
  towType: String,
  towModel: String,
  plateNumber: String,
  phone: String,
  password: String
});
const Tow = mongoose.model("Tow", towSchema);

// ========== روت راننده ==========

// تست
app.get("/api/drivers/test", (req, res) => {
  res.json({ message: "API راننده فعال است ✅" });
});

// ثبت‌نام راننده
app.post("/api/drivers/signup", async (req, res) => {
  try {
    const driver = new Driver(req.body);
    await driver.save();
    res.status(201).json({ message: "ثبت‌نام راننده موفق ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "خطا در ذخیره اطلاعات راننده" });
  }
});

// ورود راننده
app.post("/api/drivers/login", async (req, res) => {
  try {
    const { nationalId, password } = req.body;
    const driver = await Driver.findOne({ nationalId });
    if(!driver) return res.status(400).json({ message: "راننده یافت نشد" });
    if(driver.password !== password) return res.status(400).json({ message: "رمز عبور اشتباه است" });
    res.json({ message: "ورود موفق راننده ✅", driver });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message: "خطا در ورود راننده" });
  }
});

// بازیابی رمز راننده
app.post("/api/drivers/forgot-password", async (req, res) => {
  try {
    const { nationalId, phone } = req.body;
    const driver = await Driver.findOne({ nationalId, phone });
    if(!driver) return res.status(400).json({ message: "راننده با این اطلاعات یافت نشد" });

    const newPassword = Math.random().toString(36).slice(-8);
    driver.password = newPassword;
    await driver.save();
    res.json({ message: `رمز جدید راننده: ${newPassword}` });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message: "خطا در بازیابی رمز راننده" });
  }
});

// ========== روت یدک‌کش ==========

// ثبت‌نام یدک‌کش
app.post("/api/tow/signup", async (req, res) => {
  try {
    const tow = new Tow(req.body);
    await tow.save();
    res.status(201).json({ message: "ثبت‌نام یدک‌کش موفق ✅" });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message: "خطا در ذخیره اطلاعات یدک‌کش" });
  }
});

// ورود یدک‌کش
app.post("/api/tow/login", async (req, res) => {
  try {
    const { nationalId, password } = req.body;
    const tow = await Tow.findOne({ nationalId });
    if(!tow) return res.status(400).json({ message: "یدک‌کش یافت نشد" });
    if(tow.password !== password) return res.status(400).json({ message: "رمز عبور اشتباه است" });
    res.json({ message: "ورود موفق یدک‌کش ✅", tow });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message: "خطا در ورود یدک‌کش" });
  }
});

// بازیابی رمز یدک‌کش
app.post("/api/tow/forgot-password", async (req, res) => {
  try {
    const { nationalId, phone } = req.body;
    const tow = await Tow.findOne({ nationalId, phone });
    if(!tow) return res.status(400).json({ message: "یدک‌کش با این اطلاعات یافت نشد" });

    const newPassword = Math.random().toString(36).slice(-8);
    tow.password = newPassword;
    await tow.save();
    res.json({ message: `رمز جدید یدک‌کش: ${newPassword}` });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message: "خطا در بازیابی رمز یدک‌کش" });
  }
});

// اجرای سرور
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
