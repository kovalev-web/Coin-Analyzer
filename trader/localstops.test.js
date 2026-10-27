'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { isProtective, fires, closeOrderFor, watchedSymbols, createLocalStops, marketTradesUrl } = require('./localstops');

const SL_LONG = { algoId: 5, symbol: 'SOLUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: '99.50', closePosition: true };
const TP_LONG = { algoId: 6, symbol: 'SOLUSDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', triggerPrice: '102.00', closePosition: true };
const SL_SHORT = { algoId: 7, symbol: 'SOLUSDT', side: 'BUY', type: 'STOP_MARKET', triggerPrice: '101.00', closePosition: true };
const STOP_ENTRY = { algoId: 8, symbol: 'SOLUSDT', side: 'BUY', type: 'STOP_MARKET', triggerPrice: '103.00', quantity: '1' };
const LONG = { symbol: 'SOLUSDT', positionSide: 'BOTH', amount: '2.5' };
const SHORT = { symbol: 'SOLUSDT', positionSide: 'BOTH', amount: '-2.5' };

test('protective = SL / TP that closes or reduces; a stop entry is not', () => {
  assert.equal(isProtective(SL_LONG), true);
  assert.equal(isProtective(TP_LONG), true);
  assert.equal(isProtective(STOP_ENTRY), false);
  assert.equal(isProtective({ ...STOP_ENTRY, reduceOnly: true }), true);
});

test('fires: SELL stop at or below, SELL take-profit at or above, BUY stop at or above', () => {
  assert.equal(fires(SL_LONG, '99.51'), false);
  assert.equal(fires(SL_LONG, '99.50'), true);
  assert.equal(fires(SL_LONG, '99.40'), true);
  assert.equal(fires(TP_LONG, '101.99'), false);
  assert.equal(fires(TP_LONG, '102.00'), true);
  assert.equal(fires(SL_SHORT, '100.99'), false);
  assert.equal(fires(SL_SHORT, '101.20'), true);
  assert.equal(fires(SL_LONG, 'x'), false);
});

test('close order: reduce-only market for the whole position, only on the right side', () => {
  assert.deepEqual(closeOrderFor(SL_LONG, LONG), {
    symbol: 'SOLUSDT', side: 'SELL', type: 'MARKET', quantity: '2.5', reduceOnly: 'true',
    newClientOrderId: 'ls-5', newOrderRespType: 'RESULT',
  });
  assert.equal(closeOrderFor(SL_LONG, SHORT), null); // a SELL can't close a short
  assert.equal(closeOrderFor(SL_LONG, null), null);
  assert.equal(closeOrderFor(SL_SHORT, SHORT).side, 'BUY');
  // reduce-only with a quantity: no more than that
  assert.equal(closeOrderFor({ ...SL_LONG, closePosition: false, reduceOnly: true, quantity: '1' }, LONG).quantity, '1');
});

test('watched symbols: only those with protective orders', () => {
  assert.deepEqual(watchedSymbols({ algoOrders: { 5: SL_LONG, 8: STOP_ENTRY, 9: { ...SL_LONG, algoId: 9, symbol: 'BTCUSDT' } } }), ['BTCUSDT', 'SOLUSDT']);
  assert.deepEqual(watchedSymbols({ algoOrders: { 8: STOP_ENTRY } }), []);
});

test('trades go to the /market path', () => {
  assert.equal(marketTradesUrl('wss://fstream.binance.com/public/ws'), 'wss://fstream.binance.com/market/ws');
});

// ── Watcher with a fake socket and a fake exchange ───────────────────────────

class FakeWS extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; FakeWS.last = this; setImmediate(() => this.emit('open')); }
  send(m) { this.sent.push(JSON.parse(m)); }
  close() { setImmediate(() => this.emit('close')); }
}

function makeTrader(algos, positions) {
  const calls = [];
  const t = new EventEmitter();
  t.state = { algoOrders: Object.fromEntries(algos.map((a) => [a.algoId, a])), positions: Object.fromEntries(positions.map((p) => [p.symbol + ':BOTH', p])) };
  t.audits = [];
  t.audit = (action, req, res) => t.audits.push({ action, req, res });
  t.client = {
    request: async (method, p, params) => {
      calls.push({ method, path: p, params });
      if (method === 'POST') return { orderId: 1, status: 'FILLED', avgPrice: '99.48' };
      return {};
    },
  };
  return { t, calls };
}

const tick = () => new Promise((r) => setImmediate(r));

test('subscribes to the symbols with protective orders', async () => {
  const { t } = makeTrader([SL_LONG], [LONG]);
  const ls = createLocalStops({ trader: t, url: 'wss://x/market/ws', WebSocket: FakeWS, log: { log() {}, error() {} } });
  ls.sync();
  await tick(); await tick();
  assert.deepEqual(FakeWS.last.sent[0], { method: 'SUBSCRIBE', params: ['solusdt@aggTrade'], id: 1 });
  ls.stop();
});

test('a trade through the stop closes the position at once, then removes the exchange order', async () => {
  const { t, calls } = makeTrader([SL_LONG, TP_LONG], [LONG]);
  const events = [];
  t.on('event', (e) => events.push(e));
  const ls = createLocalStops({ trader: t, url: 'wss://x', WebSocket: FakeWS, log: { log() {}, error() {} }, now: () => 1000 });
  ls._onTrade('SOLUSDT', '99.60', 990);   // above the stop: nothing
  assert.equal(calls.length, 0);
  ls._onTrade('SOLUSDT', '99.45', 995);   // through it
  ls._onTrade('SOLUSDT', '99.40', 996);   // next trade: no second close
  await tick(); await tick();
  const post = calls.filter((c) => c.method === 'POST');
  assert.equal(post.length, 1);
  assert.equal(post[0].path, '/fapi/v1/order');
  assert.deepEqual(post[0].params, { symbol: 'SOLUSDT', side: 'SELL', type: 'MARKET', quantity: '2.5', reduceOnly: 'true', newClientOrderId: 'ls-5', newOrderRespType: 'RESULT' });
  assert.deepEqual(calls.find((c) => c.method === 'DELETE').params, { algoId: 5 });
  assert.equal(events[0].type, 'local-stop');
  assert.equal(events[0].stop.kind, 'SL');
  assert.equal(t.audits[0].action, 'local-stop');
});

test('old trades (reconnect backlog) and trades with no position do nothing', async () => {
  const { t, calls } = makeTrader([SL_LONG], []);
  const ls = createLocalStops({ trader: t, url: 'wss://x', WebSocket: FakeWS, log: { log() {}, error() {} }, now: () => 100000 });
  ls._onTrade('SOLUSDT', '99.00', 100000 - 6000); // stale
  ls._onTrade('SOLUSDT', '99.00', 99990);         // fresh, but flat
  await tick();
  assert.equal(calls.length, 0);
  // the position shows up → the next trade through the stop closes it
  t.state.positions['SOLUSDT:BOTH'] = LONG;
  ls._onTrade('SOLUSDT', '99.00', 99995);
  await tick();
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

test('a failed close leaves the exchange order alone and can try again', async () => {
  const { t, calls } = makeTrader([SL_LONG], [LONG]);
  let fail = true;
  t.client.request = async (method, p, params) => { calls.push({ method, path: p, params }); if (fail) throw new Error('boom'); return {}; };
  const ls = createLocalStops({ trader: t, url: 'wss://x', WebSocket: FakeWS, log: { log() {}, error() {} }, now: () => 1000 });
  ls._onTrade('SOLUSDT', '99.40', 999);
  await tick(); await tick();
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
  assert.equal(t.audits[0].res.error.message, 'boom');
});
