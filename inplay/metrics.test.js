'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./metrics');

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 29, 10, 0);
// A quiet minute: $20K, 40 trades, range 0.1% around 100
function quiet(i) { return { t: T0 + i * MIN, o: 100, h: 100.05, l: 99.95, c: 100, q: 20000, n: 40, closed: true }; }
function history(n) { return Array.from({ length: n }, (_, i) => quiet(i)); }

test('median: odd, even, ignores non-numbers, empty → null', () => {
  assert.equal(M.median([3, 1, 2]), 2);
  assert.equal(M.median([4, 1, 2, 3]), 2.5);
  assert.equal(M.median([5, NaN, 1, undefined, 3]), 3);
  assert.equal(M.median([]), null);
});

test('rangePct: high − low in % of close', () => {
  assert.equal(M.rangePct({ h: 101, l: 99, c: 100 }), 2);
  assert.equal(M.rangePct({ h: 1, l: 1, c: 0 }), 0);
});

test('splitWindow: last 5 bars are "now", up to 240 before them are the history', () => {
  const { win, hist } = M.splitWindow(history(300));
  assert.equal(win.length, 5);
  assert.equal(win[0].t, T0 + 295 * MIN);
  assert.equal(hist.length, 240);
  assert.equal(hist[hist.length - 1].t, T0 + 294 * MIN);
  assert.equal(M.splitWindow(history(10)).hist.length, 5);
});

test('ratePerMin: the forming minute counts for the part that has passed', () => {
  const win = [1, 2, 3, 4].map((i) => ({ t: i * MIN, q: 100, closed: true }));
  win.push({ t: 5 * MIN, q: 50, closed: false });
  assert.equal(M.ratePerMin(win, 'q', 5 * MIN + 30000), 450 / 4.5); // half a minute passed
  assert.equal(M.ratePerMin(win, 'q', 5 * MIN), 450 / 4);           // just started
  assert.equal(M.ratePerMin(win, 'q', 9 * MIN), 450 / 5);           // late update: one full minute at most
  assert.equal(M.ratePerMin([{ t: 0, q: 10, closed: false }], 'q', 0), null);
  assert.equal(M.ratePerMin([], 'q', 0), null);
});

test('ratio: clamped to 1/16…64, null without a norm', () => {
  assert.equal(M.ratio(300, 100), 3);
  assert.equal(M.ratio(1e9, 1), 64);
  assert.equal(M.ratio(0, 100), 1 / 16);
  assert.equal(M.ratio(5, 0), null);
  assert.equal(M.ratio(null, 5), null);
});

test('natrNow: average 1-minute range of the window', () => {
  assert.equal(M.natrNow([{ h: 101, l: 99, c: 100 }, { h: 100.5, l: 99.5, c: 100 }]), 1.5);
  assert.equal(M.natrNow([]), null);
});

test('moveInRanges and changePct: from the window open to the last close', () => {
  const win = [{ o: 100, c: 100.5 }, { o: 100.5, c: 101 }];
  assert.equal(M.moveInRanges(win, 0.5), 2); // 1% move, usual range 0.5% → 2 ranges
  assert.equal(M.changePct(win), 1);
  assert.equal(M.changePct([{ o: 100, c: 99 }]), -1);
  assert.equal(M.moveInRanges(win, 0), null);
});

test('score: 0 when everything is as usual and nothing moved, 1 at twice the norm', () => {
  assert.equal(M.score({ rv: 1, tr: 1, vr: 1, move: 0 }), 0);
  assert.ok(Math.abs(M.score({ rv: 2, tr: 2, vr: 2, move: 1 }) - 1) < 1e-12);
  assert.ok(M.score({ rv: 0.5, tr: 0.5, vr: 1, move: 0 }) < 0);
  assert.equal(M.score({ rv: 2, tr: null, vr: 1 }), null);
});

test('passesGates: liquidity norm, $ per minute now and 1-minute range now', () => {
  const ok = { normUsd: 20000, usdPerMin: 150000, natr: 0.3 };
  assert.equal(M.passesGates(ok), true);
  assert.equal(M.passesGates({ ...ok, normUsd: 10000 }), false);
  assert.equal(M.passesGates({ ...ok, usdPerMin: 90000 }), false);
  assert.equal(M.passesGates({ ...ok, natr: 0.2 }), false);
});

test('ema: first value as is, ~63% of the way after one tau, unknown keeps the old', () => {
  assert.equal(M.ema(null, 5, 1000), 5);
  assert.ok(Math.abs(M.ema(0, 1, 30000, 30000) - (1 - Math.exp(-1))) < 1e-12);
  assert.equal(M.ema(2, null, 1000), 2);
  assert.equal(M.ema(2, 4, 0), 2);
});

test('coinMetrics: a quiet coin scores ~0 and is not in play', () => {
  const bars = history(245);
  const m = M.coinMetrics(bars, T0 + 245 * MIN);
  assert.equal(m.rv, 1);
  assert.equal(m.tr, 1);
  assert.ok(Math.abs(m.vr - 1) < 1e-9);
  assert.equal(m.move, 0);
  assert.equal(m.score, 0);
  assert.equal(m.ok, false); // $20K a minute is under the $100K gate
});

test('coinMetrics: a burst — 8× volume, 5× trades, 4× range, +2% — is in play', () => {
  const bars = history(240);
  for (let i = 0; i < 5; i++) {
    const o = 100 + i * 0.4;
    bars.push({ t: T0 + (240 + i) * MIN, o, h: o + 0.6, l: o - 0.2, c: o + 0.4, q: 160000, n: 200, closed: true });
  }
  const m = M.coinMetrics(bars, T0 + 245 * MIN);
  assert.equal(m.rv, 8);
  assert.equal(m.tr, 5);
  assert.ok(m.vr > 7 && m.vr < 8.1); // ~0.8% range against 0.1%
  assert.ok(Math.abs(m.chg - 2) < 1e-9);
  assert.ok(m.score > 2);
  assert.equal(m.ok, true);
});

test('coinMetrics: not enough history → null', () => {
  assert.equal(M.coinMetrics(history(50), T0 + 50 * MIN), null);
});
