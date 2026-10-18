// Public REST API (currently vouchers). Authenticated by an API key, not by the admin session.
//   Authorization: Bearer cpk_xxx   (or  X-API-Key: cpk_xxx)
// Read keys can list and view; write keys can also generate, enable and disable.
const express = require('express');
const apikeys = require('./apikeys');
const vouchers = require('./vouchers');
const { db } = require('./db');

const router = express.Router();
router.use(express.json({ limit: '256kb' }));

// --- simple per-key rate limit ---
const hits = new Map();
setInterval(() => { for (const [k, v] of hits) if (Date.now() - v.t > 60_000) hits.delete(k); }, 60_000).unref();
function rateLimited(id) {
  const v = hits.get(id);
  if (!v || Date.now() - v.t > 60_000) { hits.set(id, { n: 1, t: Date.now() }); return false; }
  v.n++;
  return v.n > 120; // 120 requests/minute per key
}

function auth(required) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : req.get('x-api-key');
    const key = apikeys.verify(token);
    if (!key) return res.status(401).json({ error: 'Invalid or missing API key. Send it as "Authorization: Bearer <key>".' });
    if (rateLimited(key.id)) return res.status(429).json({ error: 'Rate limit exceeded (120 requests per minute).' });
    if (required === 'write' && key.scope !== 'write') return res.status(403).json({ error: 'This API key is read-only.' });
    req.apiKey = key;
    next();
  };
}

router.get('/', (req, res) => res.json({ name: 'Captive Portal API', version: 1, endpoints: ['GET /v1/vouchers', 'POST /v1/vouchers', 'GET /v1/vouchers/:code'] }));

// List vouchers
router.get('/v1/vouchers', auth('read'), (req, res) => {
  const rows = vouchers.list({ batch: String(req.query.batch || ''), status: String(req.query.status || 'all'), limit: Number(req.query.limit) || 1000 });
  res.json({ count: rows.length, vouchers: rows.map((v) => vouchers.toJson(v)) });
});

// View one voucher
router.get('/v1/vouchers/:code', auth('read'), (req, res) => {
  const v = vouchers.findByCode(req.params.code);
  if (!v) return res.status(404).json({ error: 'No voucher with that code.' });
  res.json(vouchers.toJson(v));
});

// Generate vouchers
router.post('/v1/vouchers', auth('write'), (req, res) => {
  try {
    const r = vouchers.generate(req.body || {});
    res.status(201).json({ created: r.created, batch: r.batch, vouchers: r.vouchers.map((v) => vouchers.toJson(v)) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Enable / disable a voucher
router.post('/v1/vouchers/:code/:action(enable|disable)', auth('write'), (req, res) => {
  const v = vouchers.findByCode(req.params.code);
  if (!v) return res.status(404).json({ error: 'No voucher with that code.' });
  db.prepare('UPDATE vouchers SET enabled = ? WHERE id = ?').run(req.params.action === 'enable' ? 1 : 0, v.id);
  res.json(vouchers.toJson(db.prepare('SELECT * FROM vouchers WHERE id = ?').get(v.id)));
});

router.use((req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));
module.exports = router;
