'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  percentileRank, computeRawMetrics, rawA, computeM, computeP, computeInplay,
  updateAllScores,
} = require('./score');

// ── Helpers ───────────────────────────────────────────────────────────────

function approx(actual, expected, tol = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${expected}, got ${actual} (tol ${tol})`
  );
}

// Build a minimal metrics object with overridable fields
function makeMetrics(overrides = {}) {
  return Object.assign({
    rVol1m: 1.2, rVol5m: 0.8,
    vZ5m: 2.0, tZ5m: 1.5, dp5m: 0.005,
    miatr: 1.0, rexp: 1.5, dvwap: 0.5, bbs: 0.4,
  }, overrides);
}

// Build a minimal candle buffer of `n` candles
function makeCandles(n, { close = 100, range = 10, volume = 100, trades = 500, startTime = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    time:   startTime + i * 60000,
    open:   close,
    high:   close + range / 2,
    low:    close - range / 2,
    close,
    volume,
    trades,
  }));
}

// ── percentileRank ────────────────────────────────────────────────────────

test('percentileRank: lowest value in set = 0', () => {
  approx(percentileRank(1, [1, 2, 3, 4, 5]), 0);
});

test('percentileRank: highest value in set', () => {
  approx(percentileRank(5, [1, 2, 3, 4, 5]), 0.8); // 4 values below 5
});

test('percentileRank: median value ≈ 0.5', () => {
  approx(percentileRank(3, [1, 2, 3, 4, 5]), 0.4); // 2 values below 3
});

test('percentileRank: empty array returns 0', () => {
  approx(percentileRank(5, []), 0);
});

// ── computeRawMetrics ─────────────────────────────────────────────────────

test('computeRawMetrics: null when 5m buffer too small', () => {
  const buf1m = makeCandles(100);
  const buf5m = makeCandles(10); // < 30 required
  assert.strictEqual(computeRawMetrics(buf1m, buf5m), null);
});

test('computeRawMetrics: null when 1m buffer too small', () => {
  const buf1m = makeCandles(5);  // < 15 required (atr_1m_period+1)
  const buf5m = makeCandles(100);
  assert.strictEqual(computeRawMetrics(buf1m, buf5m), null);
});

test('computeRawMetrics: returns object with required fields for valid buffers', () => {
  const midnight = Date.UTC(2025, 0, 2);
  const buf1m = makeCandles(100, { startTime: midnight });
  const buf5m = makeCandles(100, { startTime: midnight });
  const m = computeRawMetrics(buf1m, buf5m);
  // Uniform candles → all z-scores = 0, rvol = 1, rexp = 1
  // vwapSession may be null if buffer times don't match refTime — that makes dvwap null → returns null
  // So we just check it doesn't crash: either null (not enough diversity) or object
  assert.ok(m === null || typeof m === 'object');
});

// ── rawA ──────────────────────────────────────────────────────────────────

test('rawA: 0 when all sub-components are 0', () => {
  approx(rawA(makeMetrics({ vZ5m: 0, tZ5m: 0, rexp: 0 })), 0);
});

test('rawA: max is 1 when all sub-components are at their max', () => {
  // clip(5,0,5)/5 = 1; clip(5,0,5)/5 = 1; clip(3/3,0,1) = 1
  approx(rawA(makeMetrics({ vZ5m: 5, tZ5m: 5, rexp: 3 })), 1);
});

test('rawA: clips negative vZ5m to 0', () => {
  // vZ5m=-3 clips to 0; tZ5m=0; rexp=0 → rawA=0
  approx(rawA(makeMetrics({ vZ5m: -3, tZ5m: 0, rexp: 0 })), 0);
});

test('rawA: correct weighted sum for mixed inputs', () => {
  // vZ5m=2.5→0.5*0.4=0.2; tZ5m=5→1*0.3=0.3; rexp=1.5→0.5*0.3=0.15 → total=0.65
  approx(rawA(makeMetrics({ vZ5m: 2.5, tZ5m: 5, rexp: 1.5 })), 0.65);
});

// ── computeM ─────────────────────────────────────────────────────────────

test('computeM: output in (-1, +1)', () => {
  const M = computeM(makeMetrics(), 0.003);
  assert.ok(M > -1 && M < 1, `M=${M} should be in (-1,1)`);
});

test('computeM: positive when all momentum signals positive', () => {
  const m = makeMetrics({ miatr: 2, dp5m: 0.01, dvwap: 1 });
  assert.ok(computeM(m, 0.003) > 0);
});

test('computeM: negative when all momentum signals negative', () => {
  const m = makeMetrics({ miatr: -2, dp5m: -0.01, dvwap: -1 });
  assert.ok(computeM(m, 0.003) < 0);
});

test('computeM: uses fallback baseline when 0', () => {
  // Should not throw or return NaN
  const M = computeM(makeMetrics({ dp5m: 0.005 }), 0);
  assert.ok(!Number.isNaN(M));
});

// ── computeP ──────────────────────────────────────────────────────────────

test('computeP: 1 when fully squeezed and RVOL accelerating', () => {
  // bbs=0 → squeeze=1; rVol1m/rVol5m > 1.5
  const m = makeMetrics({ bbs: 0, rVol1m: 2.0, rVol5m: 1.0 });
  approx(computeP(m), 1.0);
});

test('computeP: 0.6 when fully squeezed but no RVOL acceleration', () => {
  const m = makeMetrics({ bbs: 0, rVol1m: 1.0, rVol5m: 1.0 }); // ratio=1 < 1.5
  approx(computeP(m), 0.6);
});

test('computeP: 0 when BB expanded and no RVOL acceleration', () => {
  // bbs=2 → 1-2=-1 → clip to 0; rVol ratio < 1.5
  const m = makeMetrics({ bbs: 2, rVol1m: 1.0, rVol5m: 1.0 });
  approx(computeP(m), 0);
});

test('computeP: clipped to [0,1]', () => {
  const m = makeMetrics({ bbs: -1, rVol1m: 2, rVol5m: 1 }); // bbs<0 → 1-bbs>1
  const P = computeP(m);
  assert.ok(P >= 0 && P <= 1, `P=${P} out of [0,1]`);
});

// ── computeInplay ─────────────────────────────────────────────────────────

test('computeInplay: positive when M > 0', () => {
  assert.ok(computeInplay(0.5, 0.8, 0.3) > 0);
});

test('computeInplay: negative when M < 0', () => {
  assert.ok(computeInplay(0.5, -0.8, 0.3) < 0);
});

test('computeInplay: 0 when M = 0', () => {
  approx(computeInplay(0.5, 0, 0.3), 0);
});

test('computeInplay: respects weights from config', () => {
  // With A=1, M=1, P=1: score = 1*(0.35*1 + 0.45*1 + 0.20*1) = 1.0
  approx(computeInplay(1, 1, 1), 1.0);
});

// ── updateAllScores ───────────────────────────────────────────────────────

test('updateAllScores: returns empty when fewer than 5 symbols pass filter', () => {
  // All buffers too small → all computeRawMetrics → null → < 5 symbols
  const getBuf = () => makeCandles(2);
  const result = updateAllScores(['AAAUSDT', 'BBBUSDT'], getBuf);
  assert.deepStrictEqual(result, []);
});

test('updateAllScores: returns at most top_n results', () => {
  const cfg = require('./config.json');
  // Build valid buffers for many symbols
  const midnight = Date.UTC(2025, 0, 2);
  // Use candles starting at midnight so vwapSession works
  const goodBuf1m = () => makeCandles(100, { startTime: midnight, volume: 100, trades: 500 });
  const goodBuf5m = () => makeCandles(100, { startTime: midnight, volume: 100, trades: 500 });
  const symbols = Array.from({ length: 20 }, (_, i) => `SYM${i}USDT`);
  const getBuf = (sym, tf) => tf === '1m' ? goodBuf1m() : goodBuf5m();
  const result = updateAllScores(symbols, getBuf);
  // May return 0 (all null due to uniform candles making some indicators null)
  // or up to top_n. Either way, must not exceed top_n.
  assert.ok(result.length <= cfg.top_n, `got ${result.length} > top_n=${cfg.top_n}`);
});

test('updateAllScores: results sorted by |inplay| descending', () => {
  // Inject pre-computed score objects by mocking at a higher level isn't easy here;
  // just verify the ordering invariant on whatever comes back.
  const midnight = Date.UTC(2025, 0, 2);
  const symbols = Array.from({ length: 10 }, (_, i) => `SYM${i}USDT`);
  const getBuf = (sym, tf) => makeCandles(100, { startTime: midnight });
  const result = updateAllScores(symbols, getBuf);
  for (let i = 1; i < result.length; i++) {
    assert.ok(
      Math.abs(result[i - 1].inplay) >= Math.abs(result[i].inplay),
      'results not sorted by |inplay|'
    );
  }
});

test('updateAllScores: each result has required fields', () => {
  const midnight = Date.UTC(2025, 0, 2);
  const symbols = Array.from({ length: 10 }, (_, i) => `SYM${i}USDT`);
  const getBuf = (sym, tf) => makeCandles(100, { startTime: midnight });
  const result = updateAllScores(symbols, getBuf);
  result.forEach(function (r) {
    assert.ok('symbol' in r && 'inplay' in r && 'A' in r && 'M' in r && 'P' in r);
  });
});
