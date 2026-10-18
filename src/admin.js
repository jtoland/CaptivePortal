// Admin dashboard routes (/admin).
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const { db, DATA_DIR, getSetting, setSetting, profiles, publicUrl } = require('./db');
const auth = require('./auth');
const unifi = require('./unifi');
const sso = require('./sso');
const defaults = require('./defaults');
const templates = require('./templates');
const ssidSync = require('./ssidsync');
const tls = require('./tls');

const router = express.Router();
const now = () => Math.floor(Date.now() / 1000);

// The extension comes from the (allow-listed) file type, never from the uploaded file name.
const UPLOAD_TYPES = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm',
};
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'uploads'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${UPLOAD_TYPES[file.mimetype]}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, Object.prototype.hasOwnProperty.call(UPLOAD_TYPES, file.mimetype)),
});

// ---------- who may reach the admin at all ----------
// Hotspot devices (guests on the portal SSIDs) are refused, as UniFi tells us which clients are guests. An optional
// allow-list of networks overrides that. ADMIN_ALLOW_ALL=1 in .env is the emergency way back in.
const unifiClient = require('./unifi');
const tlsMod = require('./tls');
const adminAccess = () => ({ block_guests: true, allowed: '', ...getSetting('admin_access', {}) });
const plainIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
function ip4ToInt(ip) { const p = ip.split('.').map(Number); return p.length === 4 && p.every((n) => n >= 0 && n <= 255) ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : null; }
function parseNetworks(text) {
  return String(text || '').split(/[\s,]+/).filter(Boolean).map((entry) => {
    const [addr, bitsRaw] = entry.split('/');
    const base = ip4ToInt(addr);
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return { entry, invalid: true };
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return { entry, base: (base & mask) >>> 0, mask };
  });
}
function inNetworks(ip, nets) {
  const n = ip4ToInt(plainIp(ip));
  return n !== null && nets.some((x) => !x.invalid && ((n & x.mask) >>> 0) === x.base);
}
const isLocal = (ip) => /^(127\.|::1$)/.test(plainIp(ip));

async function adminAllowed(req) {
  if (process.env.ADMIN_ALLOW_ALL === '1' || isLocal(req.ip)) return { ok: true };
  const cfg = adminAccess();
  const nets = parseNetworks(cfg.allowed).filter((x) => !x.invalid);
  if (nets.length) return inNetworks(req.ip, nets) ? { ok: true } : { ok: false, why: 'network' };
  if (cfg.block_guests) {
    try {
      const client = await unifiClient.withTimeout(unifiClient.clientByIp(plainIp(req.ip)));
      if (client && client.is_guest) return { ok: false, why: 'guest' };
    } catch (e) { /* controller unreachable: don't lock admins out */ }
  }
  return { ok: true };
}

router.use(async (req, res, next) => {
  try {
    const a = await adminAllowed(req);
    if (!a.ok) {
      return res.status(403).render('portal/message', {
        title: 'Admin not available here',
        message: a.why === 'guest' ? 'The admin can’t be opened from the guest WiFi. Use a device on your staff or office network.' : 'The admin can’t be opened from this network.',
        link: null,
      });
    }
    // Once HTTPS is set up, keep admin traffic (passwords, session cookies) encrypted.
    if (!req.secure && process.env.ADMIN_ALLOW_HTTP !== '1' && tlsMod.isActive() && !isLocal(req.ip)) {
      return res.redirect(302, publicUrl() + req.originalUrl);
    }
    next();
  } catch (e) { next(e); }
});

// ---------- login (password, then 2FA code if the account has it) ----------
const accounts = require('./accounts');
const loginFailures = new Map();
function limited(key, max = 10) {
  const f = loginFailures.get(key);
  return f && f.n >= max && Date.now() - f.t < 15 * 60_000;
}
function fail(key) {
  const f = loginFailures.get(key);
  loginFailures.set(key, !f || Date.now() - f.t > 15 * 60_000 ? { n: 1, t: Date.now() } : { n: f.n + 1, t: f.t });
}
// Drop stale entries so the failure map can't grow without bound.
setInterval(() => { for (const [k, f] of loginFailures) if (Date.now() - f.t > 15 * 60_000) loginFailures.delete(k); }, 5 * 60_000).unref();

router.get('/login', (req, res) => {
  if (auth.isAdmin(req)) return res.redirect('/admin');
  res.render('admin/login', { error: '' });
});
router.post('/login', (req, res) => {
  const key = `pw:${req.ip}`;
  if (limited(key)) return res.status(429).render('admin/login', { error: 'Too many attempts. Try again in 15 minutes.' });
  const user = accounts.byUsername(req.body.username);
  if (!user || !accounts.checkPassword(user, req.body.password)) {
    fail(key);
    return res.status(401).render('admin/login', { error: 'Invalid username or password.' });
  }
  if (user.disabled) return res.status(403).render('admin/login', { error: 'This account has been disabled. Ask another admin to re-enable it.' });
  loginFailures.delete(key);
  if (user.totp_enabled) {
    auth.issuePending(res, user, req);
    return res.redirect('/admin/login/2fa');
  }
  accounts.touchLogin(user.id);
  auth.issue(res, user, req);
  res.redirect('/admin');
});

router.get('/login/2fa', (req, res) => {
  if (!auth.pending(req)) return res.redirect('/admin/login');
  res.render('admin/login-2fa', { error: '' });
});
router.post('/login/2fa', (req, res) => {
  const p = auth.pending(req);
  if (!p) return res.redirect('/admin/login');
  const user = accounts.get(p.adminId);
  if (!user || user.disabled || user.session_version !== p.ver || !user.totp_enabled) return res.redirect('/admin/login');
  const key = `2fa:${user.id}`;
  if (limited(key, 6)) return res.status(429).render('admin/login-2fa', { error: 'Too many wrong codes. Wait 15 minutes, or ask another admin to reset your two-factor.' });
  const how = accounts.verifySecondFactor(user, req.body.code);
  if (!how) { fail(key); return res.status(401).render('admin/login-2fa', { error: 'That code isn’t right. Use the newest code from your authenticator app, or one of your recovery codes.' }); }
  loginFailures.delete(key);
  accounts.touchLogin(user.id);
  auth.issue(res, accounts.get(user.id), req);
  const left = accounts.recoveryLeft(accounts.get(user.id));
  res.redirect(how === 'recovery' ? `/admin/account?msg=${encodeURIComponent(`Signed in with a recovery code. You have ${left} left.${left <= 3 ? ' Generate new ones below.' : ''}`)}` : '/admin');
});

router.use(auth.requireAdmin);

router.use((req, res, next) => {
  res.locals.path = req.originalUrl;
  res.locals.flash = req.query.msg || '';
  res.locals.flashErr = req.query.err || '';
  res.locals.METHOD_LABELS = defaults.METHOD_LABELS;
  res.locals.METHOD_KEYS = defaults.METHOD_KEYS;
  res.locals.ssoProviders = sso.list();
  res.locals.ssoConfigured = (p) => sso.isConfigured(typeof p === 'string' ? sso.get(p) : p);
  res.locals.ssoName = (p) => sso.adminName(p);
  res.locals.SSO_TYPES = sso.TYPES;
  res.locals.tenantPinned = (p) => sso.tenantPinned(p);
  // Label for a method key: a built-in method, an SSO provider instance, or (if since deleted) the raw key.
  res.locals.methodLabel = (k) => {
    const short = { click: 'Click-through', email: 'Email', password: 'Password', voucher: 'Voucher', grace: 'Sign-in grace' };
    if (short[k]) return short[k];
    const prov = sso.get(k);
    if (prov) return sso.adminName(prov);
    const type = sso.TYPES[k.split('-')[0]];
    return type ? type.label : k;
  };
  res.locals.fmtTime = (t) => (t ? new Date(t * 1000).toLocaleString('en-GB') : '');
  res.locals.fmtAgo = (t) => {
    const d = Math.floor(Date.now() / 1000) - t;
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)} min ago`;
    if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
    return new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };
  const ic = require('./icons');
  res.locals.icon = ic.icon;
  res.locals.methodIcon = ic.methodIcon;
  next();
});

function back(res, url, msg, err) {
  const [pathPart, hash] = url.split('#');
  const q = [msg && 'msg=' + encodeURIComponent(msg), err && 'err=' + encodeURIComponent(err)].filter(Boolean).join('&');
  res.redirect(303, `${pathPart}${q ? (pathPart.includes('?') ? '&' : '?') + q : ''}${hash ? '#' + hash : ''}`);
}

router.post('/logout', (req, res) => { auth.clear(res, req); res.redirect('/admin/login'); });

// ---------- dashboard ----------
router.get('/', async (req, res, next) => { try {
  const t = now();
  const stats = {
    active: db.prepare('SELECT COUNT(DISTINCT mac) n FROM sessions WHERE revoked = 0 AND unifi_ok = 1 AND expires_at > ?').get(t).n,
    today: db.prepare('SELECT COUNT(*) n FROM sessions WHERE authorized_at > ?').get(t - 86400).n,
    vouchers: db.prepare('SELECT COUNT(*) n FROM vouchers WHERE enabled = 1 AND (max_uses = 0 OR uses < max_uses) AND (valid_until IS NULL OR valid_until > ?)').get(t).n,
    failed: db.prepare('SELECT COUNT(*) n FROM sessions WHERE unifi_ok = 0 AND authorized_at > ?').get(t - 86400).n,
  };
  const byMethod = db.prepare('SELECT method, COUNT(*) n FROM sessions WHERE authorized_at > ? GROUP BY method ORDER BY n DESC').all(t - 7 * 86400);
  const recent = await enrichSessions(db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 10').all());
  res.render('admin/dashboard', { cert: tls.certInfo(), tlsPending: tls.pending(), tlsJob: tls.job(), publicUrl: publicUrl(), stats, byMethod, recent, profiles: profiles.all(), unifiCfg: getSetting('unifi', {}), wlans: getSetting('wlans', null), syncCfg: ssidSync.config() });
} catch (e) { next(e); } });

// ---------- profiles ----------
router.get('/profiles/new', (req, res) => {
  const p = { id: null, name: '', ssids: '', is_default: 0, enabled: 1, methods: defaults.methods(), options: defaults.options() };
  res.render('admin/profile', { p });
});

function profileFromForm(body, existing) {
  const methods = {};
  for (const k of defaults.METHOD_KEYS) {
    methods[k] = { ...(existing?.methods?.[k] || defaults.methods()[k]), enabled: body[`m_${k}`] === 'on' };
  }
  for (const prov of sso.list()) methods[prov.id] = { enabled: body[`m_${prov.id}`] === 'on' };
  methods.click.button_text = String(body.click_button_text || 'Continue as guest');
  methods.email.require_name = body.email_require_name === 'on';
  methods.email.marketing_optin = body.email_marketing_optin === 'on';
  methods.password.password = String(body.password_value || '');
  const int = (v) => Math.max(0, parseInt(v, 10) || 0);
  const options = {
    ...(existing?.options || defaults.options()),
    minutes: Math.max(1, int(body.minutes) || 60),
    up_kbps: int(body.up_kbps),
    down_kbps: int(body.down_kbps),
    data_mb: int(body.data_mb),
    redirect_url: String(body.redirect_url || '').trim(),
    terms_enabled: body.terms_enabled === 'on',
    terms_text: String(body.terms_text || ''),
    sso_allowed_domains: String(body.sso_allowed_domains || '').trim(),
    maintenance: body.maintenance === 'on',
    maintenance_message: String(body.maintenance_message || '').trim().slice(0, 300),
    sso_grace_enabled: body.sso_grace_enabled === 'on',
    sso_grace_minutes: Math.min(30, Math.max(1, int(body.sso_grace_minutes) || 5)),
    sso_grace_kbps: int(body.sso_grace_kbps),
    sso_grace_cooldown: Math.min(1440, int(body.sso_grace_cooldown)),
    accent: /^#[0-9a-f]{3,8}$/i.test(body.accent || '') ? body.accent : '#4f46e5',
    widget_theme: body.widget_theme === 'dark' ? 'dark' : 'light',
    terms_mode: body.terms_mode === 'checkbox' ? 'checkbox' : 'implied',
    success_message: String(body.success_message || ''),
  };
  return {
    name: String(body.name || 'Untitled').trim(),
    ssids: String(body.ssids || '').split(',').map((s) => s.trim()).filter(Boolean).join(', '),
    is_default: body.is_default === 'on' ? 1 : 0,
    enabled: body.enabled === 'on' ? 1 : 0,
    methods, options,
  };
}

router.post('/profiles', (req, res) => {
  const p = profileFromForm(req.body);
  const id = profiles.create(p);
  if (p.is_default) profiles.update(id, { is_default: 1 });
  back(res, `/admin/profiles/${id}`, 'Profile created');
});

router.get('/profiles/:id', (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) return res.redirect('/admin');
  res.render('admin/profile', { p });
});

router.post('/profiles/:id', (req, res) => {
  const existing = profiles.get(req.params.id);
  if (!existing) return res.redirect('/admin');
  const p = profileFromForm(req.body, existing);
  if (!p.is_default && existing.is_default) p.is_default = 1; // there must always be a default
  profiles.update(existing.id, p);
  back(res, `/admin/profiles/${existing.id}`, 'Saved');
});

// Quick on/off switch for a single method (or the whole profile) from the dashboard.
router.post('/profiles/:id/toggle', (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const key = String(req.body.key || '');
  const on = req.body.enabled === true || req.body.enabled === 'true' || req.body.enabled === 'on';
  if (key === '_profile') {
    profiles.update(p.id, { enabled: on ? 1 : 0 });
  } else if (key === '_maintenance') {
    profiles.update(p.id, { options: { ...p.options, maintenance: on } });
  } else if (defaults.METHOD_KEYS.includes(key) || sso.get(key)) {
    p.methods[key] = { ...p.methods[key], enabled: on };
    profiles.update(p.id, { methods: p.methods });
  } else {
    return res.status(400).json({ error: 'bad key' });
  }
  if (req.is('application/json')) return res.json({ ok: true, key, enabled: on });
  back(res, req.get('referer') ? new URL(req.get('referer')).pathname : '/admin', 'Updated');
});

router.post('/profiles/:id/duplicate', (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) return res.redirect('/admin');
  const id = profiles.create({ ...p, name: `${p.name} (copy)`, ssids: '', is_default: 0 });
  profiles.update(id, { design_project: p.design_project });
  back(res, `/admin/profiles/${id}`, 'Profile duplicated - set its SSID names');
});

router.post('/profiles/:id/delete', (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) return res.redirect('/admin');
  if (p.is_default) return back(res, `/admin/profiles/${p.id}`, '', 'You cannot delete the default profile. Make another profile the default first.');
  profiles.remove(p.id);
  back(res, '/admin', 'Profile deleted');
});

// ---------- designer ----------
router.get('/profiles/:id/design', (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) return res.redirect('/admin');
  res.render('admin/designer', { p });
});

// Look settings edited from the designer's Page panel (stored on the profile, used by the login widget).
router.post('/api/profiles/:id/look', (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const { accent, widget_theme: theme } = req.body || {};
  const options = { ...p.options };
  if (/^#[0-9a-f]{6}$/i.test(accent || '')) options.accent = accent;
  if (theme === 'light' || theme === 'dark') options.widget_theme = theme;
  profiles.update(p.id, { options });
  res.json({ ok: true, accent: options.accent, widget_theme: options.widget_theme });
});

router.post('/api/profiles/:id/design', (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const { html, css, project } = req.body || {};
  if (typeof html !== 'string' || typeof css !== 'string') return res.status(400).json({ error: 'html and css required' });
  profiles.update(p.id, { design_html: html, design_css: css, design_project: project ? JSON.stringify(project) : null });
  res.json({ ok: true });
});

router.post('/api/profiles/:id/design/reset', (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  profiles.update(p.id, { design_html: defaults.designHtml(p.name), design_css: defaults.designCss(p.options.accent), design_project: null });
  res.json({ ok: true });
});

// Real login widget markup, used by the designer canvas so the Login box is WYSIWYG.
router.get('/api/profiles/:id/widget', (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) return res.status(404).send('');
  const { availableMethods } = require('./portal');
  res.render('portal/widget', { ctx: { id: 'preview' }, profile: p, preview: false, error: '', values: {}, methods: availableMethods(p) });
});

router.get('/api/templates', (req, res) => {
  res.json(templates.list().map((t) => ({ ...t, ...templates.build(t.id) })));
});

router.post('/api/profiles/:id/template', (req, res) => {
  const p = profiles.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const t = templates.list().find((x) => x.id === req.body?.id);
  if (!t) return res.status(400).json({ error: 'unknown template' });
  const accent = req.body.keepAccent ? p.options.accent : t.accent;
  const built = templates.build(t.id, { accent });
  profiles.update(p.id, {
    design_html: built.html, design_css: built.css, design_project: null,
    options: { ...p.options, accent: built.accent, widget_theme: built.widget_theme },
  });
  res.json({ ok: true });
});

router.post('/api/upload', (req, res) => {
  upload.array('files', 20)(req, res, (err) => {
    if (err) {
      const big = err.code === 'LIMIT_FILE_SIZE';
      return res.status(big ? 413 : 400).json({ error: big ? 'That image is bigger than 10 MB.' : `Upload failed: ${err.message}` });
    }
    res.json({ data: (req.files || []).map((f) => ({ src: `/uploads/${f.filename}`, name: f.originalname })) });
  });
});

router.get('/api/uploads', (req, res) => {
  const fs = require('fs');
  const dir = path.join(DATA_DIR, 'uploads');
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort().reverse();
  res.json(files.map((f) => ({ src: `/uploads/${f}` })));
});

// ---------- vouchers ----------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
const fmtCode = (c) => c.replace(/(.{4})(?=.)/g, '$1-');

router.get('/vouchers', (req, res) => {
  const batch = String(req.query.batch || '');
  const status = String(req.query.status || 'all');
  const t = now();
  let rows = batch
    ? db.prepare('SELECT * FROM vouchers WHERE batch = ? ORDER BY id DESC').all(batch)
    : db.prepare('SELECT * FROM vouchers ORDER BY id DESC LIMIT 1000').all();
  rows = rows.map((v) => {
    let st = 'unused';
    if (!v.enabled) st = 'disabled';
    else if ((v.valid_until && v.valid_until < t) || (v.first_used_at && v.first_used_at + v.minutes * 60 <= t)) st = 'expired';
    else if (v.max_uses > 0 && v.uses >= v.max_uses) st = 'used';
    else if (v.uses > 0) st = 'active';
    return { ...v, status: st, display: fmtCode(v.code) };
  }).filter((v) => status === 'all' || v.status === status);
  const batches = db.prepare("SELECT batch, COUNT(*) n, MAX(created_at) at FROM vouchers WHERE batch != '' GROUP BY batch ORDER BY at DESC LIMIT 50").all();
  res.render('admin/vouchers', { rows, batches, batch, status, profiles: profiles.all() });
});

router.post('/vouchers', (req, res) => {
  const int = (v, d = 0) => Math.max(0, parseInt(v, 10) || d);
  const count = Math.min(1000, Math.max(1, int(req.body.count, 1)));
  const len = Math.min(16, Math.max(6, int(req.body.length, 8)));
  const unit = { minutes: 1, hours: 60, days: 1440 }[req.body.duration_unit] || 1;
  const minutes = Math.max(1, int(req.body.duration, 1) * unit);
  const profileId = req.body.profile_id ? Number(req.body.profile_id) : null;
  const validDays = int(req.body.valid_days);
  const batch = String(req.body.batch || '').trim() || `Batch ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const insert = db.prepare(`INSERT OR IGNORE INTO vouchers(code, profile_id, minutes, max_uses, data_mb, up_kbps, down_kbps, note, batch, valid_until)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  let made = 0;
  db.transaction(() => {
    while (made < count) {
      const r = insert.run(newCode(len), profileId, minutes, int(req.body.max_uses, 1), int(req.body.data_mb), int(req.body.up_kbps),
        int(req.body.down_kbps), String(req.body.note || ''), batch, validDays ? now() + validDays * 86400 : null);
      made += r.changes;
    }
  })();
  back(res, `/admin/vouchers?batch=${encodeURIComponent(batch)}`, `Created ${made} voucher(s)`);
});

router.post('/vouchers/:id/toggle', (req, res) => {
  db.prepare('UPDATE vouchers SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  back(res, req.get('referer') ? new URL(req.get('referer')).pathname + new URL(req.get('referer')).search.replace(/[?&](msg|err)=[^&]*/g, '') : '/admin/vouchers', '');
});

router.post('/vouchers/:id/delete', (req, res) => {
  db.prepare('DELETE FROM vouchers WHERE id = ?').run(req.params.id);
  back(res, '/admin/vouchers', 'Voucher deleted');
});

router.post('/vouchers/delete-batch', (req, res) => {
  const r = db.prepare('DELETE FROM vouchers WHERE batch = ?').run(String(req.body.batch || ''));
  back(res, '/admin/vouchers', `Deleted ${r.changes} voucher(s)`);
});

router.get('/vouchers/print', (req, res) => {
  const batch = String(req.query.batch || '');
  const rows = db.prepare('SELECT * FROM vouchers WHERE batch = ? AND enabled = 1 ORDER BY id').all(batch)
    .map((v) => ({ ...v, display: fmtCode(v.code), profile: v.profile_id ? profiles.get(v.profile_id) : null }));
  res.render('admin/print', { rows, batch });
});

router.get('/vouchers.csv', (req, res) => {
  const batch = String(req.query.batch || '');
  const rows = batch ? db.prepare('SELECT * FROM vouchers WHERE batch = ?').all(batch) : db.prepare('SELECT * FROM vouchers').all();
  res.type('text/csv').attachment('vouchers.csv').send(toCsv(rows.map((v) => ({ ...v, code: fmtCode(v.code) }))));
});

// ---------- sessions ----------
// Add device descriptions, and live details (signal, access point, data used) for devices currently connected.
const device = require('./device');
async function enrichSessions(rows) {
  let clients = []; let aps = {};
  try { clients = (await unifiClient.withTimeout(unifiClient.listClients(), 2500)) || []; } catch { /* controller unreachable */ }
  try { aps = await unifiClient.withTimeout(unifiClient.apNames(), 2500); } catch { /* optional */ }
  const byMac = new Map(clients.map((c) => [c.mac, c]));
  return rows.map((r) => {
    const live = byMac.get(r.mac) || null;
    const agent = device.describeAgent(r.user_agent);
    return {
      ...r,
      ip: String(r.ip || '').replace(/^::ffff:/, ''),
      device: {
        name: r.device_name || (live && live.name) || null,
        vendor: r.device_vendor || (live && live.vendor) || null,
        type: agent ? agent.type : 'other',
        os: agent ? agent.label : null,
      },
      live: live && {
        ip: live.ip, ap: live.ap_mac ? (aps[live.ap_mac] || null) : null, essid: live.essid, wired: live.wired,
        signal: device.signalLabel(live.signal), dbm: live.signal,
        data: device.formatBytes((live.rx_bytes || 0) + (live.tx_bytes || 0)),
      },
    };
  });
}

router.get('/sessions', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const rows = q
      ? db.prepare(`SELECT * FROM sessions WHERE mac LIKE @q OR identity LIKE @q OR name LIKE @q OR ssid LIKE @q OR ip LIKE @q
          OR device_name LIKE @q OR device_vendor LIKE @q ORDER BY id DESC LIMIT 500`).all({ q: `%${q}%` })
      : db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 500').all();
    res.render('admin/sessions', { rows: await enrichSessions(rows), q, t: now() });
  } catch (e) { next(e); }
});

router.post('/sessions/:id/revoke', async (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!s) return back(res, '/admin/sessions', '', 'Session not found');
  try {
    await unifi.unauthorize(s.mac);
    db.prepare('UPDATE sessions SET revoked = 1, expires_at = ? WHERE mac = ? AND revoked = 0 AND expires_at > ?').run(now(), s.mac, now());
    back(res, '/admin/sessions', `Disconnected ${s.mac}`);
  } catch (e) {
    back(res, '/admin/sessions', '', e.message);
  }
});

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    let t = String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // stop spreadsheets treating guest-entered text as a formula
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

router.get('/sessions.csv', (req, res) => {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY id DESC').all().map((r) => ({
    ...r, authorized_at: new Date(r.authorized_at * 1000).toISOString(), expires_at: r.expires_at ? new Date(r.expires_at * 1000).toISOString() : '',
  }));
  res.type('text/csv').attachment('sessions.csv').send(toCsv(rows));
});

// ---------- settings ----------
router.get('/settings', (req, res) => {
  const base = sso.publicBase(req);
  res.render('admin/settings', {
    unifiCfg: getSetting('unifi', defaults.unifi()),
    publicUrl: publicUrl(),
    publicUrlFromEnv: !getSetting('public_url', '') && !!process.env.PUBLIC_URL,
    tlsCfg: tls.config(),
    backupCfg: require('./backup').config(),
    backups: require('./backup').list(),
    staged: require('./backup').staged(),
    dnsCfg: tls.dnsConfig(),
    dnsProviderList: require('./dnsproviders').PROVIDERS.map((p) => ({ id: p.id, name: p.name, help: p.help, fields: p.fields })),
    tlsJob: tls.job(),
    tlsRunning: tls.isAutoRunning(),
    adminAccess: adminAccess(),
    myIp: plainIp(req.ip),
    tlsPending: tls.pending(),
    cert: tls.certInfo(),
    tlsActive: tls.isActive(),
    callbackBase: base,
    walled: sso.walledGarden(),
    portalHost: publicUrl() ? new URL(publicUrl()).hostname : '',
    portalIp: process.env.PORTAL_IP || (/^\d+\.\d+\.\d+\.\d+$/.test(req.hostname) ? req.hostname : ''),
    testResult: req.query.test || '',
    syncCfg: ssidSync.config(),
  });
});

router.post('/settings/unifi', (req, res) => {
  const cur = getSetting('unifi', defaults.unifi());
  const b = req.body;
  const next = {
    controller_type: b.controller_type === 'standalone' ? 'standalone' : 'unifios',
    url: String(b.url || '').trim().replace(/\/+$/, ''),
    site: String(b.site || 'default').trim(),
    auth_mode: b.auth_mode === 'apikey' && b.controller_type !== 'standalone' ? 'apikey' : 'credentials',
    username: String(b.username || '').trim(),
    password: b.password ? String(b.password) : cur.password,
    api_key: b.api_key ? String(b.api_key).trim() : cur.api_key,
    verify_tls: b.verify_tls === 'on',
  };
  if (b.clear_password === 'on') next.password = '';
  if (b.clear_api_key === 'on') next.api_key = '';
  setSetting('unifi', next);
  if (b.action === 'test') return res.redirect(303, '/admin/settings/unifi/test');
  back(res, '/admin/settings', 'UniFi settings saved');
});

router.get('/settings/unifi/test', async (req, res) => {
  try {
    const msg = await unifi.testConnection();
    ssidSync.sync().catch(() => {}); // discover SSIDs straight away
    back(res, '/admin/settings#unifi', `✔ ${msg}`);
  } catch (e) {
    back(res, '/admin/settings#unifi', '', `UniFi connection failed: ${e.message}`);
  }
});

router.post('/ssids/sync', async (req, res) => {
  try {
    const r = await ssidSync.sync({ manual: true });
    if (r.skipped) return back(res, '/admin#ssids', '', `SSID sync skipped: ${r.skipped}`);
    const n = r.list.filter((w) => w.portal).length;
    back(res, '/admin#ssids', r.created.length ? `Found ${r.list.length} SSIDs. Created profiles for: ${r.created.join(', ')}` : `Found ${r.list.length} SSIDs (${n} with the portal on). Everything is matched.`);
  } catch (e) {
    back(res, '/admin#ssids', '', `SSID sync failed: ${e.message}`);
  }
});

router.post('/settings/ssid-sync', (req, res) => {
  setSetting('ssid_sync', {
    enabled: req.body.enabled === 'on',
    auto_create: req.body.auto_create === 'on',
    interval_min: Math.min(1440, Math.max(1, parseInt(req.body.interval_min, 10) || 5)),
  });
  back(res, '/admin/settings#unifi', 'SSID sync settings saved');
});

router.post('/settings/sso', (req, res) => {
  try {
    const inst = sso.create(String(req.body.type || ''), String(req.body.label || '').trim());
    back(res, `/admin/settings#sso-${inst.id}`, `${sso.TYPES[inst.type].label} provider added. Enter its credentials below.`);
  } catch (e) {
    back(res, '/admin/settings#sso', '', e.message);
  }
});

router.post('/settings/sso/:id', (req, res) => {
  const prov = sso.get(req.params.id);
  if (!prov) return back(res, '/admin/settings#sso', '', 'Unknown provider');
  const type = sso.TYPES[prov.type];
  const next = { label: String(req.body.label || '').trim() };
  for (const k of Object.keys(type.fields)) {
    const v = req.body[k];
    if (type.secrets.includes(k)) {
      if (v) next[k] = String(v).trim();
      if (req.body[`clear_${k}`] === 'on') next[k] = '';
    } else if (v !== undefined) {
      next[k] = String(v).trim();
    }
  }
  sso.update(prov.id, next);
  back(res, `/admin/settings#sso-${prov.id}`, `${sso.adminName({ ...prov, ...next })} saved`);
});

router.post('/settings/sso/:id/delete', (req, res) => {
  const prov = sso.get(req.params.id);
  if (!prov) return back(res, '/admin/settings#sso', '', 'Unknown provider');
  sso.remove(prov.id);
  // Drop it from every profile so nothing references a deleted provider.
  for (const p of profiles.all()) {
    if (p.methods[prov.id]) { delete p.methods[prov.id]; profiles.update(p.id, { methods: p.methods }); }
  }
  back(res, '/admin/settings#sso', `${sso.adminName(prov)} removed`);
});

router.post('/settings/admin-access', (req, res) => {
  const allowed = String(req.body.allowed || '').trim();
  const nets = parseNetworks(allowed);
  const bad = nets.filter((x) => x.invalid).map((x) => x.entry);
  if (bad.length) return back(res, '/admin/settings#account', '', `Not a valid IPv4 address or network: ${bad.join(', ')}. Use e.g. 192.168.10.0/24 or 192.168.1.20.`);
  if (nets.length && !inNetworks(req.ip, nets) && !isLocal(req.ip)) {
    return back(res, '/admin/settings#account', '', `That list doesn’t include your own address (${plainIp(req.ip)}), so you’d be locked out. Add it and save again.`);
  }
  setSetting('admin_access', { block_guests: req.body.block_guests === 'on', allowed: nets.map((x) => x.entry).join(', ') });
  back(res, '/admin/settings#account', 'Admin access settings saved');
});

router.post('/settings/public-url', (req, res) => {
  const raw = String(req.body.public_url || '').trim().replace(/\/+$/, '');
  if (raw) {
    let u;
    try { u = new URL(raw); } catch { return back(res, '/admin/settings#hotspot', '', 'That doesn\'t look like a valid URL.'); }
    if (u.protocol !== 'https:') return back(res, '/admin/settings#hotspot', '', 'The public address must start with https://');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return back(res, '/admin/settings#hotspot', '', 'Use a hostname (e.g. wifi.example.com). Certificates can\'t be issued for an IP address.');
    const changed = publicUrl() !== u.origin;
    setSetting('public_url', u.origin);
    if (changed) tls.cancel(); // a pending request belongs to the old hostname
    return back(res, '/admin/settings#certificate', `Public address set to ${u.origin}.${tls.isActive() ? '' : ' Now request a certificate below.'}`);
  }
  setSetting('public_url', '');
  back(res, '/admin/settings#hotspot', 'Public address cleared');
});

// ---------- HTTPS certificate (manual DNS-01) ----------
router.post('/settings/tls', (req, res) => {
  tls.saveConfig({ email: req.body.email, environment: req.body.environment });
  back(res, '/admin/settings#certificate', 'Certificate settings saved');
});

router.post('/settings/tls/start', async (req, res) => {
  try {
    const p = await tls.start();
    back(res, '/admin/settings#certificate', p.records.length ? 'Add the TXT record below at your DNS provider, then click Check DNS.' : 'This name is already validated, so you can issue the certificate straight away.');
  } catch (e) {
    back(res, '/admin/settings#certificate', '', `Could not start the certificate request: ${e.message}`);
  }
});

router.post('/settings/tls/check', async (req, res) => {
  try { res.json(await tls.checkDns()); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/settings/tls/finish', async (req, res) => {
  try {
    const info = await tls.finish();
    res.json({ ok: true, info });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ----- automatic (DNS provider) -----
const dnsProviders = require('./dnsproviders');
router.post('/settings/tls/dns', async (req, res) => {
  const provider = dnsProviders.get(String(req.body.provider || ''));
  if (!provider) return back(res, '/admin/settings#certificate', '', 'Choose a DNS provider.');
  const cur = tls.dnsConfig();
  const next = { provider: provider.id, zone: String(req.body.zone || '').trim().replace(/\.$/, '').toLowerCase(), auto_renew: req.body.auto_renew === 'on' };
  for (const f of provider.fields) {
    const v = String(req.body[`${provider.id}__${f.key}`] ?? '').trim();
    // Secrets: keep the saved value when left blank (and only if it belongs to the same provider).
    next[f.key] = f.secret && !v && cur.provider === provider.id ? cur[f.key] || '' : v;
  }
  const missing = provider.fields.filter((f) => !/optional/i.test(f.label) && !next[f.key]).map((f) => f.label);
  if (missing.length) return back(res, '/admin/settings#certificate', '', `${provider.name}: please fill in ${missing.join(', ')}.`);
  tls.saveDnsConfig(next);
  if (req.body.action === 'test') {
    try {
      const zone = next.zone || (tls.domain() ? (await tls.authoritativeServers(`_acme-challenge.${tls.domain()}`)).zone : null);
      if (!zone) return back(res, '/admin/settings#certificate', '', 'Saved, but couldn’t work out your DNS zone. Set the public address, or enter the zone.');
      const msg = await provider.test(next, zone);
      return back(res, '/admin/settings#certificate', `✔ ${msg}`);
    } catch (e) {
      return back(res, '/admin/settings#certificate', '', `Saved, but the connection test failed. ${e.message}`);
    }
  }
  if (req.body.action === 'issue') {
    try { tls.autoIssue({ trigger: 'manual' }); } catch (e) { return back(res, '/admin/settings#certificate', '', e.message); }
    return back(res, '/admin/settings#certificate', 'Getting your certificate. This usually takes 1–3 minutes.');
  }
  back(res, '/admin/settings#certificate', `${provider.name} settings saved`);
});

router.get('/settings/tls/job', (req, res) => {
  res.json({ running: tls.isAutoRunning(), job: tls.job(), cert: tls.certInfo(), active: tls.isActive() });
});

// ----- upload your own -----
const certUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024, files: 3 } });
router.post('/settings/tls/upload', (req, res) => {
  certUpload.fields([{ name: 'cert_file' }, { name: 'key_file' }, { name: 'pfx_file' }])(req, res, (err) => {
    if (err) return back(res, '/admin/settings#certificate', '', `Upload failed: ${err.code === 'LIMIT_FILE_SIZE' ? 'file too large' : err.message}`);
    const file = (n) => (req.files && req.files[n] && req.files[n][0]) || null;
    try {
      let out;
      if (file('pfx_file')) out = tls.uploadCertificate({ pfx: file('pfx_file').buffer, passphrase: req.body.pfx_password });
      else {
        const certPem = file('cert_file') ? file('cert_file').buffer.toString('utf8') : req.body.cert_pem;
        const keyPem = file('key_file') ? file('key_file').buffer.toString('utf8') : req.body.key_pem;
        out = tls.uploadCertificate({ certPem, keyPem });
      }
      const warn = out.warnings.length ? ` Note: ${out.warnings.join(' ')}` : '';
      back(res, '/admin/settings#certificate', `Certificate installed for ${out.info.names.join(', ')}, valid until ${new Date(out.info.expires * 1000).toLocaleDateString('en-GB')}.${warn}`);
    } catch (e) {
      back(res, '/admin/settings#certificate', '', e.message);
    }
  });
});

// ---------- backup & restore ----------
const backup = require('./backup');
const sendBackup = (res, buf, label) => {
  const name = `captive-portal-${label}-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.cpbak`;
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': buf.length });
  res.send(buf);
};
function backupPassword(req) {
  const pw = String(req.body.password || '');
  if (pw.length < 8) throw new Error('Choose a backup password of at least 8 characters.');
  if (req.body.confirm !== undefined && req.body.confirm !== pw) throw new Error('The backup passwords don’t match.');
  return pw;
}

router.post('/settings/backup/download', async (req, res) => {
  try { sendBackup(res, await backup.create(backupPassword(req)), 'backup'); } catch (e) { back(res, '/admin/settings#backup', '', e.message); }
});
router.post('/settings/backup/now', async (req, res) => {
  try { const name = await backup.saveLocal('manual'); back(res, '/admin/settings#backup', `Backup saved on the server (${name}).`); } catch (e) { back(res, '/admin/settings#backup', '', e.message); }
});
router.post('/settings/backup/config', (req, res) => {
  backup.saveConfig({ auto: req.body.auto === 'on', keep: req.body.keep });
  back(res, '/admin/settings#backup', 'Backup settings saved');
});
router.post('/settings/backup/file/:name/download', (req, res) => {
  try {
    // Server copies are stored unencrypted; a download is always encrypted with the password given here.
    const buf = backup.encryptCopy(fs.readFileSync(backup.filePath(req.params.name)), backupPassword(req));
    sendBackup(res, buf, req.params.name.replace(/\.cpbak$/, ''));
  } catch (e) { back(res, '/admin/settings#backup', '', e.message); }
});
router.post('/settings/backup/file/:name/delete', (req, res) => {
  try { backup.remove(req.params.name); back(res, '/admin/settings#backup', 'Backup deleted'); } catch (e) { back(res, '/admin/settings#backup', '', e.message); }
});
router.post('/settings/backup/file/:name/restore', (req, res) => {
  try { backup.stage(fs.readFileSync(backup.filePath(req.params.name)), null); res.redirect(303, '/admin/settings#backup'); } catch (e) { back(res, '/admin/settings#backup', '', e.message); }
});
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024, files: 1 } });
router.post('/settings/backup/upload', (req, res) => {
  backupUpload.single('file')(req, res, (err) => {
    if (err) return back(res, '/admin/settings#backup', '', `Upload failed: ${err.code === 'LIMIT_FILE_SIZE' ? 'file too large' : err.message}`);
    if (!req.file) return back(res, '/admin/settings#backup', '', 'Choose a backup file.');
    try { backup.stage(req.file.buffer, req.body.password || null); res.redirect(303, '/admin/settings#backup'); } catch (e) { back(res, '/admin/settings#backup', '', e.message); }
  });
});
router.post('/settings/backup/cancel', (req, res) => { backup.cancelStage(); back(res, '/admin/settings#backup', 'Restore cancelled. Nothing was changed.'); });
router.post('/settings/backup/apply', async (req, res) => {
  if (!accounts.checkPassword(req.user, req.body.admin_password)) return back(res, '/admin/settings#backup', '', 'Your admin password is incorrect. Nothing was changed.');
  try {
    const { safety } = await backup.apply(String(req.body.token || ''));
    res.render('admin/restoring', { safety });
  } catch (e) { back(res, '/admin/settings#backup', '', e.message); }
});

router.post('/settings/tls/cancel', (req, res) => {
  tls.cancel();
  back(res, '/admin/settings#certificate', 'Certificate request cancelled. You can remove the TXT record.');
});

router.post('/settings/tls/remove', (req, res) => {
  tls.removeCertificate();
  back(res, '/admin/settings#certificate', 'Certificate removed. Guests now stay on plain HTTP.');
});

// ---------- my account ----------
const QRCode = require('qrcode');

router.get('/account', (req, res) => {
  res.render('admin/account', { u: req.user, needs2fa: accounts.needs2fa(req.user), recoveryLeft: accounts.recoveryLeft(req.user), codes: null });
});

router.post('/account/profile', (req, res) => {
  accounts.update(req.user.id, { display_name: String(req.body.display_name || '').trim().slice(0, 80) });
  back(res, '/admin/account', 'Name updated');
});

router.post('/account/change-password', (req, res) => {
  if (!accounts.checkPassword(req.user, req.body.current)) return back(res, '/admin/account', '', 'Your current password is incorrect.');
  if (req.body.next !== req.body.confirm) return back(res, '/admin/account', '', 'The new passwords don’t match.');
  try { accounts.setOwnPassword(req.user.id, req.body.next); } catch (e) { return back(res, '/admin/account', '', e.message); }
  auth.issue(res, accounts.get(req.user.id), req); // keep this session, sign out everywhere else
  back(res, '/admin/account', 'Password changed. Other sessions have been signed out.');
});

// Forced step after an auto-generated password
router.get('/account/password', (req, res) => {
  if (!req.user.must_change_password) return res.redirect('/admin');
  res.render('admin/setup-password', { error: '', suggestion: accounts.generatePassword() });
});
router.post('/account/password', (req, res) => {
  if (!req.user.must_change_password) return res.redirect('/admin');
  const err = (error) => res.status(400).render('admin/setup-password', { error, suggestion: accounts.generatePassword() });
  if (req.body.next !== req.body.confirm) return err('The passwords don’t match.');
  if (accounts.checkPassword(req.user, req.body.next)) return err('Choose a different password from the one you were given.');
  try { accounts.setOwnPassword(req.user.id, req.body.next); } catch (e) { return err(e.message); }
  auth.issue(res, accounts.get(req.user.id), req);
  res.redirect('/admin');
});

// 2FA setup (voluntary from My account, or forced when required)
async function render2faSetup(req, res, error = '') {
  // Keep the same secret while the user is on this page, so a typo doesn't invalidate the QR they scanned.
  let secret = req.body?.secret && /^[A-Z2-7]{32}$/.test(req.body.secret) ? req.body.secret : require('./totp').generateSecret();
  const url = require('./totp').otpauthUrl(secret, req.user.username);
  const qr = await QRCode.toString(url, { type: 'svg', margin: 1, width: 200, errorCorrectionLevel: 'M' });
  res.status(error ? 400 : 200).render('admin/setup-2fa', { secret, qr, error, forced: accounts.needs2fa(req.user) && !req.user.totp_enabled, codes: null });
}
router.get('/account/2fa/setup', (req, res) => {
  if (req.user.totp_enabled) return res.redirect('/admin/account');
  render2faSetup(req, res);
});
router.post('/account/2fa/setup', async (req, res) => {
  if (req.user.totp_enabled) return res.redirect('/admin/account');
  try {
    const codes = accounts.enable2fa(req.user.id, req.body.secret, req.body.code);
    auth.issue(res, accounts.get(req.user.id), req);
    res.render('admin/setup-2fa', { secret: null, qr: null, error: '', forced: false, codes });
  } catch (e) {
    render2faSetup(req, res, e.message);
  }
});
router.post('/account/2fa/disable', (req, res) => {
  if (accounts.needs2fa(req.user)) return back(res, '/admin/account', '', 'Two-factor is required for your account, so it can’t be turned off.');
  if (!accounts.checkPassword(req.user, req.body.password)) return back(res, '/admin/account', '', 'Your password is incorrect.');
  accounts.disable2fa(req.user.id);
  auth.issue(res, accounts.get(req.user.id), req);
  back(res, '/admin/account', 'Two-factor sign-in turned off.');
});
router.post('/account/2fa/recovery', (req, res) => {
  if (!req.user.totp_enabled) return res.redirect('/admin/account');
  const codes = accounts.regenerateRecoveryCodes(req.user.id);
  res.render('admin/account', { u: accounts.get(req.user.id), needs2fa: accounts.needs2fa(req.user), recoveryLeft: 10, codes });
});

// ---------- users ----------
function renderUsers(res, extra = {}) {
  res.render('admin/users', { users: accounts.all(), security: accounts.security(), created: null, reset: null, error: '', host: res.req.get('host'), ...extra });
}
router.get('/users', (req, res) => renderUsers(res));

router.post('/users', (req, res) => {
  try {
    const { user, password } = accounts.create({
      username: req.body.username, displayName: req.body.display_name,
      require2fa: req.body.require_2fa === 'on', mustChange: req.body.must_change === 'on',
    });
    renderUsers(res, { created: { user, password } }); // shown once, never put in a URL
  } catch (e) {
    renderUsers(res.status(400), { error: e.message, form: req.body });
  }
});

function target(req, res) {
  const u = accounts.get(Number(req.params.id));
  if (!u) { back(res, '/admin/users', '', 'Account not found'); return null; }
  return u;
}
const isSelf = (req, u) => u.id === req.user.id;

router.post('/users/:id/reset-password', (req, res) => {
  const u = target(req, res); if (!u) return;
  if (isSelf(req, u)) return back(res, '/admin/users', '', 'To change your own password, use My account.');
  const password = accounts.resetPassword(u.id, { mustChange: req.body.must_change !== 'off' });
  renderUsers(res, { reset: { user: accounts.get(u.id), password } });
});

router.post('/users/:id/reset-2fa', (req, res) => {
  const u = target(req, res); if (!u) return;
  accounts.disable2fa(u.id);
  if (isSelf(req, u)) auth.issue(res, accounts.get(u.id), req);
  back(res, '/admin/users', `Two-factor reset for ${u.username}.${accounts.needs2fa(u) ? ' They’ll set it up again at next sign-in.' : ''}`);
});

router.post('/users/:id/require-2fa', (req, res) => {
  const u = target(req, res); if (!u) return;
  accounts.update(u.id, { require_2fa: u.require_2fa ? 0 : 1 });
  back(res, '/admin/users', u.require_2fa ? `${u.username} no longer has to use two-factor (unless it’s required for everyone).` : `${u.username} must use two-factor. They’ll be asked to set it up at next sign-in.`);
});

router.post('/users/:id/disable', (req, res) => {
  const u = target(req, res); if (!u) return;
  if (isSelf(req, u)) return back(res, '/admin/users', '', 'You can’t disable your own account.');
  if (!u.disabled && accounts.activeCount() <= 1) return back(res, '/admin/users', '', 'At least one account must stay active.');
  accounts.update(u.id, { disabled: u.disabled ? 0 : 1 });
  back(res, '/admin/users', u.disabled ? `${u.username} re-enabled.` : `${u.username} disabled and signed out.`);
});

router.post('/users/:id/delete', (req, res) => {
  const u = target(req, res); if (!u) return;
  if (isSelf(req, u)) return back(res, '/admin/users', '', 'You can’t delete your own account.');
  if (!u.disabled && accounts.activeCount() <= 1) return back(res, '/admin/users', '', 'At least one account must stay active.');
  accounts.remove(u.id);
  back(res, '/admin/users', `${u.username} deleted.`);
});

router.post('/users/security', (req, res) => {
  const on = req.body.require_2fa === 'on';
  accounts.setSecurity({ require_2fa: on });
  back(res, '/admin/users', on ? 'Two-factor is now required for everyone. Anyone without it will set it up at their next sign-in, starting with you if needed.' : 'Two-factor is no longer required for everyone.');
});

module.exports = router;
