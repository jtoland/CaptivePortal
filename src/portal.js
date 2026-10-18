// Guest-facing captive portal routes.
const express = require('express');
const crypto = require('crypto');
const { db, profiles, publicUrl } = require('./db');
const unifi = require('./unifi');
const grace = require('./grace');
const sso = require('./sso');
const { isAdmin } = require('./auth');

const router = express.Router();
const now = () => Math.floor(Date.now() / 1000);
const rid = (n = 18) => crypto.randomBytes(n).toString('base64url');

// ---------- simple brute-force protection ----------
const failures = new Map();
function tooManyFailures(key) {
  const f = failures.get(key);
  return f && f.count >= 8 && Date.now() - f.first < 10 * 60_000;
}
setInterval(() => { for (const [k, f] of failures) if (Date.now() - f.first > 10 * 60_000) failures.delete(k); }, 60_000).unref();
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 10 * 60_000) failures.set(key, { count: 1, first: Date.now() });
  else f.count++;
}

// ---------- context helpers ----------
function loadCtx(id) {
  if (!id) return null;
  const ctx = db.prepare('SELECT * FROM guest_ctx WHERE id = ?').get(id);
  if (!ctx) return null;
  ctx.profile = profiles.get(ctx.profile_id) || profiles.forSsid(ctx.ssid);
  return ctx;
}

function availableMethods(profile) {
  const m = profile.methods;
  return {
    click: !!m.click?.enabled,
    email: !!m.email?.enabled,
    password: !!m.password?.enabled && !!m.password.password,
    voucher: !!m.voucher?.enabled,
    sso: sso.list().filter((p) => m[p.id]?.enabled && sso.isConfigured(p)).map((p) => ({ key: p.id, type: p.type, label: sso.buttonLabel(p) })),
  };
}

// GrapesJS exports "<body id=..>...</body>"; keep its attributes on the real <body> so wrapper styles apply.
function splitBody(html) {
  const m = String(html || '').match(/^\s*<body([^>]*)>([\s\S]*)<\/body>\s*$/i);
  return m ? { bodyAttrs: m[1], bodyHtml: m[2] } : { bodyAttrs: '', bodyHtml: html || '' };
}

const inMaintenance = (profile) => !!(profile && profile.options.maintenance);

function renderPortal(res, ctx, { error = '', preview = false, values = {} } = {}) {
  const profile = ctx.profile;
  const maintenance = inMaintenance(profile) && !preview;
  if (maintenance) res.status(503).set('Retry-After', '300');
  res.render('portal/page', {
    ctx, profile, preview, maintenance, error: maintenance ? '' : error, values, ...splitBody(profile.design_html),
    methods: availableMethods(profile),
  });
}

function emailAllowed(profile, email) {
  const list = String(profile.options.sso_allowed_domains || '').split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!list.length) return true;
  const domain = String(email || '').toLowerCase().split('@')[1] || '';
  return list.some((d) => domain === d || domain.endsWith('.' + d));
}

/** What we know about the signing-in device: its browser, plus its name and maker from the controller (best effort). */
async function deviceInfo(req, mac) {
  const ua = String(req.get('user-agent') || '').slice(0, 400) || null;
  try {
    const c = await unifi.withTimeout(unifi.clientByMac(mac), 1500);
    return { ua, name: (c && c.name) || null, vendor: (c && c.vendor) || null };
  } catch { return { ua, name: null, vendor: null }; }
}
grace.deviceInfo = deviceInfo;

/** Authorise the guest on UniFi and record the session. */
async function grant(req, ctx, method, { identity = '', name = '', marketing = 0, overrides = {} } = {}) {
  const o = ctx.profile.options;
  const minutes = Number(overrides.minutes || o.minutes || 60);
  const params = {
    mac: ctx.mac, ap: ctx.ap, minutes,
    up_kbps: Number(overrides.up_kbps || o.up_kbps || 0),
    down_kbps: Number(overrides.down_kbps || o.down_kbps || 0),
    data_mb: Number(overrides.data_mb || o.data_mb || 0),
  };
  let ok = 1; let msg = '';
  try {
    msg = (await unifi.authorize(params)).via;
  } catch (e) {
    // A device on a grace period is already authorised; some controllers won't re-authorise, so clear it and retry.
    if (grace.active(ctx.mac)) {
      try {
        await unifi.unauthorize(ctx.mac).catch(() => {});
        msg = (await unifi.authorize(params)).via;
      } catch (e2) { ok = 0; msg = e2.message; }
    } else { ok = 0; msg = e.message; }
    if (!ok) console.error('[unifi] authorise failed:', msg);
  }
  if (ok) grace.complete(ctx.mac);
  const dev = await deviceInfo(req, ctx.mac);
  db.prepare(`INSERT INTO sessions(mac, ap, ssid, profile_id, profile_name, method, identity, name, ip, minutes,
      authorized_at, expires_at, marketing, unifi_ok, unifi_msg, device_name, device_vendor, user_agent)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    unifi.normMac(ctx.mac) || ctx.mac, ctx.ap, ctx.ssid, ctx.profile.id, ctx.profile.name, method, identity, name,
    String(req.ip || '').replace(/^::ffff:/, ''), minutes, now(), now() + minutes * 60, marketing ? 1 : 0, ok, msg,
    dev.name, dev.vendor, dev.ua,
  );
  if (!ok) throw new Error('We could not connect your device right now. Please try again or ask a member of staff.');
}

function termsOk(req, profile) {
  if (!profile.options.terms_enabled || profile.options.terms_mode !== 'checkbox') return true; // implied consent is shown as text
  return req.body.accept === '1' || req.body.accept === 'on';
}

const portalHost = (req) => (publicUrl() ? new URL(publicUrl()).host : req.get('host'));

// A device on an SSO grace period that lost the captive pop-up (e.g. after switching to Authenticator) can open the
// portal in a normal browser and pick up where it left off. Matched by the device's IP.
function resume(req, res) {
  const g = grace.findByIp(req.ip);
  const ctx = g && loadCtx(g.ctx_id);
  const prov = g && sso.get(g.provider);
  if (!ctx || !prov) return false;
  if (inMaintenance(ctx.profile)) { renderPortal(res, ctx); return true; }
  res.render('portal/resume', {
    ctx, profile: ctx.profile, provider: prov.id, providerLabel: sso.adminName(prov), providerType: prov.type,
    minutesLeft: Math.max(1, Math.ceil((g.expires_at - now()) / 60)), ...splitBody(ctx.profile.design_html),
  });
  return true;
}
router.get('/continue', (req, res) => {
  if (resume(req, res)) return;
  res.render('portal/message', { title: 'Nothing to continue', message: 'There is no sign-in in progress for this device. Reconnect to the WiFi to start again.', link: null });
});

// ---------- entry point: UniFi redirects here ----------
// http://<portal>/guest/s/<site>/?ap=<ap mac>&id=<client mac>&t=<ts>&url=<original url>&ssid=<ssid>
const v4 = (ip) => { const m = String(ip || '').replace(/^::ffff:/, ''); return /^\d+\.\d+\.\d+\.\d+$/.test(m) ? m : null; };

async function entry(req, res) {
  const q = req.query;
  if (!q.id) {
    if (resume(req, res)) return;
    return res.status(200).render('portal/message', {
      title: 'WiFi portal', message: 'This is the WiFi login portal. Connect to the WiFi network to sign in.', link: null,
    });
  }
  // Move the guest onto the public HTTPS hostname so OAuth/SAML callbacks share the same origin.
  // Only once a valid certificate is installed, so a missing/expired cert never strands guests.
  if (publicUrl() && require('./tls').isActive()) {
    const pub = new URL(publicUrl());
    if (req.get('host') !== pub.host) return res.redirect(302, pub.origin + req.originalUrl);
  }
  const mac = unifi.normMac(q.id);
  if (!mac) return res.status(400).render('portal/message', { title: 'Please reconnect', message: 'We couldn’t identify your device. Disconnect from the WiFi and connect again.', link: null });
  // The redirect parameters come from the guest's browser, so confirm them with the controller: the device must really be
  // the one making this request, and its network decides the profile (not a hand-edited ?ssid=). If the controller can't
  // be reached we fall back to the parameters so guests are never stranded.
  let ssid = String(q.ssid || '');
  try {
    const client = await unifi.withTimeout(unifi.clientByMac(mac));
    if (client) {
      const here = v4(req.ip); const theirs = v4(client.ip);
      if (here && theirs && here !== theirs) {
        console.warn(`[portal] refused ${mac}: request from ${here} but the controller has it at ${theirs}`);
        return res.status(403).render('portal/message', { title: 'Please reconnect', message: 'This sign-in link doesn’t belong to your device. Disconnect from the WiFi and connect again.', link: null });
      }
      if (client.essid) ssid = client.essid;
    }
  } catch (e) {
    console.warn('[portal] controller check skipped:', e.message);
  }
  const profile = profiles.forSsid(ssid);
  if (!profile) return res.status(500).render('portal/message', { title: 'Not configured', message: 'No portal profile is configured.', link: null });
  const id = rid();
  db.prepare('INSERT INTO guest_ctx(id, mac, ap, ssid, site, url, profile_id, ip, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, mac, String(q.ap || ''), ssid, String(req.params.site || 'default'), String(q.url || '').slice(0, 2048), profile.id, req.ip, now());
  res.redirect(302, `/portal/${id}`);
}
const entryRoute = (req, res, next) => entry(req, res).catch(next);
router.get('/guest/s/:site', entryRoute);
router.get('/guest/s/:site/', entryRoute);
router.get('/', entryRoute);

router.get('/portal/:ctx', (req, res) => {
  const ctx = loadCtx(req.params.ctx);
  if (!ctx) return res.status(410).render('portal/message', { title: 'Session expired', message: 'Your sign-in session has expired. Please disconnect and reconnect to the WiFi.', link: null });
  renderPortal(res, ctx);
});

// Admin-only preview of a profile's page.
router.get('/preview/:profileId', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin/login');
  const profile = profiles.get(req.params.profileId);
  if (!profile) return res.status(404).send('Profile not found');
  renderPortal(res, { id: 'preview', mac: '00:00:00:00:00:00', ssid: profile.ssidList[0] || '', profile }, { preview: !req.query.thumb });
});

// ---------- local login methods ----------
router.post('/portal/:ctx/login/:method', async (req, res) => {
  const ctx = loadCtx(req.params.ctx);
  if (!ctx) return res.redirect('/');
  if (inMaintenance(ctx.profile)) return renderPortal(res, ctx); // sign-in is switched off
  const profile = ctx.profile;
  const avail = availableMethods(profile);
  const method = req.params.method;
  const fail = (error) => renderPortal(res.status(400), ctx, { error, values: { ...req.body, _method: method } });
  const limiterKey = `${method}|${req.ip}`; // per IP: the MAC comes from the URL, so it can't be part of the key

  try {
    if (!avail[method]) return fail('That sign-in method is not available.');
    if (!termsOk(req, profile)) return fail('Please accept the terms and conditions to continue.');

    if (method === 'click') {
      await grant(req, ctx, 'click');
    } else if (method === 'email') {
      const email = String(req.body.email || '').trim();
      const name = String(req.body.name || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Please enter a valid email address.');
      if (profile.methods.email.require_name && !name) return fail('Please enter your name.');
      await grant(req, ctx, 'email', { identity: email, name, marketing: req.body.marketing ? 1 : 0 });
    } else if (method === 'password') {
      if (tooManyFailures(limiterKey)) return fail('Too many attempts. Please wait a few minutes and try again.');
      const given = Buffer.from(String(req.body.password || ''));
      const want = Buffer.from(String(profile.methods.password.password));
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        recordFailure(limiterKey);
        return fail('Incorrect password.');
      }
      await grant(req, ctx, 'password');
    } else if (method === 'voucher') {
      if (tooManyFailures(limiterKey)) return fail('Too many attempts. Please wait a few minutes and try again.');
      const code = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const v = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
      const t = now();
      let problem = null;
      if (!v || !v.enabled) problem = 'That voucher code is not valid.';
      else if (v.profile_id && v.profile_id !== profile.id) problem = 'That voucher cannot be used on this network.';
      else if (v.valid_until && v.valid_until < t) problem = 'That voucher has expired.';
      else if (v.max_uses > 0 && v.uses >= v.max_uses) problem = 'That voucher has already been used.';
      else if (v.first_used_at && v.first_used_at + v.minutes * 60 <= t) problem = 'That voucher has expired.';
      if (problem) { recordFailure(limiterKey); return fail(problem); }
      const remaining = v.first_used_at ? Math.max(1, Math.ceil((v.first_used_at + v.minutes * 60 - t) / 60)) : v.minutes;
      await grant(req, ctx, 'voucher', {
        identity: v.code.replace(/(.{4})(?=.)/g, '$1-'),
        overrides: { minutes: remaining, up_kbps: v.up_kbps, down_kbps: v.down_kbps, data_mb: v.data_mb },
      });
      db.prepare('UPDATE vouchers SET uses = uses + 1, first_used_at = COALESCE(first_used_at, ?) WHERE id = ?').run(t, v.id);
    } else {
      return fail('Unknown sign-in method.');
    }
    res.redirect(303, `/portal/${ctx.id}/success`);
  } catch (e) {
    fail(e.message);
  }
});

// ---------- SSO ----------
router.post('/portal/:ctx/sso/:provider', async (req, res) => {
  const ctx = loadCtx(req.params.ctx);
  if (!ctx) return res.redirect('/');
  if (inMaintenance(ctx.profile)) return renderPortal(res, ctx);
  const provider = req.params.provider;
  const prov = sso.get(provider);
  if (!prov || !availableMethods(ctx.profile).sso.some((s) => s.key === provider)) {
    return renderPortal(res.status(400), ctx, { error: 'That sign-in method is not available.' });
  }
  if (!termsOk(req, ctx.profile)) return renderPortal(res.status(400), ctx, { error: 'Please accept the terms and conditions to continue.' });
  try {
    const state = rid(24);
    const { url, data } = await sso.authUrl(prov, req, state);
    db.prepare('INSERT INTO oauth_states(state, ctx_id, provider, data, created_at) VALUES(?,?,?,?,?)')
      .run(state, ctx.id, provider, JSON.stringify(data), now());
    const g = await grace.start(req, ctx, provider);
    if (g && g.row && !req.body.resumed) {
      // Explain the temporary access and how to get back here if the pop-up closes, then continue to the provider.
      return res.render('portal/sso-wait', {
        ctx, profile: ctx.profile, url, providerLabel: sso.adminName(prov), providerType: prov.type,
        minutesLeft: Math.max(1, Math.ceil((g.row.expires_at - now()) / 60)), host: portalHost(req), ...splitBody(ctx.profile.design_html),
      });
    }
    res.redirect(303, url);
  } catch (e) {
    console.error(`[sso] ${provider} start failed:`, e.message);
    renderPortal(res.status(500), ctx, { error: `Could not start ${sso.buttonLabel(prov)}. Please try another method.` });
  }
});

async function ssoCallback(req, res) {
  const provider = req.params.provider;
  const state = String(req.query.state || req.body.state || req.body.RelayState || '');
  const row = state && db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(state, provider);
  if (!row) return res.status(400).render('portal/message', { title: 'Sign-in expired', message: 'Your sign-in attempt has expired. Please reconnect to the WiFi and try again.', link: null });
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  const ctx = loadCtx(row.ctx_id);
  if (!ctx) return res.redirect('/');
  if (inMaintenance(ctx.profile)) return renderPortal(res, ctx); // maintenance switched on mid sign-in
  const prov = sso.get(provider);
  try {
    if (!prov) throw new Error('This sign-in provider has been removed.');
    const user = await sso.handleCallback(prov, req, JSON.parse(row.data || '{}'));
    // Multi-tenant Microsoft sign-ins let any organisation set its users' email address, so an email-domain rule is only
    // trustworthy when the provider is pinned to specific tenants.
    if (prov.type === 'microsoft' && String(ctx.profile.options.sso_allowed_domains || '').trim() && !sso.tenantPinned(prov)) {
      await grace.revoke(ctx.mac);
      console.warn(`[sso] refused ${provider}: email-domain rule needs the Microsoft provider pinned to a tenant`);
      return renderPortal(res.status(403), ctx, { error: 'This sign-in option isn’t set up securely yet. Ask a member of staff.' });
    }
    if (!emailAllowed(ctx.profile, user.email)) {
      await grace.revoke(ctx.mac);
      return renderPortal(res.status(403), ctx, { error: `The account ${user.email || ''} is not allowed on this network.` });
    }
    await grant(req, ctx, provider, { identity: user.email || user.sub, name: user.name });
    res.redirect(303, `/portal/${ctx.id}/success`);
  } catch (e) {
    console.error(`[sso] ${provider} callback failed:`, e.message);
    await grace.revoke(ctx.mac);
    renderPortal(res.status(400), ctx, { error: e.message });
  }
}
router.get('/auth/:provider/callback', ssoCallback);
router.post('/auth/:provider/callback', ssoCallback);

router.get('/auth/:provider/metadata', (req, res) => {
  const prov = sso.get(req.params.provider);
  if (!prov || prov.type !== 'saml') return res.status(404).send('No SAML provider with that id');
  try {
    res.type('application/xml').send(sso.samlMetadata(req, prov));
  } catch (e) {
    res.status(500).send(`SAML not configured: ${e.message}`);
  }
});

// ---------- success ----------
// Only http(s) URLs, re-serialised by the URL parser (drops anything odd), and never back to the portal itself.
function safeRedirect(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch { return ''; }
}

router.get('/portal/:ctx/success', (req, res) => {
  const ctx = loadCtx(req.params.ctx);
  if (!ctx) return res.redirect('/');
  // Only for a device that actually signed in during this visit.
  const signedIn = db.prepare("SELECT 1 FROM sessions WHERE mac = ? AND authorized_at >= ? AND method != 'grace' AND unifi_ok = 1")
    .get(unifi.normMac(ctx.mac) || ctx.mac, ctx.created_at);
  if (!signedIn) return res.redirect(`/portal/${ctx.id}`);
  const target = safeRedirect(ctx.profile.options.redirect_url) || safeRedirect(ctx.url);
  res.render('portal/success', { ctx, profile: ctx.profile, target, ...splitBody(ctx.profile.design_html) });
});

router.availableMethods = availableMethods;
module.exports = router;
