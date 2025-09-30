const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// MongoDB Models
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error(err));

const driverSchema = new mongoose.Schema({
  fullName: String,
  phone: String,
  licensePlate: String,
  password: String,
});
const Driver = mongoose.model("Driver", driverSchema);

const towSchema = new mongoose.Schema({
  fullName: String,
  phone: String,
  plateNumber: String,
  image: String,
  password: String,
});
const Tow = mongoose.model("Tow", towSchema);

// --- Data structures ---
const tows = new Map(); // socketId => { location, info }
const requests = new Map(); // requestId => { driverSocketId, origin, dest, status, assignedTow, timeout }

// Timeout 30 ثانیه
const REQUEST_TIMEOUT_MS = 30000;

function generateRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}

function haversineDistance(loc1, loc2){
  if(!loc1 || !loc2) return Infinity;
  const R=6371, dLat=(loc2.lat-loc1.lat)*Math.PI/180, dLon=(loc2.lng-loc1.lng)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(loc1.lat*Math.PI/180)*Math.cos(loc2.lat*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// --- Socket.IO ---
io.on("connection", socket => {
  console.log("🔗 متصل شد:", socket.id);

  // ثبت یدک‌کش
  socket.on("registerTow", (info={}) => {
    tows.set(socket.id, { socketId: socket.id, location: null, info });
    console.log("یدک‌کش ثبت شد:", socket.id, info);
  });

  // بروزرسانی موقعیت یدک‌کش
  socket.on("updateTowLocation", loc => {
    if(tows.has(socket.id)){
      const tow = tows.get(socket.id);
      tow.location = loc;
      tows.set(socket.id, tow);
    }
  });

  // راننده درخواست سرویس
  socket.on("requestService", data => {
    const { origin, dest, driverInfo } = data;
    const requestId = generateRequestId();
    const request = {
      requestId,
      driverSocketId: socket.id,
      origin, dest,
      status: "pending",
      assignedTow: null,
      timeout: null,
      driverInfo
    };

    // Timeout
    request.timeout = setTimeout(() => {
      const r = requests.get(requestId);
      if(r && r.status === "pending"){
        r.status = "expired";
        requests.delete(requestId);
        io.to(r.driverSocketId).emit("requestUpdate",{ requestId, status:"expired" });
      }
    }, REQUEST_TIMEOUT_MS);

    requests.set(requestId, request);

    // نزدیک‌ترین یدک‌کش‌ها
    const allTows = Array.from(tows.values()).filter(t => t.location);
    allTows.sort((a,b)=> haversineDistance(a.location, origin) - haversineDistance(b.location, origin));
    const targets = allTows.slice(0,3);

    targets.forEach(tow => {
      io.to(tow.socketId).emit("receiveRequest", { requestId, driverSocketId: socket.id, origin, dest, driverInfo });
    });

    io.to(socket.id).emit("requestCreated", { requestId, status:"pending" });
  });

  // پاسخ یدک‌کش
  socket.on("requestUpdate", data => {
    const { requestId, status, towInfo } = data;
    const request = requests.get(requestId);
    if(!request) return socket.emit("requestClosed",{ requestId, message:"درخواست موجود نیست یا منقضی شده." });

    if(status === "accepted" && request.status === "pending"){
      request.status="accepted"; request.assignedTow = socket.id; clearTimeout(request.timeout);
      request.towInfo = towInfo || (tows.get(socket.id)?.info || {});
      requests.set(requestId, request);

      // اطلاع راننده
      io.to(request.driverSocketId).emit("requestUpdate", {
        requestId,
        status:"accepted",
        towId: socket.id,
        towInfo: request.towInfo,
        towLocation: tows.get(socket.id)?.location || null
      });

      // اطلاع سایر یدک‌کش‌ها
      tows.forEach(tow=>{
        if(tow.socketId !== socket.id){
          io.to(tow.socketId).emit("requestClosed", { requestId, message:"این درخواست توسط یدک‌کش دیگری پذیرفته شد." });
        }
      });
    } else if(status==="rejected"){
      io.to(request.driverSocketId).emit("requestUpdate",{ requestId, status:"rejected", towId: socket.id });
    }
  });

  // موقعیت زنده راننده
  socket.on("driverLocation", data=>{
    tows.forEach(tow=>{
      io.to(tow.socketId).emit("updateDriverLocation", data);
    });
  });

  socket.on("endTrip", ({requestId})=>{
    const req = requests.get(requestId);
    if(req){
      io.to(req.driverSocketId).emit("tripEnded",{ requestId });
      if(req.assignedTow) io.to(req.assignedTow).emit("tripEnded",{ requestId });
      requests.delete(requestId);
    }
  });

  socket.on("cancelTrip", ({requestId})=>{
    const req = requests.get(requestId);
    if(req){
      io.to(req.driverSocketId).emit("tripCanceled",{ requestId });
      if(req.assignedTow) io.to(req.assignedTow).emit("tripCanceled",{ requestId });
      requests.delete(requestId);
    }
  });

  socket.on("disconnect", () => {
    tows.delete(socket.id);
    console.log("❌ قطع اتصال:", socket.id);
  });
});

// --- روت‌های ساده راننده و یدک‌کش ---
app.get("/", (req,res)=>res.send("Server Running"));
const PORT=process.env.PORT||5000;
server.listen(PORT,()=>console.log(`🚀 Server on port ${PORT}`));
