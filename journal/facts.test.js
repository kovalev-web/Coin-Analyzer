'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeDayFacts, buildTrips, zonedDayStart } = require('./facts');

const DAY = Date.UTC(2026, 9, 25);
const MIN = 60 * 1000;
let id = 0;
// fill(t minutes into the day, side, qty, price, realizedPnl, commission)
function f(sym, tMin, side, qty, price, pnl, fee) {
  return { id: ++id, symbol: sym, time: DAY + tMin * MIN, side, qty: String(qty), price: String(price), realizedPnl: String(pnl || 0), commission: String(fee == null ? 0.01 : fee), commissionAsset: 'USDT' };
}
const base = { dayStart: DAY, dayEnd: DAY + 24 * 60 * MIN, date: '2026-10-25', tz: 'UTC' };

test('round trips: open → add → close is one trade; pnl net of fees', () => {
  const trips = buildTrips([f('AUSDT', 10, 'BUY', 10, 1), f('AUSDT', 11, 'BUY', 10, 1.1), f('AUSDT', 12, 'SELL', 20, 1.2, 3)]);
  assert.equal(trips.length, 1);
  assert.equal(trips[0].side, 'long');
  assert.equal(trips[0].fills, 3);
  const facts = computeDayFacts(Object.assign({}, base, { fills: [f('AUSDT', 10, 'BUY', 10, 1), f('AUSDT', 12, 'SELL', 10, 1.5, 5)] }));
  assert.equal(facts.summary.trades, 1);
  assert.equal(facts.summary.pnlNet, 4.98);
  assert.equal(facts.trades[0].holdSec, 120);
});

test('a fill that crosses zero closes one trade and opens the next', () => {
  const trips = buildTrips([f('AUSDT', 1, 'BUY', 10, 1), f('AUSDT', 2, 'SELL', 15, 1.1, 1)]);
  assert.equal(trips.length, 2);
  assert.equal(trips[1].side, 'short');
  assert.equal(trips[1].closeTime, null);
});

test('stop-crane: entries after two losses in a row are flagged', () => {
  const fills = [
    f('AUSDT', 10, 'BUY', 10, 1), f('AUSDT', 11, 'SELL', 10, 0.9, -1),
    f('BUSDT', 20, 'BUY', 10, 1), f('BUSDT', 21, 'SELL', 10, 0.9, -1),
    f('CUSDT', 40, 'BUY', 10, 1), f('CUSDT', 41, 'SELL', 10, 1.1, 1),
  ];
  const v = computeDayFacts(Object.assign({}, base, { fills })).violations;
  assert.equal(v.tradesAfterCrane, 1);
  assert.equal(v.craneBrokenAt, DAY + 40 * MIN);
});

test('revenge: entry within 5 minutes after a loss', () => {
  const fills = [
    f('AUSDT', 10, 'BUY', 10, 1), f('AUSDT', 11, 'SELL', 10, 0.9, -1),
    f('AUSDT', 13, 'BUY', 10, 1), f('AUSDT', 14, 'SELL', 10, 1.1, 1),
    f('AUSDT', 30, 'BUY', 10, 1), f('AUSDT', 31, 'SELL', 10, 1.1, 1),
  ];
  const facts = computeDayFacts(Object.assign({}, base, { fills }));
  assert.deepEqual(facts.trades.map((t) => t.revenge), [false, true, false]);
});

test('size-up after a streak, oversize vs limit, planned and at-level', () => {
  const fills = [
    f('AUSDT', 10, 'BUY', 10, 1), f('AUSDT', 11, 'SELL', 10, 0.9, -1),
    f('AUSDT', 20, 'BUY', 10, 1), f('AUSDT', 21, 'SELL', 10, 0.9, -1),
    f('BUSDT', 30, 'BUY', 100, 1), f('BUSDT', 31, 'SELL', 100, 1.1, 10),
  ];
  const facts = computeDayFacts(Object.assign({}, base, {
    fills, limits: { maxVolume: 50, maxTrades: 2 }, briefingSyms: ['BUSDT'], levelsBySym: { BUSDT: [1.003], AUSDT: [2] },
  }));
  const big = facts.trades[2];
  assert.equal(big.sizeUp, 'after_losses');
  assert.equal(big.oversize, true);
  assert.equal(big.planned, true);
  assert.equal(big.atLevel, true);
  assert.equal(facts.trades[0].atLevel, false);
  assert.equal(facts.violations.overMaxTrades, true);
  assert.equal(facts.violations.offPlan, 2);
});

test('trades opened before the day are not counted; open trade is reported', () => {
  const fills = [
    f('AUSDT', -30, 'BUY', 10, 1), f('AUSDT', 5, 'SELL', 10, 1.1, 1),
    f('BUSDT', 50, 'BUY', 10, 1),
  ];
  const facts = computeDayFacts(Object.assign({}, base, { fills }));
  assert.equal(facts.summary.trades, 0);
  assert.equal(facts.summary.open, 1);
  assert.equal(facts.trades[0].result, 'open');
});

test('zonedDayStart: local midnight in the user zone', () => {
  assert.equal(zonedDayStart('2026-10-25', 'Asia/Ho_Chi_Minh'), Date.UTC(2026, 9, 24, 17));
  assert.equal(zonedDayStart('2026-10-25', null, 3), Date.UTC(2026, 9, 24, 21));
  assert.equal(zonedDayStart('2026-10-25', 'UTC'), Date.UTC(2026, 9, 25));
});

test('scratch: out at about zero (within ±0.1R) is not a loss — re-entering is not revenge, no crane', () => {
  const { outcome } = require('./facts');
  // 1R = 100 USDT × 0.5% = 0.50 → scratch band ±0.05 USDT
  assert.equal(outcome(-0.01, 0.05), 'scratch');
  assert.equal(outcome(-0.06, 0.05), 'loss');
  assert.equal(outcome(0.04, 0.05), 'scratch');
  assert.equal(outcome(-0.01, 0), 'loss'); // no risk settings → any minus is a loss
  const fills = [
    f('XUSDT', 10, 'BUY', 10, 1, 0, 0.005), f('XUSDT', 11, 'SELL', 10, 1, 0, 0.005), // −0.01: fees only
    f('XUSDT', 13, 'BUY', 10, 1), f('XUSDT', 14, 'SELL', 10, 1.1, 1),
  ];
  const limits = { maxVolume: 100, riskPct: 0.5 };
  const withRisk = computeDayFacts(Object.assign({}, base, { fills, limits }));
  assert.deepEqual(withRisk.trades.map((t) => t.revenge), [false, false]);
  const noRisk = computeDayFacts(Object.assign({}, base, { fills }));
  assert.deepEqual(noRisk.trades.map((t) => t.revenge), [false, true]);
  // two scratches in a row don't fire the stop-crane
  const two = [
    f('XUSDT', 10, 'BUY', 10, 1, 0, 0.005), f('XUSDT', 11, 'SELL', 10, 1, 0, 0.005),
    f('XUSDT', 20, 'BUY', 10, 1, 0, 0.005), f('XUSDT', 21, 'SELL', 10, 1, 0, 0.005),
    f('XUSDT', 40, 'BUY', 10, 1), f('XUSDT', 41, 'SELL', 10, 1.1, 1),
  ];
  assert.equal(computeDayFacts(Object.assign({}, base, { fills: two, limits })).violations.tradesAfterCrane, 0);
});

test('a trade keeps its fills for its chart; a flip splits the fill', () => {
  const trips = buildTrips([f('AUSDT', 1, 'BUY', 10, 1), f('AUSDT', 2, 'BUY', 5, 1.05), f('AUSDT', 3, 'SELL', 20, 1.1, 1)]);
  assert.deepEqual(trips[0].execs.map((e) => [e.p, e.q, e.s]), [[1, 10, 'BUY'], [1.05, 5, 'BUY'], [1.1, 15, 'SELL']]);
  assert.deepEqual(trips[1].execs.map((e) => [e.p, e.q, e.s]), [[1.1, 5, 'SELL']]);
  const facts = computeDayFacts(Object.assign({}, base, { fills: [f('AUSDT', 10, 'BUY', 10, 1), f('AUSDT', 12, 'SELL', 10, 1.5, 5)] }));
  assert.equal(facts.trades[0].execs.length, 2);
});
