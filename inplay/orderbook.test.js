'use strict';

var { test } = require('node:test');
var assert   = require('node:assert/strict');
var ob       = require('./orderbook');

function approx(actual, expected, tol) {
  tol = tol || 1e-6;
  assert.ok(
    Math.abs(actual - expected) <= tol,
    'expected ' + expected + ', got ' + actual + ' (tol ' + tol + ')'
  );
}

// Build levels: [[price, qty], ...] at uniform qty
function makeLevels(n, startPrice, step, qty) {
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push([startPrice + i * step, qty]);
  }
  return out;
}

// ── spreadBps ─────────────────────────────────────────────────────────────

test('spreadBps: bestBid=100, bestAsk=100.1 → ~9.995 bps', function () {
  var bids = [[100, 1]];
  var asks = [[100.1, 1]];
  approx(ob.spreadBps(bids, asks), 0.1 / 100.05 * 10000, 0.01);
});

test('spreadBps: empty bids → null', function () {
  assert.strictEqual(ob.spreadBps([], [[100, 1]]), null);
});

test('spreadBps: zero mid → null', function () {
  assert.strictEqual(ob.spreadBps([[0, 1]], [[0, 1]]), null);
});

// ── obi ───────────────────────────────────────────────────────────────────

test('obi: equal bid/ask USDT → 0', function () {
  var bids = makeLevels(5, 99, -1, 10);   // each 99*10, 98*10, ...
  var asks = makeLevels(5, 101, 1, 10);   // each 101*10, ...
  // bid sum ≠ ask sum due to prices, so build equal USDT explicitly
  var bids2 = [[100, 5]];
  var asks2 = [[100, 5]];
  approx(ob.obi(bids2, asks2, 1), 0);
});

test('obi: all bids, no ask volume → 1', function () {
  approx(ob.obi([[100, 5]], [[100, 0]], 1), 1);
});

test('obi: more ask than bid → negative', function () {
  var bids = [[100, 1]];
  var asks = [[100, 3]];
  assert.ok(ob.obi(bids, asks, 1) < 0);
});

test('obi: top5 vs top20 — uses only requested N levels', function () {
  // 5 bid levels at qty=2, then 15 more at qty=100 — obi5 != obi20
  var bids = makeLevels(20, 99.9, -0.01, 2);
  for (var i = 5; i < 20; i++) bids[i][1] = 100;
  var asks = makeLevels(20, 100.1, 0.01, 10);
  var o5  = ob.obi(bids, asks, 5);
  var o20 = ob.obi(bids, asks, 20);
  assert.ok(o5 !== o20, 'top5 and top20 should differ when level sizes differ');
});

// ── depthUsdt10bps ────────────────────────────────────────────────────────

test('depthUsdt10bps: bid — counts levels at or above threshold', function () {
  var mid = 100;
  // threshold = 100 * 0.999 = 99.9
  // levels: 100→100*2=200, 99.95→199.9, 99.8→below threshold
  var bids = [[100, 2], [99.95, 2], [99.8, 2]];
  var result = ob.depthUsdt10bps(bids, mid, 'bid');
  approx(result, 100 * 2 + 99.95 * 2, 0.01);
});

test('depthUsdt10bps: ask — counts levels at or below threshold', function () {
  var mid = 100;
  // threshold = 100 * 1.001 = 100.1
  var asks = [[100.05, 3], [100.1, 3], [100.2, 3]];
  var result = ob.depthUsdt10bps(asks, mid, 'ask');
  approx(result, 100.05 * 3 + 100.1 * 3, 0.01);
});

test('depthUsdt10bps: empty levels → 0', function () {
  assert.strictEqual(ob.depthUsdt10bps([], 100, 'bid'), 0);
});

// ── depthRatio ────────────────────────────────────────────────────────────

test('depthRatio: equal bid/ask depth → ~1', function () {
  var bids = [[99.95, 10]];  // 99.95*10 = 999.5, within 10bps of mid=100
  var asks = [[100.05, 10]]; // 100.05*10 = 1000.5
  var r = ob.depthRatio(bids, asks);
  approx(r, 999.5 / 1000.5, 0.001);
});

test('depthRatio: empty bids → null', function () {
  assert.strictEqual(ob.depthRatio([], [[100, 1]]), null);
});

// ── wallDetected ──────────────────────────────────────────────────────────

test('wallDetected: one level 4× others → true', function () {
  // 19 levels at qty=1 (price=100), one at qty=4 → sizes: most=100, wall=400 > 3×100
  var levels = makeLevels(20, 100, -0.01, 1);
  levels[5][1] = 4;  // 4× median
  assert.strictEqual(ob.wallDetected(levels), true);
});

test('wallDetected: all levels equal → false', function () {
  var levels = makeLevels(20, 100, -0.01, 5);
  assert.strictEqual(ob.wallDetected(levels), false);
});

test('wallDetected: fewer than 3 levels → false', function () {
  assert.strictEqual(ob.wallDetected([[100, 10], [99, 5]]), false);
});

// ── vacuumDistance ────────────────────────────────────────────────────────

test('vacuumDistance: thin level at second position → small bps', function () {
  var mid = 100;
  // asks ascending: 100.1 (normal), 100.2 (thin: 0.1× median), 100.3 (normal)
  // sizes: 100.1*10=1001, 100.2*0.1=10.02, 100.3*10=1003 — median≈1001, thin<300.3
  var asks = [[100.1, 10], [100.2, 0.1], [100.3, 10]];
  var d = ob.vacuumDistance(asks, mid);
  // thin level at price=100.2, distance = |100.2-100|/100*10000 = 20 bps
  approx(d, 20, 0.1);
});

test('vacuumDistance: no thin levels → 999', function () {
  var mid = 100;
  var asks = makeLevels(10, 100.1, 0.1, 10);
  assert.strictEqual(ob.vacuumDistance(asks, mid), 999);
});

test('vacuumDistance: empty levels → 999', function () {
  assert.strictEqual(ob.vacuumDistance([], 100), 999);
});

// ── updateEmaOBI + obiConfirmed ───────────────────────────────────────────

test('updateEmaOBI: initialises to first value', function () {
  ob.initOrderbookState('TEST_EMA');
  ob.updateEmaOBI('TEST_EMA', 0.5);
  var s = ob.getOrderbookState('TEST_EMA');
  approx(s.emaOBI5, 0.5);
});

test('updateEmaOBI: subsequent updates smooth toward new value', function () {
  ob.initOrderbookState('TEST_EMA2');
  ob.updateEmaOBI('TEST_EMA2', 0);   // init at 0
  ob.updateEmaOBI('TEST_EMA2', 1);   // push toward 1
  var s = ob.getOrderbookState('TEST_EMA2');
  assert.ok(s.emaOBI5 > 0 && s.emaOBI5 < 1, 'EMA should be between 0 and 1');
});

test('obiConfirmed: OBI and aggrRatio same sign → returns OBI', function () {
  // emaOBI5=0.3 (positive), aggrRatio=0.7 → aggrSigned=0.4 (positive) → agree
  approx(ob.obiConfirmed(0.3, 0.7), 0.3);
});

test('obiConfirmed: OBI and aggrRatio opposite sign → returns 0', function () {
  // emaOBI5=0.3 (positive bid-heavy), aggrRatio=0.3 → aggrSigned=-0.4 (negative) → disagree
  assert.strictEqual(ob.obiConfirmed(0.3, 0.3), 0);
});

test('obiConfirmed: null emaOBI5 → 0', function () {
  assert.strictEqual(ob.obiConfirmed(null, 0.7), 0);
});

test('obiConfirmed: null aggrRatio → 0', function () {
  assert.strictEqual(ob.obiConfirmed(0.3, null), 0);
});

// ── liquidityVacuumAlignment ──────────────────────────────────────────────

test('liquidityVacuumAlignment: M>0, vacuumAbove=15 bps → 0.5', function () {
  approx(ob.liquidityVacuumAlignment(15, 50, 0.5), 0.5, 1e-9);
});

test('liquidityVacuumAlignment: M<0, vacuumBelow=0 bps → 1.0', function () {
  approx(ob.liquidityVacuumAlignment(50, 0, -0.5), 1.0);
});

test('liquidityVacuumAlignment: M>0 but vacuumAbove beyond threshold → 0', function () {
  assert.strictEqual(ob.liquidityVacuumAlignment(40, 10, 0.5), 0);
});

test('liquidityVacuumAlignment: M=0 → 0', function () {
  assert.strictEqual(ob.liquidityVacuumAlignment(10, 10, 0), 0);
});

// ── 3.1: реалистичные масштабы и детекция ошибки парсинга ─────────────────

test('spreadBps: BTC-scale prices → ~2 bps, not 50+', function () {
  // BTC at 65000, $13 spread → 13/65006.5*10000 ≈ 2 bps
  // Если spread > 10 — ошибка парсинга стакана (цена/qty перепутаны)
  var bids = [[65000, 5]];
  var asks = [[65013, 5]];
  var spr = ob.spreadBps(bids, asks);
  assert.ok(spr > 0 && spr < 5, 'BTC $13 spread should be ~2 bps, got ' + spr.toFixed(2));
});

test('spreadBps: inverted book (ask < bid) → negative spread detects parsing bug', function () {
  // Если bid и ask перепутаны при парсинге — результат отрицательный
  var r = ob.spreadBps([[101, 1]], [[99, 1]]);
  assert.ok(r < 0, 'inverted book must return negative spread');
});

test('obi: result always bounded in [-1, 1] for extreme imbalance', function () {
  assert.ok(ob.obi([[100, 1e9]], [[100, 0]], 1) <= 1);
  assert.ok(ob.obi([[100, 0]], [[100, 1e9]], 1) >= -1);
});

test('depthUsdt10bps: BTC-scale prices — 10 levels × 1 BTC > $500k', function () {
  // Spec 3.1: Depth_USDT_10bps для BTC/USDT минимум $500k
  // 10 bid levels от 65000 вниз с шагом 0.5, qty=1 BTC
  // Все уровни выше threshold 65000*0.999=64935
  var mid  = 65000;
  var bids = [];
  for (var i = 0; i < 10; i++) bids.push([65000 - i * 0.5, 1]);
  var depth = ob.depthUsdt10bps(bids, mid, 'bid');
  assert.ok(depth > 500000, 'BTC 10×1BTC depth should exceed $500k, got $' + depth.toFixed(0));
});

// ── 3.2: граничный множитель стены и сходимость EMA ──────────────────────

test('wallDetected: exactly 3× median → false (strict >, not >=)', function () {
  // Spec: > 3× median. Ровно 3× — не стена.
  var levels = [];
  for (var i = 0; i < 20; i++) levels.push([100, 1]);
  levels[5][1] = 3;   // size=300, median of others=100, 300 > 300 is false
  assert.strictEqual(ob.wallDetected(levels), false);
});

test('wallDetected: just above 3× median → true', function () {
  var levels = [];
  for (var i = 0; i < 20; i++) levels.push([100, 1]);
  levels[5][1] = 3.001;  // size=300.1 > 300.0 → true
  assert.strictEqual(ob.wallDetected(levels), true);
});

test('updateEmaOBI: converges to constant input after many steps (spec: period=30)', function () {
  // После 200 тиков с одним значением EMA должна сойтись
  // alpha=2/31≈0.0645, after 200 steps: residual = (1-alpha)^200 < 0.001
  ob.initOrderbookState('TEST_EMA_CONV');
  ob.updateEmaOBI('TEST_EMA_CONV', 0);   // init at 0
  for (var i = 0; i < 200; i++) ob.updateEmaOBI('TEST_EMA_CONV', 0.8);
  var s = ob.getOrderbookState('TEST_EMA_CONV');
  approx(s.emaOBI5, 0.8, 0.01);
});

test('vacuumDistance: returns CLOSEST thin level, not a farther one', function () {
  // Два тонких уровня: 100.2 (ближе) и 100.5 (дальше) — должен вернуть 20 bps
  var mid  = 100;
  var asks = [[100.1, 10], [100.2, 0.05], [100.5, 0.05], [100.6, 10]];
  var d    = ob.vacuumDistance(asks, mid);
  // Ближайший тонкий: 100.2 → (100.2-100)/100*10000 = 20 bps
  approx(d, 20, 0.1);
});

// ── 3.3: все четыре комбинации знаков obiConfirmed ────────────────────────

test('obiConfirmed: positive OBI + positive aggr → OBI returned', function () {
  // aggrRatio=0.8 → aggrSigned=+0.6, emaOBI5=+0.4 → agree → return OBI
  approx(ob.obiConfirmed(0.4, 0.8), 0.4);
});

test('obiConfirmed: negative OBI + negative aggr → OBI returned', function () {
  // aggrRatio=0.2 → aggrSigned=-0.6, emaOBI5=-0.4 → agree → return OBI
  approx(ob.obiConfirmed(-0.4, 0.2), -0.4);
});

test('obiConfirmed: positive OBI + negative aggr → 0', function () {
  // aggrRatio=0.2 → aggrSigned=-0.6, emaOBI5=+0.4 → disagree → 0
  assert.strictEqual(ob.obiConfirmed(0.4, 0.2), 0);
});

test('obiConfirmed: negative OBI + positive aggr → 0', function () {
  // aggrRatio=0.8 → aggrSigned=+0.6, emaOBI5=-0.4 → disagree → 0
  assert.strictEqual(ob.obiConfirmed(-0.4, 0.8), 0);
});

test('obiConfirmed: emaOBI5=0 → 0 (Math.sign(0)=0, никогда не совпадает с ±1)', function () {
  // Нейтральный OBI никогда не подтверждается — не добавляет сигнал
  assert.strictEqual(ob.obiConfirmed(0, 0.8), 0);
  assert.strictEqual(ob.obiConfirmed(0, 0.2), 0);
});

// ── getOrderbookMetrics ───────────────────────────────────────────────────

test('getOrderbookMetrics: returns null before first snapshot', function () {
  ob.initOrderbookState('TEST_METRICS_EMPTY');
  assert.strictEqual(ob.getOrderbookMetrics('TEST_METRICS_EMPTY'), null);
});

test('getOrderbookMetrics: returns all required fields after snapshot', function () {
  ob.initOrderbookState('TEST_METRICS');
  var bids = makeLevels(20, 99.9, -0.01, 5);
  var asks = makeLevels(20, 100.1, 0.01, 5);
  ob.processDepthUpdate('TEST_METRICS', bids, asks);
  ob.updateEmaOBI('TEST_METRICS', ob.obi(bids, asks, 5));
  var m = ob.getOrderbookMetrics('TEST_METRICS');
  assert.ok(m !== null);
  ['spread', 'obi5', 'obi20', 'emaOBI5', 'depthBid', 'depthAsk',
   'depthRatio', 'wallBid', 'wallAsk', 'vacuumAbove', 'vacuumBelow'
  ].forEach(function (k) {
    assert.ok(k in m, 'missing field: ' + k);
  });
});
