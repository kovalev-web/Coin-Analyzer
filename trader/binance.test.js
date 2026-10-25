'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient, sign, buildQuery } = require('./binance');

function fakeFetch(handler) {
  const calls = [];
  const fn = async function (url, init) {
    calls.push({ url, init });
    const r = await handler(url, init, calls.length);
    return {
      ok: r.status < 400, status: r.status,
      headers: { get: (h) => (r.headers || {})[h.toLowerCase()] || null },
      text: async () => JSON.stringify(r.body),
    };
  };
  fn.calls = calls;
  return fn;
}

test('sign matches the HMAC example from the Binance docs', () => {
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const q = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  assert.equal(sign(q, secret), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

test('buildQuery drops undefined/null params', () => {
  assert.equal(buildQuery({ a: 1, b: undefined, c: null, d: 'x y' }), 'a=1&d=x%20y');
});

test('signed request adds recvWindow, timestamp, signature and API key header', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { ok: 1 } }));
  const c = createClient({ rest: 'https://x', apiKey: 'KEY', apiSecret: 'SEC', fetch: f, now: () => 1000 });
  await c.request('POST', '/fapi/v1/order', { symbol: 'BTCUSDT' });
  const { url, init } = f.calls[0];
  assert.match(url, /^https:\/\/x\/fapi\/v1\/order\?symbol=BTCUSDT&recvWindow=5000&timestamp=1000&signature=[0-9a-f]{64}$/);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-MBX-APIKEY'], 'KEY');
});

test('unsigned request sends no key and no signature', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const c = createClient({ rest: 'https://x', apiKey: 'KEY', apiSecret: 'SEC', fetch: f });
  await c.request('GET', '/fapi/v1/exchangeInfo', {}, false);
  assert.equal(f.calls[0].url, 'https://x/fapi/v1/exchangeInfo');
  assert.equal(f.calls[0].init.headers['X-MBX-APIKEY'], undefined);
});

test('-1021 resyncs the clock and retries once', async () => {
  const f = fakeFetch((url, init, n) => {
    if (url.includes('/fapi/v1/time')) return { status: 200, body: { serverTime: 5000 } };
    if (n === 1) return { status: 400, body: { code: -1021, msg: 'Timestamp outside recvWindow' } };
    return { status: 200, body: { ok: 1 } };
  });
  const c = createClient({ rest: 'https://x', apiKey: 'K', apiSecret: 'S', fetch: f, now: () => 1000 });
  const r = await c.request('GET', '/fapi/v2/balance');
  assert.deepEqual(r, { ok: 1 });
  assert.equal(c.getTimeOffset(), 4000);
  assert.match(f.calls[2].url, /timestamp=5000/);
});

test('errors carry Binance code, status and retry-after', async () => {
  const f = fakeFetch(() => ({ status: 418, headers: { 'retry-after': '120' }, body: { code: -1003, msg: 'banned' } }));
  const c = createClient({ rest: 'https://x', apiKey: 'K', apiSecret: 'S', fetch: f });
  await assert.rejects(c.request('GET', '/fapi/v2/balance'), (e) => {
    assert.equal(e.status, 418); assert.equal(e.code, -1003); assert.equal(e.retryAfter, 120);
    return true;
  });
});

test('network failure is flagged as noResponse (outcome unknown)', async () => {
  const c = createClient({ rest: 'https://x', apiKey: 'K', apiSecret: 'S', fetch: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(c.request('POST', '/fapi/v1/order', {}), (e) => e.noResponse === true);
});
