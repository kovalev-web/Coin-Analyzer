'use strict';

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — what Google Authenticator uses.

var crypto = require('crypto');

var B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
var STEP = 30;

function base32Encode(buf) {
  var bits = 0, value = 0, out = '';
  for (var i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  var clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  var bits = 0, value = 0, out = [];
  for (var i = 0; i < clean.length; i++) {
    value = (value << 5) | B32.indexOf(clean[i]);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, counter) {
  var msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  var h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  var off = h[h.length - 1] & 15;
  var n = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1000000).padStart(6, '0');
}

// Accepts the current step ±1 (clock drift). Returns the matched counter or
// null; the caller rejects a counter it has already accepted (no replay).
function verify(secret, code, nowMs) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  var t = Math.floor((nowMs || Date.now()) / 1000 / STEP);
  for (var d = -1; d <= 1; d++) {
    var c = codeAt(secret, t + d);
    if (crypto.timingSafeEqual(Buffer.from(c), Buffer.from(String(code)))) return t + d;
  }
  return null;
}

function otpauthUri(secret, account, issuer) {
  return 'otpauth://totp/' + encodeURIComponent(issuer + ':' + account)
    + '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=30';
}

module.exports = { generateSecret, verify, codeAt, otpauthUri, base32Encode, base32Decode };
