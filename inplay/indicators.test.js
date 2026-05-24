'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mean, std,
  rvol, volZ, tradesZ, deltaPrice,
  atrWilder, moveInATR, rangeExpansion,
  vwapSession, distVwapATR, bbSqueeze,
} = require('./indicators');

// ── Helpers ───────────────────────────────────────────────────────────────

// Build synthetic candles. close can be a number (flat) or array (per-candle).
function makeCandles(n, { open, high, low, close, volume, trades, startTime, range } = {}) {
  const closes = Array.isArray(close) ? close : Array(n).fill(close ?? 100);
  const r = range ?? 10;
  return closes.map((c, i) => ({
    time:   (startTime ?? 0) + i * 60000,
    open:   open ?? c,
    high:   high ?? c + r / 2,
    low:    low  ?? c - r / 2,
    close:  c,
    volume: Array.isArray(volume) ? volume[i] : (volume ?? 100),
    trades: Array.isArray(trades) ? trades[i] : (trades ?? 1000),
  }));
}

function approx(actual, expected, tol = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${expected}, got ${actual} (tol ${tol})`
  );
}

// ── mean / std ────────────────────────────────────────────────────────────

test('mean of [1,2,3,4,5] = 3', () => {
  approx(mean([1, 2, 3, 4, 5]), 3);
});

test('std of uniform array = 0', () => {
  approx(std([5, 5, 5, 5]), 0);
});

test('std([2,4,4,4,5,5,7,9]) ≈ 2', () => {
  approx(std([2, 4, 4, 4, 5, 5, 7, 9]), 2);
});

// ── rvol ─────────────────────────────────────────────────────────────────

test('rvol returns null when not enough data', () => {
  const buf = makeCandles(5, { volume: 100 });
  assert.strictEqual(rvol(buf, 5), null); // needs 6
});

test('rvol = 2 when current vol is 2× baseline', () => {
  // 20 candles vol=100, last candle vol=200
  const vols = Array(20).fill(100).concat([200]);
  const buf = makeCandles(21, { volume: vols });
  approx(rvol(buf, 20), 2);
});

test('rvol = 1 when current vol equals baseline', () => {
  const buf = makeCandles(21, { volume: 100 });
  approx(rvol(buf, 20), 1);
});

// ── volZ ─────────────────────────────────────────────────────────────────

test('volZ = 0 when all volumes equal', () => {
  const buf = makeCandles(30, { volume: 100 });
  approx(volZ(buf, 30), 0);
});

test('volZ returns null when not enough data', () => {
  const buf = makeCandles(10, { volume: 100 });
  assert.strictEqual(volZ(buf, 30), null);
});

test('volZ is positive when last volume is above mean', () => {
  const vols = Array(29).fill(100).concat([200]);
  const buf = makeCandles(30, { volume: vols });
  assert.ok(volZ(buf, 30) > 0, 'expected positive volZ');
});

// ── tradesZ ───────────────────────────────────────────────────────────────

test('tradesZ = 0 when all trade counts equal', () => {
  const buf = makeCandles(30, { trades: 500 });
  approx(tradesZ(buf, 30), 0);
});

test('tradesZ is positive when last count is above mean', () => {
  const t = Array(29).fill(500).concat([1000]);
  const buf = makeCandles(30, { trades: t });
  assert.ok(tradesZ(buf, 30) > 0);
});

// ── deltaPrice ────────────────────────────────────────────────────────────

test('deltaPrice returns null when not enough data', () => {
  const buf = makeCandles(4, { close: 100 });
  assert.strictEqual(deltaPrice(buf, 5), null);
});

test('deltaPrice = 0.10 for +10% move over 5 candles', () => {
  const buf = makeCandles(6, { close: [100, 100, 100, 100, 100, 110] });
  approx(deltaPrice(buf, 5), 0.10);
});

test('deltaPrice is negative for a down move', () => {
  const buf = makeCandles(6, { close: [100, 100, 100, 100, 100, 90] });
  approx(deltaPrice(buf, 5), -0.10);
});

// ── atrWilder ─────────────────────────────────────────────────────────────

test('atrWilder returns null when not enough data', () => {
  const buf = makeCandles(14, { close: 100, range: 10 });
  assert.strictEqual(atrWilder(buf, 14), null); // needs 15
});

test('atrWilder = 10 when TR is constant 10', () => {
  // high = close+5, low = close-5 → TR = high-low = 10 always, no gaps
  const buf = makeCandles(30, { close: 100, range: 10 });
  approx(atrWilder(buf, 14), 10, 1e-9);
});

test('atrWilder matches manual Wilder smoothing', () => {
  // 16 candles, constant close=100. Vary high/low to control TR without prevClose gap effects.
  // candle 0: base (high=105,low=95)
  // candles 1..14: TR=10 (high=105,low=95) → initial ATR = 10
  // candle 15: TR=20 (high=110,low=90)
  // Expected final ATR = (10*13 + 20) / 14 = 150/14
  const base = { open: 100, close: 100, volume: 100, trades: 500 };
  const candles = [
    { time: 0,           ...base, high: 105, low: 95 },  // candle 0
    ...Array.from({ length: 14 }, (_, i) =>
      ({ time: (i + 1) * 60000, ...base, high: 105, low: 95 })  // TR=10 each
    ),
    { time: 15 * 60000, ...base, high: 110, low: 90 },   // TR=20
  ];
  approx(atrWilder(candles, 14), 150 / 14, 1e-9);
});

// ── moveInATR ─────────────────────────────────────────────────────────────

test('moveInATR returns null when not enough candles', () => {
  const buf = makeCandles(5, { close: 100, range: 10 });
  assert.strictEqual(moveInATR(buf, 14), null);
});

test('moveInATR = 1 when price rose exactly 1 ATR over 5 min', () => {
  // Gradual +2 per candle keeps TR=10 throughout (no prevClose gap > half-range).
  // close_5m_ago (buf[24]) = 100, close_now (buf[29]) = 110, ATR = 10 → ratio = 1.
  const closes = Array(25).fill(100).concat([102, 104, 106, 108, 110]);
  const buf = makeCandles(30, { close: closes, range: 10 });
  approx(moveInATR(buf, 14), 1.0, 1e-9);
});

// ── rangeExpansion ────────────────────────────────────────────────────────

test('rangeExpansion returns null when not enough data', () => {
  const buf = makeCandles(10, { range: 5 });
  assert.strictEqual(rangeExpansion(buf, 20), null);
});

test('rangeExpansion = 1 when all ranges equal', () => {
  const buf = makeCandles(20, { close: 100, range: 10 });
  approx(rangeExpansion(buf, 20), 1);
});

test('rangeExpansion = 2 when last range is 2× mean', () => {
  // 19 candles range=10, last range=20
  const candles = makeCandles(19, { close: 100, range: 10 })
    .concat([{ time: 19 * 60000, open: 100, high: 110, low: 90, close: 100, volume: 100, trades: 500 }]);
  // mean of 20 ranges: 19*10 + 20 = 210, /20 = 10.5; current=20; ratio≈1.905
  approx(rangeExpansion(candles, 20), 20 / 10.5, 1e-9);
});

// ── vwapSession ───────────────────────────────────────────────────────────

test('vwapSession returns null with no session candles', () => {
  // All candles before today UTC
  const buf = makeCandles(5, { close: 100, startTime: 0 }); // epoch 0 = 1970
  const refTime = Date.UTC(2025, 0, 2); // Jan 2 2025 00:00 UTC
  assert.strictEqual(vwapSession(buf, refTime), null);
});

test('vwapSession computes correctly for 3 candles', () => {
  // refTime = Jan 2 2025 00:00 UTC
  const midnight = Date.UTC(2025, 0, 2);
  const candles = [
    { time: midnight,           open: 100, high: 110, low: 90,  close: 100, volume: 10, trades: 100 },
    { time: midnight + 60000,   open: 100, high: 120, low: 80,  close: 100, volume: 20, trades: 100 },
    { time: midnight + 120000,  open: 100, high: 130, low: 70,  close: 100, volume: 30, trades: 100 },
  ];
  // tp: (110+90+100)/3=100, (120+80+100)/3=100, (130+70+100)/3=100 → all tp=100
  // VWAP = (100*10 + 100*20 + 100*30) / (10+20+30) = 6000/60 = 100
  approx(vwapSession(candles, midnight + 130000), 100);
});

test('vwapSession = weighted average of typical prices', () => {
  const midnight = Date.UTC(2025, 0, 2);
  const candles = [
    { time: midnight,         open: 100, high: 110, low: 90, close: 100, volume: 100, trades: 100 },
    { time: midnight + 60000, open: 100, high: 130, low: 90, close: 110, volume: 200, trades: 100 },
  ];
  // tp1 = (110+90+100)/3 = 100, tp2 = (130+90+110)/3 ≈ 110
  const tp1 = (110 + 90 + 100) / 3;
  const tp2 = (130 + 90 + 110) / 3;
  const expected = (tp1 * 100 + tp2 * 200) / 300;
  approx(vwapSession(candles, midnight + 70000), expected, 1e-9);
});

// ── distVwapATR ───────────────────────────────────────────────────────────

test('distVwapATR = 0 when close == VWAP', () => {
  // All candles today, same close/tp/volume → VWAP = close
  const midnight = Date.UTC(2025, 0, 2);
  const buf = makeCandles(30, { close: 100, range: 10, startTime: midnight });
  // VWAP = 100, close = 100, ATR = 10 → dist = 0/10 = 0
  approx(distVwapATR(buf, 14, midnight + 30 * 60000), 0, 1e-9);
});

// ── bbSqueeze ─────────────────────────────────────────────────────────────

test('bbSqueeze returns null when not enough data', () => {
  const buf = makeCandles(60, { close: 100 }); // needs 69
  assert.strictEqual(bbSqueeze(buf, 50), null);
});

test('bbSqueeze = 0 when all closes are identical (zero std)', () => {
  const buf = makeCandles(100, { close: 100 });
  approx(bbSqueeze(buf, 50), 0);
});

test('bbSqueeze ≈ 1 when volatility is constant', () => {
  // Alternating prices → constant BB_width at every window → ratio = 1
  const closes = Array.from({ length: 100 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  const buf = makeCandles(100, { close: closes });
  // All BB_widths are equal → current/mean = 1
  approx(bbSqueeze(buf, 50), 1, 1e-9);
});
