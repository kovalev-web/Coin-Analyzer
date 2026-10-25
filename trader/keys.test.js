'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateKeys } = require('./keys');

// Fake Binance: path substring → JSON body (or { status, body }).
function fakeFetch(routes) {
  return async function (url) {
    const key = Object.keys(routes).find((k) => url.includes(k));
    let r = key ? routes[key] : { status: 404, body: { msg: 'nope' } };
    if (!('status' in r)) r = { status: 200, body: r };
    return { ok: r.status < 400, status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.body), json: async () => r.body };
  };
}

const base = {
  '/fapi/v1/time': { serverTime: Date.now() },
  '/fapi/v2/account': { canTrade: true },
  '/fapi/v1/positionSide/dual': { dualSidePosition: false },
};
const opts = (env, routes) => ({ env, rest: 'https://x', apiKey: 'K'.repeat(20), apiSecret: 'S'.repeat(20), fetch: fakeFetch(routes) });

test('testnet key: futures access and trade permission are enough', async () => {
  const r = await validateKeys(opts('testnet', base));
  assert.equal(r.ok, true);
  assert.equal(r.checks.positionMode, 'oneway');
});

test('a key that cannot trade is rejected', async () => {
  const r = await validateKeys(opts('testnet', Object.assign({}, base, { '/fapi/v2/account': { canTrade: false } })));
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot trade/);
});

test('live key with withdrawals enabled is rejected', async () => {
  const r = await validateKeys(opts('mainnet', Object.assign({}, base, { apiRestrictions: { enableWithdrawals: true, ipRestrict: true } })));
  assert.equal(r.ok, false);
  assert.match(r.error, /withdraw/);
});

test('live key without IP whitelist is rejected', async () => {
  const r = await validateKeys(opts('mainnet', Object.assign({}, base, { apiRestrictions: { enableWithdrawals: false, ipRestrict: false } })));
  assert.equal(r.ok, false);
  assert.match(r.error, /IP/);
});

test('live key: restricted, no withdrawals → ok; unreadable restrictions → ok with warning', async () => {
  const good = await validateKeys(opts('mainnet', Object.assign({}, base, { apiRestrictions: { enableWithdrawals: false, ipRestrict: true } })));
  assert.equal(good.ok, true);
  const unknown = await validateKeys(opts('mainnet', Object.assign({}, base, { apiRestrictions: { status: 401, body: { code: -2015 } } })));
  assert.equal(unknown.ok, true);
  assert.match(unknown.checks.warning, /not verified/);
});

test('a key Binance rejects throws (caller turns it into a 400)', async () => {
  await assert.rejects(validateKeys(opts('testnet', Object.assign({}, base, { '/fapi/v2/account': { status: 401, body: { code: -2015, msg: 'Invalid API-key' } } }))));
});
