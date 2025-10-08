// =================== IMPORTS ===================
const cors = require("cors");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const fetch = require("node-fetch");

// =================== CONFIG ===================
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// =================== DATA STRUCTURES ===================
const tows = new Map(); // socketId => { socketId, location, info }
const requests = new Map(); // requestId => { ... }
const REQUEST_TIMEOUT_MS = 30000;

// =================== HELPERS ===================
function generateRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}

function haversineDistance(loc1, loc2) {
  if(!loc1 || !loc2) return Infinity;
  const R = 6371;
  const dLat = (loc2.lat - loc1.lat) * Math.PI / 180;
  const dLon = (loc2.lng - loc1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(loc1.lat * Math.PI/180) *
            Math.cos(loc2.lat * Math.PI/180) *
            Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// =================== MODELS ===================
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

const towSchema = new mongoose.Schema({
  fullName: String,
  birthDate: String,
  nationalId: String,
  towType: String,
  towModel: String,
  plateNumber: String,
  phone: String,
  password: String,
  location: { lat: Number, lng: Number }
});
const Tow = mongoose.model("Tow", towSchema);

// =================== JWT MIDDLEWARE ===================
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if(!authHeader) return res.status(401).json({ message: 'Not authorized ❌' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch(err) {
    res.status(401).json({ message: 'Invalid token ❌' });
  }
}

// =================== SOCKET.IO ===================
io.on("connection", (socket) => {
  console.log("یک یدک‌کش یا راننده متصل شد:", socket.id);

  // ثبت یدک‌کش
  socket.on("registerTow", () => {
    tows.set(socket.id, { socketId: socket.id, location: null });
    console.log("یدک‌کش ثبت شد:", socket.id);
  });

  // ذخیره اطلاعات یدک‌کش
  socket.on('towInfo', (info) => {
    const tow = tows.get(socket.id) || { socketId: socket.id, location: null };
    tow.info = info;
    tows.set(socket.id, tow);
  });

  // بروزرسانی موقعیت یدک‌کش
  socket.on('updateTowLocation', (loc) => {
    if(tows.has(socket.id)){
      const tow = tows.get(socket.id);
      tow.location = loc;
      tows.set(socket.id, tow);
    }
  });

  // درخواست سرویس راننده
  socket.on("requestService", async (data) => {
    const driverInfo = data.driverInfo || null;
    const requestId = generateRequestId();
    const request = {
      requestId,
      driverSocketId: socket.id,
      origin: data.origin,
      dest: data.dest,
      status: 'pending',
      assignedTow: null,
      timeout: null,
      driverInfo
    };

    // زمان انقضا
    request.timeout = setTimeout(() => {
      const r = requests.get(requestId);
      if(r && r.status === 'pending'){
        r.status = 'expired';
        requests.delete(requestId);
        io.to(r.driverSocketId).emit('requestUpdate', { requestId, status: 'expired' });
      }
    }, REQUEST_TIMEOUT_MS);

    requests.set(requestId, request);

    // نزدیک‌ترین یدک‌کش‌ها
    const allTows = Array.from(tows.values()).filter(t => t.location);
    allTows.sort((a, b) => haversineDistance(a.location, data.origin) - haversineDistance(b.location, data.origin));

    allTows.slice(0, 3).forEach(tow => {
      io.to(tow.socketId).emit('receiveRequest', { requestId, driverSocketId: socket.id, origin: data.origin, dest: data.dest, driverInfo });
    });

    io.to(socket.id).emit('requestCreated', { requestId, status: 'pending' });
  });

  // پاسخ یدک‌کش به درخواست
  socket.on("requestUpdate", (data) => {
    const { requestId, status, towInfo } = data || {};
    if(!requestId) return socket.emit('requestClosed', { message: 'requestId لازم است.' });
    const request = requests.get(requestId);
    if(!request) return socket.emit('requestClosed', { requestId, message: 'درخواست موجود نیست یا منقضی شده.' });
    if(request.status !== 'pending') return socket.emit('requestClosed', { requestId, message: 'این درخواست دیگر در دسترس نیست.' });

    if(status === 'accepted'){
      request.status = 'accepted';
      request.assignedTow = socket.id;
      if(towInfo) {
        towInfo.location = tows.get(socket.id)?.location || null;
        request.towInfo = towInfo;
      }
      clearTimeout(request.timeout);
      requests.set(requestId, request);

      const towData = request.towInfo || (tows.get(socket.id)?.info || null);
      const towLocation = tows.get(socket.id)?.location || null;

      io.to(request.driverSocketId).emit('requestUpdate', { requestId, status: 'accepted', towId: socket.id, towInfo: towData, towLocation });

      // اطلاع به سایر یدک‌کش‌ها
      tows.forEach(tow => {
        if(tow.socketId !== socket.id){
          io.to(tow.socketId).emit('requestClosed', { requestId, driverSocketId: request.driverSocketId, message: 'این درخواست توسط یدک‌کش دیگری پذیرفته شد.' });
        }
      });
    } else if(status === 'rejected'){
      io.to(request.driverSocketId).emit('requestUpdate', { requestId, status: 'rejected', towId: socket.id });
    } else {
      socket.emit('requestClosed', { requestId, message: 'status نامعتبر است.' });
    }
  });

  // live location راننده
  socket.on('driverLocation', (data) => {
    tows.forEach(tow => io.to(tow.socketId).emit('updateDriverLocation', data));
  });

  // پایان سفر
  socket.on('endTrip', ({ requestId }) => {
    const req = requests.get(requestId);
    if(req){
      io.to(req.driverSocketId).emit('tripEnded', { requestId });
      if(req.assignedTow) io.to(req.assignedTow).emit('tripEnded', { requestId });
      requests.delete(requestId);
    }
  });

  // لغو سفر
  socket.on('cancelTrip', ({ requestId }) => {
    const req = requests.get(requestId);
    if(req){
      io.to(req.driverSocketId).emit('tripCanceled', { requestId });
      if(req.assignedTow) io.to(req.assignedTow).emit('tripCanceled', { requestId });
      requests.delete(requestId);
    }
  });

  // قطع اتصال
  socket.on("disconnect", () => {
    tows.delete(socket.id);
    console.log("❌ کاربر قطع شد:", socket.id);
  });
});

// =================== ROUTES راننده ===================
app.get("/api/drivers/test", authMiddleware, (req, res) => res.json({ message: "✅ API راننده فعال است و احراز هویت شد!", user: req.user }));

app.post("/api/drivers/signup", async (req, res) => {
  try{
    const { password, ...rest } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const driver = new Driver({ ...rest, password: hashed });
    await driver.save();
    res.status(201).json({ message: "ثبت‌نام راننده موفق ✅" });
  } catch(err){ res.status(500).json({ message: "خطا در ذخیره اطلاعات راننده ❌" }); }
});

app.post("/api/drivers/login", async (req,res) => {
  try{
    const { nationalId, password } = req.body;
    const driver = await Driver.findOne({ nationalId });
    if(!driver) return res.status(400).json({ message: "راننده یافت نشد ❌" });
    const match = await bcrypt.compare(password, driver.password);
    if(!match) return res.status(400).json({ message: "رمز عبور اشتباه است ❌" });
    const token = jwt.sign({ id: driver._id, role: 'driver' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ message: "ورود موفق ✅", token, driver: { _id: driver._id, fullName: driver.fullName } });
  } catch(err){ res.status(500).json({ message: "خطا در ورود راننده ❌" }); }
});

app.post("/api/drivers/forgot-password", async (req,res) => {
  try{
    const { nationalId, phone } = req.body;
    const driver = await Driver.findOne({ nationalId, phone });
    if(!driver) return res.status(400).json({ message: "راننده با این اطلاعات یافت نشد ❌" });
    const newPass = Math.random().toString(36).slice(-8);
    driver.password = await bcrypt.hash(newPass, 10);
    await driver.save();
    res.json({ message: "رمز عبور با موفقیت تغییر کرد ✅. لطفاً login کنید." });
  } catch(err){ res.status(500).json({ message: "خطا در بازیابی رمز راننده ❌" }); }
});

// =================== ROUTES یدک‌کش ===================
app.post("/api/tow/signup", async (req,res) => {
  try{
    const { password, ...rest } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const tow = new Tow({ ...rest, password: hashed });
    await tow.save();
    res.status(201).json({ message: "ثبت‌نام یدک‌کش موفق ✅" });
  } catch(err){ res.status(500).json({ message: "خطا در ذخیره اطلاعات یدک‌کش ❌" }); }
});

app.post("/api/tow/login", async (req,res) => {
  try{
    const { nationalId, password } = req.body;
    const tow = await Tow.findOne({ nationalId });
    if(!tow) return res.status(400).json({ message: "یدک‌کش یافت نشد ❌" });
    const match = await bcrypt.compare(password, tow.password);
    if(!match) return res.status(400).json({ message: "رمز عبور اشتباه است ❌" });
    const token = jwt.sign({ id: tow._id, role: 'tow' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ message: "ورود موفق ✅", token, tow: { _id: tow._id, fullName: tow.fullName } });
  } catch(err){ res.status(500).json({ message: "خطا در ورود یدک‌کش ❌" }); }
});

app.post("/api/tow/forgot-password", async (req,res) => {
  try{
    const { nationalId, phone } = req.body;
    const tow = await Tow.findOne({ nationalId, phone });
    if(!tow) return res.status(400).json({ message: "یدک‌کش با این اطلاعات یافت نشد ❌" });
    const newPass = Math.random().toString(36).slice(-8);
    tow.password = await bcrypt.hash(newPass, 10);
    await tow.save();
    res.json({ message: "رمز عبور با موفقیت تغییر کرد ✅. لطفاً login کنید." });
  } catch(err){ res.status(500).json({ message: "خطا در بازیابی رمز یدک‌کش ❌" }); }
});

// =================== ROUTE مسیر راننده ===================
app.get('/api/route', async (req,res) => {
  try{
    const { originLat, originLng, destLat, destLng } = req.query;
    if(!originLat || !originLng || !destLat || !destLng) return res.status(400).json({ message: "پارامترهای مبدا و مقصد لازم است" });
    const url = `https://router.project-osrm.org/route/v1/driving/${originLng},${originLat};${destLng},${destLat}?overview=full&geometries=geojson`;
    const response = await fetch(url);
    if(!response.ok) throw new Error(response.statusText);
    const data = await response.json();
    res.json(data);
  } catch(err){ res.status(500).json({ message: "خطا در دریافت مسیر" }); }
});

// =================== بروزرسانی لوکیشن یدک‌کش ===================
app.post("/api/tow/update-location", authMiddleware, async (req,res) => {
  if(req.user.role !== "tow") return res.status(403).json({ message: "فقط یدک‌کش مجاز است ❌" });
  const { lat, lng } = req.body;
  if(!lat || !lng) return res.status(400).json({ message: "lat و lng لازم است ❌" });

  try{
    const tow = await Tow.findByIdAndUpdate(req.user.id, { location: { lat, lng } }, { new: true });
    if(!tow) return res.status(404).json({ message: "یدک‌کش یافت نشد ❌" });

    tows.forEach(t => io.to(t.socketId).emit('updateTowLocation', { towId: tow._id, location: tow.location }));
    res.json({ message: "موقعیت با موفقیت بروزرسانی شد ✅", location: tow.location });
  } catch(err){ res.status(500).json({ message: "خطا در سرور ❌" }); }
});

// =================== MONGODB CONNECTION ===================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// =================== START SERVER ===================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
