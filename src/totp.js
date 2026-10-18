// Time-based one-time passwords (RFC 6238) for admin two-factor sign-in.
// Works with Microsoft Authenticator, Google Authenticator, 1Password, Authy, etc.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 15;
  const bin = ((hmac[off] & 127) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(bin % 1e6).padStart(6, '0');
}

/**
 * Check a 6-digit code, allowing one step of clock drift either way.
 * Returns the matching time counter (store it to block replays), or null.
 */
function verify(secret, code, lastCounter = 0) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6 || !secret) return null;
  const now = Math.floor(Date.now() / 1000 / STEP);
  for (const drift of [0, -1, 1]) {
    const counter = now + drift;
    if (counter <= lastCounter) continue; // already used
    const expected = codeAt(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return counter;
  }
  return null;
}

function otpauthUrl(secret, account, issuer = 'Captive Portal') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

module.exports = { generateSecret, verify, otpauthUrl, codeAt, base32Decode };
