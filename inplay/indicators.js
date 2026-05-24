'use strict';

// ── Math helpers ──────────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce(function (s, v) { return s + v; }, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  var m = mean(arr);
  var variance = arr.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / arr.length;
  return Math.sqrt(variance);
}

// ── RVOL ──────────────────────────────────────────────────────────────────
// vol_current / mean(vol[-window:]) where window excludes the current candle
// Returns null if not enough data

function rvol(buf, window) {
  if (buf.length < window + 1) return null;
  var baseline = buf.slice(-window - 1, -1).map(function (c) { return c.volume; });
  var m = mean(baseline);
  if (m === 0) return null;
  return buf[buf.length - 1].volume / m;
}

// ── Volume Z-score ────────────────────────────────────────────────────────
// (vol - mean) / std over last `window` candles (including current)

function volZ(buf, window) {
  if (buf.length < window) return null;
  var vols = buf.slice(-window).map(function (c) { return c.volume; });
  var m = mean(vols);
  var s = std(vols);
  if (s === 0) return 0;
  return (vols[vols.length - 1] - m) / s;
}

// ── Trades Z-score ────────────────────────────────────────────────────────
// Same as volZ but on trade count

function tradesZ(buf, window) {
  if (buf.length < window) return null;
  var counts = buf.slice(-window).map(function (c) { return c.trades; });
  var m = mean(counts);
  var s = std(counts);
  if (s === 0) return 0;
  return (counts[counts.length - 1] - m) / s;
}

// ── Δprice ────────────────────────────────────────────────────────────────
// (close_now - close_N_ago) / close_N_ago on the 1m buffer.
// nCandles=1 → Δ1m, 5 → Δ5m, 15 → Δ15m, 60 → Δ1h

function deltaPrice(buf1m, nCandles) {
  if (buf1m.length < nCandles + 1) return null;
  var closeNow = buf1m[buf1m.length - 1].close;
  var closeAgo = buf1m[buf1m.length - 1 - nCandles].close;
  if (closeAgo === 0) return null;
  return (closeNow - closeAgo) / closeAgo;
}

// ── ATR (Wilder) ──────────────────────────────────────────────────────────
// Standard Wilder smoothing using all available 1m buffer data.
// Initial ATR = simple mean of first `period` TRs, then Wilder-smoothed.

function atrWilder(buf1m, period) {
  if (buf1m.length < period + 1) return null;
  var trs = [];
  for (var i = 1; i < buf1m.length; i++) {
    var prev = buf1m[i - 1];
    var cur = buf1m[i];
    trs.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    ));
  }
  if (trs.length < period) return null;
  var atr = mean(trs.slice(0, period));
  for (var j = period; j < trs.length; j++) {
    atr = (atr * (period - 1) + trs[j]) / period;
  }
  return atr;
}

// ── Move in ATR ───────────────────────────────────────────────────────────
// (close_now - close_5_1m_candles_ago) / ATR_1m
// Numerator uses 1m buffer; denominator is Wilder ATR on 1m.

function moveInATR(buf1m, atrPeriod) {
  if (buf1m.length < 6) return null;
  var atr = atrWilder(buf1m, atrPeriod);
  if (atr === null || atr === 0) return null;
  var closeNow = buf1m[buf1m.length - 1].close;
  var close5mAgo = buf1m[buf1m.length - 6].close;
  return (closeNow - close5mAgo) / atr;
}

// ── Range expansion ───────────────────────────────────────────────────────
// current_range / mean(range[-window:]) on 5m buffer, range = high - low

function rangeExpansion(buf5m, window) {
  if (buf5m.length < window) return null;
  var ranges = buf5m.slice(-window).map(function (c) { return c.high - c.low; });
  var m = mean(ranges);
  if (m === 0) return null;
  return ranges[ranges.length - 1] / m;
}

// ── VWAP session ──────────────────────────────────────────────────────────
// Cumulative VWAP since UTC midnight of the current trading day.
// Accepts optional refTime (ms) — used in tests to pin the "current" time.

function vwapSession(buf1m, refTime) {
  var t = refTime || Date.now();
  var d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  var midnight = d.getTime();
  var session = buf1m.filter(function (c) { return c.time >= midnight; });
  if (!session.length) return null;
  var cumTPV = 0, cumVol = 0;
  session.forEach(function (c) {
    var tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  });
  if (cumVol === 0) return null;
  return cumTPV / cumVol;
}

// ── Distance from VWAP in ATR units ──────────────────────────────────────
// (close - VWAP) / ATR_1m

function distVwapATR(buf1m, atrPeriod, refTime) {
  var vwap = vwapSession(buf1m, refTime);
  var atr = atrWilder(buf1m, atrPeriod);
  if (vwap === null || atr === null || atr === 0) return null;
  return (buf1m[buf1m.length - 1].close - vwap) / atr;
}

// ── BB squeeze ────────────────────────────────────────────────────────────
// BB_width = (upper - lower) / SMA = 4σ / SMA (2 std dev bands)
// Returns current_BB_width / mean(last `window` BB_widths).
// Squeeze when result < 0.5.
// Needs `window + BB_PERIOD - 1` candles from 5m buffer.

var BB_PERIOD = 20;

function bbSqueeze(buf5m, window) {
  var needed = window + BB_PERIOD - 1;
  if (buf5m.length < needed) return null;
  var closes = buf5m.slice(-needed).map(function (c) { return c.close; });
  var widths = [];
  for (var i = BB_PERIOD - 1; i < closes.length; i++) {
    var win = closes.slice(i - BB_PERIOD + 1, i + 1);
    var sma = mean(win);
    if (sma === 0) continue;
    widths.push((4 * std(win)) / sma);
  }
  if (!widths.length) return null;
  var m = mean(widths);
  if (m === 0) return 0;
  return widths[widths.length - 1] / m;
}

module.exports = {
  mean, std,
  rvol, volZ, tradesZ, deltaPrice,
  atrWilder, moveInATR, rangeExpansion,
  vwapSession, distVwapATR, bbSqueeze,
};
