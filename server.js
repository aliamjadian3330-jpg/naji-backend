// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const tows = new Set(); // ذخیره socket.id یدک‌کش‌ها
const drivers = new Map(); // driverId => socket.id


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
    tows.add(socket.id);
    console.log("یدک‌کش ثبت شد:", socket.id);
  });

  // راننده درخواست سرویس می‌فرسته
  socket.on("requestService", (data) => {
    console.log("📌 درخواست سرویس راننده:", data);
    tows.forEach(towSocketId => {
      io.to(towSocketId).emit("receiveRequest", data);
    });
  });

  // یدک‌کش پاسخ می‌ده
  socket.on("requestUpdate", (data) => {
    console.log("📌 پاسخ یدک‌کش:", data);
    io.to(data.driverId).emit("requestUpdate", data);
  });

  // live marker
  socket.on('driverLocation', (data) => {
    tows.forEach(towSocketId => {
      io.to(towSocketId).emit('updateDriverLocation', data);
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
