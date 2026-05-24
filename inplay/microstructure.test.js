'use strict';

var { test } = require('node:test');
var assert   = require('node:assert/strict');
var ms       = require('./microstructure');

// ── aggressorRatio ─────────────────────────────────────────────────────────

test('aggressorRatio: returns null when trades < 20', function () {
  assert.strictEqual(ms.aggressorRatio({ buyVol: 5, sellVol: 5, trades: 10, largeVol: 0 }), null);
});

test('aggressorRatio: balanced flow → 0.5', function () {
  var r = ms.aggressorRatio({ buyVol: 100, sellVol: 100, trades: 30, largeVol: 0 });
  assert.ok(r > 0.49 && r < 0.51, 'expected 0.5, got ' + r);
});

test('aggressorRatio: all buys → 1.0', function () {
  assert.strictEqual(ms.aggressorRatio({ buyVol: 100, sellVol: 0, trades: 30, largeVol: 0 }), 1.0);
});

test('aggressorRatio: null input → null', function () {
  assert.strictEqual(ms.aggressorRatio(null), null);
});

// ── largeTradeshare ────────────────────────────────────────────────────────

test('largeTradeshare: half of volume is large → 0.5', function () {
  var r = ms.largeTradeshare({ buyVol: 100, sellVol: 100, trades: 30, largeVol: 100 });
  assert.strictEqual(r, 0.5);
});

test('largeTradeshare: zero total volume → 0', function () {
  assert.strictEqual(ms.largeTradeshare({ buyVol: 0, sellVol: 0, trades: 0, largeVol: 0 }), 0);
});

test('largeTradeshare: null input → 0', function () {
  assert.strictEqual(ms.largeTradeshare(null), 0);
});

// ── cvdSlope ───────────────────────────────────────────────────────────────

test('cvdSlope: rising CVD → positive slope', function () {
  var now = Date.now();
  var pts = [];
  for (var i = 0; i < 10; i++) pts.push({ ts: now - (9 - i) * 10000, value: i * 2 });
  var s = ms.cvdSlope(pts, 120000);
  assert.ok(s > 0, 'expected positive slope, got ' + s);
});

test('cvdSlope: falling CVD → negative slope', function () {
  var now = Date.now();
  var pts = [];
  for (var i = 0; i < 10; i++) pts.push({ ts: now - (9 - i) * 10000, value: (9 - i) * 3 });
  var s = ms.cvdSlope(pts, 120000);
  assert.ok(s < 0, 'expected negative slope, got ' + s);
});

test('cvdSlope: flat CVD → slope ≈ 0', function () {
  var now = Date.now();
  var pts = [];
  for (var i = 0; i < 10; i++) pts.push({ ts: now - (9 - i) * 5000, value: 100 });
  var s = ms.cvdSlope(pts, 120000);
  assert.ok(Math.abs(s) < 0.01, 'expected ~0, got ' + s);
});

test('cvdSlope: fewer than 3 points → null', function () {
  var now = Date.now();
  assert.strictEqual(
    ms.cvdSlope([{ ts: now, value: 1 }, { ts: now - 5000, value: 2 }], 60000),
    null
  );
});

test('cvdSlope: only 2 points in window → null', function () {
  var now = Date.now();
  // 8 old points + 2 recent ones inside a 10s window
  var pts = Array.from({ length: 8 }, function (_, i) { return { ts: now - 600000 + i * 1000, value: i }; });
  pts.push({ ts: now - 5000, value: 10 });
  pts.push({ ts: now - 2000, value: 11 });
  // windowMs = 8000 ms → only the last 2 points qualify → < 3 → null
  assert.strictEqual(ms.cvdSlope(pts, 8000), null);
});

// ── cvdZscore ──────────────────────────────────────────────────────────────

test('cvdZscore: slope above history mean → positive z', function () {
  var history = Array.from({ length: 20 }, function (_, i) { return i * 0.1; });
  var z = ms.cvdZscore(5.0, history, 20);
  assert.ok(z > 0, 'expected positive z');
});

test('cvdZscore: slope below history mean → negative z', function () {
  // history mean ≈ 2.5, std > 0; slope = 0 is well below mean
  var history = Array.from({ length: 20 }, function (_, i) { return 1.0 + i * 0.2; }); // 1.0..4.8
  var z = ms.cvdZscore(0.0, history, 20);
  assert.ok(z < 0, 'expected negative z, got ' + z);
});

test('cvdZscore: null slope → null', function () {
  assert.strictEqual(ms.cvdZscore(null, [1, 2, 3, 4, 5], 5), null);
});

test('cvdZscore: fewer than 5 history entries → 0', function () {
  assert.strictEqual(ms.cvdZscore(1.0, [0.5, 0.8], 5), 0);
});

test('cvdZscore: constant history → 0 (no spread)', function () {
  var history = Array.from({ length: 10 }, function () { return 1.0; });
  assert.strictEqual(ms.cvdZscore(1.0, history, 10), 0);
});

test('cvdZscore: result clamped to [-3, 3]', function () {
  var history = Array.from({ length: 20 }, function () { return 0; });
  history[19] = 0.001; // tiny std
  var z = ms.cvdZscore(100, history, 20);
  assert.ok(z <= 3, 'expected z ≤ 3');
});

// ── cvdDivergence ──────────────────────────────────────────────────────────

test('cvdDivergence: price new high, CVD peaked earlier → bearish (-1)', function () {
  // prices: 0,1,2,...,19  (max at index 19)
  // cvds:   0,1,...,10,9,...,1  (max at index 10, not index 19)
  var prices = Array.from({ length: 20 }, function (_, i) { return i; });
  var cvds   = Array.from({ length: 20 }, function (_, i) { return i < 10 ? i : 20 - i; });
  assert.strictEqual(ms.cvdDivergence(prices, cvds, 20), -1);
});

test('cvdDivergence: price new low, CVD troughed earlier → bullish (+1)', function () {
  // prices: 20,19,...,1  (min at index 19)
  // cvds:   0,-1,...,-5,-4,...,-0.5  (min at index 5, not 19)
  var prices = Array.from({ length: 20 }, function (_, i) { return 20 - i; });
  var cvds   = Array.from({ length: 20 }, function (_, i) {
    return i <= 5 ? -i : -5 + (i - 5) * 0.5;
  });
  assert.strictEqual(ms.cvdDivergence(prices, cvds, 20), +1);
});

test('cvdDivergence: price and CVD both peak at end → 0', function () {
  var prices = Array.from({ length: 20 }, function (_, i) { return i; });
  var cvds   = Array.from({ length: 20 }, function (_, i) { return i * 0.5; });
  assert.strictEqual(ms.cvdDivergence(prices, cvds, 20), 0);
});

test('cvdDivergence: insufficient data → 0', function () {
  assert.strictEqual(ms.cvdDivergence([1, 2, 3], [1, 2, 3], 20), 0);
});

test('cvdDivergence: null inputs → 0', function () {
  assert.strictEqual(ms.cvdDivergence(null, null, 20), 0);
});
