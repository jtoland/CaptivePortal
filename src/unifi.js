// UniFi guest authorisation client.
// controller_type:
//   unifios    - UniFi OS consoles: UCG Ultra/Max, UDM, UDR, UX, Cloud Key Gen2+ (API under /proxy/network)
//   standalone - self-hosted Network Application or Cloud Key Gen1, e.g. managing a USG (API at the root, usually :8443)
// Supports two auth modes:
//   credentials - local admin username/password, classic Network API (/proxy/network/api/s/<site>/cmd/stamgr)
//   apikey      - UniFi OS API key (X-API-KEY). Uses the official Integration API
//                 (/proxy/network/integration/v1/...) and falls back to the classic API with the key.

const https = require('https');
const { getSetting } = require('./db');

function cfg() {
  return getSetting('unifi', {});
}

function request(method, url, { headers = {}, body, verifyTls = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      rejectUnauthorized: !!verifyTls,
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('UniFi request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------- credentials mode (cookie + CSRF) ----------
let cookieSession = null; // { cookie, csrf, at, key }

const isStandalone = (c) => c.controller_type === 'standalone';
const prefix = (c) => (isStandalone(c) ? '' : '/proxy/network');

async function login(c) {
  const res = await request('POST', `${base(c)}${isStandalone(c) ? '/api/login' : '/api/auth/login'}`, {
    body: { username: c.username, password: c.password, rememberMe: true },
    verifyTls: c.verify_tls,
  });
  if (res.status !== 200) {
    throw new Error(`UniFi login failed (HTTP ${res.status}): ${res.json?.message || res.text.slice(0, 200)}`);
  }
  const setCookie = [].concat(res.headers['set-cookie'] || []);
  const cookie = setCookie.map((s) => s.split(';')[0]).join('; ');
  const csrfCookie = setCookie.map((x) => x.split(';')[0]).find((x) => x.startsWith('csrf_token='));
  const csrf = res.headers['x-csrf-token'] || res.headers['x-updated-csrf-token'] || (csrfCookie ? csrfCookie.split('=')[1] : '');
  cookieSession = { cookie, csrf, at: Date.now(), key: sessionKey(c) };
  return cookieSession;
}

function sessionKey(c) { return `${c.controller_type}|${c.url}|${c.username}|${c.password}`; }
function base(c) { return String(c.url || '').replace(/\/+$/, ''); }

async function credRequest(c, method, path, body, retry = true) {
  if (!cookieSession || cookieSession.key !== sessionKey(c) || Date.now() - cookieSession.at > 3600_000) await login(c);
  const res = await request(method, `${base(c)}${path}`, {
    body,
    verifyTls: c.verify_tls,
    headers: { Cookie: cookieSession.cookie, ...(cookieSession.csrf ? { 'X-CSRF-Token': cookieSession.csrf } : {}) },
  });
  if (res.headers['x-updated-csrf-token']) cookieSession.csrf = res.headers['x-updated-csrf-token'];
  if ((res.status === 401 || res.status === 403) && retry) {
    cookieSession = null;
    return credRequest(c, method, path, body, false);
  }
  return res;
}

// ---------- api key mode ----------
async function keyRequest(c, method, path, body) {
  return request(method, `${base(c)}${path}`, {
    body,
    verifyTls: c.verify_tls,
    headers: { 'X-API-KEY': c.api_key },
  });
}

let siteIdCache = null; // { key, id }
async function integrationSiteId(c) {
  if (siteIdCache && siteIdCache.key === c.url + c.site) return siteIdCache.id;
  const res = await keyRequest(c, 'GET', '/proxy/network/integration/v1/sites?limit=200');
  if (res.status !== 200) throw new Error(`Integration API /sites failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
  const sites = res.json?.data || [];
  const site = sites.find((s) => s.internalReference === c.site || s.name === c.site || s.id === c.site) || sites[0];
  if (!site) throw new Error('No sites returned by the UniFi Integration API');
  siteIdCache = { key: c.url + c.site, id: site.id };
  return site.id;
}

async function integrationClientId(c, siteId, mac) {
  const want = mac.toLowerCase();
  // Newly associated clients can take a moment to show up - retry briefly.
  for (let attempt = 0; attempt < 4; attempt++) {
    const filter = encodeURIComponent(`macAddress.eq('${want}')`);
    let res = await keyRequest(c, 'GET', `/proxy/network/integration/v1/sites/${siteId}/clients?filter=${filter}&limit=5`);
    let list = res.status === 200 ? res.json?.data || [] : [];
    let hit = list.find((x) => String(x.macAddress).toLowerCase() === want);
    if (!hit) {
      // Older firmware without filter support: page through clients.
      for (let offset = 0; offset < 5000 && !hit; offset += 200) {
        res = await keyRequest(c, 'GET', `/proxy/network/integration/v1/sites/${siteId}/clients?offset=${offset}&limit=200`);
        if (res.status !== 200) break;
        list = res.json?.data || [];
        hit = list.find((x) => String(x.macAddress).toLowerCase() === want);
        if (list.length < 200) break;
      }
    }
    if (hit) return hit.id;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

// ---------- public API ----------
function normMac(mac) {
  const hex = String(mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

/**
 * Authorise a guest MAC on the UniFi gateway.
 * @param {object} p { mac, ap, minutes, up_kbps, down_kbps, data_mb }
 */
async function authorize(p) {
  const c = cfg();
  const mac = normMac(p.mac);
  if (!mac) throw new Error('Invalid client MAC address');
  const site = c.site || 'default';

  const classicBody = { cmd: 'authorize-guest', mac, minutes: Number(p.minutes) || 60 };
  if (p.up_kbps) classicBody.up = Number(p.up_kbps);
  if (p.down_kbps) classicBody.down = Number(p.down_kbps);
  if (p.data_mb) classicBody.bytes = Number(p.data_mb);
  const apMac = normMac(p.ap);
  if (apMac) classicBody.ap_mac = apMac;

  if (c.auth_mode === 'apikey' && !isStandalone(c)) {
    if (!c.api_key) throw new Error('UniFi API key is not configured');
    let integrationErr;
    try {
      const siteId = await integrationSiteId(c);
      const clientId = await integrationClientId(c, siteId, mac);
      if (clientId) {
        const body = { action: 'AUTHORIZE_GUEST_ACCESS', timeLimitMinutes: Number(p.minutes) || 60 };
        if (p.data_mb) body.dataUsageLimitMBytes = Number(p.data_mb);
        if (p.down_kbps) body.rxRateLimitKbps = Number(p.down_kbps);
        if (p.up_kbps) body.txRateLimitKbps = Number(p.up_kbps);
        const res = await keyRequest(c, 'POST', `/proxy/network/integration/v1/sites/${siteId}/clients/${clientId}/actions`, body);
        if (res.status >= 200 && res.status < 300) return { ok: true, via: 'integration-api' };
        integrationErr = `HTTP ${res.status}: ${res.text.slice(0, 200)}`;
      } else {
        integrationErr = 'client not found in Integration API';
      }
    } catch (e) {
      integrationErr = e.message;
    }
    // Fallback: classic API with X-API-KEY header
    const res = await keyRequest(c, 'POST', `${prefix(c)}/api/s/${site}/cmd/stamgr`, classicBody);
    if (res.status === 200 && res.json?.meta?.rc === 'ok') return { ok: true, via: 'classic-api-key' };
    throw new Error(`UniFi authorise failed. Integration API: ${integrationErr}. Classic API: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  }

  if (!c.username || !c.password) throw new Error('UniFi username/password are not configured');
  const res = await credRequest(c, 'POST', `${prefix(c)}/api/s/${site}/cmd/stamgr`, classicBody);
  if (res.status === 200 && res.json?.meta?.rc === 'ok') return { ok: true, via: 'classic-api' };
  throw new Error(`UniFi authorise failed (HTTP ${res.status}): ${res.json?.meta?.msg || res.text.slice(0, 200)}`);
}

async function unauthorize(macIn) {
  const c = cfg();
  const mac = normMac(macIn);
  if (!mac) throw new Error('Invalid MAC');
  const site = c.site || 'default';
  const body = { cmd: 'unauthorize-guest', mac };
  if (c.auth_mode === 'apikey' && !isStandalone(c)) {
    try {
      const siteId = await integrationSiteId(c);
      const clientId = await integrationClientId(c, siteId, mac);
      if (clientId) {
        const res = await keyRequest(c, 'POST', `/proxy/network/integration/v1/sites/${siteId}/clients/${clientId}/actions`, { action: 'UNAUTHORIZE_GUEST_ACCESS' });
        if (res.status >= 200 && res.status < 300) return { ok: true };
      }
    } catch { /* fall through */ }
    const res = await keyRequest(c, 'POST', `${prefix(c)}/api/s/${site}/cmd/stamgr`, body);
    if (res.status === 200) return { ok: true };
    throw new Error(`Unauthorise failed (HTTP ${res.status})`);
  }
  const res = await credRequest(c, 'POST', `${prefix(c)}/api/s/${site}/cmd/stamgr`, body);
  if (res.status === 200 && res.json?.meta?.rc === 'ok') return { ok: true };
  throw new Error(`Unauthorise failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
}

async function testConnection() {
  const c = cfg();
  if (c.auth_mode === 'apikey' && !isStandalone(c)) {
    if (!c.api_key) throw new Error('API key is empty');
    const res = await keyRequest(c, 'GET', '/proxy/network/integration/v1/info');
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    siteIdCache = null;
    const siteId = await integrationSiteId(c);
    return `Connected via API key. Network application ${res.json?.applicationVersion || ''}, site id ${siteId}`;
  }
  cookieSession = null;
  await login(c);
  const res = await credRequest(c, 'GET', `${prefix(c)}/api/s/${c.site || 'default'}/stat/sysinfo`);
  if (res.status !== 200) throw new Error(`Logged in, but site "${c.site}" returned HTTP ${res.status}`);
  const info = res.json?.data?.[0] || {};
  return `Connected with ${isStandalone(c) ? 'standalone controller' : 'local admin'}. Network application ${info.version || ''} (${info.hostname || 'gateway'})`;
}

/**
 * List the WiFi networks (WLANs) on the site. `portal` is true when the SSID has the hotspot / guest portal switched on.
 */
async function listWlans() {
  const c = cfg();
  const site = c.site || 'default';
  const path = `${prefix(c)}/api/s/${site}/rest/wlanconf`;
  let res;
  if (c.auth_mode === 'apikey' && !isStandalone(c)) {
    if (!c.api_key) throw new Error('UniFi API key is not configured');
    res = await keyRequest(c, 'GET', path);
  } else {
    if (!c.username || !c.password) throw new Error('UniFi username/password are not configured');
    res = await credRequest(c, 'GET', path);
  }
  if (res.status !== 200 || !Array.isArray(res.json?.data)) throw new Error(`Could not list WiFi networks (HTTP ${res.status})`);
  return res.json.data.map((w) => ({ id: w._id, name: w.name, enabled: w.enabled !== false, portal: !!w.is_guest }));
}

// ---------- connected clients (cached briefly; used to verify guests and to keep hotspot devices out of /admin) ----------
let staCache = { at: 0, list: null };
async function listClients() {
  if (staCache.list && Date.now() - staCache.at < 15000) return staCache.list;
  const c = cfg();
  if (!c.username && !c.api_key) return null;
  const path = `${prefix(c)}/api/s/${c.site || 'default'}/stat/sta`;
  const res = c.auth_mode === 'apikey' && !isStandalone(c) ? await keyRequest(c, 'GET', path) : await credRequest(c, 'GET', path);
  if (res.status !== 200 || !Array.isArray(res.json?.data)) throw new Error(`Could not list clients (HTTP ${res.status})`);
  const list = res.json.data.map((x) => ({
    mac: normMac(x.mac), ip: x.ip || null, essid: x.essid || null, is_guest: !!x.is_guest,
    name: x.name || x.hostname || null, vendor: x.oui || null, ap_mac: normMac(x.ap_mac), wired: !!x.is_wired,
    signal: typeof x.signal === 'number' ? x.signal : null, rx_bytes: x.rx_bytes || 0, tx_bytes: x.tx_bytes || 0, uptime: x.uptime || 0,
  }));
  staCache = { at: Date.now(), list };
  return list;
}
/** The connected client with this MAC (fresh lookup, so a just-joined device is found), or null. */
async function clientByMac(mac) {
  const m = normMac(mac);
  if (!m) return null;
  let list = await listClients();
  let hit = list && list.find((x) => x.mac === m);
  if (!hit && list) { staCache.at = 0; list = await listClients(); hit = list && list.find((x) => x.mac === m); }
  return hit || null;
}
async function clientByIp(ip) {
  const want = String(ip || '').replace(/^::ffff:/, '');
  const list = await listClients();
  return (list && list.find((x) => x.ip === want)) || null;
}
// Access point names by MAC (for "connected to Lobby AP"), cached for a minute.
let devCache = { at: 0, map: null };
async function apNames() {
  if (devCache.map && Date.now() - devCache.at < 60000) return devCache.map;
  const c = cfg();
  if (!c.username && !c.api_key) return {};
  const path = `${prefix(c)}/api/s/${c.site || 'default'}/stat/device-basic`;
  const res = c.auth_mode === 'apikey' && !isStandalone(c) ? await keyRequest(c, 'GET', path) : await credRequest(c, 'GET', path);
  const map = {};
  for (const d of (res.status === 200 && res.json?.data) || []) map[normMac(d.mac)] = d.name || d.model || null;
  devCache = { at: Date.now(), map };
  return map;
}

// Never let a slow controller hang a request.
const withTimeout = (p, ms = 2500) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('UniFi lookup timed out')), ms))]);

module.exports = { authorize, unauthorize, testConnection, listWlans, normMac, listClients, clientByMac, clientByIp, apNames, withTimeout };
