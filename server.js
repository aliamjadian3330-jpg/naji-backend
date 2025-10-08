// =================== IMPORTS ===================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fetch = require("node-fetch");

// =================== CONFIG ===================
dotenv.config();
const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// =================== DATABASE ===================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// =================== MODELS ===================
const driverSchema = new mongoose.Schema({
  fullName: String,
  birthDate: String,
  nationalId: { type: String, unique: true },
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
  nationalId: { type: String, unique: true },
  towType: String,
  towModel: String,
  plateNumber: String,
  phone: String,
  password: String,
  location: { lat: Number, lng: Number }
});
const Tow = mongoose.model("Tow", towSchema);

// =================== HELPERS ===================
function validateDriverSignup(data) {
  const { fullName, birthDate, nationalId, phone, password } = data;
  return fullName && birthDate && nationalId && phone && password;
}

function validateTowSignup(data) {
  const { fullName, birthDate, nationalId, phone, password } = data;
  return fullName && birthDate && nationalId && phone && password;
}

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

// =================== MIDDLEWARE ===================
function authMiddleware(req,res,next){
  const authHeader = req.headers.authorization;
  if(!authHeader) return res.status(401).json({ message: "Not authorized ❌" });
  const token = authHeader.split(" ")[1];
  try{
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch(err){
    res.status(401).json({ message: "Invalid token ❌" });
  }
}

// =================== RATE LIMIT ===================
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 دقیقه
  max: 30, // حداکثر درخواست در 1 دقیقه
  message: { message: "زیادی درخواست ❌" }
});
app.use(limiter);

// =================== SOCKET.IO DATA ===================
const tows = new Map(); // socketId => { info, location }
const requests = new Map(); // requestId => { data, timeout }
const REQUEST_TIMEOUT_MS = 30000;
const requestCount = new Map(); // userId => count

// =================== SOCKET.IO AUTH ===================
io.use((socket,next)=>{
  const token = socket.handshake.auth?.token;
  if(!token) return next(new Error("Not authorized ❌"));
  try{
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  }catch(err){
    next(new Error("Invalid token ❌"));
  }
});

// =================== SOCKET.IO CONNECTION ===================
io.on("connection", socket => {
  console.log("✅ کاربر متصل شد:", socket.user.id);

  // ثبت و بروزرسانی یدک‌کش
  socket.on("registerTow", () => tows.set(socket.id,{ socketId: socket.id, location: null }));
  socket.on("towInfo", info => {
    const tow = tows.get(socket.id) || { socketId: socket.id, location: null };
    tow.info = info;
    tows.set(socket.id, tow);
  });
  socket.on("updateTowLocation", loc => {
    if(tows.has(socket.id)){
      const tow = tows.get(socket.id);
      tow.location = loc;
      tows.set(socket.id, tow);
    }
  });

  // درخواست سرویس راننده با محدودیت 10 درخواست در دقیقه
  socket.on("requestService", async (data) => {
    const userId = socket.user.id;
    const count = requestCount.get(userId) || 0;
    if(count >= 10) return socket.emit('error', { message: 'زیادی درخواست ❌' });
    requestCount.set(userId, count+1);
    setTimeout(()=> requestCount.set(userId, Math.max(requestCount.get(userId)-1,0)),60000);

    const requestId = generateRequestId();
    const requestData = {
      requestId,
      driverSocketId: socket.id,
      origin: data.origin,
      dest: data.dest,
      status: "pending",
      assignedTow: null,
      timeout: null,
      driverInfo: data.driverInfo || null
    };

    requestData.timeout = setTimeout(()=>{
      const r = requests.get(requestId);
      if(r && r.status === "pending"){
        r.status = "expired";
        requests.delete(requestId);
        io.to(r.driverSocketId).emit('requestUpdate',{ requestId, status: "expired" });
      }
    }, REQUEST_TIMEOUT_MS);

    requests.set(requestId, requestData);

    // ارسال به نزدیک‌ترین 3 یدک‌کش
    const allTows = Array.from(tows.values()).filter(t => t.location);
    allTows.sort((a,b)=> haversineDistance(a.location, data.origin)-haversineDistance(b.location,data.origin));
    allTows.slice(0,3).forEach(tow=>{
      io.to(tow.socketId).emit('receiveRequest',{
        requestId,
        driverSocketId: socket.id,
        origin: data.origin,
        dest: data.dest,
        driverInfo: data.driverInfo || null
      });
    });

    socket.emit("requestCreated",{ requestId, status: "pending" });
  });

  // پاسخ یدک‌کش به درخواست
  socket.on("requestUpdate", (data)=>{
    const { requestId, status, towInfo } = data;
    if(!requestId) return socket.emit("requestClosed",{ message: "requestId لازم است." });
    const request = requests.get(requestId);
    if(!request) return socket.emit("requestClosed",{ message: "درخواست موجود نیست یا منقضی شده." });
    if(request.status !== "pending") return socket.emit("requestClosed",{ message: "این درخواست دیگر در دسترس نیست." });

    if(status==="accepted"){
      request.status = "accepted";
      request.assignedTow = socket.id;
      request.towInfo = { ...towInfo, location: tows.get(socket.id)?.location || null };
      clearTimeout(request.timeout);
      requests.set(requestId, request);

      io.to(request.driverSocketId).emit("requestUpdate",{
        requestId,
        status: "accepted",
        towId: socket.id,
        towInfo: request.towInfo
      });

      // بستن درخواست برای سایر یدک‌کش‌ها
      tows.forEach(t=>{
        if(t.socketId !== socket.id){
          io.to(t.socketId).emit("requestClosed",{ requestId, message: "این درخواست توسط یدک‌کش دیگری پذیرفته شد." });
        }
      });
    } else if(status==="rejected"){
      io.to(request.driverSocketId).emit("requestUpdate",{ requestId, status: "rejected", towId: socket.id });
    } else {
      socket.emit("requestClosed",{ requestId, message: "status نامعتبر است." });
    }
  });

  // live location راننده
  socket.on("driverLocation", data => {
    tows.forEach(t=> io.to(t.socketId).emit("updateDriverLocation", data));
  });

  // پایان سفر
  socket.on("endTrip", ({ requestId })=>{
    const req = requests.get(requestId);
    if(req){
      io.to(req.driverSocketId).emit("tripEnded",{ requestId });
      if(req.assignedTow) io.to(req.assignedTow).emit("tripEnded",{ requestId });
      requests.delete(requestId);
    }
  });

  // لغو سفر
  socket.on("cancelTrip", ({ requestId })=>{
    const req = requests.get(requestId);
    if(req){
      io.to(req.driverSocketId).emit("tripCanceled",{ requestId });
      if(req.assignedTow) io.to(req.assignedTow).emit("tripCanceled",{ requestId });
      requests.delete(requestId);
    }
  });

  socket.on("disconnect", ()=>{
    tows.delete(socket.id);
    console.log("❌ کاربر قطع شد:", socket.user.id);
  });
});

// =================== DRIVER & TOW ROUTES (SECURE) ===================
// مشابه نسخه قبلی با bcrypt, JWT, validation و forgot-password
// می‌توان از کد پیشنهادی قبل استفاده کرد

// =================== START SERVER ===================
const PORT = process.env.PORT || 5000;
server.listen(PORT, ()=> console.log(`🚀 Server running on port ${PORT}`));
