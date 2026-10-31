'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./metrics');

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 31, 10, 0);
// A quiet minute: $20K, 40 trades, range 0.1% around 100
function quiet(i) { return { t: T0 + i * MIN, o: 100, h: 100.05, l: 99.95, c: 100, q: 20000, n: 40, closed: true }; }
function history(n) { return Array.from({ length: n }, (_, i) => quiet(i)); }
const close = (a, b) => Math.abs(a - b) < 1e-9;

test('windowMinutes: closed bars count whole, the forming one for the part passed', () => {
  const win = [1, 2, 3, 4].map((i) => ({ t: i * MIN, closed: true }));
  assert.equal(M.windowMinutes(win, 0), 4);
  win.push({ t: 5 * MIN, closed: false });
  assert.equal(M.windowMinutes(win, 5 * MIN + 30000), 4.5);
  assert.equal(M.windowMinutes(win, 9 * MIN), 5);   // late update: one full minute at most
  assert.equal(M.windowMinutes([], 0), 0);
});

test('rangePct: high − low of the whole window in % of its open', () => {
  assert.equal(M.rangePct([{ o: 100, h: 101, l: 99.5 }, { o: 100.5, h: 102, l: 100 }]), 2.5);
  assert.equal(M.rangePct([{ o: 0, h: 1, l: 1 }]), null);
  assert.equal(M.rangePct([]), null);
});

test('changePct: from the window open to the last close, signed', () => {
  assert.equal(M.changePct([{ o: 100, c: 100.5 }, { o: 100.5, c: 101 }]), 1);
  assert.equal(M.changePct([{ o: 100, c: 99 }]), -1);
  assert.equal(M.changePct([]), null);
});

test('vsNorm: per minute against the norm per minute, null without a norm', () => {
  assert.equal(M.vsNorm(300, 3, 50), 2);
  assert.equal(M.vsNorm(300, 0, 50), null);
  assert.equal(M.vsNorm(300, 3, 0), null);
});

test('dayNorm: 24 h ticker → per minute and the day\'s high / low', () => {
  assert.deepEqual(M.dayNorm({ quoteVolume: '14400000', count: '144000', highPrice: '110', lowPrice: '90' }),
    { dayUsd: 14400000, usdPerMin: 10000, tradesPerMin: 100, high: 110, low: 90 });
});

test('growth: per minute of the short window against per minute of the long one', () => {
  assert.equal(M.growth({ usd: 300, mins: 15 }, { usd: 1800, mins: 180 }, 'usd'), 2);
  assert.equal(M.growth({ n: 30, mins: 15 }, { n: 0, mins: 180 }, 'n'), null);
  assert.equal(M.growth(null, { usd: 1, mins: 1 }, 'usd'), null);
});

test('candlesOf: 1-minute bars into clock-aligned candles', () => {
  const bars = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ t: T0 + i * MIN, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
  const c = M.candlesOf(bars, 5);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0], { t: T0, o: 100, h: 105, l: 99, c: 104.5 });
  assert.deepEqual(c[1], { t: T0 + 5 * MIN, o: 105, h: 107, l: 104, c: 106.5 });
});

test('natr: average true range of the last candles in % of the last price, gaps count', () => {
  // Every 5-minute candle 99…101, closing at 100: true range 2 → 2%
  const flat = history(80).map((b) => ({ ...b, h: 101, l: 99 }));
  assert.ok(close(M.natr(flat, 5, 14), 2));
  // A gap up: the previous close 100, the candle 104…105 → true range 5, not 1
  const gap = history(10).map((b) => ({ ...b, h: 101, l: 99 }));
  for (let i = 10; i < 15; i++) gap.push({ t: T0 + i * MIN, o: 104, h: 105, l: 104, c: 104.5, q: 0, n: 0, closed: true });
  assert.ok(close(M.natr(gap, 5, 2), (2 + 5) / 2 / 104.5 * 100));
  assert.equal(M.natr(history(20), 5, 14), null); // 4 candles only
});

test('dayExtreme: distance to the nearer of the day\'s high / low, fresh bars extend them', () => {
  const norm = { high: 110, low: 90 };
  assert.deepEqual(M.dayExtreme([{ h: 100, l: 99, c: 108 }], norm), { pct: 2 / 108 * 100, side: 'high' });
  assert.deepEqual(M.dayExtreme([{ h: 96, l: 95, c: 95 }], norm), { pct: 5 / 95 * 100, side: 'low' });
  assert.deepEqual(M.dayExtreme([{ h: 112, l: 108, c: 112 }], norm), { pct: 0, side: 'high' }); // a new high
  assert.equal(M.dayExtreme([], norm), null);
  assert.equal(M.dayExtreme([{ h: 1, l: 1, c: 1 }], null), null);
});

test('windowStats: a burst over the last 5 minutes against the day norm', () => {
  const bars = history(10);
  for (let i = 0; i < 5; i++) {
    const o = 100 + i * 0.4;
    bars.push({ t: T0 + (10 + i) * MIN, o, h: o + 0.6, l: o - 0.2, c: o + 0.4, q: 160000, n: 200, closed: true });
  }
  const norm = { usdPerMin: 20000, tradesPerMin: 40 };
  const w = M.windowStats(bars, 5, T0 + 15 * MIN, norm);
  assert.ok(close(w.chg, 2));
  assert.ok(close(w.range, 2.4));  // 99.8 → 102.2 from an open of 100
  assert.equal(w.usd, 800000);
  assert.equal(w.n, 1000);
  assert.equal(w.mins, 5);
  assert.equal(w.vol, 8);
  assert.equal(w.trades, 5);
  const w15 = M.windowStats(bars, 15, T0 + 15 * MIN, norm);
  assert.ok(close(w15.vol, (10 * 20000 + 800000) / 15 / 20000));
  assert.equal(M.windowStats(bars, 60, T0 + 15 * MIN, norm), null); // not enough bars yet
});

test('coinWindows: every window; ok only with a norm at the 24 h liquidity gate', () => {
  const bars = history(M.CFG.keepBars);
  const norm = M.dayNorm({ quoteVolume: String(20000 * 1440), count: String(40 * 1440), highPrice: '101', lowPrice: '99' });
  const c = M.coinWindows(bars, T0 + bars.length * MIN, norm);
  assert.deepEqual(Object.keys(c.w), ['5m', '15m', '1h', '3h']);
  assert.equal(c.gv, 1);   // a flat coin: the last 15 min like the last 3 h
  assert.equal(c.gt, 1);
  assert.equal(c.ext.side, 'high');
  assert.ok(close(c.natr, 0.1)); // flat bars 99.95…100.05
  assert.equal(c.w['3h'].vol, 1);
  assert.equal(c.w['1h'].chg, 0);
  assert.equal(c.ok, true); // $28.8M a day
  assert.equal(M.coinWindows(bars, 0, M.dayNorm({ quoteVolume: '5000000', count: '1' })).ok, false);
  assert.equal(M.coinWindows(bars, 0, null).ok, false);
});
