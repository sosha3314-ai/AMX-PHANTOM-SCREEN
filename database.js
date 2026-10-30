const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'phantom.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
`);

const upsertDevice = db.prepare(`
  INSERT INTO devices (id, name, first_registered_at, last_connected_at, sessions, status)
  VALUES (@id, @name, @now, @now, 1, 'registered')
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    last_connected_at = excluded.last_connected_at,
    sessions = devices.sessions + 1,
    status = 'registered'
`);
const eventInsert = db.prepare(`
  INSERT INTO events (device_id, device_name, event_type, created_at)
  VALUES (?, ?, ?, ?)
`);

function registerDevice({ id, name }) {
  const now = new Date().toISOString();
  upsertDevice.run({ id, name, now });
  eventInsert.run(id, name, 'connected', now);
}
function recordEvent(id, name, type) {
  eventInsert.run(id || null, name || null, type, new Date().toISOString());
}
function listDevices() {
  return db.prepare('SELECT * FROM devices ORDER BY last_connected_at DESC').all();
}
function listEvents(limit = 100) {
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}
function markOffline(id) {
  db.prepare('UPDATE devices SET status = ? WHERE id = ?').run('registered', id);
}
module.exports = { db, registerDevice, recordEvent, listDevices, listEvents, markOffline };
