// DNS providers for automatic Let's Encrypt DNS-01 challenges.
// Each provider can add (present) and remove (cleanup) the _acme-challenge TXT record through its API,
// and has a read-only test() used by "Test connection" in Settings.
//
// API base URLs can be overridden with DNS_API_<PROVIDER> environment variables (used for testing against mocks).

const crypto = require('crypto');

const base = (id, def) => (process.env[`DNS_API_${id.toUpperCase()}`] || def).replace(/\/+$/, '');

async function http(method, url, { headers = {}, body, form } = {}) {
  const opts = { method, headers: { Accept: 'application/json', ...headers } };
  if (form) { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json'; opts.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}
function fail(provider, what, r) {
  const detail = (r.json && (r.json.message || r.json.error_description || (r.json.error && (r.json.error.message || r.json.error)) || (r.json.errors && JSON.stringify(r.json.errors).slice(0, 200)) || r.json.cause))
    || r.text.slice(0, 200);
  return new Error(`${provider}: ${what} failed (HTTP ${r.status})${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const relative = (fqdn, zone) => (fqdn === zone ? '@' : fqdn.slice(0, -(zone.length + 1)));
const b64url = (b) => Buffer.from(b).toString('base64url');

// ---------------- MyDNSHost ----------------
// Uses its built-in ACME endpoints (/external/httpreq/present|cleanup). Works with either a domain key (limited to one
// domain, recommended) or an account API key (sent with the account's email; needs "domains_write").
const mydnshost = {
  id: 'mydnshost', name: 'MyDNSHost',
  help: 'Either create a domain key (your domain → Domain keys; it can only touch that one domain, recommended), or use an account API key (Profile → API keys, with domains write permission) together with your account email.',
  fields: [
    { key: 'domain', label: 'Domain', placeholder: 'example.com' },
    { key: 'domain_key', label: 'Domain key or API key', secret: true },
    { key: 'account', label: 'Account email (optional)', placeholder: 'Only for an account API key' },
  ],
  // Older saves put the account email in the Domain box. Treat that as an account key.
  norm(c, zone) {
    const domainLooksLikeEmail = /@/.test(c.domain || '');
    const account = (c.account || (domainLooksLikeEmail ? c.domain : '') || '').trim();
    const domain = (domainLooksLikeEmail ? '' : c.domain || '').trim() || zone || '';
    return { account, domain, key: c.domain_key };
  },
  headers(c, zone) {
    const n = this.norm(c, zone);
    return n.account ? { 'X-API-User': n.account, 'X-API-Key': n.key } : { 'X-Domain': n.domain, 'X-Domain-Key': n.key };
  },
  hint(r) {
    if (r.status === 401 || /Authentication required/i.test(r.text)) return new Error('MyDNSHost rejected the key. A domain key needs the domain name; an account API key also needs your account email (Account email box).');
    if (r.status === 403 || /permission/i.test(r.text)) return new Error('MyDNSHost: this key isn’t allowed to change DNS records. Give it write access (domains_write).');
    return null;
  },
  async present(c, fqdn, value, zone) {
    const r = await http('POST', `${base('mydnshost', 'https://api.mydnshost.co.uk/1.0')}/external/httpreq/present`, { headers: this.headers(c, zone), body: { fqdn, value } });
    if (!r.ok || (r.json && r.json.error)) throw this.hint(r) || fail('MyDNSHost', 'adding the TXT record', r);
  },
  async cleanup(c, fqdn, value, zone) {
    await http('POST', `${base('mydnshost', 'https://api.mydnshost.co.uk/1.0')}/external/httpreq/cleanup`, { headers: this.headers(c, zone), body: { fqdn, value } });
  },
  async test(c, zone) {
    const n = this.norm(c, zone);
    const r = await http('GET', `${base('mydnshost', 'https://api.mydnshost.co.uk/1.0')}/domains/${encodeURIComponent(n.domain)}`, { headers: this.headers(c, zone) });
    if (!r.ok || (r.json && r.json.error)) throw this.hint(r) || fail('MyDNSHost', 'reading the domain', r);
    return `Connected to MyDNSHost with ${n.account ? `the account API key for ${n.account}` : 'a domain key'}. Domain ${n.domain} is accessible.`;
  },
};

// ---------------- Cloudflare ----------------
const cloudflare = {
  id: 'cloudflare', name: 'Cloudflare',
  help: 'Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit zone DNS" template, limited to your zone.',
  fields: [{ key: 'api_token', label: 'API token', secret: true }],
  api: () => base('cloudflare', 'https://api.cloudflare.com/client/v4'),
  h: (c) => ({ Authorization: `Bearer ${c.api_token}` }),
  async zoneId(c, zone) {
    const r = await http('GET', `${this.api()}/zones?name=${encodeURIComponent(zone)}`, { headers: this.h(c) });
    if (!r.ok) throw fail('Cloudflare', 'finding the zone', r);
    const z = (r.json.result || [])[0];
    if (!z) throw new Error(`Cloudflare: zone ${zone} isn't in this account, or the token can't see it.`);
    return z.id;
  },
  async present(c, fqdn, value, zone) {
    const id = await this.zoneId(c, zone);
    const r = await http('POST', `${this.api()}/zones/${id}/dns_records`, { headers: this.h(c), body: { type: 'TXT', name: fqdn, content: value, ttl: 60 } });
    if (!r.ok) throw fail('Cloudflare', 'adding the TXT record', r);
  },
  async cleanup(c, fqdn, value, zone) {
    const id = await this.zoneId(c, zone);
    const r = await http('GET', `${this.api()}/zones/${id}/dns_records?type=TXT&name=${encodeURIComponent(fqdn)}`, { headers: this.h(c) });
    for (const rec of (r.json && r.json.result) || []) {
      if (String(rec.content).replace(/^"|"$/g, '') === value) await http('DELETE', `${this.api()}/zones/${id}/dns_records/${rec.id}`, { headers: this.h(c) });
    }
  },
  async test(c, zone) { await this.zoneId(c, zone); return `Connected to Cloudflare. Zone ${zone} found.`; },
};

// ---------------- Amazon Route 53 (AWS Signature V4, no SDK) ----------------
function sigv4({ method, url, region, service, accessKey, secretKey, body = '', amzDate }) {
  const u = new URL(url);
  const date = amzDate || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  const query = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonicalHeaders = `host:${u.host}\nx-amz-date:${date}\n`;
  const signedHeaders = 'host;x-amz-date';
  const canonical = [method, u.pathname || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    'X-Amz-Date': date,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
const route53 = {
  id: 'route53', name: 'Amazon Route 53',
  help: 'AWS IAM → create a user (or access key) with permission route53:ListHostedZonesByName, route53:ChangeResourceRecordSets and route53:GetChange on your hosted zone.',
  fields: [
    { key: 'access_key_id', label: 'Access key ID' },
    { key: 'secret_access_key', label: 'Secret access key', secret: true },
    { key: 'hosted_zone_id', label: 'Hosted zone ID (optional)', placeholder: 'Found automatically if left blank' },
  ],
  api: () => base('route53', 'https://route53.amazonaws.com'),
  async req(c, method, path, body = '') {
    const url = `${this.api()}${path}`;
    const headers = sigv4({ method, url, region: 'us-east-1', service: 'route53', accessKey: c.access_key_id, secretKey: c.secret_access_key, body });
    return http(method, url, { headers: { ...headers, ...(body ? { 'Content-Type': 'text/xml' } : {}) }, body: body || undefined });
  },
  async zoneId(c, zone) {
    if (c.hosted_zone_id) return c.hosted_zone_id.replace(/^\/?hostedzone\//, '');
    const r = await this.req(c, 'GET', `/2013-04-01/hostedzonesbyname?dnsname=${encodeURIComponent(zone)}&maxitems=1`);
    if (!r.ok) throw fail('Route 53', 'finding the hosted zone', r);
    const m = r.text.match(/<HostedZone>\s*<Id>\/hostedzone\/([^<]+)<\/Id>\s*<Name>([^<]+)<\/Name>/);
    if (!m || m[2].replace(/\.$/, '') !== zone) throw new Error(`Route 53: hosted zone ${zone} not found in this account.`);
    return m[1];
  },
  change(action, fqdn, value) {
    return `<?xml version="1.0" encoding="UTF-8"?><ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch><Changes><Change><Action>${action}</Action><ResourceRecordSet><Name>${fqdn}.</Name><Type>TXT</Type><TTL>60</TTL><ResourceRecords><ResourceRecord><Value>"${value}"</Value></ResourceRecord></ResourceRecords></ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
  },
  async present(c, fqdn, value, zone) {
    const id = await this.zoneId(c, zone);
    const r = await this.req(c, 'POST', `/2013-04-01/hostedzone/${id}/rrset`, this.change('UPSERT', fqdn, value));
    if (!r.ok) throw fail('Route 53', 'adding the TXT record', r);
  },
  async cleanup(c, fqdn, value, zone) {
    const id = await this.zoneId(c, zone);
    await this.req(c, 'POST', `/2013-04-01/hostedzone/${id}/rrset`, this.change('DELETE', fqdn, value));
  },
  async test(c, zone) { const id = await this.zoneId(c, zone); return `Connected to Route 53. Hosted zone ${zone} (${id}) found.`; },
};

// ---------------- Microsoft Azure DNS ----------------
const azure = {
  id: 'azure', name: 'Microsoft Azure DNS',
  help: 'Create an app registration with a client secret, and give it the "DNS Zone Contributor" role on your DNS zone.',
  fields: [
    { key: 'tenant_id', label: 'Tenant ID' },
    { key: 'client_id', label: 'Client (application) ID' },
    { key: 'client_secret', label: 'Client secret', secret: true },
    { key: 'subscription_id', label: 'Subscription ID' },
    { key: 'resource_group', label: 'Resource group' },
  ],
  async token(c) {
    const r = await http('POST', `${base('azure_login', 'https://login.microsoftonline.com')}/${encodeURIComponent(c.tenant_id)}/oauth2/v2.0/token`, {
      form: { grant_type: 'client_credentials', client_id: c.client_id, client_secret: c.client_secret, scope: 'https://management.azure.com/.default' },
    });
    if (!r.ok || !r.json.access_token) throw fail('Azure', 'signing in', r);
    return r.json.access_token;
  },
  url(c, zone, rel) {
    const z = `${base('azure', 'https://management.azure.com')}/subscriptions/${c.subscription_id}/resourceGroups/${encodeURIComponent(c.resource_group)}/providers/Microsoft.Network/dnsZones/${zone}`;
    return rel === undefined ? `${z}?api-version=2018-05-01` : `${z}/TXT/${encodeURIComponent(rel)}?api-version=2018-05-01`;
  },
  async present(c, fqdn, value, zone) {
    const t = await this.token(c);
    const r = await http('PUT', this.url(c, zone, relative(fqdn, zone)), { headers: { Authorization: `Bearer ${t}` }, body: { properties: { TTL: 60, TXTRecords: [{ value: [value] }] } } });
    if (!r.ok) throw fail('Azure', 'adding the TXT record', r);
  },
  async cleanup(c, fqdn, value, zone) {
    const t = await this.token(c);
    await http('DELETE', this.url(c, zone, relative(fqdn, zone)), { headers: { Authorization: `Bearer ${t}` } });
  },
  async test(c, zone) {
    const t = await this.token(c);
    const r = await http('GET', this.url(c, zone), { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) throw fail('Azure', 'reading the DNS zone', r);
    return `Connected to Azure. DNS zone ${zone} found.`;
  },
};

// ---------------- Google Cloud DNS ----------------
const google = {
  id: 'gcloud', name: 'Google Cloud DNS',
  help: 'Google Cloud → IAM → Service accounts → create one with the "DNS Administrator" role → Keys → Add key (JSON). Paste the whole JSON file.',
  fields: [{ key: 'service_account_json', label: 'Service account key (JSON)', secret: true, textarea: true }],
  creds(c) {
    let sa;
    try { sa = JSON.parse(c.service_account_json); } catch { throw new Error('Google Cloud DNS: the service account key isn’t valid JSON.'); }
    if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('Google Cloud DNS: the key JSON needs client_email, private_key and project_id.');
    return sa;
  },
  async token(c) {
    const sa = this.creds(c);
    const now = Math.floor(Date.now() / 1000);
    const tokenUrl = base('gcloud_token', 'https://oauth2.googleapis.com/token');
    const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/ndev.clouddns.readwrite', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    }))}`;
    const jwt = `${input}.${b64url(crypto.sign('sha256', Buffer.from(input), sa.private_key))}`;
    const r = await http('POST', tokenUrl, { form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt } });
    if (!r.ok || !r.json.access_token) throw fail('Google Cloud DNS', 'signing in', r);
    return { token: r.json.access_token, project: sa.project_id };
  },
  api: () => base('gcloud', 'https://dns.googleapis.com/dns/v1'),
  async zone(c, zone) {
    const { token, project } = await this.token(c);
    const r = await http('GET', `${this.api()}/projects/${project}/managedZones?dnsName=${encodeURIComponent(zone + '.')}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw fail('Google Cloud DNS', 'finding the managed zone', r);
    const z = (r.json.managedZones || [])[0];
    if (!z) throw new Error(`Google Cloud DNS: no managed zone for ${zone} in project ${project}.`);
    return { token, project, name: z.name };
  },
  async change(c, zone, kind, fqdn, value) {
    const z = await this.zone(c, zone);
    const rec = { name: `${fqdn}.`, type: 'TXT', ttl: 60, rrdatas: [`"${value}"`] };
    return http('POST', `${this.api()}/projects/${z.project}/managedZones/${z.name}/changes`, { headers: { Authorization: `Bearer ${z.token}` }, body: { [kind]: [rec] } });
  },
  async present(c, fqdn, value, zone) {
    const r = await this.change(c, zone, 'additions', fqdn, value);
    if (!r.ok) throw fail('Google Cloud DNS', 'adding the TXT record', r);
  },
  async cleanup(c, fqdn, value, zone) { await this.change(c, zone, 'deletions', fqdn, value); },
  async test(c, zone) { const z = await this.zone(c, zone); return `Connected to Google Cloud DNS. Managed zone "${z.name}" found.`; },
};

// ---------------- DigitalOcean ----------------
const digitalocean = {
  id: 'digitalocean', name: 'DigitalOcean',
  help: 'DigitalOcean → API → Generate New Token with read and write scope (or custom scope: domain read/write).',
  fields: [{ key: 'api_token', label: 'API token', secret: true }],
  api: () => base('digitalocean', 'https://api.digitalocean.com/v2'),
  h: (c) => ({ Authorization: `Bearer ${c.api_token}` }),
  async present(c, fqdn, value, zone) {
    const r = await http('POST', `${this.api()}/domains/${zone}/records`, { headers: this.h(c), body: { type: 'TXT', name: relative(fqdn, zone), data: value, ttl: 60 } });
    if (!r.ok) throw fail('DigitalOcean', 'adding the TXT record', r);
  },
  async cleanup(c, fqdn, value, zone) {
    const r = await http('GET', `${this.api()}/domains/${zone}/records?type=TXT&name=${encodeURIComponent(fqdn)}&per_page=200`, { headers: this.h(c) });
    for (const rec of (r.json && r.json.domain_records) || []) {
      if (rec.data === value) await http('DELETE', `${this.api()}/domains/${zone}/records/${rec.id}`, { headers: this.h(c) });
    }
  },
  async test(c, zone) {
    const r = await http('GET', `${this.api()}/domains/${zone}`, { headers: this.h(c) });
    if (!r.ok) throw fail('DigitalOcean', 'reading the domain', r);
    return `Connected to DigitalOcean. Domain ${zone} found.`;
  },
};

// ---------------- Hetzner DNS ----------------
// Hetzner's DNS API (dns.hetzner.com). Note: Hetzner is moving DNS into the Hetzner Console; zones moved there use a new API.
const hetzner = {
  id: 'hetzner', name: 'Hetzner DNS',
  help: 'dns.hetzner.com → API tokens → create a token. (Zones already moved into the new Hetzner Console use a different API that isn’t supported yet.)',
  fields: [{ key: 'api_token', label: 'API token', secret: true }],
  api: () => base('hetzner', 'https://dns.hetzner.com/api/v1'),
  h: (c) => ({ 'Auth-API-Token': c.api_token }),
  async zoneId(c, zone) {
    const r = await http('GET', `${this.api()}/zones?name=${encodeURIComponent(zone)}`, { headers: this.h(c) });
    if (!r.ok) throw fail('Hetzner', 'finding the zone', r);
    const z = (r.json.zones || [])[0];
    if (!z) throw new Error(`Hetzner: zone ${zone} not found.`);
    return z.id;
  },
  async present(c, fqdn, value, zone) {
    const id = await this.zoneId(c, zone);
    const r = await http('POST', `${this.api()}/records`, { headers: this.h(c), body: { zone_id: id, type: 'TXT', name: relative(fqdn, zone), value, ttl: 60 } });
    if (!r.ok) throw fail('Hetzner', 'adding the TXT record', r);
  },
  async cleanup(c, fqdn, value, zone) {
    const id = await this.zoneId(c, zone);
    const r = await http('GET', `${this.api()}/records?zone_id=${id}`, { headers: this.h(c) });
    const rel = relative(fqdn, zone);
    for (const rec of (r.json && r.json.records) || []) {
      if (rec.type === 'TXT' && rec.name === rel && String(rec.value).replace(/^"|"$/g, '') === value) await http('DELETE', `${this.api()}/records/${rec.id}`, { headers: this.h(c) });
    }
  },
  async test(c, zone) { await this.zoneId(c, zone); return `Connected to Hetzner. Zone ${zone} found.`; },
};

// ---------------- Gandi LiveDNS ----------------
const gandi = {
  id: 'gandi', name: 'Gandi',
  help: 'Gandi Admin → Organizations → Manage → Personal Access Tokens → create one with "Manage domain name technical configurations".',
  fields: [{ key: 'pat', label: 'Personal access token', secret: true }],
  api: () => base('gandi', 'https://api.gandi.net/v5/livedns'),
  h: (c) => ({ Authorization: `Bearer ${c.pat}` }),
  url(zone, fqdn) { return `${this.api()}/domains/${zone}/records/${encodeURIComponent(relative(fqdn, zone))}/TXT`; },
  async present(c, fqdn, value, zone) {
    const r = await http('PUT', this.url(zone, fqdn), { headers: this.h(c), body: { rrset_ttl: 300, rrset_values: [`"${value}"`] } });
    if (!r.ok) throw fail('Gandi', 'adding the TXT record', r);
  },
  async cleanup(c, fqdn, value, zone) { await http('DELETE', this.url(zone, fqdn), { headers: this.h(c) }); },
  async test(c, zone) {
    const r = await http('GET', `${this.api()}/domains/${zone}`, { headers: this.h(c) });
    if (!r.ok) throw fail('Gandi', 'reading the domain', r);
    return `Connected to Gandi. Domain ${zone} found.`;
  },
};

const PROVIDERS = [mydnshost, cloudflare, route53, azure, google, digitalocean, hetzner, gandi];
const get = (id) => PROVIDERS.find((p) => p.id === id) || null;

module.exports = { PROVIDERS, get, sigv4, relative };
