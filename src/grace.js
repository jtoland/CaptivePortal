// SSO grace period (per profile, off by default).
// When a guest starts an SSO sign-in, their device gets a few minutes of internet so things like a Microsoft Authenticator
// push can arrive. If the phone's captive pop-up closes while they switch apps, they can open a normal browser,
// visit the portal and continue ("resume") from where they left off. Unfinished grace access simply expires.

const { db } = require('./db');
const unifi = require('./unifi');

const now = () => Math.floor(Date.now() / 1000);
const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(+v) && v !== '' ? +v : d));

function settings(profile) {
  const o = profile.options || {};
  return {
    enabled: !!o.sso_grace_enabled,
    minutes: clamp(o.sso_grace_minutes, 1, 30, 5),
    kbps: clamp(o.sso_grace_kbps, 0, 1000000, 2000),
    cooldown: clamp(o.sso_grace_cooldown, 0, 1440, 60),
  };
}

const normIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

function active(mac) {
  return db.prepare("SELECT * FROM grace WHERE mac = ? AND status = 'active' AND expires_at > ? ORDER BY id DESC").get(unifi.normMac(mac), now()) || null;
}

/** The active grace period for the device making this request, matched by its IP. */
function findByIp(ip) {
  const want = normIp(ip);
  if (!want) return null;
  return db.prepare("SELECT * FROM grace WHERE status = 'active' AND expires_at > ? ORDER BY id DESC").all(now())
    .find((g) => normIp(g.ip) === want) || null;
}

/**
 * Give the device temporary access before sending it to the SSO provider.
 * Returns { row } when access is active (new or already running), { cooldown } when the device used one recently,
 * or null when grace is off for this profile.
 */
async function start(req, ctx, providerId) {
  const cfg = settings(ctx.profile);
  if (!cfg.enabled) return null;
  const mac = unifi.normMac(ctx.mac);
  if (!mac) return null;
  const running = active(mac);
  if (running) {
    db.prepare('UPDATE grace SET ctx_id = ?, provider = ?, ip = ? WHERE id = ?').run(ctx.id, providerId, req.ip, running.id);
    return { row: { ...running, ctx_id: ctx.id, provider: providerId } };
  }
  if (cfg.cooldown) {
    const recent = db.prepare('SELECT 1 FROM grace WHERE mac = ? AND started_at > ?').get(mac, now() - cfg.cooldown * 60);
    if (recent) return { cooldown: true };
  }
  let ok = 1; let msg = '';
  try {
    msg = (await unifi.authorize({ mac, ap: ctx.ap, minutes: cfg.minutes, up_kbps: cfg.kbps, down_kbps: cfg.kbps })).via;
  } catch (e) {
    ok = 0; msg = e.message;
    console.error('[grace] authorise failed:', e.message);
  }
  const dev = module.exports.deviceInfo ? await module.exports.deviceInfo(req, mac) : {};
  db.prepare(`INSERT INTO sessions(mac, ap, ssid, profile_id, profile_name, method, identity, name, ip, minutes, authorized_at, expires_at, unifi_ok, unifi_msg, device_name, device_vendor, user_agent)
    VALUES(?,?,?,?,?,'grace',?,'',?,?,?,?,?,?,?,?,?)`)
    .run(mac, ctx.ap, ctx.ssid, ctx.profile.id, ctx.profile.name, providerId, String(req.ip || '').replace(/^::ffff:/, ''), cfg.minutes, now(), now() + cfg.minutes * 60, ok, msg,
      dev.name || null, dev.vendor || null, dev.ua || null);
  if (!ok) return null; // fall back to the normal flow without grace
  const t = now();
  const info = db.prepare('INSERT INTO grace(mac, ip, ctx_id, provider, started_at, expires_at) VALUES(?,?,?,?,?,?)')
    .run(mac, req.ip, ctx.id, providerId, t, t + cfg.minutes * 60);
  console.log(`[grace] ${mac} has ${cfg.minutes} min to finish ${providerId} sign-in`);
  return { row: db.prepare('SELECT * FROM grace WHERE id = ?').get(info.lastInsertRowid) };
}

/** Sign-in finished: mark the grace period done and end its temporary session record. */
function complete(mac) {
  const m = unifi.normMac(mac);
  db.prepare("UPDATE grace SET status = 'completed' WHERE mac = ? AND status = 'active'").run(m);
  db.prepare("UPDATE sessions SET expires_at = ? WHERE mac = ? AND method = 'grace' AND expires_at > ?").run(now(), m, now());
}

/** Sign-in failed or was refused: take the temporary access away straight away. */
async function revoke(mac) {
  const g = active(mac);
  if (!g) return;
  db.prepare("UPDATE grace SET status = 'revoked' WHERE id = ?").run(g.id);
  db.prepare("UPDATE sessions SET expires_at = ?, revoked = 1 WHERE mac = ? AND method = 'grace' AND expires_at > ?").run(now(), g.mac, now());
  try { await unifi.unauthorize(g.mac); } catch (e) { console.error('[grace] unauthorise failed:', e.message); }
}

module.exports = { settings, active, findByIp, start, complete, revoke };
