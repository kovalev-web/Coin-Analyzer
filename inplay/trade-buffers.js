'use strict';

// Rolling per-symbol trade state built from the aggTrade WebSocket stream.
//
// Memory model: 1-second buckets (aggregated buy/sell vol, trade count, large
// trade vol) instead of raw trade objects. Keeps 16 minutes of history at ~50
// bytes per bucket × 960 buckets × 200 symbols ≈ 9 MB worst case.

var MAX_BUCKETS    = 960;   // 16 min × 60 s
var MAX_SAMPLES    = 5000;  // reservoir for 24h size distribution
var MAX_CVD_PTS    = 1200;  // 100 min at 5s sampling (enough for 1h z-score)
var MAX_SLOPE_HIST = 720;   // 1 h at 5s sampling

var _state = {};            // { [SYMBOL]: stateObj }

// ── UTC midnight helper ───────────────────────────────────────────────────

function utcMidnight(ts) {
  var d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ── State init ────────────────────────────────────────────────────────────

function initTradeState(symbol) {
  if (_state[symbol]) return;
  var now = Date.now();
  _state[symbol] = {
    // Completed 1-second buckets (most recent at the end)
    buckets:    [],       // [{ ts, buyVol, sellVol, trades, largeVol }]
    // Current (incomplete) second
    curTs:      0,        // ms, floored to second
    curBuy:     0,
    curSell:    0,
    curTrades:  0,
    curLarge:   0,
    // 24h trade size distribution — reservoir sampling, never uses shift()
    sizeSamples: [],      // up to MAX_SAMPLES float values
    sampleN:    0,        // total trades seen (reservoir counter)
    p95:        0,        // current p95 threshold (qty units)
    p95At:      0,        // last recompute time (ms)
    // CVD: Σ(buy_vol - sell_vol) since UTC midnight
    cvd:           0,
    cvdNextReset:  utcMidnight(now) + 86400000,
    // CVD time series (snapshot pushed by score loop every ~5s)
    cvdPoints:     [],    // [{ ts, value }]
    // CVD slope history (one entry per score loop tick, 1h rolling)
    cvdSlopeHist:  [],    // [float]
    // Last trade timestamp — used for gap-fill on reconnect
    lastTs: 0,
  };
}

// ── Process one incoming aggTrade ─────────────────────────────────────────
// trade = { time: ms, qty: float, isBuyerMaker: bool }
// isBuyerMaker: true  = aggressive SELL (taker hit the bid)
//               false = aggressive BUY  (taker hit the ask)

function processTrade(symbol, trade) {
  var s = _state[symbol];
  if (!s) return;

  var ts  = trade.time;
  var qty = trade.qty;

  // CVD reset at UTC midnight
  if (ts >= s.cvdNextReset) {
    s.cvd = 0;
    s.cvdNextReset = utcMidnight(ts) + 86400000;
  }
  s.cvd    += trade.isBuyerMaker ? -qty : qty;
  s.lastTs  = ts;

  // 24h size distribution — Knuth reservoir sampling (Algorithm R)
  // O(1) per trade; no shift() calls; unbiased uniform sample
  s.sampleN++;
  if (s.sizeSamples.length < MAX_SAMPLES) {
    s.sizeSamples.push(qty);
  } else {
    var j = Math.floor(Math.random() * s.sampleN);
    if (j < MAX_SAMPLES) s.sizeSamples[j] = qty;
  }

  // Recompute p95 every 60 seconds
  if (ts - s.p95At > 60000 && s.sizeSamples.length >= 20) {
    var sorted = s.sizeSamples.slice().sort(function (a, b) { return a - b; });
    s.p95   = sorted[Math.floor(sorted.length * 0.95)];
    s.p95At = ts;
  }

  var isLarge = s.p95 > 0 && qty > s.p95;

  // Second-level bucket
  var secTs = Math.floor(ts / 1000) * 1000;
  if (secTs !== s.curTs) {
    if (s.curTs > 0) {
      s.buckets.push({
        ts: s.curTs, buyVol: s.curBuy, sellVol: s.curSell,
        trades: s.curTrades, largeVol: s.curLarge,
      });
      if (s.buckets.length > MAX_BUCKETS) s.buckets.shift();
    }
    s.curTs     = secTs;
    s.curBuy    = 0;
    s.curSell   = 0;
    s.curTrades = 0;
    s.curLarge  = 0;
  }

  if (trade.isBuyerMaker) { s.curSell += qty; } else { s.curBuy += qty; }
  s.curTrades++;
  if (isLarge) s.curLarge += qty;
}

// ── Rolling aggregates ────────────────────────────────────────────────────
// Returns { buyVol, sellVol, trades, largeVol } summed over the last windowMs.
// Returns null if state not initialised or no data yet.

function getAggregates(symbol, windowMs) {
  var s = _state[symbol];
  if (!s || !s.curTs) return null;

  var cutoff   = Date.now() - windowMs;
  var buyVol   = 0, sellVol = 0, trades = 0, largeVol = 0;

  // Current (incomplete) second
  if (s.curTs >= cutoff) {
    buyVol  += s.curBuy;  sellVol  += s.curSell;
    trades  += s.curTrades;  largeVol += s.curLarge;
  }
  // Walk completed buckets from newest to oldest
  for (var i = s.buckets.length - 1; i >= 0; i--) {
    if (s.buckets[i].ts < cutoff) break;
    var b = s.buckets[i];
    buyVol  += b.buyVol;  sellVol  += b.sellVol;
    trades  += b.trades;  largeVol += b.largeVol;
  }

  return { buyVol: buyVol, sellVol: sellVol, trades: trades, largeVol: largeVol };
}

// ── CVD snapshot — called from score loop every ~5s ──────────────────────

function snapshotCVD(symbol, ts) {
  var s = _state[symbol];
  if (!s) return;
  s.cvdPoints.push({ ts: ts, value: s.cvd });
  if (s.cvdPoints.length > MAX_CVD_PTS) s.cvdPoints.shift();
}

// ── CVD slope history — called from score.js after computing slope ────────

function pushCVDSlope(symbol, slope) {
  var s = _state[symbol];
  if (!s) return;
  s.cvdSlopeHist.push(slope);
  if (s.cvdSlopeHist.length > MAX_SLOPE_HIST) s.cvdSlopeHist.shift();
}

// ── Accessors ─────────────────────────────────────────────────────────────

function getTradeState(symbol) {
  return _state[symbol] || null;
}

module.exports = {
  initTradeState,
  processTrade,
  snapshotCVD,
  pushCVDSlope,
  getAggregates,
  getTradeState,
};
