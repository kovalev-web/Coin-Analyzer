'use strict';

// End-to-end check against a running trader on TESTNET. Run on the server:
//   node trader/scripts/e2e-testnet.js [SYMBOL]
// Opens a small position, adds SL/TP, partially closes, cancels, exercises the
// kill switch, and leaves the account flat. Refuses to run on mainnet.

var { loadConfig } = require('../config');

var config = loadConfig();
var BASE = 'http://127.0.0.1:' + config.port;
var SYMBOL = (process.argv[2] || 'BTCUSDT').toUpperCase();
var run = Date.now().toString(36);
var step = 0;

async function call(method, path, body) {
  var res = await fetch(BASE + path, {
    method: method,
    headers: { 'x-trader-secret': config.internalSecret, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  var data = await res.json();
  if (!res.ok) throw new Error(method + ' ' + path + ' → ' + res.status + ' ' + JSON.stringify(data));
  return data;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function log(msg, extra) { console.log('[' + (++step) + '] ' + msg + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); }

async function position() {
  var acc = await call('GET', '/account');
  return acc.positions.find(function (p) { return p.symbol === SYMBOL; });
}

async function waitFor(desc, fn, timeoutMs) {
  var until = Date.now() + (timeoutMs || 15000);
  while (Date.now() < until) {
    var v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error('Timed out waiting for ' + desc);
}

async function main() {
  var status = await call('GET', '/status');
  if (status.env !== 'testnet') throw new Error('Refusing to run: trader env is ' + status.env);
  if (!status.tradingEnabled) await call('POST', '/resume');
  if (!status.streamConnected) throw new Error('User data stream is not connected');
  log('status', status);

  if (await position()) throw new Error(SYMBOL + ' already has a position — close it first');

  var px = Number((await (await fetch(config.rest + '/fapi/v1/premiumIndex?symbol=' + SYMBOL)).json()).markPrice);
  var qty = (Math.ceil((120 / px) * 1000) / 1000).toFixed(3); // ~120 USDT, above min notional
  log('mark price ' + px + ', quantity ' + qty);

  await call('POST', '/leverage', { symbol: SYMBOL, leverage: 5 });
  log('leverage set to 5');

  var entryId = 'e2e-' + run + '-entry';
  var entry = await call('POST', '/order', { clientOrderId: entryId, symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: qty });
  var dup = await call('POST', '/order', { clientOrderId: entryId, symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: qty });
  if (dup.order.orderId !== entry.order.orderId) throw new Error('Duplicate clientOrderId created a second order');
  log('market BUY sent once (duplicate click ignored)', { orderId: entry.order.orderId, status: entry.order.status });

  var pos = await waitFor('position via user data stream', position);
  log('position appeared via stream', { amount: pos.amount, entryPrice: pos.entryPrice });

  await call('POST', '/order', { clientOrderId: 'e2e-' + run + '-sl', symbol: SYMBOL, side: 'SELL', type: 'STOP_MARKET', triggerPrice: (px * 0.9).toFixed(2), closePosition: true });
  await call('POST', '/order', { clientOrderId: 'e2e-' + run + '-tp', symbol: SYMBOL, side: 'SELL', type: 'TAKE_PROFIT_MARKET', triggerPrice: (px * 1.1).toFixed(2), closePosition: true });
  var algos = await waitFor('SL/TP in state', async function () {
    var a = (await call('GET', '/account')).algoOrders.filter(function (x) { return x.symbol === SYMBOL; });
    return a.length >= 2 && a;
  });
  log('stop-loss and take-profit placed', algos.map(function (a) { return a.type + '@' + a.triggerPrice; }));

  var limit = await call('POST', '/order', { clientOrderId: 'e2e-' + run + '-lim', symbol: SYMBOL, side: 'BUY', type: 'LIMIT', quantity: qty, price: (px * 0.8).toFixed(2) });
  await call('POST', '/cancel', { symbol: SYMBOL, orderId: limit.order.orderId });
  log('far limit order placed and cancelled', { orderId: limit.order.orderId });

  var half = (Math.floor((Number(qty) / 2) * 1000) / 1000).toFixed(3);
  await call('POST', '/order', { clientOrderId: 'e2e-' + run + '-half', symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity: half, reduceOnly: true });
  pos = await waitFor('partial close', async function () { var p = await position(); return p && Number(p.amount) < Number(qty) && p; });
  log('partially closed', { amount: pos.amount });

  var kill = await call('POST', '/kill', { closePositions: true });
  log('kill switch', kill);
  var blocked = await fetch(BASE + '/order', {
    method: 'POST', headers: { 'x-trader-secret': config.internalSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientOrderId: 'e2e-' + run + '-blocked', symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: qty }),
  });
  if (blocked.status !== 423) throw new Error('Expected 423 after kill, got ' + blocked.status);
  log('orders blocked after kill (423)');

  await waitFor('flat account', async function () { return !(await position()); });
  var acc = await call('GET', '/account');
  var left = acc.orders.concat(acc.algoOrders).filter(function (o) { return o.symbol === SYMBOL; });
  if (left.length) throw new Error('Orders left after kill: ' + JSON.stringify(left));
  log('account flat, no open orders');

  await call('POST', '/resume');
  log('trading resumed');
  console.log('E2E OK');
}

main().catch(function (e) {
  console.error('E2E FAILED:', e.message);
  process.exit(1);
});
