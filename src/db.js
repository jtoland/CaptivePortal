const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const defaults = require('./defaults');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

// A restore stages the database here and restarts the portal; swap it in before anything opens the live file.
const DB_FILE = path.join(DATA_DIR, 'portal.db');
if (fs.existsSync(`${DB_FILE}.restore`)) {
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(DB_FILE + ext)) fs.unlinkSync(DB_FILE + ext);
  fs.renameSync(`${DB_FILE}.restore`, DB_FILE);
  console.log('[restore] database restored from backup');
}
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ssids TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  methods TEXT NOT NULL DEFAULT '{}',
  options TEXT NOT NULL DEFAULT '{}',
  design_html TEXT NOT NULL DEFAULT '',
  design_css TEXT NOT NULL DEFAULT '',
  design_project TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  minutes INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  data_mb INTEGER NOT NULL DEFAULT 0,
  up_kbps INTEGER NOT NULL DEFAULT 0,
  down_kbps INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  batch TEXT NOT NULL DEFAULT '',
  valid_until INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  first_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS guest_ctx (
  id TEXT PRIMARY KEY,
  mac TEXT,
  ap TEXT,
  ssid TEXT,
  site TEXT,
  url TEXT,
  profile_id INTEGER,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  ctx_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mac TEXT NOT NULL,
  ap TEXT,
  ssid TEXT,
  profile_id INTEGER,
  profile_name TEXT,
  method TEXT NOT NULL,
  identity TEXT,
  name TEXT,
  ip TEXT,
  minutes INTEGER,
  authorized_at INTEGER NOT NULL,
  expires_at INTEGER,
  marketing INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  unifi_ok INTEGER NOT NULL DEFAULT 1,
  unifi_msg TEXT
);
CREATE TABLE IF NOT EXISTS grace (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mac TEXT NOT NULL,
  ip TEXT,
  ctx_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_grace_mac ON grace(mac);
CREATE INDEX IF NOT EXISTS idx_sessions_mac ON sessions(mac);
CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(authorized_at);
`);

// ---------- migrations ----------
const profileCols = db.prepare('PRAGMA table_info(profiles)').all().map((c) => c.name);
if (!profileCols.includes('auto_created')) db.exec('ALTER TABLE profiles ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0');
const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
for (const col of ['device_name', 'device_vendor', 'user_agent']) if (!sessionCols.includes(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);

db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read',
  created_at INTEGER NOT NULL,
  created_by TEXT,
  last_used_at INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0
)`);
const adminCols = db.prepare('PRAGMA table_info(admins)').all().map((c) => c.name);
for (const [col, def] of Object.entries({
  display_name: "TEXT NOT NULL DEFAULT ''",
  totp_secret: 'TEXT',
  totp_enabled: 'INTEGER NOT NULL DEFAULT 0',
  totp_last: 'INTEGER NOT NULL DEFAULT 0',
  recovery_codes: "TEXT NOT NULL DEFAULT '[]'",
  require_2fa: 'INTEGER NOT NULL DEFAULT 0',
  must_change_password: 'INTEGER NOT NULL DEFAULT 0',
  disabled: 'INTEGER NOT NULL DEFAULT 0',
  session_version: 'INTEGER NOT NULL DEFAULT 1',
  created_at: 'INTEGER',
  last_login_at: 'INTEGER',
})) if (!adminCols.includes(col)) db.exec(`ALTER TABLE admins ADD COLUMN ${col} ${def}`);

// ---------- settings ----------
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------- profiles ----------
function hydrateProfile(row) {
  if (!row) return null;
  return {
    ...row,
    methods: { ...defaults.methods(), ...safeJson(row.methods, {}) },
    options: { ...defaults.options(), ...safeJson(row.options, {}) },
    ssidList: row.ssids.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

const profiles = {
  all: () => db.prepare('SELECT * FROM profiles ORDER BY is_default DESC, name').all().map(hydrateProfile),
  get: (id) => hydrateProfile(db.prepare('SELECT * FROM profiles WHERE id = ?').get(id)),
  forSsid(ssid) {
    const all = profiles.all().filter((p) => p.enabled);
    if (ssid) {
      const s = ssid.toLowerCase();
      const match = all.find((p) => p.ssidList.some((x) => x.toLowerCase() === s));
      if (match) return match;
    }
    return all.find((p) => p.is_default) || all[0] || null;
  },
  create(p) {
    const info = db.prepare(`INSERT INTO profiles(name, ssids, is_default, enabled, methods, options, design_html, design_css, design_project, auto_created)
      VALUES(@name, @ssids, @is_default, 1, @methods, @options, @design_html, @design_css, @design_project, @auto_created)`).run({
      design_project: p.design_project || null,
      auto_created: p.auto_created ? 1 : 0,
      name: p.name,
      ssids: p.ssids || '',
      is_default: p.is_default ? 1 : 0,
      methods: JSON.stringify(p.methods || defaults.methods()),
      options: JSON.stringify(p.options || defaults.options()),
      design_html: p.design_html ?? defaults.designHtml(p.name),
      design_css: p.design_css ?? defaults.designCss(),
    });
    return info.lastInsertRowid;
  },
  update(id, fields) {
    const cur = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    if (!cur) return;
    const next = { ...cur, ...fields };
    if (typeof next.methods !== 'string') next.methods = JSON.stringify(next.methods);
    if (typeof next.options !== 'string') next.options = JSON.stringify(next.options);
    if (fields.is_default) db.prepare('UPDATE profiles SET is_default = 0').run();
    db.prepare(`UPDATE profiles SET name=@name, ssids=@ssids, is_default=@is_default, enabled=@enabled, methods=@methods,
      options=@options, design_html=@design_html, design_css=@design_css, design_project=@design_project,
      updated_at=strftime('%s','now') WHERE id=@id`).run({ ...next, id });
  },
  remove: (id) => db.prepare('DELETE FROM profiles WHERE id = ?').run(id),
};

// ---------- first run seeding ----------
// Public HTTPS address of the portal: set on the Settings page, falling back to the PUBLIC_URL env var.
function publicUrl() {
  return String(getSetting('public_url', '') || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
}

function seed() {
  if (!getSetting('session_secret')) setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
  if (!getSetting('unifi')) setSetting('unifi', defaults.unifi());
  if (!getSetting('ssid_sync')) setSetting('ssid_sync', defaults.ssidSync());

  const adminCount = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (adminCount === 0) {
    const user = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASSWORD || 'admin';
    db.prepare('INSERT INTO admins(username, password_hash) VALUES(?, ?)').run(user, bcrypt.hashSync(pass, 10));
    console.log(`[setup] created admin user "${user}"`);
  }

  const profileCount = db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n;
  if (profileCount === 0) {
    for (const p of defaults.seedProfiles()) profiles.create(p);
    console.log('[setup] created default Guest and Staff profiles');
  }
}

// ---------- housekeeping ----------
function cleanup() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM guest_ctx WHERE created_at < ?').run(now - 6 * 3600);
  db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(now - 1800);
  db.prepare('DELETE FROM grace WHERE started_at < ?').run(now - 7 * 86400);
}

module.exports = { db, DATA_DIR, getSetting, setSetting, profiles, seed, cleanup, publicUrl };
