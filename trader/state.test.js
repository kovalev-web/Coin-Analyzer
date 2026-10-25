'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const st = require('./state');

function orderEvent(over) {
  return Object.assign({
    s: 'BTCUSDT', c: 'cid-1', S: 'BUY', o: 'LIMIT', f: 'GTC', q: '0.010', p: '60000',
    ap: '0', x: 'NEW', X: 'NEW', i: 101, l: '0', z: '0', L: '0', T: 1000, R: false, ps: 'BOTH',
  }, over);
}

test('loadSnapshot keeps only non-zero positions', () => {
  const s = st.createState();
  st.loadSnapshot(s, {
    balances: [{ asset: 'USDT', balance: '1000', crossWalletBalance: '1000', availableBalance: '900' }],
    positions: [
      { symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.010', entryPrice: '60000', unRealizedProfit: '5', leverage: '10', marginType: 'cross' },
      { symbol: 'ETHUSDT', positionSide: 'BOTH', positionAmt: '0.000', entryPrice: '0' },
    ],
    openOrders: [{ orderId: 7, clientOrderId: 'a', symbol: 'BTCUSDT', side: 'SELL', type: 'LIMIT', status: 'NEW', updateTime: 5 }],
    openAlgoOrders: [{ algoId: 9, clientAlgoId: 'b', symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP_MARKET', algoStatus: 'NEW', triggerPrice: '58000', closePosition: true, updateTime: 5 }],
  });
  const j = st.toJSON(s);
  assert.equal(j.positions.length, 1);
  assert.equal(j.positions[0].leverage, '10');
  assert.equal(j.orders[0].orderId, 7);
  assert.equal(j.algoOrders[0].type, 'STOP_MARKET');
  assert.equal(j.balances[0].availableBalance, '900');
});

test('order lifecycle: NEW → PARTIALLY_FILLED kept, FILLED removed', () => {
  const s = st.createState();
  st.applyOrderUpdate(s, orderEvent(), 1000);
  assert.ok(s.orders[101]);
  st.applyOrderUpdate(s, orderEvent({ X: 'PARTIALLY_FILLED', x: 'TRADE', z: '0.004', T: 1100 }), 1100);
  assert.equal(s.orders[101].executedQty, '0.004');
  const done = st.applyOrderUpdate(s, orderEvent({ X: 'FILLED', x: 'TRADE', z: '0.010', T: 1200 }), 1200);
  assert.equal(done.status, 'FILLED');
  assert.equal(s.orders[101], undefined);
});

test('stale order update (older than state) is ignored', () => {
  const s = st.createState();
  st.applyOrderUpdate(s, orderEvent({ X: 'PARTIALLY_FILLED', z: '0.004', T: 2000 }), 2000);
  const r = st.applyOrderUpdate(s, orderEvent({ T: 1500 }), 1500);
  assert.equal(r, null);
  assert.equal(s.orders[101].executedQty, '0.004');
});

test('algo order: NEW kept, TRIGGERED removed', () => {
  const s = st.createState();
  const ev = { caid: 'sl-1', aid: 55, o: 'STOP_MARKET', s: 'BTCUSDT', S: 'SELL', ps: 'BOTH', q: '0', X: 'NEW', tp: '58000', p: '0', R: false, cp: true, wt: 'MARK_PRICE' };
  st.applyAlgoUpdate(s, ev, 1000);
  assert.equal(s.algoOrders[55].closePosition, true);
  st.applyAlgoUpdate(s, Object.assign({}, ev, { X: 'TRIGGERED' }), 1100);
  assert.equal(s.algoOrders[55], undefined);
});

test('account update: position change keeps leverage, zero amount removes it', () => {
  const s = st.createState();
  st.loadSnapshot(s, { positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '0.010', entryPrice: '60000', leverage: '10', updateTime: 1 }] });
  let ch = st.applyAccountUpdate(s, {
    B: [{ a: 'USDT', wb: '990', cw: '990' }],
    P: [{ s: 'BTCUSDT', pa: '0.020', ep: '60500', up: '3', mt: 'cross', ps: 'BOTH' }],
  }, 1000);
  assert.equal(s.positions['BTCUSDT:BOTH'].amount, '0.020');
  assert.equal(s.positions['BTCUSDT:BOTH'].leverage, '10');
  assert.equal(ch.balances[0].walletBalance, '990');
  ch = st.applyAccountUpdate(s, { P: [{ s: 'BTCUSDT', pa: '0', ep: '0', up: '0', mt: 'cross', ps: 'BOTH' }] }, 1100);
  assert.equal(s.positions['BTCUSDT:BOTH'], undefined);
  assert.equal(ch.positions[0].amount, '0');
});

test('openTime: set when opened or flipped, kept while adding', () => {
  const s = st.createState();
  st.applyAccountUpdate(s, { P: [{ s: 'BTCUSDT', pa: '0.01', ep: '1', ps: 'BOTH' }] }, 1000);
  assert.equal(s.positions['BTCUSDT:BOTH'].openTime, 1000);
  st.applyAccountUpdate(s, { P: [{ s: 'BTCUSDT', pa: '0.02', ep: '1', ps: 'BOTH' }] }, 2000);
  assert.equal(s.positions['BTCUSDT:BOTH'].openTime, 1000);
  st.applyAccountUpdate(s, { P: [{ s: 'BTCUSDT', pa: '-0.01', ep: '1', ps: 'BOTH' }] }, 3000);
  assert.equal(s.positions['BTCUSDT:BOTH'].openTime, 3000);
  // snapshot keeps a known same-side position's openTime
  st.loadSnapshot(s, { positions: [{ symbol: 'BTCUSDT', positionSide: 'BOTH', positionAmt: '-0.03', entryPrice: '1' }] });
  assert.equal(s.positions['BTCUSDT:BOTH'].openTime, 3000);
});

test('openTimeFromTrades walks fills back to where the position started', () => {
  const trades = [
    { side: 'BUY', qty: '0.01', time: 1 }, { side: 'SELL', qty: '0.01', time: 2 }, // closed earlier
    { side: 'BUY', qty: '0.02', time: 3 }, { side: 'BUY', qty: '0.01', time: 4 }, { side: 'SELL', qty: '0.01', time: 5 },
  ];
  assert.equal(st.openTimeFromTrades(trades, '0.02'), 3);
  assert.equal(st.openTimeFromTrades([{ side: 'SELL', qty: '0.05', time: 7 }], '-0.05'), 7);
});
