// HTTPS certificate via Let's Encrypt using a *manual* DNS-01 challenge:
// the admin UI shows the TXT record to add, the admin adds it at their DNS host, then we verify and issue.
// Nothing needs to be publicly reachable. Certificates last 90 days; renewal repeats the same steps.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const acme = require('acme-client');
const { DATA_DIR, getSetting, setSetting, publicUrl } = require('./db');

const DIR = path.join(DATA_DIR, 'tls');
fs.mkdirSync(DIR, { recursive: true });
const FILES = { account: path.join(DIR, 'account.key'), key: path.join(DIR, 'key.pem'), cert: path.join(DIR, 'cert.pem') };

const DIRECTORIES = {
  production: acme.directory.letsencrypt.production,
  staging: acme.directory.letsencrypt.staging,
};
// ACME_DIRECTORY_URL overrides both (used for testing against a local Pebble server).
const directoryUrl = (env) => process.env.ACME_DIRECTORY_URL || DIRECTORIES[env] || DIRECTORIES.production;

function config() { return { email: '', environment: 'production', ...getSetting('tls', {}) }; }
function pending() { return getSetting('tls_pending', null); }
function setPending(p) { setSetting('tls_pending', p); }

const domain = () => (publicUrl() ? new URL(publicUrl()).hostname.toLowerCase() : '');

// ---------- installed certificate ----------
let listeners = [];
function onChange(fn) { listeners.push(fn); }

function certInfo() {
  if (!fs.existsSync(FILES.cert) || !fs.existsSync(FILES.key)) return null;
  try {
    const pem = fs.readFileSync(FILES.cert, 'utf8');
    const x = new crypto.X509Certificate(pem);
    const names = String(x.subjectAltName || '').split(',').map((s) => s.trim().replace(/^DNS:/, '').toLowerCase()).filter(Boolean);
    const expires = Math.floor(new Date(x.validTo).getTime() / 1000);
    const issuerOrg = (x.issuer.match(/O=([^\n]+)/) || [])[1] || x.issuer;
    return {
      names, expires, issuer: issuerOrg,
      issued: Math.floor(new Date(x.validFrom).getTime() / 1000),
      days_left: Math.floor((expires - Date.now() / 1000) / 86400),
      staging: /staging|fake|pebble/i.test(x.issuer),
      source: getSetting('tls_source', null),
    };
  } catch {
    return null;
  }
}

/** True when a valid certificate covering the public hostname is installed, so it's safe to send guests to HTTPS. */
function isActive() {
  const info = certInfo();
  const d = domain();
  return !!(info && d && info.expires > Date.now() / 1000 && info.names.some((n) => n === d || (n.startsWith('*.') && d.endsWith(n.slice(1)))));
}

function secureContextOptions() {
  if (!fs.existsSync(FILES.cert) || !fs.existsSync(FILES.key)) return null;
  return { cert: fs.readFileSync(FILES.cert), key: fs.readFileSync(FILES.key) };
}

// ---------- ACME client ----------
async function client() {
  const cfg = config();
  if (!fs.existsSync(FILES.account)) fs.writeFileSync(FILES.account, await acme.crypto.createPrivateKey(), { mode: 0o600 });
  const accountKey = fs.readFileSync(FILES.account);
  const accounts = getSetting('tls_accounts', {}) || {};
  const dirUrl = directoryUrl(cfg.environment);
  const c = new acme.Client({ directoryUrl: dirUrl, accountKey, accountUrl: accounts[dirUrl] || undefined });
  if (!accounts[dirUrl]) {
    await c.createAccount({ termsOfServiceAgreed: true, contact: cfg.email ? [`mailto:${cfg.email}`] : undefined });
    accounts[dirUrl] = c.getAccountUrl();
    setSetting('tls_accounts', accounts);
  }
  return c;
}

/** Step 1: create an order and return the TXT record(s) the admin must add. */
async function start() {
  const d = domain();
  if (!d) throw new Error('Set the public HTTPS address first.');
  const c = await client();
  const order = await c.createOrder({ identifiers: [{ type: 'dns', value: d }] });
  const authzs = await c.getAuthorizations(order);
  const records = [];
  for (const authz of authzs) {
    if (authz.status === 'valid') continue; // already validated recently, nothing to add
    const ch = authz.challenges.find((x) => x.type === 'dns-01');
    if (!ch) throw new Error('Let\'s Encrypt did not offer a DNS challenge for this name.');
    const value = await c.getChallengeKeyAuthorization(ch);
    const name = `_acme-challenge.${authz.identifier.value}`;
    // Most DNS panels want the name relative to the zone (e.g. "_acme-challenge.wifi" in example.co.uk).
    let zone = null;
    if (!process.env.ACME_DNS_CHECK_SERVERS) { try { zone = (await authoritativeServers(name)).zone; } catch { /* optional */ } }
    const host = zone && name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : null;
    records.push({ name, host, zone, type: 'TXT', value, challenge: ch, identifier: authz.identifier.value });
  }
  const p = { domain: d, environment: config().environment, directory: directoryUrl(config().environment), order, records, created_at: Math.floor(Date.now() / 1000), status: 'waiting_dns', error: null };
  setPending(p);
  return p;
}

// ---------- DNS lookup against the zone's authoritative servers ----------
async function authoritativeServers(fqdn) {
  const pub = new dns.Resolver();
  pub.setServers((process.env.ACME_DNS_RESOLVERS || '1.1.1.1,8.8.8.8').split(','));
  const labels = fqdn.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const zone = labels.slice(i).join('.');
    try {
      const ns = await pub.resolveNs(zone);
      if (ns.length) {
        const ips = [];
        for (const h of ns) { try { ips.push(...(await pub.resolve4(h))); } catch { /* skip */ } }
        if (ips.length) return { zone, ns, ips };
      }
    } catch { /* keep walking up */ }
  }
  return { zone: null, ns: [], ips: pub.getServers() };
}

/** Look up the challenge TXT records. Returns one entry per required record with what each DNS server currently answers. */
async function checkDns() {
  const p = pending();
  if (!p) throw new Error('No certificate request in progress.');
  const results = [];
  for (const r of p.records) {
    const auth = await dnsServersFor(r.name);
    const answers = await lookupTxt(auth.ips, r.name, r.value);
    results.push({ name: r.name, value: r.value, ns: auth.ns, answers, ok: answers.length > 0 && answers.every((a) => a.ok) });
  }
  const ok = results.every((x) => x.ok);
  setPending({ ...p, last_check: { at: Math.floor(Date.now() / 1000), ok, results } });
  return { ok, results };
}

async function lookupTxt(ips, name, value) {
    const answers = [];
    for (const ip of ips.slice(0, 4)) {
      const res = new dns.Resolver({ timeout: 3000, tries: 1 });
      res.setServers([ip]);
      try {
        const txt = (await res.resolveTxt(name)).map((parts) => parts.join(''));
        answers.push({ server: ip, values: txt, ok: txt.includes(value) });
      } catch (e) {
        answers.push({ server: ip, values: [], ok: false, error: e.code === 'ENOTFOUND' || e.code === 'ENODATA' ? 'not found yet' : e.code || e.message });
      }
    }
    return answers;
}
const dnsServersFor = async (name) => (process.env.ACME_DNS_CHECK_SERVERS ? { ips: process.env.ACME_DNS_CHECK_SERVERS.split(','), ns: [] } : authoritativeServers(name));

/** Step 2: tell Let's Encrypt to validate, then finalise and install the certificate. */
let finishing = false;
async function finish() {
  const p = pending();
  if (!p) throw new Error('No certificate request in progress.');
  if (finishing) throw new Error('Already verifying. Please wait.');
  finishing = true;
  setPending({ ...p, status: 'verifying', error: null });
  try {
    const c = await client();
    for (const r of p.records) {
      await c.completeChallenge(r.challenge);
      await c.waitForValidStatus(r.challenge);
    }
    const [key, csr] = await acme.crypto.createCsr({ commonName: p.domain, altNames: [p.domain] });
    let order = await c.getOrder(p.order);
    if (order.status !== 'valid') order = await c.finalizeOrder(order, csr);
    const certPem = await c.getCertificate(order);
    install(certPem, key, { type: 'manual' });
    setPending(null);
    return certInfo();
  } catch (e) {
    const msg = acmeError(e);
    setPending({ ...pending(), status: 'failed', error: msg });
    throw new Error(msg);
  } finally {
    finishing = false;
  }
}

function acmeError(e) {
  const m = String(e && e.message || e);
  if (/NXDOMAIN|No TXT record|incorrect TXT|value not found|DNS problem|unauthorized/i.test(m)) {
    return `Let's Encrypt couldn't see the right TXT record. Check it was added exactly as shown and that Check DNS shows it everywhere, then start a new request. The value changes each time. (${m})`;
  }
  return m;
}

function cancel() { setPending(null); }

function saveConfig({ email, environment }) {
  const cur = config();
  const next = { email: String(email || '').trim(), environment: environment === 'staging' ? 'staging' : 'production' };
  setSetting('tls', next);
  if (cur.environment !== next.environment) setPending(null); // an order belongs to one CA
}

function removeCertificate() {
  for (const f of [FILES.cert, FILES.key]) if (fs.existsSync(f)) fs.unlinkSync(f);
  listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

// ---------- installing a certificate (from any source) ----------
const now = () => Math.floor(Date.now() / 1000);
function install(certPem, keyPem, source) {
  require('tls').createSecureContext({ cert: certPem, key: keyPem }); // throws if Node can't use them
  fs.writeFileSync(FILES.key, keyPem, { mode: 0o600 });
  fs.writeFileSync(FILES.cert, certPem);
  setSetting('tls_source', { ...source, at: now() });
  setSetting('tls_last', { at: now(), ok: true, domain: domain() });
  listeners.forEach((fn) => { try { fn(); } catch (e) { console.error('[tls] listener', e.message); } });
  console.log(`[tls] certificate installed (${source.type}${source.provider ? ` via ${source.provider}` : ''})`);
}

// ---------- uploading your own certificate ----------
function pfxToPem(buf, passphrase) {
  const forge = require('node-forge');
  let p12;
  try { p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(buf.toString('binary')), String(passphrase || '')); } catch (e) {
    throw new Error(/password|MAC/i.test(e.message) ? 'The .pfx password is wrong.' : 'That .pfx/.p12 file couldn’t be read.');
  }
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b) => b.cert).filter(Boolean);
  const keyBag = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0]
    || (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])[0];
  if (!keyBag || !keyBag.key) throw new Error('No private key found in the .pfx file. (Files with EC keys aren’t supported here: export the certificate and key as PEM instead.)');
  return { certPem: certs.map((c) => forge.pki.certificateToPem(c)).join(''), keyPem: forge.pki.privateKeyToPem(keyBag.key) };
}

/** Check a certificate + key and return them ready to install (leaf first), with any warnings. */
function validateUpload({ certPem, keyPem }) {
  const blocks = String(certPem || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (!blocks.length) throw new Error('No certificate found. Paste the text that starts with -----BEGIN CERTIFICATE-----.');
  let key;
  try { key = crypto.createPrivateKey(String(keyPem || '')); } catch {
    throw new Error('The private key couldn’t be read. It must be an unencrypted PEM key (-----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----).');
  }
  const certs = blocks.map((b) => ({ pem: b, x: new crypto.X509Certificate(b) }));
  const leafIdx = certs.findIndex((c) => c.x.checkPrivateKey(key));
  if (leafIdx < 0) throw new Error('The private key doesn’t belong to this certificate.');
  const [leaf] = certs.splice(leafIdx, 1);
  const t = Date.now();
  if (new Date(leaf.x.validFrom).getTime() > t) throw new Error(`This certificate isn’t valid until ${leaf.x.validFrom}.`);
  if (new Date(leaf.x.validTo).getTime() < t) throw new Error(`This certificate expired on ${leaf.x.validTo}.`);
  const d = domain();
  if (d && !leaf.x.checkHost(d)) throw new Error(`This certificate is for ${leaf.x.subjectAltName || leaf.x.subject}, not ${d}. Change the public address or upload the right certificate.`);
  const warnings = [];
  if (!certs.length && leaf.x.issuer !== leaf.x.subject) warnings.push('No intermediate (chain) certificates were included, so some phones may not trust it. Paste the full chain if your provider gave you one.');
  if (leaf.x.issuer === leaf.x.subject) warnings.push('This is a self-signed certificate. Phones won’t trust it, and sign-in pop-ups may show a warning.');
  return { certPem: [leaf.pem, ...certs.map((c) => c.pem)].join('\n') + '\n', keyPem: key.export({ type: 'pkcs8', format: 'pem' }), warnings };
}

function uploadCertificate({ certPem, keyPem, pfx, passphrase }) {
  const pair = pfx ? pfxToPem(pfx, passphrase) : { certPem, keyPem };
  const v = validateUpload(pair);
  install(v.certPem, v.keyPem, { type: 'upload' });
  setPending(null);
  return { info: certInfo(), warnings: v.warnings };
}

// ---------- automatic issue & renewal through a DNS provider ----------
const dnsProviders = require('./dnsproviders');
function dnsConfig() {
  const c = { provider: '', zone: '', auto_renew: true, ...getSetting('tls_dns', {}) };
  if (c.provider === 'mydnshost' && /@/.test(c.domain || '') && !c.account) { c.account = c.domain; c.domain = c.zone || ''; }
  return c;
}
function saveDnsConfig(next) { setSetting('tls_dns', next); }
const job = () => getSetting('tls_job', null);
function jobLog(msg) {
  const j = job() || { log: [] };
  j.log = [...(j.log || []), { at: now(), msg }].slice(-40);
  setSetting('tls_job', j);
  console.log(`[tls-auto] ${msg}`);
}

async function waitForTxt(name, value) {
  const limit = Date.now() + Number(process.env.ACME_DNS_WAIT_MS || 6 * 60_000);
  const { ips } = await dnsServersFor(name);
  if (!ips.length) throw new Error(`Couldn’t find the DNS servers for ${name}.`);
  for (let attempt = 1; Date.now() < limit; attempt++) {
    const answers = await lookupTxt(ips, name, value);
    if (answers.length && answers.every((a) => a.ok)) return attempt;
    await new Promise((r) => setTimeout(r, Number(process.env.ACME_DNS_POLL_MS || 10_000)));
  }
  throw new Error('The TXT record didn’t appear on your DNS servers within 6 minutes.');
}

let autoRunning = false;
/** Start an automatic issue/renewal in the background. Progress is in job(). */
function autoIssue({ trigger = 'manual' } = {}) {
  if (autoRunning) throw new Error('A certificate request is already running.');
  const cfg = dnsConfig();
  const provider = dnsProviders.get(cfg.provider);
  if (!provider) throw new Error('Choose and save a DNS provider first.');
  const d = domain();
  if (!d) throw new Error('Set the public HTTPS address first.');
  autoRunning = true;
  setSetting('tls_job', { status: 'running', trigger, provider: provider.name, started: now(), log: [] });
  (async () => {
    const cleanups = [];
    try {
      jobLog(`Requesting a certificate for ${d} from Let’s Encrypt${trigger === 'renewal' ? ' (automatic renewal)' : ''}…`);
      const c = await client();
      const order = await c.createOrder({ identifiers: [{ type: 'dns', value: d }] });
      const pendingChallenges = [];
      for (const authz of await c.getAuthorizations(order)) {
        if (authz.status === 'valid') continue;
        const ch = authz.challenges.find((x) => x.type === 'dns-01');
        if (!ch) throw new Error('Let’s Encrypt did not offer a DNS challenge.');
        const value = await c.getChallengeKeyAuthorization(ch);
        const fqdn = `_acme-challenge.${authz.identifier.value}`;
        const zone = cfg.zone || (await authoritativeServers(fqdn)).zone;
        if (!zone) throw new Error(`Couldn’t work out which DNS zone ${fqdn} belongs to. Enter it under "Zone".`);
        jobLog(`Adding the TXT record at ${provider.name} (zone ${zone})…`);
        await provider.present(cfg, fqdn, value, zone);
        cleanups.push(async () => { await provider.cleanup(cfg, fqdn, value, zone); });
        pendingChallenges.push({ ch, fqdn, value });
      }
      for (const p of pendingChallenges) {
        jobLog('Waiting for the record to appear on your DNS servers…');
        const tries = await waitForTxt(p.fqdn, p.value);
        jobLog(`Record is live${tries > 1 ? ` (after ${tries} checks)` : ''}. Asking Let’s Encrypt to verify…`);
        await c.completeChallenge(p.ch);
        await c.waitForValidStatus(p.ch);
      }
      const [key, csr] = await acme.crypto.createCsr({ commonName: d, altNames: [d] });
      const final = await c.finalizeOrder(order, csr);
      install(await c.getCertificate(final), key, { type: 'auto', provider: provider.name });
      setPending(null);
      const info = certInfo();
      jobLog(`Certificate installed. Valid until ${new Date(info.expires * 1000).toUTCString()}.`);
      setSetting('tls_job', { ...job(), status: 'ok', finished: now(), error: null });
    } catch (e) {
      const msg = acmeError(e);
      jobLog(`Failed: ${msg}`);
      setSetting('tls_job', { ...job(), status: 'failed', finished: now(), error: msg });
    } finally {
      for (const fn of cleanups) {
        try { await fn(); jobLog('Removed the temporary TXT record.'); } catch (e) { jobLog(`Couldn’t remove the TXT record automatically (${e.message}). You can delete it yourself.`); }
      }
      autoRunning = false;
    }
  })();
}

// Renew automatically 30 days before expiry when the certificate came from a DNS provider.
function startRenewals() {
  const tick = () => {
    try {
      const info = certInfo();
      const cfg = dnsConfig();
      const j = job();
      if (!info || !info.source || info.source.type !== 'auto' || !cfg.auto_renew || autoRunning) return;
      if (info.days_left > 30) return;
      if (j && j.status === 'failed' && now() - (j.finished || 0) < 6 * 3600) return; // retry at most every 6 hours
      autoIssue({ trigger: 'renewal' });
    } catch (e) { console.error('[tls-auto] renewal check:', e.message); }
  };
  setTimeout(tick, 2 * 60_000).unref();
  setInterval(tick, 6 * 3600_000).unref();
}

module.exports = {
  uploadCertificate, validateUpload, dnsConfig, saveDnsConfig, autoIssue, job, startRenewals, isAutoRunning: () => autoRunning,
  authoritativeServers,
  config, saveConfig, pending, start, checkDns, finish, cancel, certInfo, isActive, domain,
  secureContextOptions, onChange, removeCertificate,
};
