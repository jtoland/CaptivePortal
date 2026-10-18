// Shared voucher logic used by both the admin UI and the API, so they behave identically.
const crypto = require('crypto');
const { db } = require('./db');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters (0/O, 1/I/L)
const now = () => Math.floor(Date.now() / 1000);
const clampInt = (v, lo, hi, d = 0) => { const n = parseInt(v, 10); return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : d)); };

function newCode(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
const format = (c) => String(c).replace(/(.{4})(?=.)/g, '$1-');

function status(v, t = now()) {
  if (!v.enabled) return 'disabled';
  if ((v.valid_until && v.valid_until < t) || (v.first_used_at && v.first_used_at + v.minutes * 60 <= t)) return 'expired';
  if (v.max_uses > 0 && v.uses >= v.max_uses) return 'used';
  if (v.uses > 0) return 'active';
  return 'unused';
}

/** Public shape of a voucher (never exposes internal row id directly as "id" field name clashes, but fine). */
function toJson(v, t = now()) {
  return {
    code: format(v.code),
    status: status(v, t),
    minutes: v.minutes,
    max_uses: v.max_uses,
    uses: v.uses,
    up_kbps: v.up_kbps, down_kbps: v.down_kbps, data_mb: v.data_mb,
    note: v.note || '',
    batch: v.batch || '',
    profile_id: v.profile_id || null,
    enabled: !!v.enabled,
    valid_until: v.valid_until || null,
    created_at: v.created_at,
    first_used_at: v.first_used_at || null,
  };
}

/**
 * Generate a batch of vouchers. Accepts the same fields as the admin form (duration + duration_unit)
 * or a direct `minutes`. Returns { created, batch, vouchers: [...] }.
 */
function generate(opts = {}) {
  const count = clampInt(opts.count, 1, 1000, 1);
  const len = clampInt(opts.length, 6, 16, 8);
  let minutes;
  if (opts.minutes != null) minutes = clampInt(opts.minutes, 1, 525600, 60);
  else {
    const unit = { minutes: 1, hours: 60, days: 1440 }[opts.duration_unit] || 1;
    minutes = Math.max(1, clampInt(opts.duration, 1, 525600, 1) * unit);
  }
  const profileId = opts.profile_id ? Number(opts.profile_id) : null;
  if (profileId && !db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId)) {
    const e = new Error('No network profile with that id.'); e.status = 400; throw e;
  }
  const validDays = clampInt(opts.valid_days, 0, 3650, 0);
  const batch = String(opts.batch || '').trim() || `Batch ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const insert = db.prepare(`INSERT OR IGNORE INTO vouchers(code, profile_id, minutes, max_uses, data_mb, up_kbps, down_kbps, note, batch, valid_until)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const made = [];
  db.transaction(() => {
    while (made.length < count) {
      const code = newCode(len);
      const r = insert.run(code, profileId, minutes, clampInt(opts.max_uses, 0, 100000, 1), clampInt(opts.data_mb, 0, 1e9),
        clampInt(opts.up_kbps, 0, 1e9), clampInt(opts.down_kbps, 0, 1e9), String(opts.note || '').slice(0, 500), batch,
        validDays ? now() + validDays * 86400 : null);
      if (r.changes) made.push(code);
    }
  })();
  const rows = made.map((c) => db.prepare('SELECT * FROM vouchers WHERE code = ?').get(c));
  return { created: rows.length, batch, vouchers: rows };
}

function list({ batch = '', status: want = 'all', limit = 1000 } = {}) {
  const t = now();
  const rows = batch
    ? db.prepare('SELECT * FROM vouchers WHERE batch = ? ORDER BY id DESC').all(batch)
    : db.prepare('SELECT * FROM vouchers ORDER BY id DESC LIMIT ?').all(clampInt(limit, 1, 5000, 1000));
  return rows.filter((v) => want === 'all' || status(v, t) === want);
}

const findByCode = (code) => db.prepare('SELECT * FROM vouchers WHERE code = ?').get(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')) || null;

module.exports = { newCode, format, status, toJson, generate, list, findByCode };
