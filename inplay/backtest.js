'use strict';

/**
 * Inplay backtest harness — Stage 1.4
 *
 * Usage:
 *   node inplay/backtest.js [--days 7] [--symbols 30] [--top-n 10]
 *
 * Fetches historical 1m + 5m klines from Binance REST, replays the Inplay
 * score at each 5-minute step, measures |Δprice| on T+5m..T+15m horizon,
 * and reports hit-rate + score distribution.
 *
 * Target: hit-rate ≥ 60%. If below — tune weights in inplay/config.json.
 */

const { updateAllScores } = require('./score');
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
var SYMBOL_COUNT = parseInt(getArg('symbols', '30'));
var TOP_N        = parseInt(getArg('top-n',   String(cfg.top_n)));

// ── REST helpers ──────────────────────────────────────────────────────────

async function fetchJSON(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function parseCandle(arr) {
  return {
    time:   arr[0],
    open:   parseFloat(arr[1]),
    high:   parseFloat(arr[2]),
    low:    parseFloat(arr[3]),
    close:  parseFloat(arr[4]),
    volume: parseFloat(arr[5]),
    trades: parseInt(arr[8], 10),
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

// Top N USDT perp symbols by 24h quote volume
async function getTopSymbols(n) {
  console.log('[Backtest] Fetching symbol list...');
  var tickers = await fetchJSON(BINANCE_REST + '/fapi/v1/ticker/24hr');
  return tickers
    .filter(function (t) { return t.symbol.endsWith('USDT'); })
    .sort(function (a, b) { return parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume); })
    .slice(0, n)
    .map(function (t) { return t.symbol; });
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

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  var endTime   = Date.now();
  var startTime = endTime - DAYS * 24 * 60 * 60 * 1000;

  console.log('[Backtest] Days=' + DAYS + '  Symbols=' + SYMBOL_COUNT + '  Top-N=' + TOP_N);
  console.log('[Backtest] ' + new Date(startTime).toISOString() + ' → ' + new Date(endTime).toISOString());

  var symbols  = await getTopSymbols(SYMBOL_COUNT);
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

  // Diagnostics: A/|M|/P per hit vs miss, hit-rate by Inplay sign
  var diag = {
    hits:   { A: [], absM: [], P: [] },
    misses: { A: [], absM: [], P: [] },
    pos: { hits: 0, total: 0 },  // Inplay > 0 (long signal)
    neg: { hits: 0, total: 0 },  // Inplay < 0 (short signal)
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

    var top = updateAllScores(symbols, getBuffer, T);
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

      // Collect A/|M|/P for diagnostic
      var bucket = isHit ? diag.hits : diag.misses;
      bucket.A.push(r.A);
      bucket.absM.push(Math.abs(r.M));
      bucket.P.push(r.P);

      // Hit-rate by Inplay sign
      if (r.inplay >= 0) { diag.pos.total++; if (isHit) diag.pos.hits++; }
      else               { diag.neg.total++; if (isHit) diag.neg.hits++; }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────

  var hitRate = totalPredictions > 0 ? totalHits / totalPredictions : 0;

  console.log('\n══════════════════════════════════════');
  console.log('  INPLAY BACKTEST RESULTS');
  console.log('══════════════════════════════════════');
  console.log('  Days:          ', DAYS);
  console.log('  Symbols:       ', symbols.length);
  console.log('  Steps run:     ', stepsDone, '  (skipped: ' + stepsSkipped + ')');
  console.log('  Predictions:   ', totalPredictions);
  console.log('  Hits:          ', totalHits);
  console.log('  Hit-rate:      ', (hitRate * 100).toFixed(1) + '%',
    hitRate >= 0.6 ? '✓ PASS' : '✗ FAIL (<60%)');

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
  console.log('              hits    misses  ratio');
  ['A','absM','P'].forEach(function(k) {
    var h = avgArr(diag.hits[k]), m = avgArr(diag.misses[k]);
    var ratio = m > 0 ? h/m : 0;
    var label = k === 'absM' ? '|M|  ' : k + '    ';
    console.log('    ' + label + '    ' + h.toFixed(3) + '   ' + m.toFixed(3) + '   ' + ratio.toFixed(2) +
      (ratio > 1.05 ? ' ↑ discriminative' : ratio < 0.95 ? ' ↓ inverse' : ' ~ neutral'));
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

  console.log('══════════════════════════════════════\n');

  if (hitRate < 0.6) {
    console.log('Tuning hints (check inplay/config.json weights):');
    console.log('  1. If A dominates top-10 — try lowering wA, raising wM');
    console.log('  2. If top-10 barely changes between steps — cross-sectional rank may be stuck');
    console.log('     → check that buffers update on each step (not all same candles)');
    console.log('  3. If hit-rate ~50% (random) — dp5m_baseline may be unstable');
    console.log('     → try hardcoding dp5mBaseline=0.003 in score.js temporarily\n');
  }
}

main().catch(function (e) {
  console.error('[Backtest] Fatal:', e.message);
  process.exit(1);
});
