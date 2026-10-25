'use strict';

// "My edge" report: closed trades from saved day facts, joined with the
// per-trade tag (setup A/B/C, what drove the entry) and that morning's state,
// grouped so you can see where results come from. Every group carries n;
// groups under MIN_N are flagged as not enough data.

var MIN_N = 20;
var TAG_MATCH_MS = 2000; // tag close_time vs fact closeTime (both are the exchange fill time)

var SETUP = { A: 'A setup', B: 'B setup', C: 'C setup' };
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
function computeEdge(days, tags) {
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
      trades.push({ date: d.date, t: t, tag: best != null ? tags[best] : null, m: d.morning || {} });
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

  var flagOrder = ['clean', 'revenge (≤5 min after a loss)', 'size-up after a streak', 'after stop-crane', 'over volume limit'];
  return {
    minN: MIN_N,
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

module.exports = { computeEdge, MIN_N, TAG_MATCH_MS, SETUP, EMOTION };
