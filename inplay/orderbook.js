'use strict';

// Per-symbol order book state built from @depth20@100ms WebSocket snapshots.
// Stores top-20 bids/asks in memory and maintains EMA of OBI_top5.

var OBI_EMA_PERIOD  = 30;   // ~3s at 100ms updates
var OBI_EMA_ALPHA   = 2 / (OBI_EMA_PERIOD + 1);
var WALL_MULTIPLIER = 3;    // level is a wall if USDT size > 3× median of the rest
var VACUUM_THIN     = 0.3;  // level is thin if USDT size < 0.3× median
var VACUUM_THRESHOLD_BPS = 30;  // relevance threshold for vacuum_alignment

var _state = {};  // { [SYMBOL]: { bids, asks, emaOBI5, emaInited } }

// ── State init ────────────────────────────────────────────────────────────

function initOrderbookState(symbol) {
  if (_state[symbol]) return;
  _state[symbol] = {
    bids:      [],     // [[price, qty], ...] descending by price
    asks:      [],     // [[price, qty], ...] ascending by price
    emaOBI5:   null,
    emaInited: false,
  };
}

// ── Snapshot ingest ───────────────────────────────────────────────────────

function processDepthUpdate(symbol, bids, asks) {
  var s = _state[symbol];
  if (!s) return;
  s.bids = bids;
  s.asks = asks;
}

// ── Spread ────────────────────────────────────────────────────────────────
// Returns (best_ask - best_bid) / mid × 10000 in basis points.

function spreadBps(bids, asks) {
  if (!bids.length || !asks.length) return null;
  var bestBid = bids[0][0];
  var bestAsk = asks[0][0];
  var mid = (bestBid + bestAsk) / 2;
  if (mid === 0) return null;
  return (bestAsk - bestBid) / mid * 10000;
}

// ── Order Book Imbalance ──────────────────────────────────────────────────
// (Σbids_top_n - Σasks_top_n) / (Σbids_top_n + Σasks_top_n), USDT-weighted.
// Returns value in [-1, 1].

function obi(bids, asks, n) {
  var bidVol = 0, askVol = 0;
  for (var i = 0; i < Math.min(n, bids.length); i++) bidVol += bids[i][0] * bids[i][1];
  for (var j = 0; j < Math.min(n, asks.length); j++) askVol += asks[j][0] * asks[j][1];
  var total = bidVol + askVol;
  if (total === 0) return 0;
  return (bidVol - askVol) / total;
}

// ── Depth within 10bps of mid ─────────────────────────────────────────────
// Sum of USDT-denominated volume in levels within 10bps (0.1%) of mid.
// side: 'bid' (descending levels) or 'ask' (ascending levels).

function depthUsdt10bps(levels, mid, side) {
  if (!levels.length || mid === 0) return 0;
  var threshold = mid * (side === 'bid' ? (1 - 0.001) : (1 + 0.001));
  var total = 0;
  for (var i = 0; i < levels.length; i++) {
    var price = levels[i][0];
    var qty   = levels[i][1];
    if (side === 'bid' && price < threshold) break;
    if (side === 'ask' && price > threshold) break;
    total += price * qty;
  }
  return total;
}

// ── Depth ratio ───────────────────────────────────────────────────────────

function depthRatio(bids, asks) {
  if (!bids.length || !asks.length) return null;
  var mid      = (bids[0][0] + asks[0][0]) / 2;
  var bidDepth = depthUsdt10bps(bids, mid, 'bid');
  var askDepth = depthUsdt10bps(asks, mid, 'ask');
  if (askDepth === 0) return null;
  return bidDepth / askDepth;
}

// ── Wall detection ────────────────────────────────────────────────────────
// Returns true if any level has USDT size > WALL_MULTIPLIER × median of the rest.

function wallDetected(levels) {
  if (levels.length < 3) return false;
  var sizes = levels.map(function (l) { return l[0] * l[1]; });
  for (var i = 0; i < sizes.length; i++) {
    var others = [];
    for (var j = 0; j < sizes.length; j++) { if (j !== i) others.push(sizes[j]); }
    var sorted = others.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(sorted.length / 2);
    var med = sorted.length % 2 !== 0 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    if (med > 0 && sizes[i] > WALL_MULTIPLIER * med) return true;
  }
  return false;
}

// ── Vacuum distance ───────────────────────────────────────────────────────
// Distance in bps from mid to the first "thin" level (USDT size < VACUUM_THIN × median).
// levels must be ordered outward from mid (asks ascending, bids descending).
// Returns 999 when no vacuum is found within the top-20.

function vacuumDistance(levels, mid) {
  if (!levels.length || mid === 0) return 999;
  var sizes = levels.map(function (l) { return l[0] * l[1]; });
  var sorted = sizes.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(sorted.length / 2);
  var med = sorted.length % 2 !== 0 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  if (med === 0) return 999;
  var thinThreshold = med * VACUUM_THIN;
  for (var i = 0; i < levels.length; i++) {
    if (sizes[i] < thinThreshold) {
      return Math.abs(levels[i][0] - mid) / mid * 10000;
    }
  }
  return 999;
}

// ── EMA of OBI_top5 ───────────────────────────────────────────────────────
// Called on every depth snapshot (every 100ms).
// alpha = 2 / (period + 1) ≈ 0.0645 for period=30.

function updateEmaOBI(symbol, rawOBI5) {
  var s = _state[symbol];
  if (!s) return;
  if (!s.emaInited) {
    s.emaOBI5  = rawOBI5;
    s.emaInited = true;
  } else {
    s.emaOBI5 = OBI_EMA_ALPHA * rawOBI5 + (1 - OBI_EMA_ALPHA) * s.emaOBI5;
  }
}

// ── OBI_confirmed ─────────────────────────────────────────────────────────
// Returns emaOBI5 only when its sign agrees with aggressor_ratio-derived sign.
// Both "spoof" stacking on the bid that gets pulled and "real" bid support look
// identical in the book. Agreement with trade flow reduces false positives.

function obiConfirmed(emaOBI5, aggrRatio) {
  if (emaOBI5 === null || emaOBI5 === undefined) return 0;
  if (aggrRatio === null || aggrRatio === undefined) return 0;
  var aggrSigned = 2 * aggrRatio - 1;
  if (Math.sign(emaOBI5) === Math.sign(aggrSigned)) return emaOBI5;
  return 0;
}

// ── Liquidity vacuum alignment ────────────────────────────────────────────
// Returns 0..1. High value when a vacuum in the direction of M momentum is close.

function liquidityVacuumAlignment(vacuumAbove, vacuumBelow, M) {
  if (M > 0 && vacuumAbove < VACUUM_THRESHOLD_BPS) return 1 - vacuumAbove / VACUUM_THRESHOLD_BPS;
  if (M < 0 && vacuumBelow < VACUUM_THRESHOLD_BPS) return 1 - vacuumBelow / VACUUM_THRESHOLD_BPS;
  return 0;
}

// ── Aggregate metrics for one symbol ─────────────────────────────────────
// Returns null when no snapshot has arrived yet.

function getOrderbookMetrics(symbol) {
  var s = _state[symbol];
  if (!s || !s.bids.length || !s.asks.length) return null;
  var bids = s.bids;
  var asks = s.asks;
  var mid  = (bids[0][0] + asks[0][0]) / 2;
  return {
    spread:      spreadBps(bids, asks),
    obi5:        obi(bids, asks, 5),
    obi20:       obi(bids, asks, 20),
    emaOBI5:     s.emaOBI5,
    depthBid:    depthUsdt10bps(bids, mid, 'bid'),
    depthAsk:    depthUsdt10bps(asks, mid, 'ask'),
    depthRatio:  depthRatio(bids, asks),
    wallBid:     wallDetected(bids),
    wallAsk:     wallDetected(asks),
    vacuumAbove: vacuumDistance(asks, mid),
    vacuumBelow: vacuumDistance(bids, mid),
  };
}

function getOrderbookState(symbol) {
  return _state[symbol] || null;
}

module.exports = {
  initOrderbookState,
  processDepthUpdate,
  updateEmaOBI,
  spreadBps,
  obi,
  depthUsdt10bps,
  depthRatio,
  wallDetected,
  vacuumDistance,
  obiConfirmed,
  liquidityVacuumAlignment,
  getOrderbookMetrics,
  getOrderbookState,
};
