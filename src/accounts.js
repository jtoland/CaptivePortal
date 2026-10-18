// Admin accounts: auto-generated passwords, two-factor (TOTP + recovery codes), and account management rules.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, getSetting, setSetting } = require('./db');
const totp = require('./totp');

const now = () => Math.floor(Date.now() / 1000);

// Readable, strong passwords: 4 groups of 4 from an alphabet without look-alikes (≈ 92 bits of entropy).
const PW_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generatePassword() {
  const bytes = crypto.randomBytes(64);
  let out = '';
  for (let i = 0, n = 0; n < 16; i++) {
    const b = bytes[i];
    if (b >= 256 - (256 % PW_ALPHABET.length)) continue; // avoid modulo bias
    out += PW_ALPHABET[b % PW_ALPHABET.length];
    n++;
  }
  return out.match(/.{4}/g).join('-');
}

const security = () => ({ require_2fa: false, ...getSetting('security', {}) });
function setSecurity(next) { setSetting('security', { ...security(), ...next }); }

const get = (id) => db.prepare('SELECT * FROM admins WHERE id = ?').get(id) || null;
const byUsername = (u) => db.prepare('SELECT * FROM admins WHERE username = ? COLLATE NOCASE').get(String(u || '').trim()) || null;
const all = () => db.prepare('SELECT * FROM admins ORDER BY username COLLATE NOCASE').all();
const activeCount = () => db.prepare('SELECT COUNT(*) n FROM admins WHERE disabled = 0').get().n;

/** Must this account have 2FA (because of the global rule or its own flag)? */
const needs2fa = (u) => !!(u && (security().require_2fa || u.require_2fa));

function validUsername(u) { return /^[a-zA-Z0-9._@-]{3,64}$/.test(u); }

function create({ username, displayName, require2fa, mustChange }) {
  username = String(username || '').trim();
  if (!validUsername(username)) throw new Error('Username must be 3–64 characters: letters, numbers, dot, dash, underscore or @.');
  if (byUsername(username)) throw new Error(`The username "${username}" is already taken.`);
  const password = generatePassword();
  db.prepare(`INSERT INTO admins(username, password_hash, display_name, require_2fa, must_change_password, created_at)
    VALUES(?,?,?,?,?,?)`).run(username, bcrypt.hashSync(password, 10), String(displayName || '').trim(), require2fa ? 1 : 0, mustChange ? 1 : 0, now());
  return { user: byUsername(username), password };
}

function resetPassword(id, { mustChange = true } = {}) {
  const password = generatePassword();
  db.prepare('UPDATE admins SET password_hash = ?, must_change_password = ?, session_version = session_version + 1 WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), mustChange ? 1 : 0, id);
  return password;
}

function setOwnPassword(id, password) {
  if (String(password).length < 10) throw new Error('Choose a password of at least 10 characters.');
  db.prepare('UPDATE admins SET password_hash = ?, must_change_password = 0, session_version = session_version + 1 WHERE id = ?')
    .run(bcrypt.hashSync(String(password), 10), id);
}

const checkPassword = (u, password) => !!(u && bcrypt.compareSync(String(password || ''), u.password_hash));

// ---------- two-factor ----------
const hashCode = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
  return { codes, hashes: codes.map(hashCode) };
}

/** Finish 2FA setup: the code must match the pending secret. Returns fresh recovery codes to show once. */
function enable2fa(id, secret, code) {
  const counter = totp.verify(secret, code);
  if (!counter) throw new Error('That code didn’t match. Check the time on your phone is correct and try the newest code.');
  const { codes, hashes } = newRecoveryCodes();
  db.prepare('UPDATE admins SET totp_secret = ?, totp_enabled = 1, totp_last = ?, recovery_codes = ?, session_version = session_version + 1 WHERE id = ?')
    .run(secret, counter, JSON.stringify(hashes), id);
  return codes;
}

function disable2fa(id) {
  db.prepare("UPDATE admins SET totp_secret = NULL, totp_enabled = 0, totp_last = 0, recovery_codes = '[]', session_version = session_version + 1 WHERE id = ?").run(id);
}

function regenerateRecoveryCodes(id) {
  const { codes, hashes } = newRecoveryCodes();
  db.prepare('UPDATE admins SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), id);
  return codes;
}

/** Check a sign-in code: a 6-digit authenticator code, or a one-time recovery code (which is then used up). */
function verifySecondFactor(u, input) {
  const raw = String(input || '').trim();
  if (/^\d[\d\s]{5,7}$/.test(raw)) {
    const counter = totp.verify(u.totp_secret, raw, u.totp_last);
    if (!counter) return null;
    db.prepare('UPDATE admins SET totp_last = ? WHERE id = ?').run(counter, u.id);
    return 'totp';
  }
  const hashes = JSON.parse(u.recovery_codes || '[]');
  const h = hashCode(raw);
  const i = hashes.indexOf(h);
  if (i < 0) return null;
  hashes.splice(i, 1);
  db.prepare('UPDATE admins SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), u.id);
  return 'recovery';
}

const recoveryLeft = (u) => JSON.parse(u.recovery_codes || '[]').length;

// ---------- management (with guard rails) ----------
function update(id, fields) {
  const allowed = ['display_name', 'require_2fa', 'disabled'];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return;
  db.prepare(`UPDATE admins SET ${sets.map((k) => `${k} = @${k}`).join(', ')}${'disabled' in fields ? ', session_version = session_version + 1' : ''} WHERE id = @id`)
    .run({ ...fields, id });
}

function remove(id) { db.prepare('DELETE FROM admins WHERE id = ?').run(id); }

function touchLogin(id) { db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(now(), id); }

module.exports = {
  generatePassword, security, setSecurity, get, byUsername, all, activeCount, needs2fa, create, resetPassword, setOwnPassword,
  checkPassword, enable2fa, disable2fa, regenerateRecoveryCodes, verifySecondFactor, recoveryLeft, update, remove, touchLogin,
};
