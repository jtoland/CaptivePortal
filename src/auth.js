// Signed-cookie admin sessions (no server-side store needed).
// A session is tied to the account's session_version, so password resets, 2FA changes and disabling an account
// sign that person out everywhere.
const crypto = require('crypto');
const { getSetting } = require('./db');

const COOKIE = 'cp_admin';
const PENDING = 'cp_2fa'; // password accepted, waiting for the 2FA code
// Plain-HTTP sessions use their own cookie names: browsers won't let an http:// page replace a Secure cookie set earlier
// over https://, which would otherwise trap the admin in a sign-in loop whenever HTTPS goes away.
const name = (req, base) => (req && req.secure ? base : `${base}_http`);
const MAX_AGE = 12 * 3600;

function secret() { return getSetting('session_secret'); }
function sign(v) { return crypto.createHmac('sha256', secret()).update(v).digest('base64url'); }
function safeEq(a, b) { return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieStr(name, value, maxAge, req) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req && req.secure ? '; Secure' : ''}`;
}
function addCookie(res, str) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [].concat(prev || [], str));
}

function issue(res, user, req) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const csrf = crypto.randomBytes(16).toString('base64url');
  const payload = `${user.id}.${user.session_version || 1}.${exp}.${csrf}`;
  addCookie(res, cookieStr(name(req, COOKIE), `${payload}.${sign(payload)}`, MAX_AGE, req));
  addCookie(res, cookieStr(name(req, PENDING), '', 0, req));
}

function clear(res, req) {
  for (const n of [name(req, COOKIE), name(req, PENDING)]) addCookie(res, cookieStr(n, '', 0, req));
}

function session(req) {
  const raw = parseCookies(req)[name(req, COOKIE)];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 5) return null;
  const [id, ver, exp, csrf, sig] = parts;
  if (!safeEq(sig, sign(`${id}.${ver}.${exp}.${csrf}`))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return { adminId: Number(id), ver: Number(ver), csrf };
}

// ----- pending 2FA step -----
function issuePending(res, user, req) {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const payload = `${user.id}.${user.session_version || 1}.${exp}`;
  addCookie(res, cookieStr(name(req, PENDING), `${payload}.${sign('2fa:' + payload)}`, 300, req));
}
function pending(req) {
  const raw = parseCookies(req)[name(req, PENDING)];
  if (!raw) return null;
  const [id, ver, exp, sig] = raw.split('.');
  if (!sig || !safeEq(sig, sign(`2fa:${id}.${ver}.${exp}`)) || Number(exp) < Date.now() / 1000) return null;
  return { adminId: Number(id), ver: Number(ver) };
}

/** Load the signed-in, still-valid account for this request (or null). */
function currentUser(req) {
  const s = session(req);
  if (!s) return null;
  const accounts = require('./accounts');
  const u = accounts.get(s.adminId);
  if (!u || u.disabled || (u.session_version || 1) !== s.ver) return null;
  return { user: u, session: s };
}
const isAdmin = (req) => !!currentUser(req);

// Pages a signed-in user can still reach while a required step (new password / 2FA setup) is outstanding.
const SETUP_PATHS = ['/account/password', '/account/2fa/setup', '/logout'];

function requireAdmin(req, res, next) {
  const cur = currentUser(req);
  if (!cur) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
    return res.redirect('/admin/login');
  }
  req.admin = { adminId: cur.user.id, csrf: cur.session.csrf };
  req.user = cur.user;
  res.locals.csrf = cur.session.csrf;
  res.locals.me = cur.user;
  // CSRF: every state-changing admin request must echo the token (form field or header).
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    // File-upload forms aren't parsed yet at this point, so they carry the token in the form's URL instead.
    const multipart = /^multipart\/form-data/i.test(req.get('content-type') || '');
    const token = req.get('x-csrf-token') || req.body?._csrf || (multipart ? req.query._csrf : undefined);
    if (token !== cur.session.csrf) return res.status(403).send('Invalid CSRF token - reload the page and try again.');
  }
  // Required steps first: choose own password, then set up two-factor if this account needs it.
  const accounts = require('./accounts');
  if (!SETUP_PATHS.includes(req.path)) {
    if (cur.user.must_change_password) return res.redirect('/admin/account/password');
    if (accounts.needs2fa(cur.user) && !cur.user.totp_enabled) return res.redirect('/admin/account/2fa/setup');
  }
  next();
}

module.exports = { issue, clear, session, isAdmin, requireAdmin, issuePending, pending, currentUser };
