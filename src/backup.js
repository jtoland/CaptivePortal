// Backups of everything (database, uploaded images, HTTPS certificate) in one file, and simple restores.
//
// File format (.cpbak):  "CPBK01" | mode byte (0 = plain, 1 = encrypted) | [salt 16 | iv 12 | tag 16] | payload
// payload = gzip(JSON { format, version, created, host, counts, db (base64), files: [{ dir, name, data (base64) }] })
// Encryption: AES-256-GCM with a key derived from the password by scrypt. Downloads are always encrypted.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { db, DATA_DIR, getSetting, setSetting } = require('./db');

const MAGIC = Buffer.from('CPBK01');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const STAGING = path.join(DATA_DIR, 'restore-staging');
const DIRS = ['uploads', 'tls']; // folders inside the data directory that are included
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const now = () => Math.floor(Date.now() / 1000);
const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const config = () => ({ auto: true, keep: 14, ...getSetting('backup', {}) });
function saveConfig(c) { setSetting('backup', { auto: !!c.auto, keep: Math.min(90, Math.max(1, parseInt(c.keep, 10) || 14)) }); }

function counts(database) {
  const n = (t) => { try { return database.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return 0; } };
  return { profiles: n('profiles'), vouchers: n('vouchers'), sessions: n('sessions'), admins: n('admins') };
}

// ---------- creating ----------
async function snapshot() {
  const tmp = path.join(BACKUP_DIR, `.snapshot-${process.pid}-${Date.now()}.db`);
  await db.backup(tmp); // consistent copy even while the portal is busy
  const dbBuf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  const files = [];
  for (const dir of DIRS) {
    const full = path.join(DATA_DIR, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      const f = path.join(full, name);
      if (fs.statSync(f).isFile()) files.push({ dir, name, data: fs.readFileSync(f).toString('base64') });
    }
  }
  const { publicUrl } = require('./db');
  const doc = {
    format: 'captive-portal-backup', version: 1, created: now(), host: publicUrl() || null,
    counts: { ...counts(db), uploads: files.filter((f) => f.dir === 'uploads').length, certificate: files.some((f) => f.dir === 'tls' && f.name === 'cert.pem') },
    db: dbBuf.toString('base64'), files,
  };
  return zlib.gzipSync(Buffer.from(JSON.stringify(doc)));
}

function seal(payload, password) {
  if (!password) return Buffer.concat([MAGIC, Buffer.from([0]), payload]);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(password), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(payload), c.final()]);
  return Buffer.concat([MAGIC, Buffer.from([1]), salt, iv, c.getAuthTag(), enc]);
}

function open(buf, password) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 6).equals(MAGIC)) throw new Error('This isn’t a Captive Portal backup file.');
  const mode = buf[6];
  let payload;
  if (mode === 0) payload = buf.subarray(7);
  else if (mode === 1) {
    if (!password) { const e = new Error('This backup is encrypted. Enter its password.'); e.needsPassword = true; throw e; }
    const salt = buf.subarray(7, 23); const iv = buf.subarray(23, 35); const tag = buf.subarray(35, 51);
    const key = crypto.scryptSync(String(password), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      payload = Buffer.concat([d.update(buf.subarray(51)), d.final()]);
    } catch { const e = new Error('Wrong password, or the file is damaged.'); e.needsPassword = true; throw e; }
  } else throw new Error('Unknown backup format.');
  let doc;
  try { doc = JSON.parse(zlib.gunzipSync(payload).toString('utf8')); } catch { throw new Error('The backup file is damaged.'); }
  if (doc.format !== 'captive-portal-backup' || !doc.db) throw new Error('This isn’t a Captive Portal backup file.');
  if (doc.version > 1) throw new Error('This backup was made by a newer version of the portal. Update the portal first.');
  return doc;
}

/** Re-package a plain server backup as an encrypted download. */
function encryptCopy(buf, password) {
  open(buf); // validates it
  return seal(buf.subarray(7), password);
}

/** Make a backup. password → encrypted (for downloads); without → plain (automatic backups kept on this server). */
async function create(password) { return seal(await snapshot(), password); }

// ---------- automatic backups on this server ----------
const isBackupName = (n) => /^(auto|manual|pre-restore)-\d{8}-\d{4}(-\d+)?\.cpbak$/.test(n);
function list() {
  return fs.readdirSync(BACKUP_DIR).filter(isBackupName).map((name) => {
    const st = fs.statSync(path.join(BACKUP_DIR, name));
    return { name, kind: name.split('-')[0].replace('pre', 'pre-restore'), size: st.size, at: Math.floor(st.mtimeMs / 1000) };
  }).sort((a, b) => b.at - a.at);
}
function filePath(name) {
  if (!isBackupName(name)) throw new Error('Unknown backup.');
  const p = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(p)) throw new Error('That backup no longer exists.');
  return p;
}
async function saveLocal(kind) {
  let name = `${kind}-${stamp()}.cpbak`;
  for (let i = 2; fs.existsSync(path.join(BACKUP_DIR, name)); i++) name = `${kind}-${stamp()}-${i}.cpbak`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), await create(null), { mode: 0o600 });
  prune();
  return name;
}
function prune() {
  const keep = config().keep;
  for (const kind of ['auto', 'manual', 'pre']) {
    list().filter((b) => b.name.startsWith(kind)).slice(kind === 'auto' ? keep : 10).forEach((b) => fs.unlinkSync(path.join(BACKUP_DIR, b.name)));
  }
}
function remove(name) { fs.unlinkSync(filePath(name)); }

function startSchedule() {
  const tick = async () => {
    try {
      if (!config().auto) return;
      const last = list().find((b) => b.name.startsWith('auto-'));
      if (last && now() - last.at < 23 * 3600) return;
      const name = await saveLocal('auto');
      console.log(`[backup] automatic backup ${name}`);
    } catch (e) { console.error('[backup] automatic backup failed:', e.message); }
  };
  setTimeout(tick, 5 * 60_000).unref();
  setInterval(tick, 3600_000).unref(); // checks hourly, runs once a day
}

// ---------- restoring ----------
/** Check a backup and stage it. Returns a summary for the confirmation screen. */
function stage(buf, password) {
  const doc = open(buf, password);
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  const dbPath = path.join(STAGING, 'portal.db');
  fs.writeFileSync(dbPath, Buffer.from(doc.db, 'base64'));
  let summary;
  try {
    const test = new Database(dbPath, { readonly: true, fileMustExist: true });
    const ok = test.pragma('integrity_check', { simple: true });
    summary = { ...counts(test), admins_list: test.prepare('SELECT username FROM admins ORDER BY username').all().map((r) => r.username) };
    test.close();
    if (ok !== 'ok') throw new Error('integrity');
  } catch {
    fs.rmSync(STAGING, { recursive: true, force: true });
    throw new Error('The database inside this backup is damaged.');
  }
  for (const f of doc.files || []) {
    if (!DIRS.includes(f.dir) || f.name.includes('/') || f.name.includes('\\') || f.name.startsWith('.')) continue; // never write outside the data folders
    fs.mkdirSync(path.join(STAGING, f.dir), { recursive: true });
    fs.writeFileSync(path.join(STAGING, f.dir, f.name), Buffer.from(f.data, 'base64'));
  }
  const token = crypto.randomBytes(16).toString('hex');
  const info = { token, created: doc.created, host: doc.host, counts: { ...doc.counts, ...summary }, staged_at: now() };
  fs.writeFileSync(path.join(STAGING, 'info.json'), JSON.stringify(info));
  return info;
}
function staged() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(STAGING, 'info.json'), 'utf8'));
    return now() - info.staged_at < 3600 ? info : null;
  } catch { return null; }
}
function cancelStage() { fs.rmSync(STAGING, { recursive: true, force: true }); }

/** Apply the staged restore: safety backup first, then files, then the database on restart. */
async function apply(token) {
  const info = staged();
  if (!info || info.token !== token) throw new Error('That restore has expired. Upload the backup again.');
  const safety = await saveLocal('pre-restore');
  for (const dir of DIRS) {
    const from = path.join(STAGING, dir);
    const to = path.join(DATA_DIR, dir);
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(to)) { const f = path.join(to, name); if (fs.statSync(f).isFile()) fs.unlinkSync(f); }
    if (fs.existsSync(from)) for (const name of fs.readdirSync(from)) fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
  fs.copyFileSync(path.join(STAGING, 'portal.db'), path.join(DATA_DIR, 'portal.db.restore'));
  cancelStage();
  console.log(`[restore] applying backup from ${new Date(info.created * 1000).toISOString()} (safety backup: ${safety}); restarting`);
  // Restart so the database is swapped in cleanly before anything opens it (Docker restarts the container).
  setTimeout(() => process.exit(0), 800);
  return { safety };
}

module.exports = { config, saveConfig, create, open, encryptCopy, list, filePath, saveLocal, remove, startSchedule, stage, staged, cancelStage, apply, BACKUP_DIR };
