const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ذخیره یدک‌کش‌ها و راننده‌ها
const tows = new Map();    // towId => { socketId, info, location }
const drivers = new Map(); // driverId => { socketId, info, location }

// مدیریت درخواست‌ها
const requests = new Map(); // requestId => { driverId, origin, dest, status, assignedTow, timeout }

const REQUEST_TIMEOUT_MS = 30000;

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

io.on("connection", socket => {
  console.log("✅ متصل شد:", socket.id);

  // ثبت یدک‌کش
  socket.on("registerTow", () => {
    tows.set(socket.id, { socketId: socket.id, info: {}, location: null });
    console.log("یدک‌کش ثبت شد:", socket.id);
  });

  socket.on("towInfo", info => {
    if(tows.has(socket.id)){
      const tow = tows.get(socket.id);
      tow.info = info;
      tows.set(socket.id, tow);
      console.log("اطلاعات یدک‌کش ذخیره شد:", info);
    }
  });

  socket.on("updateTowLocation", loc => {
    if(tows.has(socket.id)){
      const tow = tows.get(socket.id);
      tow.location = loc;
      tows.set(socket.id, tow);
    }
  });

  // ثبت راننده
  socket.on("registerDriver", info => {
    drivers.set(socket.id, { socketId: socket.id, info, location: null });
    console.log("راننده ثبت شد:", info);
  });

  socket.on("updateDriverLocation", loc => {
    if(drivers.has(socket.id)){
      const d = drivers.get(socket.id);
      d.location = loc;
      drivers.set(socket.id, d);

      // ارسال موقعیت راننده به تمام یدک‌کش‌ها
      tows.forEach(tow => {
        io.to(tow.socketId).emit("updateDriverLocation", { driverId: socket.id, lat: loc.lat, lng: loc.lng });
      });
    }
  });

  // راننده درخواست سرویس
  socket.on("requestService", data => {
    const requestId = generateRequestId();
    const request = {
      requestId,
      driverSocketId: socket.id,
      origin: data.origin,
      dest: data.dest,
      status: "pending",
      assignedTow: null,
      timeout: null,
      driverInfo: data.driverInfo
    };

    // timeout
    request.timeout = setTimeout(() => {
      if(requests.has(requestId) && requests.get(requestId).status === "pending"){
        io.to(socket.id).emit("requestUpdate", { requestId, status: "expired" });
        requests.delete(requestId);
      }
    }, REQUEST_TIMEOUT_MS);

    requests.set(requestId, request);

    // ارسال درخواست به نزدیک‌ترین 3 یدک‌کش
    const availableTows = Array.from(tows.values()).filter(t => t.location);
    availableTows.sort((a,b) => haversineDistance(a.location, data.origin) - haversineDistance(b.location, data.origin));
    const targets = availableTows.slice(0,3);
    targets.forEach(tow => {
      io.to(tow.socketId).emit("receiveRequest", {
        requestId,
        origin: data.origin,
        dest: data.dest,
        driverInfo: data.driverInfo
      });
    });

    io.to(socket.id).emit("requestCreated", { requestId, status: "pending" });
  });

  // یدک‌کش پاسخ می‌دهد
  socket.on("requestUpdate", ({ requestId, status, towInfo }) => {
    if(!requests.has(requestId)) {
      socket.emit("requestClosed", { requestId, message: "درخواست موجود نیست" });
      return;
    }
    const request = requests.get(requestId);
    if(request.status !== "pending") return;

    if(status === "accepted"){
      request.status = "accepted";
      request.assignedTow = socket.id;
      if(towInfo) request.towInfo = towInfo;
      clearTimeout(request.timeout);
      requests.set(requestId, request);

      // اطلاع به راننده
      io.to(request.driverSocketId).emit("requestUpdate", {
        requestId,
        status: "accepted",
        towInfo: request.towInfo,
        towLocation: tows.get(socket.id)?.location
      });

      // اطلاع به بقیه یدک‌کش‌ها
      tows.forEach(tow => {
        if(tow.socketId !== socket.id){
          io.to(tow.socketId).emit("requestClosed", { requestId, message: "درخواست توسط یدک‌کش دیگر پذیرفته شد" });
        }
      });
    } else if(status === "rejected"){
      io.to(request.driverSocketId).emit("requestUpdate", { requestId, status: "rejected" });
    }
  });

  socket.on("endTrip", ({ requestId }) => {
    if(requests.has(requestId)){
      const r = requests.get(requestId);
      io.to(r.driverSocketId).emit("tripEnded", { requestId });
      if(r.assignedTow) io.to(r.assignedTow).emit("tripEnded", { requestId });
      requests.delete(requestId);
    }
  });

  socket.on("cancelTrip", ({ requestId }) => {
    if(requests.has(requestId)){
      const r = requests.get(requestId);
      io.to(r.driverSocketId).emit("tripCanceled", { requestId });
      if(r.assignedTow) io.to(r.assignedTow).emit("tripCanceled", { requestId });
      requests.delete(requestId);
    }
  });

  socket.on("disconnect", () => {
    tows.delete(socket.id);
    drivers.delete(socket.id);
    console.log("❌ کاربر قطع شد:", socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
