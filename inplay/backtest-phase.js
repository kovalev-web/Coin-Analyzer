'use strict';

/**
 * Phase-detector backtest harness
 *
 * Usage:
 *   node inplay/backtest-phase.js [--days 7] [--symbols 200]
 *   node inplay/backtest-phase.js --sweep
 *
 * Symbols are selected by 24h quote volume range (--min-vol / --max-vol).
 * CVD disabled in backtest (no aggTrade history available).
 * Hit = max directional move >= HIT_PCT within 60 min of phase start.
 */

const { updatePhases, resetState } = require('./phase-detector');
const cfg = require('./config.json');

const BINANCE_REST   = 'https://fapi.binance.com';
const STEP_MS        = 5 * 60 * 1000;
const TF_MS          = { '1m': 60000, '5m': 300000 };
const WARMUP_STEPS   = 50;
const OUTCOME_WINDOW = 60 * 60 * 1000;
const HIT_PCT        = 3.0;

// ── CLI args ──────────────────────────────────────────────────────────────

function getArg(name, def) {
  var i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
var DAYS         = parseInt(getArg('days',    '7'));
var SYMBOL_COUNT = parseInt(getArg('symbols', '200'));
var MIN_VOL      = parseFloat(getArg('min-vol', '20000000'));   // $20M
var MAX_VOL      = parseFloat(getArg('max-vol', '200000000'));  // $200M
var SWEEP_MODE   = process.argv.indexOf('--sweep') >= 0;

// ── REST helpers ──────────────────────────────────────────────────────────

async function fetchJSON(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
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

async function fetchAllKlines(symbol, interval, startTime, endTime) {
  var intervalMs = TF_MS[interval];
  var candles = [];
  var start = startTime;
  while (start < endTime) {
    var url = BINANCE_REST + '/fapi/v1/klines?symbol=' + symbol +
      '&interval=' + interval + '&startTime=' + start + '&endTime=' + endTime + '&limit=500';
    var data;
    try { data = await fetchJSON(url); } catch (e) {
      console.error('  [fetch error]', symbol, interval, e.message);
      break;
    }
    if (!Array.isArray(data) || !data.length) break;
    data.forEach(function (a) { candles.push(parseCandle(a)); });
    if (data.length < 500) break;
    start = data[data.length - 1][0] + intervalMs;
    await sleep(150);
  }
  return candles;
}

// Coins with 24h quote volume in [minVol, maxVol], sorted by volume desc, up to n
async function getSymbolsByVolume(n, minVol, maxVol) {
  console.log('[Backtest] Fetching symbol list...');
  var tickers = await fetchJSON(BINANCE_REST + '/fapi/v1/ticker/24hr');
  var filtered = tickers
    .filter(function (t) {
      if (!t.symbol.endsWith('USDT')) return false;
      var vol = parseFloat(t.quoteVolume);
      return vol >= minVol && vol <= maxVol;
    })
    .sort(function (a, b) { return parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume); })
    .slice(0, n)
    .map(function (t) { return t.symbol; });
  console.log('[Backtest] Found ' + filtered.length + ' symbols in $' +
    (minVol / 1e6).toFixed(0) + 'M–$' + (maxVol / 1e6).toFixed(0) + 'M volume range');
  return filtered;
}

async function fetchHistoricalData(symbols, startTime, endTime) {
  var data = {};
  for (var i = 0; i < symbols.length; i++) {
    var sym = symbols[i];
    process.stdout.write('\r[Backtest] Fetching ' + (i + 1) + '/' + symbols.length + ' ' + sym + '      ');
    data[sym] = {
      '1m': await fetchAllKlines(sym, '1m', startTime, endTime),
      '5m': await fetchAllKlines(sym, '5m', startTime, endTime),
    };
    await sleep(200);
  }
  process.stdout.write('\n');
  return data;
}

// ── Simulation helpers ────────────────────────────────────────────────────

function sliceBefore(arr, T, n) {
  var lo = 0, hi = arr.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (arr[mid].time < T) lo = mid + 1; else hi = mid;
  }
  return arr.slice(Math.max(0, lo - n), lo);
}

function measureMaxMove(arr1m, T, entryPrice, direction) {
  var end = T + OUTCOME_WINDOW;
  var maxMove = 0;
  for (var i = 0; i < arr1m.length; i++) {
    var t = arr1m[i].time;
    if (t < T) continue;
    if (t > end) break;
    var move = (arr1m[i].close - entryPrice) / entryPrice * direction * 100;
    if (move > maxMove) maxMove = move;
  }
  return maxMove;
}

function median(arr) {
  if (!arr.length) return 0;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── Core simulation ───────────────────────────────────────────────────────

function runSimulation(histData, symbols, startTime, endTime, pdCfg) {
  resetState();

  var simStart   = startTime + WARMUP_STEPS * STEP_MS;
  var openPhases = {};
  var phases     = [];

  for (var T = simStart; T <= endTime - OUTCOME_WINDOW; T += STEP_MS) {
    var getBuffer = (function (currentT) {
      return function (sym, tf) {
        return histData[sym] ? sliceBefore(histData[sym][tf], currentT, 100) : [];
      };
    })(T);

    var result = updatePhases(symbols, getBuffer, null, null, T, pdCfg);

    for (var ti = 0; ti < result.transitions.length; ti++) {
      var tr = result.transitions[ti];
      if (tr.to === 'active' && tr.from === 'not_in_phase') {
        var buf5m = getBuffer(tr.symbol, '5m');
        var ep = buf5m.length ? buf5m[buf5m.length - 1].close : null;
        openPhases[tr.symbol] = { startT: T, direction: tr.direction, entryPrice: ep, revivals: 0 };
      } else if (tr.to === 'active' && tr.revival) {
        if (openPhases[tr.symbol]) openPhases[tr.symbol].revivals++;
      } else if (tr.to === 'not_in_phase' && openPhases[tr.symbol]) {
        var op = openPhases[tr.symbol];
        phases.push({ sym: tr.symbol, startT: op.startT, endT: T, direction: op.direction, entryPrice: op.entryPrice, revivals: op.revivals });
        delete openPhases[tr.symbol];
      }
    }
  }

  Object.keys(openPhases).forEach(function (sym) {
    var op = openPhases[sym];
    phases.push({ sym: sym, startT: op.startT, endT: endTime, direction: op.direction, entryPrice: op.entryPrice, revivals: op.revivals, open: true });
  });

  return phases;
}

function computeStats(phases, histData) {
  if (!phases.length) return null;

  var hits = 0, maxMoves = [], durations = [], totalRevivals = 0;

  phases.forEach(function (ph) {
    if (!ph.entryPrice) return;
    var arr1m = histData[ph.sym] ? histData[ph.sym]['1m'] : [];
    var maxMove = measureMaxMove(arr1m, ph.startT, ph.entryPrice, ph.direction);
    maxMoves.push(maxMove);
    if (maxMove >= HIT_PCT) hits++;
    durations.push((ph.endT - ph.startT) / 60000);
    totalRevivals += ph.revivals;
  });

  return {
    total:         phases.length,
    hits:          hits,
    hitRate:       hits / phases.length,
    medianMaxMove: median(maxMoves),
    avgDuration:   durations.reduce(function (s, v) { return s + v; }, 0) / durations.length,
    avgRevivals:   totalRevivals / phases.length,
    perDay:        phases.length / DAYS,
  };
}

// ── Output helpers ────────────────────────────────────────────────────────

function pct(n, d) { return d ? (n / d * 100).toFixed(1) + '%' : 'n/a'; }

function printStats(label, stats) {
  if (!stats) { console.log(label + ': no phases detected'); return; }
  console.log('\n' + label);
  console.log('  Phases:           ' + stats.total + '  (' + stats.perDay.toFixed(1) + '/day)');
  console.log('  Hit-rate:         ' + pct(stats.hits, stats.total) +
    '  (' + stats.hits + '/' + stats.total + ', >=' + HIT_PCT + '% in 60min)');
  console.log('  Median max move:  ' + stats.medianMaxMove.toFixed(1) + '%');
  console.log('  Avg duration:     ' + stats.avgDuration.toFixed(0) + ' min');
  console.log('  Avg revivals:     ' + stats.avgRevivals.toFixed(2) + ' / phase');
}

// Print one metric as a 4×4 grid table
function printMetricTable(title, grid, RVOL, PRICE, cellFn) {
  var COL_W = 12;
  console.log('\n' + title);
  var header = 'rvol \\ Δp%'.padEnd(11) + ' |';
  PRICE.forEach(function (p) { header += (' Δp>=' + p + '%').padStart(COL_W) + ' |'; });
  console.log(header);
  console.log('-'.repeat(header.length));
  for (var ri = 0; ri < RVOL.length; ri++) {
    var row = ('rvol>=' + RVOL[ri]).padEnd(11) + ' |';
    for (var pi = 0; pi < PRICE.length; pi++) {
      var s = grid[ri][pi];
      row += (s ? cellFn(s) : '—').padStart(COL_W) + ' |';
    }
    console.log(row);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  var endTime   = Date.now();
  var startTime = endTime - DAYS * 24 * 60 * 60 * 1000;

  console.log('[Backtest] Days=' + DAYS + '  Symbols up to ' + SYMBOL_COUNT +
    '  Vol $' + (MIN_VOL/1e6).toFixed(0) + 'M–$' + (MAX_VOL/1e6).toFixed(0) + 'M');
  console.log('[Backtest] ' + new Date(startTime).toISOString() + ' → ' + new Date(endTime).toISOString());
  console.log('[Backtest] CVD disabled (no aggTrade history)');

  var symbols  = await getSymbolsByVolume(SYMBOL_COUNT, MIN_VOL, MAX_VOL);
  var histData = await fetchHistoricalData(symbols, startTime, endTime);

  // Base config: CVD disabled
  var pdBase = JSON.parse(JSON.stringify(cfg.phase_detector));
  pdBase.entry.cvd_alignment  = false;
  pdBase.entry.cvd_zscore_min = 0;

  // ── Default run ──────────────────────────────────────────────────────
  console.log('\n[Backtest] Running default simulation...');
  var phases = runSimulation(histData, symbols, startTime, endTime, pdBase);
  printStats(
    '=== DEFAULT RUN (rvol_avg>=' + pdBase.entry.rvol_avg_threshold +
    ', Δp>=' + pdBase.entry.price_change_threshold_pct + '%) ===',
    computeStats(phases, histData)
  );

  if (!SWEEP_MODE) return;

  // ── Parameter sweep ──────────────────────────────────────────────────
  var RVOL_T  = [8, 10, 12, 15];
  var PRICE_T = [5,  8, 10, 15];

  console.log('\n[Backtest] Running sweep (' + RVOL_T.length * PRICE_T.length + ' combinations)...');

  var grid = [];
  for (var ri = 0; ri < RVOL_T.length; ri++) {
    grid[ri] = [];
    for (var pi = 0; pi < PRICE_T.length; pi++) {
      var pd = JSON.parse(JSON.stringify(pdBase));
      pd.entry.rvol_avg_threshold        = RVOL_T[ri];
      pd.entry.price_change_threshold_pct = PRICE_T[pi];
      process.stdout.write('  rvol>=' + RVOL_T[ri] + ' Δp>=' + PRICE_T[pi] + '%... ');
      var phasesRun = runSimulation(histData, symbols, startTime, endTime, pd);
      var s = computeStats(phasesRun, histData);
      grid[ri][pi] = s;
      process.stdout.write((s ? s.total + ' phases' : 'none') + '\n');
    }
  }

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(' SWEEP RESULTS  (7 days, ' + symbols.length + ' symbols, hit=move>=3% in 60min)');
  console.log('════════════════════════════════════════════════════════════════');

  printMetricTable('── phases count ──', grid, RVOL_T, PRICE_T, function (s) {
    return String(s.total) + ' (' + s.perDay.toFixed(1) + '/d)';
  });

  printMetricTable('── hit rate ──', grid, RVOL_T, PRICE_T, function (s) {
    return pct(s.hits, s.total);
  });

  printMetricTable('── median max move ──', grid, RVOL_T, PRICE_T, function (s) {
    return s.medianMaxMove.toFixed(1) + '%';
  });

  printMetricTable('── avg duration (min) ──', grid, RVOL_T, PRICE_T, function (s) {
    return s.avgDuration.toFixed(0) + 'm';
  });
}

main().catch(function (e) { console.error(e); process.exit(1); });
