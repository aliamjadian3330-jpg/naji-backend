// server.js
// نسخه امن‌شده: Express + Socket.IO با JWT short access + refresh token ذخیره‌شده
// توضیحات: قبل از اجرای کامل زیربنایی موارد deployment (TLS، WAF، آپدیت پکیج‌ها) را انجام دهید.

require('dotenv').config();
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
// Optional Redis for token blacklist (recommended)
let Redis;
let redisClient;
const USE_REDIS = !!process.env.REDIS_URL;
if (USE_REDIS) {
  Redis = require('ioredis');
  redisClient = new Redis(process.env.REDIS_URL);
}

// ---------- CONFIG ----------
const PORT = process.env.PORT || 5000;
const ORIGIN = process.env.CORS_ORIGIN || '*'; // در production محدود به دامنه فرانت کن
const JWT_SECRET = process.env.JWT_SECRET || 'please_change_me';
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m'; // کوتاه
const REFRESH_TOKEN_TTL_SECS = parseInt(process.env.REFRESH_TOKEN_TTL_SECS || '60*60*24*30'); // 30 days default
const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12');

// ---------- APP ----------
const app = express();
app.use(helmet({
  contentSecurityPolicy: false, // اگر CSP می‌خوای فعال کن و تنظیمات لازم رو اضافه کن
}));
app.use(express.json({ limit: '50kb' })); // محدودیت payload
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(mongoSanitize());
app.use(xss());
app.use(hpp());
app.use(compression());

// CORS: در production مقدار origin را به دامنه‌ی فرانت محدود کن
app.use(cors({
  origin: ORIGIN,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));

// Rate limiter برای روت‌های حساس (مثال: auth)
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // max requests per IP per window
  message: { message: 'Too many requests, please slow down.' }
});

// Simple global limiter (IP-level)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { message: 'Too many requests' }
});
app.use(globalLimiter);

// ---------- LOGGER (winston) ----------
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console()
  ]
});

// ---------- Mongoose models ----------
// مدل راننده (Driver)
const driverSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  phone: { type: String, required: true },
  carType: { type: String, required: true },
  carModel: { type: String, required: true },
  carColor: { type: String },
  plate: { type: String },
  image: { type: String }, // optional
  password: { type: String, required: true } 
});

const Driver = mongoose.model('Driver', driverSchema);

// مدل یدک‌کش (Tow)
const towSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  phone: { type: String, required: true },
  carType: { type: String, required: true },
  carModel: { type: String, required: true },
  password: { type: String, required: true }, // برای login
  refreshTokenHash: String // برای ذخیره refresh token امن
}, { timestamps: true });
const Tow = mongoose.model('Tow', towSchema);

// Optional: blacklist توکن‌ها (همانند قبل)
const tokenBlacklistSchema = new mongoose.Schema({
  jti: { type: String, index: true },
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } }
});
const TokenBlacklist = mongoose.model('TokenBlacklist', tokenBlacklistSchema);

// ---------- HELPERS ----------
function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}
function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}
function signRefreshToken(payload) {
  // include jti to blacklist individually
  const jti = uuidv4();
  const token = jwt.sign({ ...payload, jti }, JWT_SECRET, { expiresIn: `${Math.floor(REFRESH_TOKEN_TTL_SECS)}s` });
  return { token, jti };
}
async function addJtiToBlacklist(jti, ttlSec) {
  if (USE_REDIS) {
    await redisClient.setex(`bl_${jti}`, ttlSec, '1');
  } else {
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    await TokenBlacklist.create({ jti, expiresAt });
  }
}
async function isJtiBlacklisted(jti) {
  if (!jti) return false;
  if (USE_REDIS) {
    const v = await redisClient.get(`bl_${jti}`);
    return !!v;
  } else {
    const exists = await TokenBlacklist.findOne({ jti }).lean();
    return !!exists;
  }
}

// bcrypt helpers
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}
async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// ---------- AUTH MIDDLEWARE ----------
async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ message: 'Not authorized' });
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    // Optionally check jti blacklist (if access tokens have jti)
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
}
// ---------- INPUT VALIDATION (Joi) ----------
const signupSchema = Joi.object({
  fullName: Joi.string().min(2).max(100).required(),
  nationalId: Joi.string().min(3).max(50).required(),
  phone: Joi.string().min(5).max(30).required(),
  carType: Joi.string().required(),
  carModel: Joi.string().required(),
  carColor: Joi.string().allow('', null),
  plate: Joi.string().allow('', null),
  image: Joi.string().allow('', null),
  password: Joi.string().min(8).max(128).required()
});

// ---------- HTTP ROUTES (Auth, Tow update) ----------

// Driver signup
app.post('/api/drivers/signup', authLimiter, validate(signupSchema), async (req, res) => {
  try {
    // ← اینجا تغییر می‌کنیم
    const { password, licensePlate, ...rest } = req.body;  // destructure فرم
    const hashed = await hashPassword(password);

    // این خط را اضافه کن:
    const driver = new Driver({ ...rest, plate: licensePlate, password: hashed });

    await driver.save();

    // emit اطلاعات کامل برای داشبورد
    const dashData = {
      id: driver._id.toString(),
      fullName: driver.fullName,
      phone: driver.phone,
      carType: driver.carType,
      carModel: driver.carModel,
      carColor: driver.carColor || '-',
      plate: driver.licensePlate || '-',   // حالا مقدار plate درست ارسال می‌شود
      image: driver.image || ''
    };
    io.emit('newDriverRegistered', dashData);

    res.status(201).json({ message: 'Driver registered' });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});


// Tow signup
app.post('/api/tow/signup', authLimiter, validate(signupSchema), async (req, res) => {
  try {
    const { password, ...rest } = req.body;
    const hashed = await hashPassword(password);
    const tow = new Tow({ ...rest, password: hashed });
    await tow.save();

    // emit فقط فیلدهای مورد نیاز برای داشبورد
    const dashData = {
      id: tow._id.toString(),
      fullName: tow.fullName,
      phone: tow.phone,
      carType: tow.carType || '-',
      carModel: tow.carModel || '-',
      carColor: tow.carColor || '-',
      plate: tow.plate || '-',
      image: tow.image || ''
    };
    io.emit('newTowRegistered', dashData);

    res.status(201).json({ message: 'Tow registered' });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});
// Tow login -> returns access + refresh tokens (refresh stored hashed)
app.post('/api/tow/login', authLimiter, async (req, res) => {
  try {
    const { nationalId, password } = req.body;
    const tow = await Tow.findOne({ nationalId });
    if (!tow) return res.status(400).json({ message: 'Tow not found' });
    const ok = await comparePassword(password, tow.password);
    if (!ok) return res.status(400).json({ message: 'Invalid credentials' });

    const access = signAccessToken({ id: tow._id.toString(), role: 'tow' });
    const { token: refreshToken, jti } = signRefreshToken({ id: tow._id.toString(), role: 'tow' });

    // store hash of refresh token (so we can revoke by comparing hash)
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    tow.refreshTokenHash = refreshHash;
    await tow.save();

    // send refresh as httpOnly secure cookie (recommended)
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_TOKEN_TTL_SECS * 1000
    });

    res.json({ accessToken: access });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Refresh token endpoint
app.post('/api/token/refresh', async (req, res) => {
  try {
    const rt = req.cookies?.refreshToken || req.body.refreshToken;
    if (!rt) return res.status(401).json({ message: 'No refresh token' });
    const decoded = jwt.verify(rt, JWT_SECRET);
    // check blacklist
    if (await isJtiBlacklisted(decoded.jti)) return res.status(401).json({ message: 'Revoked' });

    const userId = decoded.id;
    const tow = await Tow.findById(userId);
    if (!tow) return res.status(401).json({ message: 'Not found' });

    // compare stored hashed refresh token
    const matches = await bcrypt.compare(rt, tow.refreshTokenHash || '');
    if (!matches) return res.status(401).json({ message: 'Invalid refresh token' });

    // issue new access token (and optionally new refresh)
    const access = signAccessToken({ id: tow._id.toString(), role: 'tow' });

    // Optionally rotate refresh token
    const { token: newRefresh, jti } = signRefreshToken({ id: tow._id.toString(), role: 'tow' });
    const refreshHash = await bcrypt.hash(newRefresh, 10);
    tow.refreshTokenHash = refreshHash;
    await tow.save();

    res.cookie('refreshToken', newRefresh, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_TOKEN_TTL_SECS * 1000
    });

    res.json({ accessToken: access });
  } catch (err) {
    logger.warn('Refresh failed', err.message);
    return res.status(401).json({ message: 'Invalid refresh token' });
  }
});

// Logout / revoke refresh token
app.post('/api/token/revoke', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    // invalidate stored refresh token
    if (req.user.role === 'tow') {
      await Tow.findByIdAndUpdate(userId, { $unset: { refreshTokenHash: 1 } });
    } else {
      // handle driver if you store refresh tokens for drivers too
    }
    // If token had jti, add to blacklist (if you saved jti)
    // addJtiToBlacklist(jti, ttl)
    res.clearCookie('refreshToken');
    res.json({ message: 'Logged out' });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update tow location (protected)
app.post('/api/tow/update-location', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'tow') return res.status(403).json({ message: 'Forbidden' });
    const { lat, lng } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ message: 'Invalid coordinates' });
    const tow = await Tow.findByIdAndUpdate(req.user.id, { location: { lat, lng } }, { new: true });
    if (!tow) return res.status(404).json({ message: 'Tow not found' });

    // Notify connected sockets (we'll bridge by socketId map)
    // See socket logic below to maintain mapping between userId and socketId(s).
    res.json({ message: 'Location updated' });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// simple health
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- SOCKET.IO (auth + per-socket rate limit + role check) ----------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ORIGIN, methods: ['GET','POST'] } });

// Map userId -> set of socketIds
const userSockets = new Map();

// simple token bucket per socket (avoid spam)
const socketRate = new Map();
function allowSocketEvent(socketId) {
  const now = Date.now();
  const bucket = socketRate.get(socketId) || { tokens: 10, last: now };
  const elapsed = now - bucket.last;
  // refill rate: 1 token per 1000ms
  bucket.tokens = Math.min(10, bucket.tokens + Math.floor(elapsed / 1000));
  bucket.last = now;
  if (bucket.tokens > 0) {
    bucket.tokens -= 1;
    socketRate.set(socketId, bucket);
    return true;
  } else {
    socketRate.set(socketId, bucket);
    return false;
  }
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Not authorized'));
    const decoded = jwt.verify(token, JWT_SECRET);
    // optionally check jti blacklist for access token
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  logger.info('socket connected', { id: socket.id, user: socket.user?.id });
  // register socket to user
  if (socket.user?.id) {
    const set = userSockets.get(socket.user.id) || new Set();
    set.add(socket.id);
    userSockets.set(socket.user.id, set);
  }

  // register as tow (if the client wants)
  socket.on('registerTow', () => {
    if (!allowSocketEvent(socket.id)) return socket.emit('error', { message: 'Too many events' });
    // store mapping socket -> userId if authenticated tow
    // also store location/info in memory map if needed
  });

  socket.on('requestService', (payload) => {
    if (!allowSocketEvent(socket.id)) return socket.emit('error', { message: 'Too many events' });
    // validate payload (simple)
    // find nearby tows and emit receiveRequest only to authenticated tow sockets
  });

  socket.on('updateTowLocation', (loc) => {
    if (!allowSocketEvent(socket.id)) return socket.emit('error', { message: 'Too many events' });
    // validate loc
  });

  socket.on('disconnect', () => {
    logger.info('socket disconnected', { id: socket.id });
    if (socket.user?.id) {
      const set = userSockets.get(socket.user.id);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) userSockets.delete(socket.user.id);
      }
    }
  });
});

// ---------- START & MONGO ----------
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    logger.info('Mongo connected');
    server.listen(PORT, () => logger.info(`Server listening on ${PORT}`));
  })
  .catch(err => {
    logger.error('Mongo connection failed', err);
    process.exit(1);
  });

// ---------- ERROR HANDLING ----------
app.use((err, req, res, next) => {
  logger.error(err);
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({ message: 'Internal server error' });
  } else {
    res.status(500).json({ message: err.message, stack: err.stack });
  }
});
