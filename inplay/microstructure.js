'use strict';

var ind = require('./indicators');

// ── Aggressor ratio ───────────────────────────────────────────────────────
// buy_vol / (buy_vol + sell_vol) in the given window.
// Returns null when trade count < MIN_TRADES (not enough data to be reliable).

var MIN_TRADES = 20;

function aggressorRatio(agg) {
  if (!agg || agg.trades < MIN_TRADES) return null;
  var total = agg.buyVol + agg.sellVol;
  if (total === 0) return null;
  return agg.buyVol / total;
}

// ── Large trade share ─────────────────────────────────────────────────────
// Fraction of 5m volume that came from "large" trades (qty > p95 threshold).
// The p95 threshold is maintained by trade-buffers.js over a 24h distribution.

function largeTradeshare(agg) {
  if (!agg) return 0;
  var total = agg.buyVol + agg.sellVol;
  if (total === 0) return 0;
  return agg.largeVol / total;
}

// ── CVD slope (linear regression) ─────────────────────────────────────────
// Fits a line to the CVD time series within the last windowMs milliseconds.
// Returns slope in CVD-units per second, or null if < 3 points in window.
//
// points: [{ ts: ms, value: float }, ...] (most recent last)

function cvdSlope(points, windowMs) {
  if (!points || points.length < 3) return null;
  var now    = points[points.length - 1].ts;
  var cutoff = now - windowMs;

  // Collect points inside the window (walk backwards for early exit)
  var recent = [];
  for (var i = points.length - 1; i >= 0 && points[i].ts >= cutoff; i--) {
    recent.push(points[i]);
  }
  if (recent.length < 3) return null;
  recent.reverse();  // chronological order for regression

  // OLS: b = (n·Σxy − Σx·Σy) / (n·Σx² − (Σx)²)
  // x = seconds relative to first point, y = CVD value
  var t0 = recent[0].ts;
  var n = recent.length;
  var sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (var k = 0; k < n; k++) {
    var x = (recent[k].ts - t0) / 1000;  // normalise to seconds
    var y = recent[k].value;
    sx  += x;
    sy  += y;
    sxx += x * x;
    sxy += x * y;
  }
  var denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-10) return 0;
  return (n * sxy - sx * sy) / denom;   // CVD units per second
}

// ── CVD z-score ───────────────────────────────────────────────────────────
// Rolling z-score of the current CVD slope against the last `window` slopes.
// Returns null if slope is null; returns 0 if history too short (< 5 entries).
// Clamped to [-3, 3] to stay within tanh's sensitive range.

function cvdZscore(slope, slopeHistory, window) {
  if (slope === null || slope === undefined) return null;
  if (!slopeHistory || slopeHistory.length < 5) return 0;
  var recent = slopeHistory.length > window ? slopeHistory.slice(-window) : slopeHistory;
  var m = ind.mean(recent);
  var s = ind.std(recent);
  if (s === 0) return 0;
  var z = (slope - m) / s;
  return Math.max(-3, Math.min(3, z));
}

// ── CVD divergence detector ───────────────────────────────────────────────
// Checks for divergence between price and CVD over the last `lookback` bars.
//
// priceSeries: close prices at 1m resolution, most recent last
// cvdSeries:   CVD values at the same 1m resolution, most recent last
//
// Returns:
//  -1  bearish divergence: price at new high, CVD NOT at new high (distribution)
//  +1  bullish divergence: price at new low,  CVD NOT at new low  (accumulation)
//   0  no divergence

function cvdDivergence(priceSeries, cvdSeries, lookback) {
  lookback = lookback || 20;
  if (!priceSeries || !cvdSeries) return 0;
  var n = Math.min(priceSeries.length, cvdSeries.length, lookback);
  if (n < lookback) return 0;

  var prices = priceSeries.slice(-n);
  var cvds   = cvdSeries.slice(-n);
  var last   = n - 1;

  var priceHi = 0, priceLo = 0, cvdHi = 0, cvdLo = 0;
  for (var i = 1; i < n; i++) {
    if (prices[i] > prices[priceHi]) priceHi = i;
    if (prices[i] < prices[priceLo]) priceLo = i;
    if (cvds[i]   > cvds[cvdHi])     cvdHi   = i;
    if (cvds[i]   < cvds[cvdLo])     cvdLo   = i;
  }

  // Bearish: price at new high, CVD peaked earlier (at least 4 bars ago)
  if (priceHi === last && cvdHi < last - 3) return -1;
  // Bullish: price at new low, CVD troughed earlier
  if (priceLo === last && cvdLo < last - 3) return +1;
  return 0;
}

module.exports = {
  aggressorRatio,
  largeTradeshare,
  cvdSlope,
  cvdZscore,
  cvdDivergence,
};
