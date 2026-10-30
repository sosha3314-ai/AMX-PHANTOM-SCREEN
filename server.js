'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { WebSocketServer, WebSocket } = require('ws');

const {
  registerDevice,
  recordEvent,
  listDevices,
  listEvents,
  markOffline
} = require('./database');

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';

const cookieSetting = String(
  process.env.COOKIE_SECURE || 'auto'
).toLowerCase();

const secureCookie =
  cookieSetting === 'true' ||
  (cookieSetting === 'auto' &&
    process.env.NODE_ENV === 'production');

if (
  DASHBOARD_PASSWORD.length < 16 ||
  SESSION_SECRET.length < 32
) {
  console.error(
    'SECURITY ERROR: Set DASHBOARD_PASSWORD (16+ chars) and SESSION_SECRET (32+ chars).'
  );
  process.exit(1);
}

if (secureCookie) {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));

app.use(express.json({ limit: '16kb' }));

const sessionMiddleware = session({
  store: new SQLiteStore({
    db: 'sessions.sqlite',
    dir: DATA_DIR
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'amx.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookie,
    maxAge: 8 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);

app.use('/api/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
}));

let roomToken = crypto.randomBytes(32).toString('base64url');

const startedAt = new Date().toISOString();

const activeDevices = new Map();
const sessions = new Map();

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 32 * 1024
});

// ------------------------------
// SECURITY HELPERS
// ------------------------------

function isAuthed(req) {
  return Boolean(
    req.session &&
    req.session.authenticated === true
  );
}

function requireAuth(req, res, next) {
  if (!isAuthed(req)) {
    return res.status(401).json({
      error: 'ورود به داشبورد لازم است.'
    });
  }

  next();
}

function safeString(value, max = 48) {
  return typeof value === 'string'
    ? value.trim().replace(/[<>]/g, '').slice(0, max)
    : '';
}

function jsonSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getIceServers() {
  const servers = [{
    urls: process.env.STUN_URL ||
      'stun:stun.l.google.com:19302'
  }];

  if (
    process.env.TURN_URL &&
    process.env.TURN_USERNAME &&
    process.env.TURN_CREDENTIAL
  ) {
    servers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  return servers;
}

function getViewer(sess, viewerId) {
  if (!sess || !viewerId) return null;

  for (const viewer of sess.viewers) {
    if (viewer.id === viewerId) {
      return viewer;
    }
  }

  return null;
}

// ------------------------------
// FRONTEND FILES
// ------------------------------

app.get('/css/style.css', (_req, res) => {
  res.sendFile(path.join(__dirname, 'style.css'));
});

app.get('/js/dashboard.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.js'));
});

app.get('/js/login.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'login.js'));
});

app.get('/js/share.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'share.js'));
});

app.get('/assets/logo.svg', (_req, res) => {
  res.sendFile(path.join(__dirname, 'logo.svg'));
});

// ------------------------------
// MAIN PAGES
// ------------------------------

app.get('/', (req, res) => {
  const page = isAuthed(req)
    ? 'index.html'
    : 'login.html';

  res.sendFile(path.join(__dirname, page));
});

app.get('/share', (_req, res) => {
  res.sendFile(path.join(__dirname, 'share.html'));
});

// ------------------------------
// HEALTH CHECK
// ------------------------------

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'AMX PHANTOM SCREEN',
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// ------------------------------
// LOGIN
// ------------------------------

app.post('/api/login', (req, res, next) => {
  const password =
    typeof req.body?.password === 'string'
      ? req.body.password
      : '';

  const a = Buffer.from(password);
  const b = Buffer.from(DASHBOARD_PASSWORD);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(401).json({
      error: 'رمز عبور صحیح نیست.'
    });
  }

  req.session.regenerate(err => {
    if (err) return next(err);

    req.session.authenticated = true;

    req.session.save(saveErr => {
      if (saveErr) return next(saveErr);

      res.json({ ok: true });
    });
  });
});

// ------------------------------
// LOGOUT
// ------------------------------

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('amx.sid');
    res.json({ ok: true });
  });
});

// ------------------------------
// QR ROOM
// ------------------------------

app.get('/api/room', requireAuth, async (req, res, next) => {
  try {
    const shareUrl =
      `${req.protocol}://${req.get('host')}/share?room=${encodeURIComponent(roomToken)}`;

    const qr = await QRCode.toDataURL(shareUrl, {
      width: 260,
      margin: 2,
      color: {
        dark: '#00ff88',
        light: '#07100d'
      }
    });

    res.json({
      shareUrl,
      qr,
      roomToken,
      expiresOnRestart: true
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------
// DASHBOARD STATUS
// ------------------------------

app.get('/api/status', requireAuth, (_req, res) => {
  res.json({
    ok: true,
    startedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    activeCount: sessions.size,
    registeredCount: listDevices().length
  });
});

// ------------------------------
// DEVICE LIST
// ------------------------------

app.get('/api/devices', requireAuth, (_req, res) => {
  res.json({
    devices: listDevices(),
    events: listEvents(60),
    onlineIds: [...sessions.keys()]
  });
});

// ------------------------------
// WEBRTC ICE CONFIGURATION
// ------------------------------

app.get('/api/ice-servers', (req, res) => {
  const requestedRoom = req.query.room;

  const authorized =
    isAuthed(req) ||
    (
      typeof requestedRoom === 'string' &&
      requestedRoom === roomToken
    );

  if (!authorized) {
    return res.status(401).json({
      error: 'دسترسی غیرمجاز'
    });
  }

  res.set('Cache-Control', 'no-store');

  res.json({
    iceServers: getIceServers()
  });
});

// ------------------------------
// BROADCAST STATUS
// ------------------------------

function broadcastStatus() {
  const devices = [...sessions.entries()].map(([id, s]) => ({
    id,
    name: s.name,
    connectedAt: s.connectedAt,
    viewers: s.viewers.size
  }));

  for (const ws of wss.clients) {
    if (ws.role === 'dashboard') {
      jsonSend(ws, {
        type: 'status',
        devices
      });
    }
  }
}

// ------------------------------
// WEBSOCKET AUTHENTICATION
// ------------------------------

server.on('upgrade', (req, socket, head) => {
  let url;

  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    socket.destroy();
    return;
  }

  if (url.pathname !== '/signal') {
    socket.destroy();
    return;
  }

  sessionMiddleware(req, {}, () => {
    const isDashboard = Boolean(
      req.session?.authenticated
    );

    const isPhone =
      url.searchParams.get('room') === roomToken;

    if (!isDashboard && !isPhone) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\n\r\n'
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      ws.role = isDashboard ? 'dashboard' : 'phone';
      ws.id = crypto.randomUUID();

      wss.emit('connection', ws, req);
    });
  });
});

// ------------------------------
// WEBSOCKET CONNECTION
// ------------------------------

wss.on('connection', ws => {

  ws.on('message', raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return jsonSend(ws, {
        type: 'error',
        message: 'پیام نامعتبر است.'
      });
    }

    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    // PHONE REGISTRATION

    if (
      msg.type === 'register' &&
      ws.role === 'phone'
    ) {
      const id = safeString(msg.deviceId, 80);

      const name =
        safeString(msg.name || 'گوشی ناشناس', 40) ||
        'گوشی ناشناس';

      if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) {
        return jsonSend(ws, {
          type: 'error',
          message: 'شناسه دستگاه نامعتبر است.'
        });
      }

      const previous = activeDevices.get(id);

      if (previous && previous !== ws) {
        try {
          previous.close(4001, 'replaced');
        } catch {}
      }

      ws.deviceId = id;
      ws.deviceName = name;

      activeDevices.set(id, ws);

      sessions.set(id, {
        name,
        connectedAt: new Date().toISOString(),
        viewers: new Set()
      });

      registerDevice({ id, name });

      jsonSend(ws, {
        type: 'registered',
        deviceId: id
      });

      broadcastStatus();
      return;
    }

    // DASHBOARD WATCH REQUEST

    if (
      msg.type === 'watch' &&
      ws.role === 'dashboard'
    ) {
      const id = safeString(msg.deviceId, 80);
      const phone = activeDevices.get(id);
      const sess = sessions.get(id);

      if (
        !phone ||
        phone.readyState !== WebSocket.OPEN ||
        !sess
      ) {
        return jsonSend(ws, {
          type: 'error',
          message: 'این دستگاه آنلاین نیست.'
        });
      }

      sess.viewers.add(ws);

      if (!ws.watchingDevices) {
        ws.watchingDevices = new Set();
      }

      ws.watchingDevices.add(id);

      jsonSend(phone, {
        type: 'watch-request',
        deviceId: id,
        viewerId: ws.id
      });

      jsonSend(ws, {
        type: 'watch-request-sent',
        deviceId: id
      });

      broadcastStatus();
      return;
    }

    // PHONE TO VIEWER

    if (
      ws.role === 'phone' &&
      [
        'offer',
        'ice',
        'stream-stopped',
        'consent-denied'
      ].includes(msg.type)
    ) {
      const sess = sessions.get(ws.deviceId);

      if (!sess) return;

      if (msg.type === 'stream-stopped') {
        for (const viewer of sess.viewers) {
          jsonSend(viewer, {
            type: 'stream-stopped',
            deviceId: ws.deviceId
          });
        }

        recordEvent(
          ws.deviceId,
          ws.deviceName,
          'stream-stopped'
        );

        return;
      }

      const viewerId = safeString(msg.viewerId, 80);
      const viewer = getViewer(sess, viewerId);

      if (!viewer) return;

      jsonSend(viewer, {
        ...msg,
        deviceId: ws.deviceId,
        viewerId
      });

      return;
    }

    // DASHBOARD TO PHONE

    if (
      ws.role === 'dashboard' &&
      [
        'answer',
        'ice',
        'consent',
        'stop'
      ].includes(msg.type)
    ) {
      const id = safeString(msg.deviceId, 80);
      const phone = activeDevices.get(id);
      const sess = sessions.get(id);

      if (
        !phone ||
        phone.readyState !== WebSocket.OPEN ||
        !sess ||
        !sess.viewers.has(ws)
      ) {
        return;
      }

      if (msg.type === 'stop') {
        sess.viewers.delete(ws);

        if (ws.watchingDevices) {
          ws.watchingDevices.delete(id);
        }

        jsonSend(phone, {
          type: 'stop',
          deviceId: id,
          viewerId: ws.id
        });

        broadcastStatus();
        return;
      }

      jsonSend(phone, {
        ...msg,
        deviceId: id,
        viewerId: ws.id
      });

      return;
    }
  });

  // CONNECTION CLOSED

  ws.on('close', () => {

    if (
      ws.role === 'phone' &&
      ws.deviceId &&
      activeDevices.get(ws.deviceId) === ws
    ) {
      const sess = sessions.get(ws.deviceId);

      if (sess) {
        for (const viewer of sess.viewers) {
          jsonSend(viewer, {
            type: 'stream-stopped',
            deviceId: ws.deviceId
          });
        }
      }

      activeDevices.delete(ws.deviceId);
      sessions.delete(ws.deviceId);

      markOffline(ws.deviceId);

      recordEvent(
        ws.deviceId,
        ws.deviceName,
        'disconnected'
      );

      broadcastStatus();
    }

    if (
      ws.role === 'dashboard' &&
      ws.watchingDevices
    ) {
      for (const id of ws.watchingDevices) {
        const sess = sessions.get(id);

        if (sess) {
          sess.viewers.delete(ws);

          const phone = activeDevices.get(id);

          jsonSend(phone, {
            type: 'stop',
            deviceId: id,
            viewerId: ws.id
          });
        }
      }

      broadcastStatus();
    }
  });

  ws.on('error', err => {
    console.error('WebSocket error:', err.message);
  });
});

// ------------------------------
// ERROR HANDLER
// ------------------------------

app.use((err, _req, res, _next) => {
  console.error(err);

  if (res.headersSent) return;

  res.status(500).json({
    error: 'خطای داخلی سرور.'
  });
});

// ------------------------------
// START SERVER
// ------------------------------

server.listen(PORT, HOST, () => {
  console.log(
    `AMX PHANTOM SCREEN running on ${HOST}:${PORT}`
  );
});

// ------------------------------
// SHUTDOWN
// ------------------------------

function shutdown() {
  console.log('Shutting down AMX PHANTOM SCREEN...');

  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'server shutdown');
    } catch {}
  }

  wss.close();

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);