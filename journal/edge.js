'use strict';

// "My edge" report: closed trades from saved day facts, joined with the
// per-trade tag (setup A/B/C, what drove the entry) and that morning's state,
// grouped so you can see where results come from. Every group carries n;
// groups under MIN_N are flagged as not enough data.

var MIN_N = 20;
var TAG_MATCH_MS = 2000; // tag close_time vs fact closeTime (both are the exchange fill time)

var SETUP = { A: 'A setup', B: 'B setup', C: 'C setup' };
// Setup types — what kind of entry the trade was (tagged after the close). The
// user edits the list (user_setups); these are the starting six, used when no list is passed.
var PATTERNS = ['squeeze_breakout', 'retest_breakout', 'level_bounce', 'false_breakout', 'knife', 'range'];
var STOP_OVERRUN_R = 1.2; // a loss beyond this many R means the stop wasn't held

// ── Strategy and execution (measured in R, not USDT) ───────────────────────

// 1R in USDT — the planned loss per trade, the same for every trade: risk %
// (Account settings, % per trade) of the working volume (Account settings,
// max volume). 0.5% of 100 USDT = 0.50 USDT. Without a working volume, the
// trade's own size stands in. null when the risk is unknown.
function riskUsd(riskPct, workingVolume, maxNotional) {
  var base = Number(workingVolume) > 0 ? Number(workingVolume) : Number(maxNotional);
  var r = base * Number(riskPct) / 100;
  return r > 0 ? r : null;
}

// R = PnL in units of 1R. +1.00 USDT with 1R = 0.50 USDT is +2R, whatever size
// you entered with. null when 1R is unknown.
function tradeR(pnlNet, oneR) {
  if (!(oneR > 0) || pnlNet == null || isNaN(pnlNet)) return null;
  return pnlNet / oneR;
}

// Your rules; a trade is "by the rules" when none is broken. Unknown → not counted.
var RULES = [
  ['planned', 'монета из брифинга'],
  ['stopHeld', 'стоп выдержан (убыток не больше 1R)'],
  ['size', 'объём в лимите'],
  ['noRevenge', 'без реванша после убытка'],
  ['noCrane', 'без входов после стоп-крана'],
  ['noSizeUp', 'без роста объёма после серии'],
];

// Keys of the rules this trade broke. x: { t: fact trade, tag, r }
function brokenRules(x) {
  var out = [];
  if (!x.t.planned) out.push('planned');
  if (x.r != null && x.r < -STOP_OVERRUN_R) out.push('stopHeld');
  if (x.t.oversize) out.push('size');
  if (x.t.revenge) out.push('noRevenge');
  if (x.t.afterCrane) out.push('noCrane');
  if (x.t.sizeUp) out.push('noSizeUp');
  return out;
}

// Expectancy of a list of R results: what one trade of this kind is worth on average
function setupStats(rs) {
  var wins = rs.filter(function (r) { return r > 0; }), losses = rs.filter(function (r) { return r <= 0; });
  var sum = function (a) { return a.reduce(function (s, v) { return s + v; }, 0); };
  var r2 = function (v) { return Math.round(v * 100) / 100; };
  return {
    n: rs.length,
    winRate: rs.length ? Math.round(wins.length / rs.length * 100) : 0,
    avgWinR: wins.length ? r2(sum(wins) / wins.length) : null,
    avgLossR: losses.length ? r2(sum(losses) / losses.length) : null,
    expectancyR: rs.length ? r2(sum(rs) / rs.length) : null,
    totalR: r2(sum(rs)),
  };
}

// Monday of the date's week (YYYY-MM-DD), for the weekly execution trend
function weekOf(date) {
  var d = new Date(date + 'T00:00:00Z');
  var dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
var EMOTION = { plan: 'Calm, by plan', fomo: 'FOMO', revenge: 'Revenge', boredom: 'Boredom', fear: 'Fear' };

function scaleBucket(v) {
  if (v == null || v === '') return 'not recorded';
  var n = Number(v);
  return n <= 2 ? 'low (1–2)' : n === 3 ? 'mid (3)' : 'high (4–5)';
}

function sleepBucket(h) {
  if (h == null || h === '') return 'not recorded';
  var n = Number(h);
  return n < 6 ? '< 6 h' : n < 7.5 ? '6–7.5 h' : '7.5 h +';
}

function hourBlock(h) {
  if (h == null) return 'unknown';
  var from = Math.floor(h / 4) * 4;
  return String(from).padStart(2, '0') + '–' + String(from + 4).padStart(2, '0');
}

// days: [{ date, facts, morning: { sleepHours, sleepQuality, energy, carryover, focus } }]
// tags: [{ symbol, close_time, setup, emotion }]
// The report's period: a preset (week / month / all) or explicit from–to
// (YYYY-MM-DD), never before `start` nor after `today`. → { from, to, preset }
var PERIOD_DAYS = { week: 7, month: 30 };
function edgePeriod(q, today, start) {
  var re = /^\d{4}-\d{2}-\d{2}$/;
  var clamp = function (d) { return d < start ? start : d > today ? today : d; };
  if (q && re.test(q.from || '') && re.test(q.to || '') && q.from <= q.to) {
    return { from: clamp(q.from), to: clamp(q.to), preset: null };
  }
  var preset = q && (PERIOD_DAYS[q.range] || q.range === 'all') ? q.range : 'all';
  if (preset === 'all') return { from: start, to: today, preset: 'all' };
  var d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - PERIOD_DAYS[preset] + 1);
  return { from: clamp(d.toISOString().slice(0, 10)), to: today, preset: preset };
}

// opts: { riskPct, workingVolume, setups } — risk per trade in % and the
// working volume in USDT (Account settings); the user's setups [{ key, name, exclude, archived }]. Trades tagged
// with an excluded setup (misclicks, tests) are left out of the whole report.
function computeEdge(days, tags, opts) {
  var riskPct = opts && opts.riskPct;
  var workingVolume = opts && opts.workingVolume;
  var setupList = (opts && opts.setups) || PATTERNS.map(function (k) { return { key: k, name: k }; });
  var excludedKeys = {};
  setupList.forEach(function (x) { if (x.exclude) excludedKeys[x.key] = true; });
  var excludedCount = 0;
  var trades = [];
  var used = new Set();
  (days || []).forEach(function (d) {
    if (!d.facts || !d.facts.trades) return;
    d.facts.trades.forEach(function (t) {
      if (t.result !== 'win' && t.result !== 'loss') return;
      // Nearest unused tag on the same symbol: scalps can close a second apart
      var best = null, bestD = Infinity;
      (tags || []).forEach(function (g, i) {
        if (used.has(i) || g.symbol !== t.symbol) return;
        var dt = Math.abs(g.close_time - t.closeTime);
        if (dt <= TAG_MATCH_MS && dt < bestD) { best = i; bestD = dt; }
      });
      if (best != null) used.add(best);
      var x = { date: d.date, t: t, tag: best != null ? tags[best] : null, m: d.morning || {} };
      if (x.tag && x.tag.pattern && excludedKeys[x.tag.pattern]) { excludedCount++; return; }
      x.r = tradeR(t.pnlNet, riskUsd(riskPct, workingVolume, t.maxNotional));
      x.broken = brokenRules(x);
      trades.push(x);
    });
  });

  function group(keyFn, order) {
    var map = {};
    trades.forEach(function (x) {
      var k = keyFn(x);
      if (k == null) return;
      var g = map[k] = map[k] || { key: k, n: 0, wins: 0, pnl: 0 };
      g.n++;
      if (x.t.result === 'win') g.wins++;
      g.pnl += x.t.pnlNet;
    });
    var rows = Object.keys(map).map(function (k) {
      var g = map[k];
      return {
        key: k, n: g.n, wins: g.wins,
        winRate: Math.round(g.wins / g.n * 100),
        pnl: Math.round(g.pnl * 100) / 100,
        avgPnl: Math.round(g.pnl / g.n * 10000) / 10000,
        enough: g.n >= MIN_N,
      };
    });
    if (order) rows.sort(function (a, b) { return order.indexOf(a.key) - order.indexOf(b.key); });
    else rows.sort(function (a, b) { return b.n - a.n; });
    return rows;
  }

  // Execution: share of trades by the rules, which rules break, by week
  var clean = trades.filter(function (x) { return !x.broken.length; });
  var weeks = {};
  trades.forEach(function (x) {
    var w = weeks[weekOf(x.date)] = weeks[weekOf(x.date)] || { week: weekOf(x.date), n: 0, clean: 0 };
    w.n++;
    if (!x.broken.length) w.clean++;
  });
  var execution = {
    n: trades.length,
    clean: clean.length,
    rate: trades.length ? Math.round(clean.length / trades.length * 100) : null,
    rules: RULES.map(function (r) {
      return { key: r[0], label: r[1], broken: trades.filter(function (x) { return x.broken.indexOf(r[0]) !== -1; }).length };
    }),
    weeks: Object.keys(weeks).sort().map(function (k) {
      var w = weeks[k];
      return { week: w.week, n: w.n, clean: w.clean, rate: Math.round(w.clean / w.n * 100) };
    }),
  };

  // Strategy: each setup on trades done by the rules (other than tagging), in R
  var byRules = trades.filter(function (x) {
    return x.r != null && !x.broken.length && x.tag && x.tag.pattern;
  });
  var setups = setupList.filter(function (p) { return !p.exclude; }).map(function (p) {
    var st = setupStats(byRules.filter(function (x) { return x.tag.pattern === p.key; }).map(function (x) { return x.r; }));
    // Every trade tagged with this setup (breaks included, marked) — for the review list
    var list = trades.filter(function (x) { return x.tag && x.tag.pattern === p.key; })
      .sort(function (a, b) { return (b.t.closeTime || 0) - (a.t.closeTime || 0); }).slice(0, 100)
      .map(function (x) {
        return { symbol: x.t.symbol, side: x.t.side, openTime: x.t.openTime, closeTime: x.t.closeTime,
          pnlNet: x.t.pnlNet, r: x.r == null ? null : Math.round(x.r * 100) / 100, broken: x.broken };
      });
    return Object.assign({ key: p.key, name: p.name, archived: !!p.archived, enough: st.n >= MIN_N, trades: list }, st);
  }).filter(function (p) { return !p.archived || p.n > 0 || p.trades.length; }); // a hidden setup still shows while it has trades
  var allByRules = Object.assign({ key: 'all', enough: byRules.length >= MIN_N }, setupStats(byRules.map(function (x) { return x.r; })));
  // Everything you actually traded, breaks included — the real result in R —
  // and what the trades with breaks cost on their own
  var withR = trades.filter(function (x) { return x.r != null; });
  var allTrades = Object.assign({ key: 'everything' }, setupStats(withR.map(function (x) { return x.r; })));
  var breaksR = withR.filter(function (x) { return x.broken.length; }).reduce(function (sum, x) { return sum + x.r; }, 0);

  var flagOrder = ['clean', 'revenge (≤5 min after a loss)', 'size-up after a streak', 'after stop-crane', 'over volume limit'];
  return {
    minN: MIN_N,
    riskPct: riskPct || null,
    workingVolume: workingVolume || null,
    oneR: riskUsd(riskPct, workingVolume, null),
    execution: execution,
    setups: setups,
    setupsAll: allByRules,
    allTrades: allTrades,
    breaksCostR: Math.round(breaksR * 100) / 100,
    dates: days.filter(function (d) { return d.facts && d.facts.trades; }).map(function (d) { return d.date; }),
    excluded: excludedCount,
    noPattern: trades.filter(function (x) { return !x.tag || !x.tag.pattern; }).length,
    // Trades still waiting for a setup type, newest first — tagged right in the report
    untagged: trades.filter(function (x) { return x.t.closeTime && (!x.tag || !x.tag.pattern); })
      .sort(function (a, b) { return b.t.closeTime - a.t.closeTime; }).slice(0, 50)
      .map(function (x) {
        return { symbol: x.t.symbol, side: x.t.side, openTime: x.t.openTime, closeTime: x.t.closeTime,
          pnlNet: x.t.pnlNet, r: x.r == null ? null : Math.round(x.r * 100) / 100, broken: x.broken };
      }),
    total: group(function () { return 'all trades'; })[0] || { key: 'all trades', n: 0 },
    tagged: trades.filter(function (x) { return x.tag; }).length,
    groups: {
      setup: group(function (x) { return x.tag && x.tag.setup ? SETUP[x.tag.setup] || x.tag.setup : 'not tagged'; }, ['A setup', 'B setup', 'C setup', 'not tagged']),
      emotion: group(function (x) { return x.tag && x.tag.emotion ? EMOTION[x.tag.emotion] || x.tag.emotion : 'not tagged'; }, ['Calm, by plan', 'FOMO', 'Revenge', 'Boredom', 'Fear', 'not tagged']),
      plan: group(function (x) { return x.t.planned ? 'in briefing' : 'outside briefing'; }, ['in briefing', 'outside briefing']),
      level: group(function (x) { return x.t.atLevel === true ? 'at a signal level' : x.t.atLevel === false ? 'away from levels' : 'no levels set'; }, ['at a signal level', 'away from levels', 'no levels set']),
      flags: group(function (x) {
        if (x.t.afterCrane) return 'after stop-crane';
        if (x.t.revenge) return 'revenge (≤5 min after a loss)';
        if (x.t.sizeUp) return 'size-up after a streak';
        if (x.t.oversize) return 'over volume limit';
        return 'clean';
      }, flagOrder),
      hour: group(function (x) { return hourBlock(x.t.hour); }),
      sleep: group(function (x) { return sleepBucket(x.m.sleepHours); }, ['< 6 h', '6–7.5 h', '7.5 h +', 'not recorded']),
      sleepQuality: group(function (x) { return scaleBucket(x.m.sleepQuality); }, ['low (1–2)', 'mid (3)', 'high (4–5)', 'not recorded']),
      energy: group(function (x) { return scaleBucket(x.m.energy); }, ['low (1–2)', 'mid (3)', 'high (4–5)', 'not recorded']),
      carryover: group(function (x) { return scaleBucket(x.m.carryover); }, ['low (1–2)', 'mid (3)', 'high (4–5)', 'not recorded']),
      focus: group(function (x) { return scaleBucket(x.m.focus); }, ['low (1–2)', 'mid (3)', 'high (4–5)', 'not recorded']),
    },
  };
}

module.exports = { computeEdge, edgePeriod, tradeR, riskUsd, brokenRules, setupStats, weekOf, MIN_N, TAG_MATCH_MS, SETUP, EMOTION, PATTERNS, RULES, STOP_OVERRUN_R };
