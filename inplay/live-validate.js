'use strict';

/**
 * Live validation — hit-rate from inplay.log.
 *
 * Usage (on VPS):
 *   node inplay/live-validate.js [--log ./inplay.log] [--top-n 7] [--symbols 50]
 *   node inplay/live-validate.js --stage1        # reconstruct Stage-1 scores for comparison
 *   node inplay/live-validate.js --ab            # A/B: Stage-1 vs Stage-2 (current log)
 *   node inplay/live-validate.js --ab23          # A/B: Stage-2 vs Stage-3 (current log)
 *   node inplay/live-validate.js --ab123         # A/B/C: Stage-1 vs Stage-2 vs Stage-3
 *
 * --ab23   Re-ranks logged signals using Stage-2 reconstructed score vs logged Stage-3 score.
 *          Stage-2 M (approximate, momentum term omitted):
 *            M_s2 = tanh(0.25·miatr + 0.20·dvwap + 0.30·cvdZ + 0.15·aggrTerm)
 *          Stage-2 P (rvolAccel omitted — not logged):
 *            P_s2 = 0.40·squeeze + 0.30·cvdDiv_abs  (rvolAccel dropped → 0.40+0.30=0.70, rest is 0)
 *          Use only to detect direction of impact, not as an exact Stage-2 replica.
 *
 * Methodology identical to backtest.js:
 *   - Basket  = top-N USDT perps by 24h quote volume (same as backtest)
 *   - Signals = top-N from log, sampled at 5-minute boundaries
 *   - Outcome = max |Δprice| over T+5m..T+15m vs basket median
 */

const fs   = require('fs');
const path = require('path');

const BINANCE_REST  = 'https://fapi.binance.com';
const STEP_MS       = 5 * 60 * 1000;
const OUTCOME_START = 5  * 60 * 1000;
const OUTCOME_END   = 15 * 60 * 1000;

function getArg(name, def) {
  var i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
var LOG_PATH      = getArg('log',     path.join(__dirname, '..', 'inplay.log'));
var TOP_N         = parseInt(getArg('top-n',   '7'));
var SYMBOL_COUNT  = parseInt(getArg('symbols', '50'));
var SKIP_TOP      = parseInt(getArg('skip',    '10')); // skip top-N mega-caps (BTC/ETH/SOL…)
var STAGE1_MODE   = process.argv.indexOf('--stage1') >= 0;
var AB_MODE       = process.argv.indexOf('--ab') >= 0;
var AB23_MODE     = process.argv.indexOf('--ab23') >= 0;   // Stage-2 vs Stage-3
var AB123_MODE    = process.argv.indexOf('--ab123') >= 0;  // Stage-1 vs Stage-2 vs Stage-3

// ── REST helpers ──────────────────────────────────────────────────────────

async function fetchJSON(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function fetchKlines(symbol, startTime, endTime) {
  var candles = [];
  var start = startTime;
  while (start < endTime) {
    var url = BINANCE_REST + '/fapi/v1/klines?symbol=' + symbol +
      '&interval=1m&startTime=' + start + '&endTime=' + endTime + '&limit=500';
    var data;
    try { data = await fetchJSON(url); } catch (e) {
      console.error('  [fetch error]', symbol, e.message);
      break;
    }
    if (!Array.isArray(data) || !data.length) break;
    data.forEach(function (arr) {
      candles.push({ time: arr[0], close: parseFloat(arr[4]) });
    });
    if (data.length < 500) break;
    start = data[data.length - 1][0] + 60000;
    await sleep(100);
  }
  return candles;
}

async function getTopSymbols(n, skip) {
  var tickers = await fetchJSON(BINANCE_REST + '/fapi/v1/ticker/24hr');
  return tickers
    .filter(function (t) { return t.symbol.endsWith('USDT'); })
    .sort(function (a, b) { return parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume); })
    .slice(skip, skip + n)
    .map(function (t) { return t.symbol; });
}

// ── Log parser ────────────────────────────────────────────────────────────
// Line: 2026-05-24T11:18:45.358Z [Inplay] CHZUSDT score=-0.961 A=0.83 ...

function parseLine(line) {
  var m = line.match(/^(\S+) \[Inplay\] (\S+) score=(-?[\d.]+) A=([\d.]+) M=(-?[\d.]+) P=([\d.]+)/);
  if (!m) return null;
  var ts = new Date(m[1]).getTime();
  if (isNaN(ts)) return null;

  function grab(re) { var r = line.match(re); return r ? parseFloat(r[1]) : null; }

  // Stage-1/2 fields
  var miatr  = grab(/miatr=(-?[\d.]+)/)  || 0;
  var dvwap  = grab(/dvwap=(-?[\d.]+)/)  || 0;
  var bbs    = grab(/bbs=(-?[\d.]+)/);
  var cvdZ   = grab(/cvdZ=(-?[\d.]+)/);
  var aggr   = grab(/aggr=([\d.]+)/);
  var cvdDiv = grab(/div=(-?[\d.]+)/);

  // Stage-3 fields (present only when orderbook data received)
  var spr    = grab(/spr=(-?[\d.]+)bps/);
  var emaOBI = grab(/obi=(-?[\d.]+)/);
  var obiC   = grab(/obiC=(-?[\d.]+)/);
  var vacU   = grab(/vacU=(-?[\d.]+)bps/);
  var vacD   = grab(/vacD=(-?[\d.]+)bps/);

  return {
    ts:     ts,
    symbol: m[2],
    score:  parseFloat(m[3]),
    A:      parseFloat(m[4]),
    M:      parseFloat(m[5]),
    P:      parseFloat(m[6]),
    miatr:  miatr,
    dvwap:  dvwap,
    bbs:    bbs,
    cvdZ:   cvdZ,
    aggr:   aggr,
    cvdDiv: cvdDiv,
    // Stage-3 (null when not present in log)
    spr:    spr,
    emaOBI: emaOBI,
    obiC:   obiC,
    vacU:   vacU,
    vacD:   vacD,
  };
}

// Stage-1 score reconstructed from logged miatr/dvwap/A/P.
// M_s1 = tanh(0.40·miatr + 0.30·dvwap)  [momentumTerm not logged → omitted]
// score_s1 = sign(M_s1) × (0.35·A + 0.45·|M_s1| + 0.20·P)
function stage1Score(e) {
  var M    = Math.tanh(0.40 * e.miatr + 0.30 * e.dvwap);
  var sign = M > 0 ? 1 : M < 0 ? -1 : 0;
  return sign * (0.35 * e.A + 0.45 * Math.abs(M) + 0.20 * e.P);
}

// Stage-2 score reconstructed from Stage-3 log fields.
// Approximation — momentum term and rvolAccel omitted (not logged).
// M_s2 = tanh(0.25·miatr + 0.20·dvwap + 0.30·cvdZ + 0.15·aggrTerm)
// P_s2 = clip(0.40·squeeze + 0.30·|cvdDiv|, 0, 1)   [rvolAccel not logged → 0]
// score_s2 = sign(M_s2) × (0.35·A + 0.45·|M_s2| + 0.20·P_s2)
function stage2Score(e) {
  var aggrTerm = e.aggr !== null ? (2 * e.aggr - 1) : 0;
  var cvdZ     = e.cvdZ !== null ? e.cvdZ : 0;
  var M        = Math.tanh(0.25 * e.miatr + 0.20 * e.dvwap + 0.30 * cvdZ + 0.15 * aggrTerm);
  var squeeze  = e.bbs !== null ? Math.max(0, Math.min(1, 1 - e.bbs)) : 0;
  var cvdDiv   = e.cvdDiv !== null ? Math.abs(e.cvdDiv) : 0;
  var P        = Math.max(0, Math.min(1, 0.40 * squeeze + 0.30 * cvdDiv));
  var sign     = M > 0 ? 1 : M < 0 ? -1 : 0;
  return sign * (0.35 * e.A + 0.45 * Math.abs(M) + 0.20 * P);
}

// ── Simulation helpers ────────────────────────────────────────────────────

// Last close price strictly before time T
function closeAt(candles, T) {
  var close = null;
  for (var i = 0; i < candles.length; i++) {
    if (candles[i].time < T) close = candles[i].close;
    else break;
  }
  return close;
}

function measureOutcome(candles, T, closeT) {
  if (closeT == null) return null;
  var start = T + OUTCOME_START;
  var end   = T + OUTCOME_END;
  var max   = -1;
  for (var i = 0; i < candles.length; i++) {
    var t = candles[i].time;
    if (t < start) continue;
    if (t > end)   break;
    var move = Math.abs(candles[i].close - closeT) / closeT;
    if (move > max) max = move;
  }
  return max >= 0 ? max : null;
}

function median(arr) {
  if (!arr.length) return 0;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── Stats helpers ─────────────────────────────────────────────────────────

function makeStats() {
  return {
    total: 0, hits: 0, dayStats: {},
    pos: { hits: 0, total: 0 }, neg: { hits: 0, total: 0 },
    // Stage-3 diagnostics
    s3: {
      hits:   { spr: [], emaOBI: [], obiC: [], vacU: [], vacD: [] },
      misses: { spr: [], emaOBI: [], obiC: [], vacU: [], vacD: [] },
      obiC_zero: 0,  // times OBI_confirmed was 0 (filter fired)
      obiC_nonzero: 0,
    },
  };
}

function recordTopN(topN, T, bMedian, klines, st) {
  var dayKey = new Date(T).toISOString().slice(0, 10);
  if (!st.dayStats[dayKey]) st.dayStats[dayKey] = { hits: 0, total: 0 };
  topN.forEach(function (r) {
    var arr = klines[r.symbol];
    if (!arr || !arr.length) return;
    var ct  = closeAt(arr, T);
    var out = measureOutcome(arr, T, ct);
    if (out == null) return;
    st.total++;
    st.dayStats[dayKey].total++;
    var isHit = out > bMedian;
    if (isHit) { st.hits++; st.dayStats[dayKey].hits++; }
    if (r.score >= 0) { st.pos.total++; if (isHit) st.pos.hits++; }
    else              { st.neg.total++; if (isHit) st.neg.hits++; }

    // Stage-3 component collection
    var e      = r.entry;
    var bucket = isHit ? st.s3.hits : st.s3.misses;
    if (e.spr    !== null) bucket.spr.push(e.spr);
    if (e.emaOBI !== null) bucket.emaOBI.push(e.emaOBI);
    if (e.obiC   !== null) { bucket.obiC.push(e.obiC);
      if (e.obiC === 0) st.s3.obiC_zero++; else st.s3.obiC_nonzero++; }
    if (e.vacU   !== null) bucket.vacU.push(e.vacU);
    if (e.vacD   !== null) bucket.vacD.push(e.vacD);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // 1. Parse log
  console.log('[LiveValidate] Reading', LOG_PATH, '...');
  var raw;
  try { raw = fs.readFileSync(LOG_PATH, 'utf8'); } catch (e) {
    console.error('Cannot read log:', e.message); process.exit(1);
  }

  var entries = [];
  raw.split('\n').forEach(function (line) {
    var e = parseLine(line.trim());
    if (e) entries.push(e);
  });
  console.log('[LiveValidate] Parsed', entries.length, 'log entries');
  if (!entries.length) { console.error('No entries found'); process.exit(1); }

  // Sort by timestamp (should already be sorted, but just in case)
  entries.sort(function (a, b) { return a.ts - b.ts; });

  var logStart = entries[0].ts;
  var logEnd   = entries[entries.length - 1].ts;

  // 2. Build 5-minute evaluation boundaries
  //    For each boundary T, find the last score per symbol from log entries with ts <= T.
  //    Only keep T where outcome window T+15m has already passed.
  var now       = Date.now();
  var evalStart = Math.ceil(logStart / STEP_MS) * STEP_MS;   // first complete 5m after log start
  var evalEnd   = Math.floor((Math.min(logEnd, now - OUTCOME_END - 60000)) / STEP_MS) * STEP_MS;

  if (evalEnd <= evalStart) {
    console.error('Not enough data: outcome window (T+15m) has not passed yet for any bucket');
    process.exit(1);
  }

  var boundaries = [];
  for (var T = evalStart; T <= evalEnd; T += STEP_MS) boundaries.push(T);
  console.log('[LiveValidate] Evaluation boundaries:', boundaries.length,
    '|', new Date(boundaries[0]).toISOString().slice(0, 16),
    '→', new Date(boundaries[boundaries.length - 1]).toISOString().slice(0, 16));

  // Pre-index entries by symbol → sorted list
  var bySymbol = {};
  entries.forEach(function (e) {
    if (!bySymbol[e.symbol]) bySymbol[e.symbol] = [];
    bySymbol[e.symbol].push(e);
  });
  var loggedSymbols = Object.keys(bySymbol);

  // For a given boundary T, get the latest score per symbol from log (ts <= T)
  function snapshotAt(T) {
    var snap = {}; // symbol → score
    loggedSymbols.forEach(function (sym) {
      var arr = bySymbol[sym];
      // Binary search for last entry with ts <= T
      var lo = 0, hi = arr.length - 1, found = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (arr[mid].ts <= T) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (found >= 0) snap[sym] = arr[found];
    });
    return snap;
  }

  // 3. Fetch basket symbols (top-N by 24h volume, same as backtest)
  console.log('[LiveValidate] Fetching top-' + SYMBOL_COUNT + ' basket symbols (skip=' + SKIP_TOP + ')...');
  var basketSymbols = await getTopSymbols(SYMBOL_COUNT, SKIP_TOP);
  console.log('[LiveValidate] Basket:', basketSymbols.slice(0, 5).join(', '), '...');

  // Union: basket + signal symbols (to fetch klines for all)
  var allSymbols = basketSymbols.slice();
  loggedSymbols.forEach(function (s) {
    if (allSymbols.indexOf(s) < 0) allSymbols.push(s);
  });

  // 4. Fetch klines
  var fetchStart = boundaries[0] - 60000;
  var fetchEnd   = boundaries[boundaries.length - 1] + OUTCOME_END + 120000;
  var klines = {};

  for (var i = 0; i < allSymbols.length; i++) {
    var sym = allSymbols[i];
    process.stdout.write('\r[LiveValidate] Fetching klines ' +
      (i + 1) + '/' + allSymbols.length + ' ' + sym + '        ');
    klines[sym] = await fetchKlines(sym, fetchStart, fetchEnd);
    await sleep(150);
  }
  process.stdout.write('\n[LiveValidate] Fetch complete\n');

  // 5. Evaluate each boundary
  var stCurrent = makeStats();                                              // logged score
  var stAlt     = (AB_MODE || STAGE1_MODE || AB23_MODE || AB123_MODE) ? makeStats() : null;
  var stAlt2    = AB123_MODE ? makeStats() : null;  // Stage-2 approx (only for --ab123)

  boundaries.forEach(function (T) {
    // Basket outcomes
    var basketOutcomes = [];
    basketSymbols.forEach(function (sym) {
      var arr = klines[sym];
      if (!arr || !arr.length) return;
      var ct  = closeAt(arr, T);
      var out = measureOutcome(arr, T, ct);
      if (out !== null) basketOutcomes.push(out);
    });
    if (basketOutcomes.length < 5) return;
    var bMedian = median(basketOutcomes);

    var snap = snapshotAt(T);
    var snapSyms = Object.keys(snap);
    if (snapSyms.length < 5) return;

    // Logged score (Stage-2 or Stage-3 depending on what ran on VPS)
    var topNLogged = snapSyms
      .map(function (s) { var e = snap[s]; return { symbol: s, score: e.score, entry: e }; })
      .sort(function (a, b) { return Math.abs(b.score) - Math.abs(a.score); })
      .slice(0, TOP_N);

    // Reconstructed Stage-1 score
    var topN1 = (AB_MODE || STAGE1_MODE || AB123_MODE) ? snapSyms
      .map(function (s) { var e = snap[s]; return { symbol: s, score: stage1Score(e), entry: e }; })
      .sort(function (a, b) { return Math.abs(b.score) - Math.abs(a.score); })
      .slice(0, TOP_N) : null;

    // Reconstructed Stage-2 score (for --ab23 and --ab123)
    var topN2approx = (AB23_MODE || AB123_MODE) ? snapSyms
      .map(function (s) { var e = snap[s]; return { symbol: s, score: stage2Score(e), entry: e }; })
      .sort(function (a, b) { return Math.abs(b.score) - Math.abs(a.score); })
      .slice(0, TOP_N) : null;

    if (AB_MODE) {
      recordTopN(topN1,      T, bMedian, klines, stAlt);
      recordTopN(topNLogged, T, bMedian, klines, stCurrent);
    } else if (AB23_MODE) {
      recordTopN(topN2approx, T, bMedian, klines, stAlt);
      recordTopN(topNLogged,  T, bMedian, klines, stCurrent);
    } else if (AB123_MODE) {
      recordTopN(topN1,       T, bMedian, klines, stAlt);   // Stage 1
      recordTopN(topN2approx, T, bMedian, klines, stAlt2);  // Stage 2 approx
      recordTopN(topNLogged,  T, bMedian, klines, stCurrent); // Stage 3
    } else if (STAGE1_MODE) {
      recordTopN(topN1, T, bMedian, klines, stAlt);
    } else {
      recordTopN(topNLogged, T, bMedian, klines, stCurrent);
    }
  });

  // 6. Report
  function avgArr(arr) { return arr.length ? arr.reduce(function (s, v) { return s + v; }, 0) / arr.length : null; }

  function printStats(label, st, showS3) {
    var hitRate = st.total > 0 ? st.hits / st.total : 0;
    var posRate = st.pos.total > 0 ? st.pos.hits / st.pos.total : 0;
    var negRate = st.neg.total > 0 ? st.neg.hits / st.neg.total : 0;
    console.log('\n══════════════════════════════════════');
    console.log('  LIVE VALIDATION RESULTS  (' + label + ')');
    console.log('══════════════════════════════════════');
    console.log('  Basket symbols:   ', SYMBOL_COUNT, '(top by 24h volume)');
    console.log('  Boundaries:       ', boundaries.length);
    console.log('  Predictions:      ', st.total);
    console.log('  Hits:             ', st.hits);
    console.log('  Hit-rate:         ', (hitRate * 100).toFixed(1) + '%',
      hitRate >= 0.75 ? '✓ PASS  (≥75% Stage-3)' :
      hitRate >= 0.70 ? '✓ PASS  (≥70% Stage-2)' :
      hitRate >= 0.60 ? '~ Stage-1 level (≥60%)' :
                        '✗ FAIL  (<60%)');
    console.log('\n  Per-day breakdown:');
    Object.keys(st.dayStats).sort().forEach(function (day) {
      var d  = st.dayStats[day];
      var dr = d.total > 0 ? (d.hits / d.total * 100).toFixed(1) : 'N/A';
      console.log('    ' + day + '  ' + dr + '%  (' + d.hits + '/' + d.total + ')');
    });
    console.log('\n  Hit-rate by signal direction:');
    console.log('    Long  (score > 0): ' + (posRate * 100).toFixed(1) +
      '%  (' + st.pos.hits + '/' + st.pos.total + ')');
    console.log('    Short (score < 0): ' + (negRate * 100).toFixed(1) +
      '%  (' + st.neg.hits + '/' + st.neg.total + ')');

    // Stage-3 component diagnostics (shown when log contains Stage-3 fields)
    if (showS3) {
      var s3 = st.s3;
      var totalObiC = s3.obiC_zero + s3.obiC_nonzero;
      console.log('\n  Stage-3 order book diagnostics:');
      if (totalObiC > 0) {
        console.log('    OBI_confirmed=0 (filter fired): ' + s3.obiC_zero + '/' + totalObiC +
          '  (' + (s3.obiC_zero / totalObiC * 100).toFixed(1) + '%)' +
          (s3.obiC_zero > 0 ? '  ✓ filter active' : '  ⚠ filter never fired'));
      }
      var fields = [
        { key: 'spr',    label: 'Spread bps    ' },
        { key: 'emaOBI', label: 'EMA OBI_top5  ' },
        { key: 'obiC',   label: 'OBI_confirmed ' },
        { key: 'vacU',   label: 'Vacuum above  ' },
        { key: 'vacD',   label: 'Vacuum below  ' },
      ];
      var hasS3Data = false;
      fields.forEach(function (f) {
        var h = avgArr(s3.hits[f.key]);
        var mv = avgArr(s3.misses[f.key]);
        if (h === null && mv === null) return;
        hasS3Data = true;
        var ratio = (h !== null && mv !== null && mv !== 0) ? h / mv : null;
        console.log('    ' + f.label + '  hits=' + (h !== null ? h.toFixed(2) : 'n/a') +
          '  misses=' + (mv !== null ? mv.toFixed(2) : 'n/a') +
          (ratio !== null ? '  ratio=' + ratio.toFixed(2) +
            (ratio > 1.05 ? ' ↑' : ratio < 0.95 ? ' ↓' : ' ~') : ''));
      });
      if (!hasS3Data) console.log('    (no Stage-3 fields in log — run with INPLAY_BETA_ENABLED=true + Stage-3 code)');
    }

    console.log('══════════════════════════════════════');
  }

  function abcTable(stA, stB, stC) {
    function r(st) { return st.total > 0 ? st.hits / st.total : 0; }
    function p(st) { return st.pos.total > 0 ? st.pos.hits / st.pos.total : 0; }
    function n(st) { return st.neg.total > 0 ? st.neg.hits / st.neg.total : 0; }
    function pct(v) { return (v * 100).toFixed(1) + '%'; }
    function dlt(d) { return (d >= 0 ? '+' : '') + (d * 100).toFixed(1) + 'pp'; }
    var aHR = r(stA), bHR = r(stB), cHR = r(stC);
    var aPos = p(stA), bPos = p(stB), cPos = p(stC);
    var aNeg = n(stA), bNeg = n(stB), cNeg = n(stC);
    console.log('\n  ┌─────────────────────────────────────────────────────────┐');
    console.log('  │  A/B/C  (same boundaries & klines)                      │');
    console.log('  ├────────────┬─────────┬─────────┬─────────┬──────┬──────┤');
    console.log('  │            │ Stage-1 │ Stage-2 │ Stage-3 │ Δ2-1 │ Δ3-2 │');
    console.log('  ├────────────┼─────────┼─────────┼─────────┼──────┼──────┤');
    console.log('  │ Overall    │ ' + pct(aHR).padStart(6)  + '  │ ' + pct(bHR).padStart(6)  + '  │ ' + pct(cHR).padStart(6)  + '  │ ' + dlt(bHR  - aHR).padStart(5)  + ' │ ' + dlt(cHR  - bHR).padStart(5)  + ' │');
    console.log('  │ Long >0    │ ' + pct(aPos).padStart(6) + '  │ ' + pct(bPos).padStart(6) + '  │ ' + pct(cPos).padStart(6) + '  │ ' + dlt(bPos - aPos).padStart(5) + ' │ ' + dlt(cPos - bPos).padStart(5) + ' │');
    console.log('  │ Short <0   │ ' + pct(aNeg).padStart(6) + '  │ ' + pct(bNeg).padStart(6) + '  │ ' + pct(cNeg).padStart(6) + '  │ ' + dlt(bNeg - aNeg).padStart(5) + ' │ ' + dlt(cNeg - bNeg).padStart(5) + ' │');
    console.log('  └────────────┴─────────┴─────────┴─────────┴──────┴──────┘\n');
  }

  function abTable(labelA, labelB, stA, stB) {
    var aHR  = stA.total > 0 ? stA.hits / stA.total : 0;
    var bHR  = stB.total > 0 ? stB.hits / stB.total : 0;
    var aPos = stA.pos.total > 0 ? stA.pos.hits / stA.pos.total : 0;
    var bPos = stB.pos.total > 0 ? stB.pos.hits / stB.pos.total : 0;
    var aNeg = stA.neg.total > 0 ? stA.neg.hits / stA.neg.total : 0;
    var bNeg = stB.neg.total > 0 ? stB.neg.hits / stB.neg.total : 0;
    function pct(r) { return (r * 100).toFixed(1) + '%'; }
    function dlt(d) { return (d >= 0 ? '+' : '') + (d * 100).toFixed(1) + 'pp'; }
    var lA = labelA.padEnd(8), lB = labelB.padEnd(8);
    console.log('\n  ┌──────────────────────────────────────────┐');
    console.log('  │  A/B  (same boundaries & klines)         │');
    console.log('  ├────────────┬──────────┬──────────┬───────┤');
    console.log('  │            │  ' + lA + '  │  ' + lB + '  │   Δ   │');
    console.log('  ├────────────┼──────────┼──────────┼───────┤');
    console.log('  │ Overall    │ ' + pct(aHR).padStart(7)  + '  │ ' + pct(bHR).padStart(7)  + '  │ ' + dlt(bHR  - aHR).padStart(6)  + ' │');
    console.log('  │ Long >0    │ ' + pct(aPos).padStart(7) + '  │ ' + pct(bPos).padStart(7) + '  │ ' + dlt(bPos - aPos).padStart(6) + ' │');
    console.log('  │ Short <0   │ ' + pct(aNeg).padStart(7) + '  │ ' + pct(bNeg).padStart(7) + '  │ ' + dlt(bNeg - aNeg).padStart(6) + ' │');
    console.log('  └────────────┴──────────┴──────────┴───────┘\n');
  }

  var hasS3Fields = Object.values(snapshotAt(boundaries[0] || 0))
    .some(function (e) { return e.spr !== null; });

  if (AB_MODE) {
    printStats('Stage 1 approx', stAlt, false);
    printStats('Stage 2 (logged)', stCurrent, hasS3Fields);
    abTable('Stage-1', 'Stage-2', stAlt, stCurrent);
  } else if (AB23_MODE) {
    printStats('Stage 2 approx', stAlt, false);
    printStats('Stage 3 (logged)', stCurrent, true);
    abTable('Stage-2', 'Stage-3', stAlt, stCurrent);
    console.log('  Note: Stage-2 approx omits momentumTerm + rvolAccel (not logged).\n');
  } else if (AB123_MODE) {
    printStats('Stage 1 approx', stAlt, false);
    printStats('Stage 2 approx', stAlt2, false);
    printStats('Stage 3 (logged)', stCurrent, true);
    abcTable(stAlt, stAlt2, stCurrent);
    console.log('  Note: Stage-1/2 approx omit momentumTerm + rvolAccel (not logged).\n');
  } else if (STAGE1_MODE) {
    printStats('Stage 1 approx', stAlt, false);
  } else {
    printStats('Current (logged score)', stCurrent, hasS3Fields);
  }
}

main().catch(function (e) {
  console.error('[LiveValidate] Fatal:', e.message);
  process.exit(1);
});
