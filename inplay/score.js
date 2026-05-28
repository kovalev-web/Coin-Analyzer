'use strict';

var cfg = require('./config.json');
var { getBuffer } = require('./buffers');
var ind = require('./indicators');
var tb  = require('./trade-buffers');
var ms  = require('./microstructure');
var ob  = require('./orderbook');

// ── Math helpers ──────────────────────────────────────────────────────────

function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }

function median(arr) {
  if (!arr.length) return 0;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Fraction of `values` strictly below `value`. Works correctly for N >= 5.
function percentileRank(value, values) {
  if (!values.length) return 0;
  var below = 0;
  for (var i = 0; i < values.length; i++) { if (values[i] < value) below++; }
  return below / values.length;
}

// ── Microstructure integration ────────────────────────────────────────────

// Build 1m-resolution CVD series aligned to the last `lookback` 1m candles.
// For each candle, takes the last CVD snapshot at or before the candle's
// close time. Returns null if not enough aligned data.
function alignCVDTo1m(cvdPoints, buf1m, lookback) {
  if (!cvdPoints || !cvdPoints.length) return null;
  var n = Math.min(lookback, buf1m.length);
  var result = [];
  for (var i = buf1m.length - n; i < buf1m.length; i++) {
    var closeTs = buf1m[i].time + 60000;
    var val = null;
    for (var j = cvdPoints.length - 1; j >= 0; j--) {
      if (cvdPoints[j].ts <= closeTs) { val = cvdPoints[j].value; break; }
    }
    if (val === null) return null;
    result.push(val);
  }
  return result.length >= lookback ? result : null;
}

// ── Orderbook integration (Stage 3) ──────────────────────────────────────
// Returns fields to merge into rawMetrics, or {} when no snapshot yet.
// aggrRatio is passed in from the already-computed microstructure metrics.

function buildOrderbook(sym, aggrRatio) {
  var metrics = ob.getOrderbookMetrics(sym);
  if (!metrics) return {};
  return {
    spread:       metrics.spread,
    emaOBI5:      metrics.emaOBI5,
    obiConfirmed: ob.obiConfirmed(metrics.emaOBI5, aggrRatio !== undefined ? aggrRatio : null),
    depthBid:     metrics.depthBid,
    depthAsk:     metrics.depthAsk,
    vacuumAbove:  metrics.vacuumAbove,
    vacuumBelow:  metrics.vacuumBelow,
    wallBid:      metrics.wallBid,
    wallAsk:      metrics.wallAsk,
  };
}

// Compute Stage-2 microstructure metrics for one symbol.
// Returns an object with fields that are merged into rawMetrics.
// All fields default to null / 0 when trade state is unavailable (warm-up period).
function buildMicro(sym, buf1m) {
  var w     = cfg.windows;
  var state = tb.getTradeState(sym);
  // When no trade state (backtest, cold start) return nothing — score.js falls
  // back to Stage-1 formulas when M/P/A fields are undefined.
  if (!state) return {};
  var result = { cvdZ: null, aggrRatio: null, largeShare: 0, cvdDiv: 0, cvdSlope: null };

  var agg1m = tb.getAggregates(sym, 60000);
  var agg5m = tb.getAggregates(sym, 300000);

  result.aggrRatio  = ms.aggressorRatio(agg1m);
  result.largeShare = ms.largeTradeshare(agg5m);

  var slope = ms.cvdSlope(state.cvdPoints, w.cvd_slope_window_ms);
  result.cvdSlope = slope;
  if (slope !== null) {
    result.cvdZ = ms.cvdZscore(slope, state.cvdSlopeHist, w.cvd_zscore_window);
  }

  if (buf1m && buf1m.length >= w.cvd_div_lookback) {
    var prices  = buf1m.slice(-w.cvd_div_lookback).map(function (c) { return c.close; });
    var cvdAt1m = alignCVDTo1m(state.cvdPoints, buf1m, w.cvd_div_lookback);
    if (cvdAt1m) {
      result.cvdDiv = ms.cvdDivergence(prices, cvdAt1m, w.cvd_div_lookback);
    }
  }

  return result;
}

// ── Raw metrics for one symbol ────────────────────────────────────────────
// refTime: current moment in ms — used for VWAP session boundary.
// In production: undefined → Date.now(). In backtest: pass T explicitly.
// Returns null if pre-filters fail or any required Stage-1 indicator is null.

function computeRawMetrics(buf1m, buf5m, refTime) {
  var w = cfg.windows;

  if (buf5m.length < cfg.prefilter.min_buffer_5m) return null;
  if (buf1m.length < w.atr_1m_period + 1) return null;

  var rVol1m  = ind.rvol(buf1m, w.rvol_1m);
  var rVol5m  = ind.rvol(buf5m, w.rvol_5m);
  var vZ5m    = ind.volZ(buf5m, w.volZ_5m);
  var tZ5m    = ind.tradesZ(buf5m, w.tradesZ_5m);
  var dp5m    = ind.deltaPrice(buf1m, 5);
  var miatr   = ind.moveInATR(buf1m, w.atr_1m_period);
  var rexp    = ind.rangeExpansion(buf5m, w.range_expansion);
  var dvwap   = ind.distVwapATR(buf1m, w.atr_1m_period, refTime);
  var bbs     = ind.bbSqueeze(buf5m, w.bb_squeeze);

  if (vZ5m === null || tZ5m === null || dp5m === null ||
      miatr === null || rexp === null || dvwap === null || bbs === null) return null;

  return { rVol1m, rVol5m, vZ5m, tZ5m, dp5m, miatr, rexp, dvwap, bbs };
}

// ── A component (raw, before cross-sectional percentile rank) ─────────────
// Stage 2: adds largeShare term (0.30 weight) when trade state is available.
// Stage 1 fallback: original 0.4/0.3/0.3 split.

function rawA(m) {
  if (m.largeShare !== undefined) {
    // Stage 2 weights (spec §A update)
    return 0.30 * clip(m.vZ5m,  0, 5) / 5
         + 0.20 * clip(m.tZ5m,  0, 5) / 5
         + 0.20 * clip(m.rexp / 3, 0, 1)
         + 0.30 * clip(m.largeShare / 0.3, 0, 1);
  }
  // Stage 1 fallback
  return 0.40 * clip(m.vZ5m,  0, 5) / 5
       + 0.30 * clip(m.tZ5m,  0, 5) / 5
       + 0.30 * clip(m.rexp / 3, 0, 1);
}

// ── M component ───────────────────────────────────────────────────────────
// Stage 2: CVD_zscore replaces some candle momentum weight.
//          aggrRatio shifts M toward buy/sell pressure direction.
// Stage 1 fallback used when cvdZ is null (warm-up or no trade data).

function computeM(m, dp5mBaseline) {
  var base         = dp5mBaseline > 0 ? dp5mBaseline : 0.003;
  var momentumTerm = sign(m.dp5m) * Math.sqrt(Math.abs(m.dp5m) / base);

  if (m.cvdZ !== null && m.cvdZ !== undefined) {
    var aggrTerm = m.aggrRatio !== null ? (2 * m.aggrRatio - 1) : 0;
    if (m.obiConfirmed !== undefined) {
      // Stage 3 formula — weights shift to make room for OBI_confirmed
      return Math.tanh(
        0.20 * m.miatr        +
        0.15 * m.dvwap        +
        0.25 * m.cvdZ         +
        0.15 * aggrTerm       +
        0.15 * m.obiConfirmed +
        0.10 * momentumTerm
      );
    }
    // Stage 2 formula
    return Math.tanh(
      0.25 * m.miatr  +
      0.20 * m.dvwap  +
      0.30 * m.cvdZ   +
      0.15 * aggrTerm +
      0.10 * momentumTerm
    );
  }

  // Stage 1 fallback
  return Math.tanh(0.40 * m.miatr + 0.30 * momentumTerm + 0.30 * m.dvwap);
}

// ── P component ───────────────────────────────────────────────────────────
// Stage 2: adds |cvdDiv| term (0.30 weight) when divergence is available.
// Stage 1 fallback: original 0.6/0.4 split.

// M is passed in at Stage 3 to compute vacuum_alignment (needs momentum direction).
function computeP(m, M) {
  var squeeze   = clip(1 - m.bbs, 0, 1);
  var rvolAccel = (m.rVol1m !== null && m.rVol5m !== null &&
                   m.rVol5m > 0 && m.rVol1m / m.rVol5m > 1.5) ? 1 : 0;

  if (m.vacuumAbove !== undefined && M !== undefined) {
    // Stage 3 weights
    var va = ob.liquidityVacuumAlignment(m.vacuumAbove, m.vacuumBelow, M);
    return clip(
      0.30 * squeeze +
      0.20 * rvolAccel +
      0.25 * Math.abs(m.cvdDiv || 0) +
      0.25 * va,
      0, 1
    );
  }

  if (m.cvdDiv !== undefined && m.cvdDiv !== null) {
    // Stage 2 weights
    return clip(0.40 * squeeze + 0.30 * rvolAccel + 0.30 * Math.abs(m.cvdDiv), 0, 1);
  }

  // Stage 1 fallback
  return clip(0.60 * squeeze + 0.40 * rvolAccel, 0, 1);
}

// ── Inplay formula ────────────────────────────────────────────────────────

function computeInplay(A, M, P) {
  var w = cfg.weights;
  return sign(M) * (w.wA * A + w.wM * Math.abs(M) + w.wP * P);
}

// ── Main update: compute scores for all symbols, return sorted top-N ──────
// getBufferFn  — injectable for tests; defaults to buffers.getBuffer.
// refTime      — injectable for backtest; defaults to Date.now().
// getMicroFn   — optional (sym, buf1m) → micro object; when provided,
//                replaces buildMicro() and skips live CVD snapshotting.
//                Used by backtest to inject kline-based CVD proxy.

function updateAllScores(inplaySymbols, getBufferFn, refTime, getMicroFn) {
  var getBuf = getBufferFn || getBuffer;
  var now    = refTime || Date.now();

  // Snapshot CVD for all symbols (production only — skipped when proxy provided)
  if (!getMicroFn) {
    inplaySymbols.forEach(function (sym) {
      if (tb.getTradeState(sym)) tb.snapshotCVD(sym, now);
    });
  }

  // Step 1: raw metrics for every passing symbol
  var rawMetrics = {};
  inplaySymbols.forEach(function (sym) {
    var m = computeRawMetrics(getBuf(sym, '1m'), getBuf(sym, '5m'), now);
    if (!m) return;

    // Merge microstructure — real trade state (production) or proxy (backtest)
    var micro = getMicroFn
      ? getMicroFn(sym, getBuf(sym, '1m'))
      : buildMicro(sym, getBuf(sym, '1m'));

    // Push CVD slope into production history only (not in backtest)
    if (!getMicroFn && micro.cvdSlope !== null && micro.cvdSlope !== undefined) {
      tb.pushCVDSlope(sym, micro.cvdSlope);
    }
    Object.assign(m, micro);

    // Stage 3: orderbook metrics (no-op when no snapshot received yet)
    var book = buildOrderbook(sym, m.aggrRatio);
    Object.assign(m, book);

    // Stage 3 hygiene filters — only applied when orderbook data is present
    if (book.spread !== undefined && book.spread !== null) {
      if (book.spread > cfg.prefilter.spread_bps_max) return;
      var depthAvg = (book.depthBid + book.depthAsk) / 2;
      if (depthAvg < cfg.prefilter.depth_usdt_10bps_min) return;
    }

    rawMetrics[sym] = m;
  });

  var syms = Object.keys(rawMetrics);
  if (syms.length < 5) return []; // too few for meaningful cross-sectional rank

  // Step 2: cross-sectional baseline for M (median |Δprice_5m| across basket)
  var absDp5m = syms.map(function (s) { return Math.abs(rawMetrics[s].dp5m); }).filter(function (v) { return v > 0; });
  var dp5mBaseline = absDp5m.length ? median(absDp5m) : 0.003;

  // Step 3: raw A values for cross-sectional percentile rank
  var rawAValues = syms.map(function (s) { return rawA(rawMetrics[s]); });

  // Step 4: assemble final scores
  var scores = syms.map(function (sym, i) {
    var m = rawMetrics[sym];
    var A = percentileRank(rawAValues[i], rawAValues);
    var M = computeM(m, dp5mBaseline);
    var P = computeP(m, M);
    return {
      symbol:  sym,
      inplay:  computeInplay(A, M, P),
      A:       A,
      M:       M,
      P:       P,
      // Stage-1 sub-components
      _vZ5m:   m.vZ5m,
      _tZ5m:   m.tZ5m,
      _rexp:   m.rexp,
      _miatr:  m.miatr,
      _dvwap:  m.dvwap,
      _bbs:    m.bbs,
      _dp5m:   m.dp5m,
      _rvol5m: m.rVol5m,
      // Stage-2 sub-components (null during warm-up)
      _cvdZ:       m.cvdZ,
      _aggrRatio:  m.aggrRatio,
      _largeShare: m.largeShare,
      _cvdDiv:     m.cvdDiv,
      // Stage-3 sub-components (undefined until orderbook arrives)
      _spread:       m.spread,
      _emaOBI5:      m.emaOBI5,
      _obiConfirmed: m.obiConfirmed,
      _vacuumAbove:  m.vacuumAbove,
      _vacuumBelow:  m.vacuumBelow,
    };
  });

  // Sort by |Inplay| descending
  scores.sort(function (a, b) { return Math.abs(b.inplay) - Math.abs(a.inplay); });

  return scores.slice(0, cfg.top_n);
}

module.exports = {
  // Exported for tests
  percentileRank, computeRawMetrics, rawA, computeM, computeP, computeInplay,
  // Main entry point
  updateAllScores,
  // Exported for unit tests
  alignCVDTo1m,
  buildOrderbook,
};
