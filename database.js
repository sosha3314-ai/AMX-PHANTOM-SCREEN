

  

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// Persistent database directory
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'phantom.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Create database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    first_registered_at TEXT NOT NULL,
    last_connected_at TEXT,
    sessions INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'registered'
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    device_name TEXT,
    event_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_created_at
  ON events(created_at);

  CREATE INDEX IF NOT EXISTS idx_events_device_id
  ON events(device_id);
`);

const upsertDevice = db.prepare(`
  INSERT INTO devices (
    id,
    name,
    first_registered_at,
    last_connected_at,
    sessions,
    status
  )
  VALUES (
    @id,
    @name,
    @now,
    @now,
    1,
    'registered'
  )
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    last_connected_at = excluded.last_connected_at,
    sessions = devices.sessions + 1,
    status = 'registered'
`);

const eventInsert = db.prepare(`
  INSERT INTO events (
    device_id,
    device_name,
    event_type,
    created_at
  )
  VALUES (?, ?, ?, ?)
`);

function registerDevice({ id, name }) {
  const now = new Date().toISOString();

  const transaction = db.transaction(() => {
    upsertDevice.run({
      id,
      name,
      now
    });

    eventInsert.run(
      id,
      name,
      'connected',
      now
    );
  });

  transaction();
}

function recordEvent(id, name, type) {
  if (typeof type !== 'string' || !type.trim()) {
    throw new Error('Invalid event type');
  }

  eventInsert.run(
    id || null,
    name || null,
    type.trim().slice(0, 60),
    new Date().toISOString()
  );
}

function listDevices() {
  return db.prepare(`
    SELECT *
    FROM devices
    ORDER BY last_connected_at DESC
  `).all();
}

function listEvents(limit = 100) {
  const safeLimit = Math.max(
    1,
    Math.min(Number(limit) || 100, 500)
  );

  return db.prepare(`
    SELECT *
    FROM events
    ORDER BY id DESC
    LIMIT ?
  `).all(safeLimit);
}

function markOffline(id) {
  db.prepare(`
    UPDATE devices
    SET status = ?
    WHERE id = ?
  `).run('registered', id);
}

function closeDatabase() {
  if (db.open) {
    db.close();
  }
}

module.exports = {
  db,
  registerDevice,
  recordEvent,
  listDevices,
  listEvents,
  markOffline,
  closeDatabase
};
