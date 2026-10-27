'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Trader } = require('./trader');
const { BinanceError } = require('./binance');

const EXCHANGE_INFO = {
  symbols: [{
    symbol: 'BTCUSDT', status: 'TRADING',
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '120' },
      { filterType: 'MIN_NOTIONAL', notional: '100' },
    ],
  }],
};

// Fake Binance: routes "METHOD path" → handler(params); records every call.
function fakeClient(overrides) {
  const calls = [];
  const routes = Object.assign({
    'GET /fapi/v1/exchangeInfo': () => EXCHANGE_INFO,
    'GET /fapi/v1/positionSide/dual': () => ({ dualSidePosition: false }),
    'GET /fapi/v2/balance': () => [],
    'GET /fapi/v2/positionRisk': () => [],
    'GET /fapi/v1/openOrders': () => [],
    'GET /fapi/v1/openAlgoOrders': () => [],
    'POST /fapi/v1/order': (p) => ({ orderId: 1, clientOrderId: p.newClientOrderId, symbol: p.symbol, side: p.side, type: p.type, status: 'NEW', origQty: p.quantity, price: p.price || '0' }),
    'POST /fapi/v1/algoOrder': (p) => ({ algoId: 2, clientAlgoId: p.clientAlgoId, symbol: p.symbol, side: p.side, orderType: p.type, algoStatus: 'NEW', triggerPrice: p.triggerPrice, closePosition: p.closePosition === 'true' }),
    'DELETE /fapi/v1/allOpenOrders': () => ({ code: 200 }),
    'DELETE /fapi/v1/algoOpenOrders': () => ({ code: 200 }),
  }, overrides);
  return {
    calls,
    syncTime: async () => 0,
    request: async (method, p, params) => {
      calls.push({ method, path: p, params: params || {} });
      const h = routes[method + ' ' + p];
      if (!h) throw new Error('unexpected ' + method + ' ' + p);
      return h(params || {});
    },
  };
}

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-test-')); });

async function makeTrader(overrides) {
  const client = fakeClient(overrides);
  const t = new Trader({ client, dataDir: dir });
  await t.init();
  return { t, client };
}

const callsTo = (client, m, p) => client.calls.filter((c) => c.method === m && c.path === p);

test('same clientOrderId twice sends one order', async () => {
  const { t, client } = await makeTrader();
  const o = { clientOrderId: 'qt-1', symbol: 'btcusdt', side: 'buy', type: 'MARKET', quantity: '0.0129' };
  const [a, b] = await Promise.all([t.placeOrder(o), t.placeOrder(o)]);
  assert.equal(callsTo(client, 'POST', '/fapi/v1/order').length, 1);
  assert.deepEqual(a, b);
  assert.equal(callsTo(client, 'POST', '/fapi/v1/order')[0].params.quantity, '0.012');
});

test('stop-loss with closePosition goes to the algo endpoint without quantity', async () => {
  const { t, client } = await makeTrader();
  const r = await t.placeOrder({ clientOrderId: 'sl-1', symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: '58000.04', closePosition: true });
  const call = callsTo(client, 'POST', '/fapi/v1/algoOrder')[0];
  assert.equal(call.params.algoType, 'CONDITIONAL');
  assert.equal(call.params.closePosition, 'true');
  assert.equal(call.params.quantity, undefined);
  assert.equal(call.params.reduceOnly, undefined);
  assert.equal(call.params.triggerPrice, '58000.0');
  assert.equal(call.params.workingType, 'MARK_PRICE');
  assert.equal(r.algo.algoId, 2);
});

test('a stop on the last price is sent with workingType CONTRACT_PRICE (the order book sends this)', async () => {
  const { t, client } = await makeTrader();
  await t.placeOrder({ clientOrderId: 'sl-last', symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: '58000.0', closePosition: true, workingType: 'CONTRACT_PRICE' });
  assert.equal(callsTo(client, 'POST', '/fapi/v1/algoOrder')[0].params.workingType, 'CONTRACT_PRICE');
});

test('validation errors are 400 and send nothing', async () => {
  const { t, client } = await makeTrader();
  await assert.rejects(t.placeOrder({ clientOrderId: 'x1', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '1' }), { status: 400 });
  await assert.rejects(t.placeOrder({ clientOrderId: 'x2', symbol: 'BTCUSDT', side: 'HOLD', type: 'MARKET', quantity: '1' }), { status: 400 });
  await assert.rejects(t.placeOrder({ clientOrderId: 'bad id!', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '1' }), { status: 400 });
  await assert.rejects(t.placeOrder({ clientOrderId: 'x3', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.001', price: '60000' }), /below minimum 100 USDT/);
  assert.equal(callsTo(client, 'POST', '/fapi/v1/order').length, 0);
});

test('kill disables trading, cancels every symbol from REST, persists across restart', async () => {
  const { t, client } = await makeTrader({
    'GET /fapi/v1/openOrders': () => [{ symbol: 'BTCUSDT' }],
    'GET /fapi/v1/openAlgoOrders': () => [{ symbol: 'ETHUSDT' }],
  });
  const s = await t.kill({});
  assert.deepEqual(s.cancelledSymbols.sort(), ['BTCUSDT', 'ETHUSDT']);
  assert.equal(t.tradingEnabled, false);
  await assert.rejects(t.placeOrder({ clientOrderId: 'k1', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01' }), { status: 423 });

  const restarted = new Trader({ client, dataDir: dir });
  assert.equal(restarted.tradingEnabled, false);
  restarted.resume();
  assert.equal(new Trader({ client, dataDir: dir }).tradingEnabled, true);
});

test('kill with closePositions market-closes each position reduce-only', async () => {
  const { t, client } = await makeTrader({
    'GET /fapi/v2/positionRisk': () => [
      { symbol: 'BTCUSDT', positionAmt: '-0.020' },
      { symbol: 'ETHUSDT', positionAmt: '0.000' },
    ],
  });
  const s = await t.kill({ closePositions: true });
  const closes = callsTo(client, 'POST', '/fapi/v1/order');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].params.side, 'BUY');
  assert.equal(closes[0].params.quantity, '0.020');
  assert.equal(closes[0].params.reduceOnly, 'true');
  assert.deepEqual(s.closed, ['BTCUSDT']);
});

test('unknown outcome is reconciled by clientOrderId', async () => {
  const { t } = await makeTrader({
    'POST /fapi/v1/order': () => { throw new BinanceError('Network error: timeout', { noResponse: true }); },
    'GET /fapi/v1/order': (p) => ({ orderId: 77, clientOrderId: p.origClientOrderId, symbol: 'BTCUSDT', status: 'FILLED' }),
  });
  const r = await t.placeOrder({ clientOrderId: 'qt-9', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01' });
  assert.equal(r.reconciled, true);
  assert.equal(r.order.orderId, 77);
});

test('hedge mode accounts are refused', async () => {
  const { t } = await makeTrader({ 'GET /fapi/v1/positionSide/dual': () => ({ dualSidePosition: true }) });
  await assert.rejects(t.placeOrder({ clientOrderId: 'h1', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.01' }), { status: 409 });
});

test('balance change from the stream triggers one available-balance refresh', async () => {
  let balanceCalls = 0;
  const { t } = await makeTrader({
    'GET /fapi/v2/balance': () => { balanceCalls++; return [{ asset: 'USDT', balance: '5000', crossWalletBalance: '5000', availableBalance: '4880', updateTime: 9 }]; },
  });
  balanceCalls = 0;
  const upd = { e: 'ACCOUNT_UPDATE', E: 1000, a: { B: [{ a: 'USDT', wb: '5000', cw: '5000' }], P: [] } };
  t.handleStreamEvent(upd);
  t.handleStreamEvent(Object.assign({}, upd, { E: 1001 }));
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(balanceCalls, 1);
  assert.equal(t.state.balances.USDT.availableBalance, '4880');
});

test('stream events during resync are buffered and applied after the snapshot', async () => {
  let release;
  const { t } = await makeTrader();
  t.client.request = (orig => async (m, p, params) => {
    if (p === '/fapi/v1/openOrders') await new Promise((r) => { release = r; });
    return orig(m, p, params);
  })(t.client.request);
  const events = [];
  t.on('event', (e) => events.push(e.type));
  const sync = t.resync();
  await new Promise((r) => setImmediate(r));
  t.handleStreamEvent({ e: 'ORDER_TRADE_UPDATE', E: 5000, o: { s: 'BTCUSDT', c: 'c', S: 'BUY', o: 'LIMIT', X: 'NEW', x: 'NEW', i: 9, q: '1', p: '1', T: 5000 } });
  assert.equal(t.state.orders[9], undefined); // not applied yet
  release();
  await sync;
  assert.ok(t.state.orders[9]);
  assert.deepEqual(events, ['order', 'snapshot']);
});

// ── move (drag in the ladder) ────────────────────────────────────────────────

test('move: a limit order is modified in place, same quantity, price on the tick', async () => {
  const { t, client } = await makeTrader({
    'GET /fapi/v1/order': () => ({ orderId: 7, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', status: 'NEW', origQty: '0.005', price: '79000.0', reduceOnly: false }),
    'PUT /fapi/v1/order': (p) => ({ orderId: 7, symbol: p.symbol, side: p.side, type: 'LIMIT', status: 'NEW', origQty: p.quantity, price: p.price }),
    'GET /fapi/v1/ticker/bookTicker': () => ({ bidPrice: '79990.0', askPrice: '80000.0' }),
  });
  let guarded = 0;
  const r = await t.move({ symbol: 'BTCUSDT', orderId: 7, price: '78950.04' }, { requireUnlocked: () => { guarded++; } });
  const put = callsTo(client, 'PUT', '/fapi/v1/order')[0].params;
  assert.deepEqual([put.orderId, put.side, put.quantity, put.price], [7, 'BUY', '0.005', '78950.0']);
  assert.equal(r.order.price, '78950.0');
  assert.equal(guarded, 1); // an entry order needs the 2FA unlock
});

test('move: a reduce-only limit skips the unlock check', async () => {
  const { t } = await makeTrader({
    'GET /fapi/v1/order': () => ({ orderId: 8, symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', status: 'NEW', origQty: '0.005', price: '81000.0', reduceOnly: true }),
    'PUT /fapi/v1/order': (p) => ({ orderId: 8, symbol: p.symbol, side: p.side, type: 'LIMIT', status: 'NEW', origQty: p.quantity, price: p.price }),
    'GET /fapi/v1/ticker/bookTicker': () => ({ bidPrice: '79990.0', askPrice: '80000.0' }),
  });
  await t.move({ symbol: 'BTCUSDT', orderId: 8, price: '81500' }, { requireUnlocked: () => { throw new Error('locked'); } });
});

const SL = { algoId: 5, symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP_MARKET', algoStatus: 'NEW', triggerPrice: '78000.0', closePosition: true, workingType: 'MARK_PRICE' };

test('move: a stop-loss is cancelled and placed again at the new trigger', async () => {
  const { t, client } = await makeTrader({
    'GET /fapi/v1/algoOrder': () => SL,
    'GET /fapi/v1/premiumIndex': () => ({ markPrice: '80000' }),
    'DELETE /fapi/v1/algoOrder': () => ({ code: 200 }),
  });
  const r = await t.move({ symbol: 'BTCUSDT', algoId: 5, price: '78500.03' }, { requireUnlocked: () => { throw new Error('locked'); } });
  assert.equal(callsTo(client, 'DELETE', '/fapi/v1/algoOrder').length, 1);
  const post = callsTo(client, 'POST', '/fapi/v1/algoOrder')[0].params;
  assert.deepEqual([post.type, post.side, post.closePosition, post.triggerPrice, post.quantity], ['STOP_MARKET', 'SELL', 'true', '78500.0', undefined]);
  assert.equal(r.algo.triggerPrice, '78500.0');
});

test('move: a trigger that would fire at once is refused before anything is cancelled', async () => {
  const { t, client } = await makeTrader({
    'GET /fapi/v1/algoOrder': () => SL,
    'GET /fapi/v1/premiumIndex': () => ({ markPrice: '80000' }),
  });
  await assert.rejects(t.move({ symbol: 'BTCUSDT', algoId: 5, price: '80100' }), /trigger at once/);
  assert.equal(callsTo(client, 'DELETE', '/fapi/v1/algoOrder').length, 0);
});

test('move: if the new stop is rejected, the old one is put back', async () => {
  let n = 0;
  const { t, client } = await makeTrader({
    'GET /fapi/v1/algoOrder': () => SL,
    'GET /fapi/v1/premiumIndex': () => ({ markPrice: '80000' }),
    'DELETE /fapi/v1/algoOrder': () => ({ code: 200 }),
    'POST /fapi/v1/algoOrder': (p) => {
      if (++n === 1) throw new BinanceError('Order would immediately trigger.', { status: 400, code: -2021 });
      return { algoId: 6, symbol: p.symbol, side: p.side, orderType: p.type, algoStatus: 'NEW', triggerPrice: p.triggerPrice, closePosition: true };
    },
  });
  await assert.rejects(t.move({ symbol: 'BTCUSDT', algoId: 5, price: '79000' }), /immediately trigger\. — the order is back at 78000\.0/);
  const posts = callsTo(client, 'POST', '/fapi/v1/algoOrder').map((c) => c.params.triggerPrice);
  assert.deepEqual(posts, ['79000.0', '78000.0']);
});

test('move: a buy stop entry needs the unlock and must stay above the price', async () => {
  const BS = { algoId: 9, symbol: 'BTCUSDT', side: 'BUY', orderType: 'STOP_MARKET', algoStatus: 'NEW', triggerPrice: '81000.0', quantity: '0.002', closePosition: false, reduceOnly: false, workingType: 'MARK_PRICE' };
  const { t } = await makeTrader({
    'GET /fapi/v1/algoOrder': () => BS,
    'GET /fapi/v1/premiumIndex': () => ({ markPrice: '80000' }),
  });
  await assert.rejects(t.move({ symbol: 'BTCUSDT', algoId: 9, price: '81500' }, { requireUnlocked: () => { throw new Error('locked'); } }), /locked/);
  await assert.rejects(t.move({ symbol: 'BTCUSDT', algoId: 9, price: '79900' }), /trigger at once/);
});

test('move: a limit moved through the market is refused, nothing is modified', async () => {
  const { t, client } = await makeTrader({
    'GET /fapi/v1/order': () => ({ orderId: 7, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', status: 'NEW', origQty: '0.005', price: '79000.0', reduceOnly: false }),
    'GET /fapi/v1/ticker/bookTicker': () => ({ bidPrice: '79990.0', askPrice: '80000.0' }),
  });
  await assert.rejects(t.move({ symbol: 'BTCUSDT', orderId: 7, price: '80000' }), /fill at once/);
  assert.equal(callsTo(client, 'PUT', '/fapi/v1/order').length, 0);
});
