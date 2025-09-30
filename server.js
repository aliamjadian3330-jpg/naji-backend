// server.js
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

// ذخیره داده‌ها
const tows = new Map(); // towId => { socketId, location, info }
const requests = new Map(); // requestId => { driverSocketId, origin, dest, status, assignedTow, timeout, driverInfo, towInfo }

// زمان انقضا درخواست (۳۰ ثانیه)
const REQUEST_TIMEOUT_MS = 30000;

// تولید id یکتا برای درخواست
function generateRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// محاسبه فاصله جغرافیایی
function haversineDistance(loc1, loc2) {
  if (!loc1 || !loc2) return Infinity;
  const R = 6371;
  const dLat = (loc2.lat - loc1.lat) * Math.PI / 180;
  const dLon = (loc2.lng - loc1.lng) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(loc1.lat * Math.PI / 180) *
      Math.cos(loc2.lat * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// socket.io
io.on("connection", (socket) => {
  console.log("✅ اتصال برقرار شد:", socket.id);

  // ثبت یدک‌کش
  socket.on("registerTow", () => {
    tows.set(socket.id, { socketId: socket.id, location: null, info: {} });
    console.log("یدک‌کش ثبت شد:", socket.id);
  });

  // ذخیره اطلاعات یدک‌کش
  socket.on("towInfo", (info) => {
    const tow = tows.get(socket.id) || { socketId: socket.id, location: null };
    tow.info = info;
    tows.set(socket.id, tow);
    console.log("اطلاعات یدک‌کش ذخیره شد:", socket.id, info);
  });

  // آپدیت موقعیت یدک‌کش
  socket.on("updateTowLocation", (loc) => {
    if (tows.has(socket.id)) {
      const tow = tows.get(socket.id);
      tow.location = loc;
      tows.set(socket.id, tow);
    }
  });

  // راننده درخواست سرویس می‌فرستد
  socket.on("requestService", (data) => {
    console.log("📌 درخواست سرویس راننده:", data);

    const driverInfoFromClient = data.driverInfo || null;
    const requestId = generateRequestId();

    const request = {
      requestId,
      driverSocketId: socket.id,
      origin: data.origin,
      dest: data.dest,
      status: "pending",
      assignedTow: null,
      timeout: null,
      driverInfo: driverInfoFromClient,
    };

    // زمان انقضا
    request.timeout = setTimeout(() => {
      const r = requests.get(requestId);
      if (r && r.status === "pending") {
        r.status = "expired";
        clearTimeout(r.timeout);
        requests.delete(requestId);
        io.to(r.driverSocketId).emit("requestUpdate", { requestId, status: "expired" });
      }
    }, REQUEST_TIMEOUT_MS);

    requests.set(requestId, request);

    // انتخاب نزدیک‌ترین یدک‌کش‌ها
    const allTows = Array.from(tows.values()).filter((t) => t.location);
    allTows.sort(
      (a, b) =>
        haversineDistance(a.location, data.origin) -
        haversineDistance(b.location, data.origin)
    );

    const targets = allTows.slice(0, 3);
    targets.forEach((tow) => {
      io.to(tow.socketId).emit("receiveRequest", {
        requestId,
        driverSocketId: socket.id,
        origin: data.origin,
        dest: data.dest,
        driverInfo: driverInfoFromClient,
      });
    });

    io.to(socket.id).emit("requestCreated", { requestId, status: "pending" });
  });

  // یدک‌کش پاسخ می‌دهد
  socket.on("requestUpdate", (data) => {
    const { requestId, status, towInfo } = data || {};
    const request = requests.get(requestId);

    if (!request) {
      socket.emit("requestClosed", { requestId, message: "درخواست موجود نیست یا منقضی شده." });
      return;
    }

    if (request.status !== "pending") {
      socket.emit("requestClosed", { requestId, message: "این درخواست دیگر در دسترس نیست." });
      return;
    }

    if (status === "accepted") {
      request.status = "accepted";
      request.assignedTow = socket.id;

      request.towInfo = {
        ...(tows.get(socket.id)?.info || {}),
        ...(towInfo || {}),
        location: tows.get(socket.id)?.location || null,
      };

      clearTimeout(request.timeout);
      requests.set(requestId, request);

      // اطلاع به راننده
      io.to(request.driverSocketId).emit("requestUpdate", {
        requestId,
        status: "accepted",
        towId: socket.id,
        towInfo: request.towInfo,
        towLocation: request.towInfo.location,
      });

      // بستن درخواست برای بقیه یدک‌کش‌ها
      tows.forEach((tow) => {
        if (tow.socketId !== socket.id) {
          io.to(tow.socketId).emit("requestClosed", {
            requestId,
            driverSocketId: request.driverSocketId,
            message: "این درخواست توسط یدک‌کش دیگری پذیرفته شد.",
          });
        }
      });
    } else if (status === "rejected") {
      io.to(request.driverSocketId).emit("requestUpdate", {
        requestId,
        status: "rejected",
        towId: socket.id,
      });
    } else {
      socket.emit("requestClosed", { requestId, message: "وضعیت نامعتبر است." });
    }
  });

  // راننده لوکیشن زنده می‌فرستد
  socket.on("driverLocation", (data) => {
    const req = Array.from(requests.values()).find(
      (r) => r.driverSocketId === socket.id && r.status === "accepted"
    );
    if (req && req.assignedTow) {
      io.to(req.assignedTow).emit("updateDriverLocation", {
        driverId: socket.id,
        lat: data.lat,
        lng: data.lng,
      });
    }
  });

  // پایان یا لغو سفر
  socket.on("endTrip", ({ requestId }) => {
    const req = requests.get(requestId);
    if (req) {
      io.to(req.driverSocketId).emit("tripEnded", { requestId });
      if (req.assignedTow) io.to(req.assignedTow).emit("tripEnded", { requestId });
      clearTimeout(req.timeout);
      requests.delete(requestId);
    }
  });

  socket.on("cancelTrip", ({ requestId }) => {
    const req = requests.get(requestId);
    if (req) {
      io.to(req.driverSocketId).emit("tripCanceled", { requestId });
      if (req.assignedTow) io.to(req.assignedTow).emit("tripCanceled", { requestId });
      clearTimeout(req.timeout);
      requests.delete(requestId);
    }
  });

  // قطع اتصال
  socket.on("disconnect", () => {
    tows.delete(socket.id);
    console.log("❌ کاربر قطع شد:", socket.id);
  });
});

// اتصال به MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// مدل‌ها
const driverSchema = new mongoose.Schema({
  fullName: String,
  birthDate: String,
  nationalId: String,
  licensePlate: String,
  phone: String,
  carType: String,
  carColor: String,
  carModel: String,
  password: String,
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
});
const Tow = mongoose.model("Tow", towSchema);

// روت‌های ساده
app.get("/api/drivers/test", (req, res) => res.json({ message: "API راننده فعال است ✅" }));
app.post("/api/drivers/signup", async (req, res) => {
  try {
    const driver = new Driver(req.body);
    await driver.save();
    res.status(201).json({ message: "ثبت‌نام راننده موفق ✅" });
  } catch {
    res.status(500).json({ message: "خطا در ذخیره اطلاعات راننده" });
  }
});
app.post("/api/drivers/login", async (req, res) => {
  try {
    const { nationalId, password } = req.body;
    const driver = await Driver.findOne({ nationalId });
    if (!driver) return res.status(400).json({ message: "راننده یافت نشد" });
    if (driver.password !== password) return res.status(400).json({ message: "رمز عبور اشتباه است" });
    res.json({ message: "ورود موفق راننده ✅", driver });
  } catch {
    res.status(500).json({ message: "خطا در ورود راننده" });
  }
});
app.post("/api/tow/signup", async (req, res) => {
  try {
    const tow = new Tow(req.body);
    await tow.save();
    res.status(201).json({ message: "ثبت‌نام یدک‌کش موفق ✅" });
  } catch {
    res.status(500).json({ message: "خطا در ذخیره اطلاعات یدک‌کش" });
  }
});
app.post("/api/tow/login", async (req, res) => {
  try {
    const { nationalId, password } = req.body;
    const tow = await Tow.findOne({ nationalId });
    if (!tow) return res.status(400).json({ message: "یدک‌کش یافت نشد" });
    if (tow.password !== password) return res.status(400).json({ message: "رمز عبور اشتباه است" });
    res.json({ message: "ورود موفق یدک‌کش ✅", tow });
  } catch {
    res.status(500).json({ message: "خطا در ورود یدک‌کش" });
  }
});

// اجرای سرور
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
