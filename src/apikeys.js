// API keys for the vouchers API. Tokens are high-entropy random strings; we store only their SHA-256 hash.
const crypto = require('crypto');
const { db } = require('./db');

const now = () => Math.floor(Date.now() / 1000);
const PREFIX = 'cpk_';
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function create({ label, scope, createdBy }) {
  const secret = crypto.randomBytes(24).toString('base64url'); // ~192 bits
  const token = `${PREFIX}${secret}`;
  const info = db.prepare('INSERT INTO api_keys(label, prefix, token_hash, scope, created_at, created_by) VALUES(?,?,?,?,?,?)')
    .run(String(label || '').trim().slice(0, 80), token.slice(0, 12), hash(token), scope === 'write' ? 'write' : 'read', now(), String(createdBy || ''));
  return { id: info.lastInsertRowid, token };
}

const all = () => db.prepare('SELECT * FROM api_keys ORDER BY id DESC').all();
const remove = (id) => db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
function setDisabled(id, disabled) { db.prepare('UPDATE api_keys SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id); }

/** Look up a presented token. Returns the key row (and records usage) or null. */
function verify(token) {
  if (!token || !String(token).startsWith(PREFIX)) return null;
  const row = db.prepare('SELECT * FROM api_keys WHERE token_hash = ? AND disabled = 0').get(hash(token));
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ?, uses = uses + 1 WHERE id = ?').run(now(), row.id);
  return row;
}

module.exports = { create, all, remove, setDisabled, verify, PREFIX };
