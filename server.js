
require('dotenv').config();

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { WebSocketServer, WebSocket } = require('ws');

// database.js is in the project root.
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

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';

const cookieSetting = String(
  process.env.COOKIE_SECURE || 'auto'
).toLowerCase();

const secureCookie =
  cookieSetting === 'true' ||
  (cookieSetting === 'auto' && process.env.NODE_ENV === 'production');

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

let roomToken = crypto.randomBytes(32).toString('base64url');

const startedAt = new Date().toISOString();

const activeDevices = new Map();
const sessions = new Map();

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
app.use(sessionMiddleware);

app.use('/api/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
}));

// Serve only public frontend assets.
// Never expose server.js, database.js, .env or the data directory.
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

function jsonSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcastStatus() {
  for (const ws of wss.clients) {
    if (ws.role === 'dashboard') {
      jsonSend(ws, {
        type: 'status',
        devices: [...sessions.entries()].map(([id, s]) => ({
          id,
          name: s.name,
          connectedAt: s.connectedAt,
          viewers: s.viewers.size
        }))
      });
    }
  }
}

function getDashboardPage(req) {
  return path.join(
    __dirname,
    isAuthed(req) ? 'index.html' : 'login.html'
  );
}

// Main pages
app.get('/', (req, res) => {
  res.sendFile(getDashboardPage(req));
});

app.get('/share', (_req, res) => {
  res.sendFile(path.join(__dirname, 'share.html'));
});

// Health check for hosting platforms
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'AMX PHANTOM SCREEN',
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// Dashboard APIs
app.get('/api/status', requireAuth, (_req, res) => {
  res.json({
    ok: true,
    startedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    activeCount: sessions.size,
    registeredCount: listDevices().length
  });
});

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

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('amx.sid');
    res.json({ ok: true });
  });
});

app.get('/api/room', requireAuth, async (req, res, next) => {
  try {
    const host = req.get('host');
    const protocol = req.protocol;

    const shareUrl =
      `${protocol}://${host}/share?room=${encodeURIComponent(roomToken)}`;

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

app.get('/api/devices', requireAuth, (_req, res) => {
  res.json({
    devices: listDevices(),
    events: listEvents(60),
    onlineIds: [...sessions.keys()]
  });
});

// WebSocket signaling
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 32 * 1024
});

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
      ws.roomToken = isPhone ? roomToken : null;
      ws.id = crypto.randomUUID();

      wss.emit('connection', ws, req);
    });
  });
});

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

    // Phone registers itself
    if (msg.type === 'register' && ws.role === 'phone') {
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

    // Dashboard requests to watch a phone
    if (msg.type === 'watch' && ws.role === 'dashboard') {
      const id = safeString(msg.deviceId, 80);
      const phone = activeDevices.get(id);

      if (!phone || phone.readyState !== WebSocket.OPEN) {
        return jsonSend(ws, {
          type: 'error',
          message: 'این دستگاه آنلاین نیست.'
        });
      }

      const sess = sessions.get(id);

      if (sess) {
        sess.viewers.add(ws);
      }

      if (!ws.watchingDevices) {
        ws.watchingDevices = new Set();
      }

      ws.watchingDevices.add(id);

      jsonSend(phone, {
        type: 'watch-request',
        viewerId: ws.id
      });

      return;
    }

    // Phone sends WebRTC messages to all dashboards watching it
    if (
      ws.role === 'phone' &&
      ['offer', 'answer', 'ice', 'stream-stopped', 'consent-denied'].includes(msg.type)
    ) {
      const sess = sessions.get(ws.deviceId);

      if (!sess) return;

      for (const viewer of sess.viewers) {
        jsonSend(viewer, {
          ...msg,
          deviceId: ws.deviceId,
          viewerId: viewer.id
        });
      }

      if (msg.type === 'stream-stopped') {
        recordEvent(
          ws.deviceId,
          ws.deviceName,
          'stream-stopped'
        );
      }

      return;
    }

    // Dashboard sends WebRTC messages or commands to a phone
    if (
      ws.role === 'dashboard' &&
      ['answer', 'ice', 'consent', 'stop'].includes(msg.type)
    ) {
      const id = safeString(msg.deviceId, 80);
      const phone = activeDevices.get(id);

      if (!phone || phone.readyState !== WebSocket.OPEN) {
        return;
      }

      jsonSend(phone, {
        ...msg,
        viewerId: ws.id
      });

      return;
    }
  });

  ws.on('close', () => {
    if (
      ws.role === 'phone' &&
      ws.deviceId &&
      activeDevices.get(ws.deviceId) === ws
    ) {
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

    if (ws.role === 'dashboard' && ws.watchingDevices) {
      for (const id of ws.watchingDevices) {
        const sess = sessions.get(id);

        if (sess) {
          sess.viewers.delete(ws);
        }
      }
    }
  });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);

  if (res.headersSent) return;

  res.status(500).json({
    error: 'خطای داخلی سرور.'
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    `AMX PHANTOM SCREEN running on ${HOST}:${PORT}`
  );
});

process.on('SIGINT', () => {
  wss.close();

  server.close(() => {
    process.exit(0);
  });
});
