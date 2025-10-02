// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");



// const tows = new Set(); // قديمي
const tows = new Map(); // towId => { socketId, location }

// جلوگيري از قبول همزمان يک درخواست توسط چند يدک‌کش
const acceptedRequests = new Map(); // requestId => towId
// اجازه ندادن به يدکش بعدي وقتي که يدکش قبلي قبول کرده
// ذخيره درخواست‌هاي در حال اجرا
const requests = new Map(); // requestId => { requestId, driverId, origin, dest, status, assignedTow, timeout }

// تنظيم زمان انقضا (مي‌توني مقدار را تغيير بدي)
const REQUEST_TIMEOUT_MS = 30000; // 30 ثانيه

function generateRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}

// .................................................................................................


// بارگذاري متغيرهاي محيطي
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
// socket.IO
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }  // يا محدود به دامنه فرانت شما
});



io.on("connection", (socket) => {
  console.log("يک يدک‌کش يا راننده متصل شد:", socket.id);
  
// 222222222222222222222222222222222222222222222222222
socket.on('endTrip', ({ requestId }) => {
  const req = requests.get(requestId);
  if(req){
    io.to(req.driverSocketId).emit('tripEnded', { requestId });
    if(req.assignedTow) io.to(req.assignedTow).emit('tripEnded', { requestId });
    requests.delete(requestId);
  }
});

socket.on('cancelTrip', ({ requestId }) => {
  const req = requests.get(requestId);
  if(req){
    io.to(req.driverSocketId).emit('tripCanceled', { requestId });
    if(req.assignedTow) io.to(req.assignedTow).emit('tripCanceled', { requestId });
    requests.delete(requestId);
  }
});

  // ثبت يدک‌کش
  
socket.on("registerTow", () => {
    tows.set(socket.id, { socketId: socket.id, location: null });
    console.log("يدک‌کش ثبت شد:", socket.id);
});

// بعد از registerTow handler اضافه کن:
socket.on('towInfo', (info) => {
  // info: { fullName, phone, plate, image }
  const tow = tows.get(socket.id) || { socketId: socket.id, location: null };
  tow.info = info; // ذخيره اطلاعات يدک‌کش
  tows.set(socket.id, tow);
  console.log('اطلاعات يدک‌کش ذخيره شد:', socket.id, info);
});



socket.on('updateTowLocation', (loc) => {
    // loc = { lat, lng } از فرانت يدک‌کش
    if(tows.has(socket.id)){
        const tow = tows.get(socket.id);
        tow.location = loc;
        tows.set(socket.id, tow);
    }
    
});



  // راننده درخواست سرويس مي‌فرسته
  
  

socket.on("requestService", async (data) => {
  console.log("?? درخواست سرويس راننده:", data);

  // data بايد شامل: { origin, dest, driverInfo }
  // driverInfo: { fullName, phone, plate, image } -- راننده از کلاينت مي‌فرستد
  const driverInfoFromClient = data.driverInfo || null;

  const requestId = generateRequestId();
  const request = {
    requestId,
    driverSocketId: socket.id,
    origin: data.origin,
    dest: data.dest,
    status: 'pending',
    assignedTow: null,
    timeout: null,
    driverInfo: driverInfoFromClient
  };

  // timeout
  request.timeout = setTimeout(() => {
    const r = requests.get(requestId);
    if (r && r.status === 'pending') {
      r.status = 'expired';
      requests.delete(requestId);
      io.to(r.driverSocketId).emit('requestUpdate', { requestId, status: 'expired' });
    }
  }, REQUEST_TIMEOUT_MS);

  requests.set(requestId, request);

  // انتخاب نزديک‌ترين يدک‌کش‌ها
  const allTows = Array.from(tows.values()).filter(t => t.location);
  allTows.sort((a, b) => haversineDistance(a.location, data.origin) - haversineDistance(b.location, data.origin));

  const targets = allTows.slice(0, 3);
  targets.forEach(tow => {
    io.to(tow.socketId).emit('receiveRequest', {
      requestId,
      driverSocketId: socket.id,
      origin: data.origin,
      dest: data.dest,
      driverInfo: driverInfoFromClient // ارسال اطلاعات راننده
    });
  });

  // اطلاع به راننده
  io.to(socket.id).emit('requestCreated', { requestId, status: 'pending' });
});








// تابع محاسبه فاصله جغرافيايي بين دو مختصات
function haversineDistance(loc1, loc2) {
  if(!loc1 || !loc2) return Infinity;
  const R = 6371; // شعاع زمين به کيلومتر
  const dLat = (loc2.lat - loc1.lat) * Math.PI / 180;
  const dLon = (loc2.lng - loc1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(loc1.lat * Math.PI/180) *
            Math.cos(loc2.lat * Math.PI/180) *
            Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}



  // يدک‌کش پاسخ مي‌ده
socket.on("requestUpdate", (data) => {
  const { requestId, status, towInfo } = data || {};
  if (!requestId) {
    socket.emit('requestClosed', { message: 'requestId لازم است.' });
    return;
  }

  const request = requests.get(requestId);
  if(!request){
    socket.emit('requestClosed', { requestId, message: 'درخواست موجود نيست يا منقضي شده.' });
    return;
  }

  if(request.status !== 'pending'){
    socket.emit('requestClosed', { requestId, message: 'اين درخواست ديگر در دسترس نيست.' });
    return;
  }
if(status === 'accepted'){
  request.status = 'accepted';
  request.assignedTow = socket.id;
  if(towInfo) {
    towInfo.location = tows.get(socket.id)?.location || null; // اينجا لوکيشن اضافه ميشه
    request.towInfo = towInfo;
  }
  clearTimeout(request.timeout);
  requests.set(requestId, request);


    const towData = request.towInfo || (tows.get(socket.id)?.info || null);
    const towLocation = tows.get(socket.id)?.location || null;

    // اطلاع به راننده
    io.to(request.driverSocketId).emit('requestUpdate', { 
      requestId, 
      status: 'accepted', 
      towId: socket.id, 
      towInfo: towData,
      towLocation
    });

    // اطلاع به ساير يدک‌کش‌ها که درخواست بسته شد
    tows.forEach(tow => {
      if(tow.socketId !== socket.id){
        io.to(tow.socketId).emit('requestClosed', { 
          requestId, 
          driverSocketId: request.driverSocketId, 
          message: 'اين درخواست توسط يدک‌کش ديگري پذيرفته شد.' 
        });
      }
    });

  } else if(status === 'rejected'){
    io.to(request.driverSocketId).emit('requestUpdate', { requestId, status: 'rejected', towId: socket.id });
    // request هنوز pending
  } else {
    socket.emit('requestClosed', { requestId, message: 'status نامعتبر است.' });
  }
});





  // live marker
socket.on('driverLocation', (data) => {
  tows.forEach(tow => {
    io.to(tow.socketId).emit('updateDriverLocation', data);
  });
});


// ارسال موقعیت زنده یدک‌کش به راننده مرتبط
socket.on('updateTowLocation', (loc) => {
  if(tows.has(socket.id)){
    const tow = tows.get(socket.id);
    tow.location = loc;
    tows.set(socket.id, tow);

    // ارسال موقعیت زنده به راننده‌های مرتبط
    requests.forEach((req) => {
      if(req.assignedTow === socket.id){
        io.to(req.driverSocketId).emit('towLocation', {
          requestId: req.requestId,
          lat: loc.lat,
          lng: loc.lng
        });
      }
    });
  }
});


  // قطع اتصال
  socket.on("disconnect", () => {
    tows.delete(socket.id);
    console.log("? کاربر قطع شد:", socket.id);
  });
});



// اتصال به MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("? MongoDB connected"))
  .catch(err => console.error("? MongoDB connection error:", err));

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

// مدل يدک‌کش
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
  res.json({ message: "API راننده فعال است ?" });
});

// ثبت‌نام راننده
app.post("/api/drivers/signup", async (req, res) => {
  try {
    const driver = new Driver(req.body);
    await driver.save();
    res.status(201).json({ message: "ثبت‌نام راننده موفق ?" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "خطا در ذخيره اطلاعات راننده" });
  }
});

// ورود راننده
app.post("/api/drivers/login", async (req, res) => {
  try {
    const { nationalId, password } = req.body;
    const driver = await Driver.findOne({ nationalId });
    if(!driver) return res.status(400).json({ message: "راننده يافت نشد" });
    if(driver.password !== password) return res.status(400).json({ message: "رمز عبور اشتباه است" });
    res.json({ message: "ورود موفق راننده ?", driver });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message: "خطا در ورود راننده" });
  }
});

// بازيابي رمز راننده
app.post("/api/drivers/forgot-password", async (req, res) => {
  try {
    const { nationalId, phone } = req.body;
    const driver = await Driver.findOne({ nationalId, phone });
    if(!driver) return res.status(400).json({ message: "راننده با اين اطلاعات يافت نشد" });

    const newPassword = Math.random().toString(36).slice(-8);
    driver.password = newPassword;
    await driver.save();
    res.json({ message: `رمز جديد راننده: ${newPassword}` });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message: "خطا در بازيابي رمز راننده" });
  }
});

// ========== روت يدک‌کش ==========

// ثبت‌نام يدک‌کش
app.post("/api/tow/signup", async (req, res) => {
  try {
    const tow = new Tow(req.body);
    await tow.save();
    res.status(201).json({ message: "ثبت‌نام يدک‌کش موفق ?" });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message: "خطا در ذخيره اطلاعات يدک‌کش" });
  }
});

// ورود يدک‌کش
app.post("/api/tow/login", async (req, res) => {
  try {
    const { nationalId, password } = req.body;
    const tow = await Tow.findOne({ nationalId });
    if(!tow) return res.status(400).json({ message: "يدک‌کش يافت نشد" });
    if(tow.password !== password) return res.status(400).json({ message: "رمز عبور اشتباه است" });
    res.json({ message: "ورود موفق يدک‌کش ?", tow });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message: "خطا در ورود يدک‌کش" });
  }
});

// بازيابي رمز يدک‌کش
app.post("/api/tow/forgot-password", async (req, res) => {
  try {
    const { nationalId, phone } = req.body;
    const tow = await Tow.findOne({ nationalId, phone });
    if(!tow) return res.status(400).json({ message: "يدک‌کش با اين اطلاعات يافت نشد" });

    const newPassword = Math.random().toString(36).slice(-8);
    tow.password = newPassword;
    await tow.save();
    res.json({ message: `رمز جديد يدک‌کش: ${newPassword}` });
  } catch(err) {
    console.error(err);
    res.status(500).json({ message: "خطا در بازيابي رمز يدک‌کش" });
  }
});

// نمایش کیلومتر مسیر
app.get('/api/route', async (req, res) => {
  try {
    const { originLat, originLng, destLat, destLng } = req.query;
    if (!originLat || !originLng || !destLat || !destLng) {
      return res.status(400).json({ message: "پارامترهای مبدا و مقصد لازم است" });
    }

    const url = `https://router.project-osrm.org/route/v1/driving/${originLng},${originLat};${destLng},${destLat}?overview=full&geometries=geojson`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`خطا در دریافت مسیر: ${response.statusText}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("خطا در دریافت مسیر:", err);
    res.status(500).json({ message: "خطا در دریافت مسیر" });
  }
});

// اجراي سرور
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`?? Server running on port ${PORT}`));
