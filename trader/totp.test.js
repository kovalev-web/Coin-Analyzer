'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const totp = require('./totp');

// RFC 6238 Appendix B (SHA-1), last 6 digits
const SEED = totp.base32Encode(Buffer.from('12345678901234567890'));

test('base32 seed matches the RFC test key', () => {
  assert.equal(SEED, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp.base32Decode(SEED).toString(), '12345678901234567890');
});

test('codes match RFC 6238 vectors', () => {
  assert.equal(totp.codeAt(SEED, Math.floor(59 / 30)), '287082');
  assert.equal(totp.codeAt(SEED, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totp.codeAt(SEED, Math.floor(2000000000 / 30)), '279037');
});

test('verify accepts ±1 step and returns the counter, rejects others', () => {
  const now = 1111111109 * 1000;
  const c = Math.floor(1111111109 / 30);
  assert.equal(totp.verify(SEED, totp.codeAt(SEED, c), now), c);
  assert.equal(totp.verify(SEED, totp.codeAt(SEED, c - 1), now), c - 1);
  assert.equal(totp.verify(SEED, totp.codeAt(SEED, c + 2), now), null);
  assert.equal(totp.verify(SEED, '12345', now), null);
  assert.equal(totp.verify(SEED, 'abcdef', now), null);
});

test('generated seeds are 32 base32 chars; uri is Google Authenticator format', () => {
  const s = totp.generateSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.match(totp.otpauthUri(s, 'trading', 'QuestTick'), /^otpauth:\/\/totp\/QuestTick%3Atrading\?secret=[A-Z2-7]{32}&issuer=QuestTick/);
});
