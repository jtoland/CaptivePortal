// SSO provider instances: Google, Microsoft/Entra ID, Facebook, Apple, generic OIDC (OAuth2 auth-code + PKCE) and SAML 2.0.
// Any number of instances of each type can exist (e.g. two Entra ID tenants), each with its own id, label and credentials.
// ID tokens are received directly from the provider's token endpoint over TLS, which the OIDC spec
// (Core 3.1.3.7) allows as the validation of the token's origin.

const crypto = require('crypto');
const { getSetting, setSetting, publicUrl } = require('./db');

const TYPES = {
  google: { label: 'Google', button: 'Continue with Google', fields: { client_id: '', client_secret: '' }, secrets: ['client_secret'] },
  microsoft: { label: 'Microsoft / Entra ID', button: 'Continue with Microsoft', fields: { client_id: '', client_secret: '', tenant: 'common', allowed_tenants: '' }, secrets: ['client_secret'] },
  facebook: { label: 'Facebook', button: 'Continue with Facebook', fields: { app_id: '', app_secret: '' }, secrets: ['app_secret'] },
  apple: { label: 'Apple', button: 'Continue with Apple', fields: { client_id: '', team_id: '', key_id: '', private_key: '' }, secrets: ['private_key'] },
  oidc: { label: 'OpenID Connect', button: 'Single Sign-On', fields: { issuer: '', client_id: '', client_secret: '', scope: 'openid email profile' }, secrets: ['client_secret'] },
  saml: { label: 'SAML 2.0', button: 'Company SSO', fields: { entry_point: '', idp_issuer: '', sp_entity_id: '', idp_cert: '', email_attribute: '' }, secrets: [] },
};

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) throw new Error('Invalid id_token');
  return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

function publicBase(req) {
  if (publicUrl()) return publicUrl();
  return `${req.protocol}://${req.get('host')}`;
}
const callbackUrl = (req, id) => `${publicBase(req)}/auth/${id}/callback`;

// ---------- instance storage ----------
function list() {
  let items = getSetting('sso_providers', null);
  if (!items) {
    // Migrate the old one-per-type settings; keep the type as the id so existing callback URLs keep working.
    const old = getSetting('sso', {}) || {};
    items = [];
    for (const type of Object.keys(TYPES)) {
      const c = old[type];
      if (!c) continue;
      const { display_name: label, ...fields } = c;
      const inst = { id: type, type, label: label || '', ...TYPES[type].fields, ...fields };
      if (isConfigured(inst)) items.push(inst);
    }
    setSetting('sso_providers', items);
  }
  return items;
}
const get = (id) => list().find((p) => p.id === id) || null;
function saveAll(items) { setSetting('sso_providers', items); }

function create(type, label) {
  if (!TYPES[type]) throw new Error('Unknown provider type');
  const items = list();
  let id = type;
  while (items.some((p) => p.id === id)) id = `${type}-${crypto.randomBytes(2).toString('hex')}`;
  const inst = { id, type, label: label || '', ...TYPES[type].fields };
  items.push(inst);
  saveAll(items);
  return inst;
}
function update(id, fields) {
  const items = list();
  const i = items.findIndex((p) => p.id === id);
  if (i < 0) return null;
  items[i] = { ...items[i], ...fields, id, type: items[i].type };
  saveAll(items);
  return items[i];
}
function remove(id) { saveAll(list().filter((p) => p.id !== id)); }

function isConfigured(p) {
  if (!p) return false;
  switch (p.type) {
    case 'google': return !!(p.client_id && p.client_secret);
    case 'microsoft': return !!(p.client_id && p.client_secret);
    case 'facebook': return !!(p.app_id && p.app_secret);
    case 'apple': return !!(p.client_id && p.team_id && p.key_id && p.private_key);
    case 'oidc': return !!(p.issuer && p.client_id);
    case 'saml': return !!(p.entry_point && p.idp_cert);
    default: return false;
  }
}

/** Is a Microsoft provider limited to specific organisations (so its email claims can be trusted for domain rules)? */
function tenantPinned(p) {
  if (!p || p.type !== 'microsoft') return true;
  if (String(p.allowed_tenants || '').split(',').some((t) => t.trim())) return true;
  return !['', 'common', 'organizations', 'consumers'].includes(String(p.tenant || '').trim().toLowerCase());
}

/** Button text guests see. */
const buttonLabel = (p) => p.label || TYPES[p.type]?.button || p.id;
/** Name shown in the admin. */
const adminName = (p) => p.label || TYPES[p.type]?.label || p.id;

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token exchange failed: ${json.error_description || json.error?.message || json.error || res.status}`);
  return json;
}

const discoveryCache = new Map();
async function discover(issuer) {
  const key = issuer.replace(/\/+$/, '');
  const hit = discoveryCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.doc;
  const res = await fetch(`${key}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${key} (HTTP ${res.status})`);
  const doc = await res.json();
  discoveryCache.set(key, { at: Date.now(), doc });
  return doc;
}

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function appleClientSecret(c) {
  const header = { alg: 'ES256', kid: c.key_id };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: c.team_id, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: c.client_id };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: c.private_key.replace(/\\n/g, '\n'), dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

// ---------- SAML ----------
let samlLib = null;
const spEntityId = (req, p) => p.sp_entity_id || `${publicBase(req)}/auth/${p.id}/metadata`;
function samlClient(req, p) {
  if (!samlLib) samlLib = require('@node-saml/node-saml');
  return new samlLib.SAML({
    entryPoint: p.entry_point,
    issuer: spEntityId(req, p),
    idpIssuer: p.idp_issuer || undefined,
    idpCert: p.idp_cert,
    callbackUrl: callbackUrl(req, p.id),
    wantAssertionsSigned: false,
    wantAuthnResponseSigned: false,
    audience: spEntityId(req, p), // reject assertions the IdP issued for other apps
    acceptedClockSkewMs: 5 * 60 * 1000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  });
}
const samlMetadata = (req, p) => samlClient(req, p).generateServiceProviderMetadata(null, null);

/** Build the provider redirect URL. Returns { url, data } where data is stored alongside the state. */
async function authUrl(p, req, state) {
  const redirect_uri = callbackUrl(req, p.id);
  const nonce = b64url(crypto.randomBytes(16));

  if (p.type === 'google') {
    const k = pkce();
    const q = new URLSearchParams({
      client_id: p.client_id, redirect_uri, response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: k.challenge, code_challenge_method: 'S256', prompt: 'select_account',
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, data: { verifier: k.verifier, nonce } };
  }
  if (p.type === 'microsoft') {
    const k = pkce();
    const q = new URLSearchParams({
      client_id: p.client_id, redirect_uri, response_type: 'code', scope: 'openid email profile',
      response_mode: 'query', state, nonce, code_challenge: k.challenge, code_challenge_method: 'S256', prompt: 'select_account',
    });
    return { url: `https://login.microsoftonline.com/${encodeURIComponent(p.tenant || 'common')}/oauth2/v2.0/authorize?${q}`, data: { verifier: k.verifier, nonce } };
  }
  if (p.type === 'facebook') {
    const q = new URLSearchParams({ client_id: p.app_id, redirect_uri, state, scope: 'email,public_profile', response_type: 'code' });
    return { url: `https://www.facebook.com/v19.0/dialog/oauth?${q}`, data: {} };
  }
  if (p.type === 'apple') {
    const q = new URLSearchParams({ client_id: p.client_id, redirect_uri, response_type: 'code', scope: 'name email', response_mode: 'form_post', state, nonce });
    return { url: `https://appleid.apple.com/auth/authorize?${q}`, data: { nonce } };
  }
  if (p.type === 'oidc') {
    const d = await discover(p.issuer);
    const k = pkce();
    const q = new URLSearchParams({
      client_id: p.client_id, redirect_uri, response_type: 'code', scope: p.scope || 'openid email profile',
      state, nonce, code_challenge: k.challenge, code_challenge_method: 'S256',
    });
    return { url: `${d.authorization_endpoint}?${q}`, data: { verifier: k.verifier, nonce } };
  }
  if (p.type === 'saml') {
    const url = await samlClient(req, p).getAuthorizeUrlAsync(state, req.get('host'), {});
    return { url, data: {} };
  }
  throw new Error(`Unknown provider type ${p.type}`);
}

/** Exchange the callback for a user identity. Returns { email, name, sub, extra }. */
async function handleCallback(p, req, stored) {
  const params = { ...req.query, ...req.body };
  if (params.error) throw new Error(`Sign-in was cancelled or failed: ${params.error_description || params.error}`);
  const redirect_uri = callbackUrl(req, p.id);

  if (p.type === 'google' || p.type === 'microsoft' || p.type === 'oidc') {
    let tokenEndpoint;
    const body = { grant_type: 'authorization_code', code: params.code, redirect_uri, client_id: p.client_id, code_verifier: stored.verifier };
    if (p.client_secret) body.client_secret = p.client_secret;
    if (p.type === 'google') tokenEndpoint = 'https://oauth2.googleapis.com/token';
    else if (p.type === 'microsoft') tokenEndpoint = `https://login.microsoftonline.com/${encodeURIComponent(p.tenant || 'common')}/oauth2/v2.0/token`;
    else tokenEndpoint = (await discover(p.issuer)).token_endpoint;

    const tok = await postForm(tokenEndpoint, body);
    const claims = decodeJwt(tok.id_token);
    if (stored.nonce && claims.nonce && claims.nonce !== stored.nonce) throw new Error('Nonce mismatch');
    if (![].concat(claims.aud || []).includes(p.client_id)) throw new Error('id_token audience mismatch');

    if (p.type === 'microsoft' && p.allowed_tenants) {
      const allowed = p.allowed_tenants.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (allowed.length && !allowed.includes(String(claims.tid || '').toLowerCase())) {
        throw new Error('Your Microsoft account belongs to an organisation that is not allowed on this network.');
      }
    }
    if ((p.type === 'google' || p.type === 'oidc') && claims.email_verified === false) throw new Error('Your email address hasn\u2019t been verified with this sign-in provider.');
    let email = claims.email || claims.preferred_username || claims.upn || '';
    let name = claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ');
    if (p.type === 'oidc' && !email && tok.access_token) {
      const d = await discover(p.issuer);
      if (d.userinfo_endpoint) {
        const ui = await (await fetch(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
        email = ui.email || ui.preferred_username || '';
        name = name || ui.name || '';
      }
    }
    return { email, name, sub: claims.sub, extra: p.type === 'microsoft' ? { tid: claims.tid } : {} };
  }

  if (p.type === 'facebook') {
    const q = new URLSearchParams({ client_id: p.app_id, client_secret: p.app_secret, redirect_uri, code: params.code });
    const tokRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${q}`);
    const tok = await tokRes.json();
    if (!tok.access_token) throw new Error(`Facebook token exchange failed: ${tok.error?.message || tokRes.status}`);
    const proof = crypto.createHmac('sha256', p.app_secret).update(tok.access_token).digest('hex');
    const me = await (await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name,email&access_token=${encodeURIComponent(tok.access_token)}&appsecret_proof=${proof}`)).json();
    if (!me.id) throw new Error('Could not read Facebook profile');
    return { email: me.email || '', name: me.name || '', sub: me.id, extra: {} };
  }

  if (p.type === 'apple') {
    const tok = await postForm('https://appleid.apple.com/auth/token', {
      grant_type: 'authorization_code', code: params.code, redirect_uri, client_id: p.client_id, client_secret: appleClientSecret(p),
    });
    const claims = decodeJwt(tok.id_token);
    if (claims.aud !== p.client_id) throw new Error('Apple id_token audience mismatch');
    if (stored.nonce && claims.nonce && claims.nonce !== stored.nonce) throw new Error('Nonce mismatch');
    let name = '';
    try {
      const u = JSON.parse(params.user || '{}');
      name = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(' ');
    } catch { /* only sent on first sign-in */ }
    return { email: claims.email || '', name, sub: claims.sub, extra: {} };
  }

  if (p.type === 'saml') {
    const { profile } = await samlClient(req, p).validatePostResponseAsync(req.body);
    if (!profile) throw new Error('SAML response did not contain a profile');
    const attr = p.email_attribute;
    const email = (attr && profile[attr]) || profile.email || profile.mail
      || profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] || profile.nameID || '';
    const name = profile.displayName || profile['http://schemas.microsoft.com/identity/claims/displayname']
      || profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] || '';
    return { email: String(email), name: String(name), sub: profile.nameID, extra: {} };
  }

  throw new Error(`Unknown provider type ${p.type}`);
}

// Domains guests must be able to reach before they are authorised (UniFi "Pre-Authorization Allowances").
const WALLED_GARDEN = {
  google: ['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'ssl.gstatic.com', 'www.gstatic.com', 'fonts.gstatic.com', 'fonts.googleapis.com', 'apis.google.com', 'play.google.com', 'lh3.googleusercontent.com'],
  microsoft: ['login.microsoftonline.com', 'login.microsoft.com', 'login.live.com', 'aadcdn.msftauth.net', 'aadcdn.msauth.net', 'logincdn.msauth.net', 'account.live.com', 'msauth.net', 'msftauth.net'],
  facebook: ['www.facebook.com', 'm.facebook.com', 'facebook.com', 'static.xx.fbcdn.net', 'connect.facebook.net', 'graph.facebook.com', 'fbcdn.net'],
  apple: ['appleid.apple.com', 'appleid.cdn-apple.com', 'idmsa.apple.com', 'gsa.apple.com', 'iforgot.apple.com', 'www.apple.com'],
};

/** One entry per provider type in use (fixed domains), plus each OIDC/SAML instance's own host. */
function walledGarden() {
  const out = [];
  const host = (u) => { try { return new URL(u).hostname; } catch { return null; } };
  const configured = list().filter(isConfigured);
  for (const type of Object.keys(WALLED_GARDEN)) {
    if (configured.some((p) => p.type === type)) out.push({ type, name: TYPES[type].label, domains: WALLED_GARDEN[type] });
  }
  for (const p of configured) {
    if (p.type === 'oidc' || p.type === 'saml') {
      const h = host(p.type === 'oidc' ? p.issuer : p.entry_point);
      if (h) out.push({ type: p.type, name: adminName(p), domains: [h] });
    }
  }
  return out;
}

module.exports = {
  TYPES, list, get, create, update, remove, isConfigured, tenantPinned, buttonLabel, adminName,
  authUrl, handleCallback, samlMetadata, spEntityId, walledGarden, callbackUrl, publicBase,
};
