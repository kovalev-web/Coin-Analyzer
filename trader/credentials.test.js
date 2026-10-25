'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createStore, mask } = require('./credentials');

function tmpFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cred-')), 'credentials.enc'); }
const KEY = crypto.randomBytes(32).toString('hex');

test('keys round-trip per environment and the file holds no plaintext', () => {
  const file = tmpFile();
  const s = createStore(file, KEY);
  s.set('testnet', { apiKey: 'TESTKEY1234567890abcd', apiSecret: 'SUPERSECRETVALUE123456' });
  s.set('mainnet', { apiKey: 'LIVEKEY1234567890wxyz', apiSecret: 'LIVESECRETVALUE7890' });
  assert.equal(s.get('testnet').apiSecret, 'SUPERSECRETVALUE123456');
  assert.equal(s.get('mainnet').apiKey, 'LIVEKEY1234567890wxyz');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('SUPERSECRET') && !raw.includes('TESTKEY') && !raw.includes('LIVESECRET'));
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
});

test('describe masks keys and never includes secrets', () => {
  const s = createStore(tmpFile(), KEY);
  s.set('testnet', { apiKey: 'ABCDEFGHIJKLMNOPQRST', apiSecret: 'shh-secret-value-1234', checks: { futures: true } });
  const d = s.describe();
  assert.equal(d.testnet.apiKey, 'ABCD…QRST');
  assert.equal(d.mainnet, null);
  assert.ok(!JSON.stringify(d).includes('shh-secret'));
  assert.deepEqual(d.testnet.checks, { futures: true });
});

test('wrong master key cannot read, tampering is detected', () => {
  const file = tmpFile();
  createStore(file, KEY).set('testnet', { apiKey: 'K'.repeat(20), apiSecret: 'S'.repeat(20) });
  assert.throws(() => createStore(file, crypto.randomBytes(32).toString('hex')).get('testnet'));
  const o = JSON.parse(fs.readFileSync(file, 'utf8'));
  o.data = (o.data[0] === 'a' ? 'b' : 'a') + o.data.slice(1);
  fs.writeFileSync(file, JSON.stringify(o));
  assert.throws(() => createStore(file, KEY).get('testnet'));
});

test('remove drops one env, unknown env and bad master key are rejected', () => {
  const s = createStore(tmpFile(), KEY);
  s.set('testnet', { apiKey: 'K'.repeat(20), apiSecret: 'S'.repeat(20) });
  s.remove('testnet');
  assert.equal(s.get('testnet'), null);
  assert.throws(() => s.set('prod', {}), /testnet or mainnet/);
  assert.throws(() => createStore(tmpFile(), 'abc'), /64 hex/);
  assert.equal(mask(null), null);
});
