'use strict';

/**
 * Inplay backtest harness
 *
 * Usage:
 *   node inplay/backtest.js [--days 7] [--symbols 30] [--top-n 10]
 *   node inplay/backtest.js --stage1           # force Stage-1 formulas (no micro)
 *   node inplay/backtest.js --stage3           # Stage-3 formulas with proxy OBI
 *   node inplay/backtest.js --compare          # run all 3 stages, print comparison table
 *
 * Stage-3 proxy notes:
 *   obiConfirmed_proxy = taker_buy_fraction * 2 - 1  (same sign as aggrRatio by construction)
 *   vacuumAbove = vacuumBelow = 999 bps              (no order book → always beyond threshold → va=0)
 *   Correlation OBI_proxy ↔ aggrRatio will be ~1.0; real live OBI differs from aggrRatio.
 *   Backtest validates the Stage-3 code path and weight distribution, not OBI/vacuum signals.
 *
 * Fetches historical 1m + 5m klines from Binance REST, replays the Inplay
 * score at each 5-minute step, measures |Δprice| on T+5m..T+15m horizon,
 * and reports hit-rate + score distribution.
 *
 * Target: hit-rate ≥ 70% (Stage 2+). Stage 3 target: 75%+.
 */

const { updateAllScores } = require('./score');
const ms  = require('./microstructure');
const cfg = require('./config.json');

const BINANCE_REST   = 'https://fapi.binance.com';
const STEP_MS        = 5 * 60 * 1000;
const OUTCOME_START  = 5  * 60 * 1000;   // T+5m
const OUTCOME_END    = 15 * 60 * 1000;   // T+15m
const TF_MS          = { '1m': 60000, '5m': 300000 };
// bbSqueeze needs (bb_squeeze + BB_PERIOD - 1) = 69 five-minute candles to warm up
const WARMUP_STEPS   = cfg.windows.bb_squeeze + 19;

// ── CLI args ──────────────────────────────────────────────────────────────

function getArg(name, def) {
  var i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
var DAYS         = parseInt(getArg('days',    '7'));
var SYMBOL_COUNT = parseInt(getArg('symbols', '50'));
var SKIP_TOP     = parseInt(getArg('skip',    '10')); // skip top-N mega-caps (BTC/ETH/SOL…)
var TOP_N        = parseInt(getArg('top-n',   String(cfg.top_n)));
var STAGE1_MODE  = process.argv.indexOf('--stage1') >= 0; // force Stage-1 formulas (no micro)
var STAGE3_MODE  = process.argv.indexOf('--stage3') >= 0; // Stage-3 formulas with proxy OBI
var COMPARE_MODE = process.argv.indexOf('--compare') >= 0; // run all 3 stages, print comparison table
var EXCLUDE_SYMS = new Set((getArg('exclude', '') || '').split(',').map(function(s){return s.trim().toUpperCase();}).filter(Boolean));

// ── REST helpers ──────────────────────────────────────────────────────────

async function fetchJSON(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function parseCandle(arr) {
  return {
    time:        arr[0],
    open:        parseFloat(arr[1]),
    high:        parseFloat(arr[2]),
    low:         parseFloat(arr[3]),
    close:       parseFloat(arr[4]),
    volume:      parseFloat(arr[5]),
    trades:      parseInt(arr[8], 10),
    takerBuyVol: parseFloat(arr[9]),   // taker buy base volume (aggressive buys)
  };
}

// Paginated kline fetch. Uses limit=500 (weight=2) per page.
async function fetchAllKlines(symbol, interval, startTime, endTime) {
  var intervalMs = TF_MS[interval];
  var candles = [];
  var start = startTime;
  while (start < endTime) {
    var url = BINANCE_REST + '/fapi/v1/klines?symbol=' + symbol +
      '&interval=' + interval +
      '&startTime=' + start +
      '&endTime=' + endTime +
      '&limit=500';
    var data;
    try { data = await fetchJSON(url); } catch (e) {
      console.error('  [fetch error]', symbol, interval, e.message);
      break;
    }
    if (!Array.isArray(data) || !data.length) break;
    data.forEach(function (arr) { candles.push(parseCandle(arr)); });
    if (data.length < 500) break;
    start = data[data.length - 1][0] + intervalMs;
    await sleep(150); // ~6 req/sec, well inside 2400 weight/min limit
  }
  return candles;
}

// Top N USDT perp symbols by 24h quote volume, optionally skipping the heaviest
async function getTopSymbols(n, skip) {
  console.log('[Backtest] Fetching symbol list...');
  var tickers = await fetchJSON(BINANCE_REST + '/fapi/v1/ticker/24hr');
  var sorted = tickers
    .filter(function (t) { return t.symbol.endsWith('USDT') && !EXCLUDE_SYMS.has(t.symbol); })
    .sort(function (a, b) { return parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume); });
  if (skip > 0) console.log('[Backtest] Skipping top-' + skip + ' heavy caps');
  if (EXCLUDE_SYMS.size > 0) console.log('[Backtest] Excluding: ' + Array.from(EXCLUDE_SYMS).join(', '));
  return sorted.slice(skip, skip + n).map(function (t) { return t.symbol; });
}

// Fetch historical data for all symbols (sequential to avoid rate limit burst)
async function fetchHistoricalData(symbols, startTime, endTime) {
  var data = {};
  for (var i = 0; i < symbols.length; i++) {
    var sym = symbols[i];
    process.stdout.write('\r[Backtest] Fetching ' + (i + 1) + '/' + symbols.length + ' ' + sym + '      ');
    data[sym] = {
      '1m': await fetchAllKlines(sym, '1m', startTime, endTime),
      '5m': await fetchAllKlines(sym, '5m', startTime, endTime),
    };
    await sleep(200); // pause between symbols
  }
  process.stdout.write('\n');
  console.log('[Backtest] Fetch complete');
  return data;
}

// ── Simulation helpers ────────────────────────────────────────────────────

// Last `n` candles in `arr` with open time strictly before `T`
function sliceBefore(arr, T, n) {
  var lo = 0, hi = arr.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (arr[mid].time < T) lo = mid + 1; else hi = mid;
  }
  return arr.slice(Math.max(0, lo - n), lo);
}

// Max |Δprice| from closeT over candles in [T+OUTCOME_START, T+OUTCOME_END]
function measureOutcome(arr1m, T, closeT) {
  if (!closeT) return null;
  var start = T + OUTCOME_START;
  var end   = T + OUTCOME_END;
  var maxMove = -1;
  for (var i = 0; i < arr1m.length; i++) {
    var t = arr1m[i].time;
    if (t < start) continue;
    if (t > end)   break;
    var move = Math.abs(arr1m[i].close - closeT) / closeT;
    if (move > maxMove) maxMove = move;
  }
  return maxMove >= 0 ? maxMove : null;
}

function median(arr) {
  if (!arr.length) return 0;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── CVD proxy (Stage-2 backtest) ──────────────────────────────────────────
// Since historical aggTrade data isn't available from Binance REST, we approximate
// CVD from kline data using the Schultz formula:
//   delta = ((close - low) / (high - low) * 2 - 1) * volume
// aggrRatio uses the real takerBuyVol field (kline arr[9]).
// largeShare cannot be approximated without per-trade sizes → always 0.

function utcMidnight(ts) {
  var d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Per-symbol slope history, persists across time steps within one simulation run.
var proxyState = {};

function buildProxyMicro(sym, buf1m, T, withOBI) {
  if (!buf1m || buf1m.length < 3) return {};
  if (!proxyState[sym]) proxyState[sym] = { cvdSlopeHist: [] };

  var w        = cfg.windows;
  var midnight = utcMidnight(T);

  // Build cumulative proxy CVD since UTC midnight
  var cvdCum    = 0;
  var cvdPoints = [];
  for (var ci = 0; ci < buf1m.length; ci++) {
    var c  = buf1m[ci];
    if (c.time < midnight) continue;
    var hl    = c.high - c.low;
    var delta = hl > 0 ? ((c.close - c.low) / hl * 2 - 1) * c.volume : 0;
    cvdCum += delta;
    cvdPoints.push({ ts: c.time + 60000, value: cvdCum });
  }
  if (cvdPoints.length < 3) return {};

  // OLS slope over last 5m + rolling z-score
  var slope = ms.cvdSlope(cvdPoints, w.cvd_slope_window_ms);
  var cvdZ  = null;
  if (slope !== null) {
    var hist = proxyState[sym].cvdSlopeHist;
    hist.push(slope);
    if (hist.length > w.cvd_zscore_window) hist.shift();
    cvdZ = ms.cvdZscore(slope, hist, w.cvd_zscore_window);
  }

  // aggrRatio: taker-buy fraction over last 20 1m candles
  var aggrRatio = null;
  var lk = Math.min(20, buf1m.length);
  var totalVol = 0, buyVol = 0;
  for (var bi = buf1m.length - lk; bi < buf1m.length; bi++) {
    var cb = buf1m[bi];
    if (cb.takerBuyVol != null && cb.volume > 0) {
      buyVol   += cb.takerBuyVol;
      totalVol += cb.volume;
    }
  }
  if (totalVol > 0) aggrRatio = buyVol / totalVol;

  // largeShare: no per-trade size data in klines → 0 (Stage-2 A formula still fires)
  var largeShare = 0;

  // cvdDiv: proxy CVD values are 1:1 aligned with buf1m candles since midnight
  var cvdDiv    = 0;
  var dLookback = w.cvd_div_lookback;
  if (cvdPoints.length >= dLookback) {
    var prices  = buf1m.slice(-cvdPoints.length).map(function (x) { return x.close; }).slice(-dLookback);
    var cvdVals = cvdPoints.slice(-dLookback).map(function (p) { return p.value; });
    if (prices.length >= dLookback) {
      cvdDiv = ms.cvdDivergence(prices, cvdVals, dLookback);
    }
  }

  // largeShare omitted intentionally: klines have no per-trade size data,
  // so we can't compute it reliably. Omitting forces the Stage-1 A formula
  // (full 0.40/0.30/0.30 weights) which proved discriminative in Stage 1.
  // In production, buildMicro() provides the real largeShare from aggTrade data.
  var result = { cvdZ: cvdZ, aggrRatio: aggrRatio, cvdDiv: cvdDiv, cvdSlope: slope };

  // Stage-3 proxy: OBI cannot be reconstructed from klines; we approximate via
  // taker buy fraction. Sign always agrees with aggrRatio (correlation ~1.0).
  // Vacuum requires live order book — set to 999 bps (always beyond threshold).
  if (withOBI || STAGE3_MODE) {
    result.obiConfirmed = aggrRatio !== null ? (2 * aggrRatio - 1) : 0;
    result.vacuumAbove  = 999;
    result.vacuumBelow  = 999;
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────

function makeStat() {
  return { hits: 0, total: 0, pos: { hits: 0, total: 0 }, neg: { hits: 0, total: 0 } };
}

async function main() {
  var endTime   = Date.now();
  var startTime = endTime - DAYS * 24 * 60 * 60 * 1000;

  console.log('[Backtest] Days=' + DAYS + '  Symbols=' + SYMBOL_COUNT + '  Skip=' + SKIP_TOP + '  Top-N=' + TOP_N);
  console.log('[Backtest] ' + new Date(startTime).toISOString() + ' → ' + new Date(endTime).toISOString());

  var symbols  = await getTopSymbols(SYMBOL_COUNT, SKIP_TOP);
  var histData = await fetchHistoricalData(symbols, startTime, endTime);

  // Simulation starts after warmup (need enough 5m candles for bbSqueeze)
  var simStart = startTime + WARMUP_STEPS * STEP_MS;

  var totalPredictions = 0;
  var totalHits        = 0;
  var allScores        = [];
  var stepsDone        = 0;
  var stepsSkipped     = 0;

  // Per-day hit tracking
  var dayStats = {}; // 'YYYY-MM-DD' → { hits, total }

  // Compare mode: separate stats per stage
  var cmpS1 = COMPARE_MODE ? makeStat() : null;
  var cmpS2 = COMPARE_MODE ? makeStat() : null;
  var cmpS3 = COMPARE_MODE ? makeStat() : null;

  // Diagnostics: A/|M|/P per hit vs miss, hit-rate by Inplay sign
  var diag = {
    hits:   { A: [], absM: [], P: [], cvdZ: [], aggrRatio: [], obiConfirmed: [] },
    misses: { A: [], absM: [], P: [], cvdZ: [], aggrRatio: [], obiConfirmed: [] },
    pos: { hits: 0, total: 0 },  // Inplay > 0 (long signal)
    neg: { hits: 0, total: 0 },  // Inplay < 0 (short signal)
    // Stage-3: OBI_proxy vs aggrRatio correlation check
    obiProxyPairs: [],  // [{obi, aggr}]
  };

  console.log('[Backtest] Simulating...');

  for (var T = simStart; T <= endTime - OUTCOME_END; T += STEP_MS) {
    // Inject historical buffers as of time T
    var getBuffer = (function (currentT) {
      return function (sym, tf) {
        if (!histData[sym]) return [];
        return sliceBefore(histData[sym][tf], currentT, 100);
      };
    })(T);

    // ── Compare mode: run all 3 stages, shared outcomes ───────────────────
    if (COMPARE_MODE) {
      var _cacheC = {};
      var getMicroS1C = function () { return {}; };
      var getMicroS2C = function (sym, buf1m) {
        if (!_cacheC[sym]) _cacheC[sym] = buildProxyMicro(sym, buf1m, T, false);
        return _cacheC[sym];
      };
      var getMicroS3C = function (sym, buf1m) {
        var b = _cacheC[sym] || (_cacheC[sym] = buildProxyMicro(sym, buf1m, T, false));
        return Object.assign({}, b, {
          obiConfirmed: b.aggrRatio !== null ? (2 * b.aggrRatio - 1) : 0,
          vacuumAbove: 999, vacuumBelow: 999,
        });
      };
      var topC1 = updateAllScores(symbols, getBuffer, T, getMicroS1C);
      var topC2 = updateAllScores(symbols, getBuffer, T, getMicroS2C);
      var topC3 = updateAllScores(symbols, getBuffer, T, getMicroS3C);
      if (topC1.length < 5 && topC2.length < 5 && topC3.length < 5) { stepsSkipped++; continue; }
      stepsDone++;

      var outcomesC = {};
      for (var siC = 0; siC < symbols.length; siC++) {
        var symC = symbols[siC];
        var arr1mC = histData[symC] ? histData[symC]['1m'] : [];
        var bufC = sliceBefore(arr1mC, T, 1);
        var closeTc = bufC.length ? bufC[0].close : null;
        var outC = measureOutcome(arr1mC, T, closeTc);
        if (outC !== null) outcomesC[symC] = outC;
      }
      var outValsC = Object.values(outcomesC);
      if (outValsC.length < 5) continue;
      var medianC = median(outValsC);

      var stagesList = [[topC1, cmpS1], [topC2, cmpS2], [topC3, cmpS3]];
      for (var si3 = 0; si3 < stagesList.length; si3++) {
        var topX = stagesList[si3][0], statX = stagesList[si3][1];
        for (var riX = 0; riX < topX.length; riX++) {
          var rX = topX[riX];
          if (outcomesC[rX.symbol] == null) continue;
          statX.total++;
          var hitX = outcomesC[rX.symbol] > medianC;
          if (hitX) statX.hits++;
          if (rX.inplay >= 0) { statX.pos.total++; if (hitX) statX.pos.hits++; }
          else                { statX.neg.total++; if (hitX) statX.neg.hits++; }
        }
      }
      continue;
    }
    // ── End compare mode ───────────────────────────────────────────────────

    var getMicro = STAGE1_MODE
      ? function () { return {}; }                                          // Stage-1: no micro
      : (function (currentT) {                                              // Stage-2: proxy CVD
          return function (sym, buf1m) { return buildProxyMicro(sym, buf1m, currentT); };
        })(T);

    var top = updateAllScores(symbols, getBuffer, T, getMicro);
    if (top.length < 5) { stepsSkipped++; continue; }

    stepsDone++;
    top.forEach(function (r) { allScores.push(r.inplay); });

    // Outcome for every symbol in basket
    var outcomes = {};
    for (var si = 0; si < symbols.length; si++) {
      var sym = symbols[si];
      var arr1m = histData[sym] ? histData[sym]['1m'] : [];
      var buf   = sliceBefore(arr1m, T, 1);
      var closeT = buf.length ? buf[0].close : null;
      var out = measureOutcome(arr1m, T, closeT);
      if (out !== null) outcomes[sym] = out;
    }

    var outcomeVals = Object.values(outcomes);
    if (outcomeVals.length < 5) continue;
    var basketMedian = median(outcomeVals);

    // Score predictions against basket median
    var dayKey = new Date(T).toISOString().slice(0, 10);
    if (!dayStats[dayKey]) dayStats[dayKey] = { hits: 0, total: 0 };

    for (var ri = 0; ri < top.length; ri++) {
      var r = top[ri];
      if (outcomes[r.symbol] == null) continue;
      totalPredictions++;
      dayStats[dayKey].total++;
      var isHit = outcomes[r.symbol] > basketMedian;
      if (isHit) { totalHits++; dayStats[dayKey].hits++; }

      // Collect A/|M|/P + Stage-2/3 sub-components for diagnostic
      var bucket = isHit ? diag.hits : diag.misses;
      bucket.A.push(r.A);
      bucket.absM.push(Math.abs(r.M));
      bucket.P.push(r.P);
      if (r._cvdZ      != null) bucket.cvdZ.push(r._cvdZ);
      if (r._aggrRatio != null) bucket.aggrRatio.push(r._aggrRatio);
      if (r._obiConfirmed != null && r._obiConfirmed !== undefined) {
        bucket.obiConfirmed.push(r._obiConfirmed);
      }

      // Stage-3 correlation: OBI_proxy vs aggrRatio
      if (STAGE3_MODE && r._obiConfirmed !== undefined && r._aggrRatio != null) {
        diag.obiProxyPairs.push({ obi: r._obiConfirmed, aggr: 2 * r._aggrRatio - 1 });
      }

      // Hit-rate by Inplay sign
      if (r.inplay >= 0) { diag.pos.total++; if (isHit) diag.pos.hits++; }
      else               { diag.neg.total++; if (isHit) diag.neg.hits++; }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────

  if (COMPARE_MODE) {
    function cmpPct(stat) {
      return stat.total > 0 ? (stat.hits / stat.total * 100).toFixed(1) + '%' : 'N/A';
    }
    function cmpPos(stat) {
      return stat.pos.total > 0 ? (stat.pos.hits / stat.pos.total * 100).toFixed(1) + '%' : 'N/A';
    }
    function cmpNeg(stat) {
      return stat.neg.total > 0 ? (stat.neg.hits / stat.neg.total * 100).toFixed(1) + '%' : 'N/A';
    }
    function delta(a, b) {
      if (a.total === 0 || b.total === 0) return '  N/A';
      var d = (b.hits/b.total - a.hits/a.total) * 100;
      return (d >= 0 ? '+' : '') + d.toFixed(1) + 'pp';
    }
    function deltaD(a, b, fn) {
      var ra = a[fn].total > 0 ? a[fn].hits / a[fn].total : null;
      var rb = b[fn].total > 0 ? b[fn].hits / b[fn].total : null;
      if (ra === null || rb === null) return '  N/A';
      var d = (rb - ra) * 100;
      return (d >= 0 ? '+' : '') + d.toFixed(1) + 'pp';
    }
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  INPLAY BACKTEST — STAGE COMPARISON');
    console.log('══════════════════════════════════════════════════════════');
    console.log('  Days: ' + DAYS + '   Symbols: ' + symbols.length + '   Steps run: ' + stepsDone + '   (skipped: ' + stepsSkipped + ')');
    console.log('  Predictions — S1: ' + cmpS1.total + '   S2: ' + cmpS2.total + '   S3: ' + cmpS3.total);
    console.log('');
    console.log('  ┌────────────┬─────────┬─────────┬─────────┬──────┬──────┐');
    console.log('  │            │ Stage-1 │ Stage-2 │ Stage-3*│ Δ2-1 │ Δ3-2 │');
    console.log('  ├────────────┼─────────┼─────────┼─────────┼──────┼──────┤');
    console.log('  │ Overall    │ ' + cmpPct(cmpS1).padStart(6) + '  │ ' + cmpPct(cmpS2).padStart(6) + '  │ ' + cmpPct(cmpS3).padStart(6) + '  │ ' + delta(cmpS1, cmpS2).padStart(5) + ' │ ' + delta(cmpS2, cmpS3).padStart(5) + ' │');
    console.log('  │ Long  >0   │ ' + cmpPos(cmpS1).padStart(6) + '  │ ' + cmpPos(cmpS2).padStart(6) + '  │ ' + cmpPos(cmpS3).padStart(6) + '  │ ' + deltaD(cmpS1, cmpS2, 'pos').padStart(5) + ' │ ' + deltaD(cmpS2, cmpS3, 'pos').padStart(5) + ' │');
    console.log('  │ Short <0   │ ' + cmpNeg(cmpS1).padStart(6) + '  │ ' + cmpNeg(cmpS2).padStart(6) + '  │ ' + cmpNeg(cmpS3).padStart(6) + '  │ ' + deltaD(cmpS1, cmpS2, 'neg').padStart(5) + ' │ ' + deltaD(cmpS2, cmpS3, 'neg').padStart(5) + ' │');
    console.log('  └────────────┴─────────┴─────────┴─────────┴──────┴──────┘');
    console.log('  * Stage-3: OBI proxy = 2·aggrRatio−1 (corr~1.0), vacuum=0');
    console.log('══════════════════════════════════════════════════════════\n');
    return;
  }

  var hitRate = totalPredictions > 0 ? totalHits / totalPredictions : 0;
  var modeLabel = STAGE1_MODE ? 'Stage 1' : STAGE3_MODE ? 'Stage 3 proxy' : 'Stage 2 proxy';

  console.log('\n══════════════════════════════════════');
  console.log('  INPLAY BACKTEST RESULTS  (' + modeLabel + ')');
  console.log('══════════════════════════════════════');
  console.log('  Days:          ', DAYS);
  console.log('  Symbols:       ', symbols.length);
  console.log('  Steps run:     ', stepsDone, '  (skipped: ' + stepsSkipped + ')');
  console.log('  Predictions:   ', totalPredictions);
  console.log('  Hits:          ', totalHits);
  var passThreshold = STAGE3_MODE ? 0.75 : 0.70;
  console.log('  Hit-rate:      ', (hitRate * 100).toFixed(1) + '%',
    hitRate >= passThreshold ? '✓ PASS' :
    hitRate >= 0.70          ? '~ STAGE-2 LEVEL (need +5pp for Stage 3)' :
    hitRate >= 0.60          ? '~ STAGE-1 LEVEL' : '✗ FAIL (<60%)');

  // Per-day breakdown
  console.log('\n  Per-day breakdown:');
  Object.keys(dayStats).sort().forEach(function (day) {
    var d = dayStats[day];
    var dr = d.total > 0 ? (d.hits / d.total * 100).toFixed(1) : 'N/A';
    console.log('    ' + day + '  ' + dr + '%  (' + d.hits + '/' + d.total + ')');
  });

  // Component diagnostics: hits vs misses
  function avgArr(arr) { return arr.length ? arr.reduce(function(s,v){return s+v;},0)/arr.length : 0; }
  console.log('\n  Component averages (hits vs misses):');
  console.log('               hits    misses  ratio');
  var diagItems = [
    { key: 'A',            label: 'A            ' },
    { key: 'absM',         label: '|M|          ' },
    { key: 'P',            label: 'P            ' },
    { key: 'cvdZ',         label: 'cvdZ         ' },
    { key: 'aggrRatio',    label: 'aggrRatio    ' },
  ];
  if (STAGE3_MODE) {
    diagItems.push({ key: 'obiConfirmed', label: 'obiConfirmed ' });
  }
  diagItems.forEach(function(item) {
    var h = avgArr(diag.hits[item.key]), mv = avgArr(diag.misses[item.key]);
    var n = diag.hits[item.key].length;
    if (n === 0) { console.log('    ' + item.label + '  (no data)'); return; }
    var ratio = mv !== 0 ? h/mv : (h > 0 ? Infinity : 1);
    console.log('    ' + item.label + '   ' + h.toFixed(3) + '   ' + mv.toFixed(3) + '   ' + ratio.toFixed(2) +
      (ratio > 1.05 ? ' ↑ discriminative' : ratio < 0.95 ? ' ↓ inverse' : ' ~ neutral') +
      '  (n=' + n + ')');
  });

  // Hit-rate by Inplay sign (positive = long, negative = short)
  var posRate = diag.pos.total > 0 ? diag.pos.hits / diag.pos.total : 0;
  var negRate = diag.neg.total > 0 ? diag.neg.hits / diag.neg.total : 0;
  console.log('\n  Hit-rate by signal direction:');
  console.log('    Inplay > 0 (long):   ' + (posRate*100).toFixed(1) + '%  (' + diag.pos.hits + '/' + diag.pos.total + ')');
  console.log('    Inplay < 0 (short):  ' + (negRate*100).toFixed(1) + '%  (' + diag.neg.hits + '/' + diag.neg.total + ')');

  // Score distribution
  if (allScores.length) {
    allScores.sort(function (a, b) { return a - b; });
    var pct = function (p) { return allScores[Math.floor(p * allScores.length / 100)] || 0; };
    var allZero = allScores.every(function (s) { return Math.abs(s) < 0.01; });
    var allOne  = allScores.every(function (s) { return Math.abs(s) > 0.99; });
    console.log('\n  Score distribution (' + allScores.length + ' samples):');
    console.log('    min  ', allScores[0].toFixed(3));
    console.log('    p25  ', pct(25).toFixed(3));
    console.log('    p50  ', pct(50).toFixed(3));
    console.log('    p75  ', pct(75).toFixed(3));
    console.log('    max  ', allScores[allScores.length - 1].toFixed(3));
    if (allZero || allOne) console.log('    ⚠  Distribution is degenerate — check normalization');
  }

  // Stage-3: OBI_proxy ↔ aggrRatio correlation check (spec §3.4)
  if (STAGE3_MODE && diag.obiProxyPairs.length > 10) {
    var pairs = diag.obiProxyPairs;
    var n = pairs.length;
    var mObi = 0, mAgg = 0;
    for (var pi = 0; pi < n; pi++) { mObi += pairs[pi].obi; mAgg += pairs[pi].aggr; }
    mObi /= n; mAgg /= n;
    var cov = 0, vObi = 0, vAgg = 0;
    for (var pi2 = 0; pi2 < n; pi2++) {
      var dObi = pairs[pi2].obi - mObi;
      var dAgg = pairs[pi2].aggr - mAgg;
      cov += dObi * dAgg; vObi += dObi * dObi; vAgg += dAgg * dAgg;
    }
    var corr = (vObi > 0 && vAgg > 0) ? cov / Math.sqrt(vObi * vAgg) : 1;
    console.log('\n  Stage-3 OBI proxy diagnostic:');
    console.log('    OBI_proxy ↔ aggrRatio corr: ' + corr.toFixed(3) +
      (corr > 0.99 ? '  ⚠ proxy = aggrRatio (by construction)' : '  ✓ some divergence'));
    console.log('    Note: live OBI will diverge from aggrRatio due to spoofing/order-pulling.');
    console.log('    vacuumAbove/Below = 999 → vacuum_alignment = 0 (not proxiable from klines).');
    console.log('    To isolate OBI impact: compare --stage2 vs --stage3 hit-rates.');
  }

  console.log('══════════════════════════════════════\n');

  var passRate = STAGE3_MODE ? 0.75 : 0.70;
  if (hitRate < passRate) {
    console.log('Tuning hints (check inplay/config.json weights):');
    if (STAGE3_MODE) {
      console.log('  Stage-3 specific:');
      console.log('  1. If obiConfirmed ratio ~ 1 — proxy ≈ aggrRatio, no added info; run live to see real OBI impact');
      console.log('  2. If Stage-3 hit-rate < Stage-2 — set OBI weight to 0 in config, keep vacuum_alignment in P');
      console.log('     → In score.js computeM Stage-3 branch: change 0.15 * m.obiConfirmed → 0');
      console.log('  3. vacuum_alignment not testable in backtest; verify on live data via log vacU/vacD fields');
    } else {
      console.log('  Stage-2 specific:');
      console.log('  1. If _cvdZ ratio is < 1 — CVD proxy z-score is inverse; try lowering cvdZ weight (0.30→0.20)');
      console.log('  2. If _aggrRatio ratio is ~ 1 — aggrRatio not discriminating; try wM += 0.05, wA -= 0.05');
      console.log('  3. If |M| ratio is < 1 — momentum hurts; Stage-2 M weights may need re-balancing');
    }
    console.log('  General:');
    console.log('  4. If A dominates top-10 — try lowering wA, raising wM');
    console.log('  5. If hit-rate ~50% (random) — dp5m_baseline may be unstable');
    console.log('     → try hardcoding dp5mBaseline=0.003 in score.js temporarily\n');
  }
}

main().catch(function (e) {
  console.error('[Backtest] Fatal:', e.message);
  process.exit(1);
});
