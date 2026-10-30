'use strict';

// Day facts for the journal, computed from exchange fills — never typed in.
// The evening card shows them read-only; the AI report and the edge stats
// read them instead of self-reported numbers. Definitions live in
// docs/TRADER_EDGE.md; keep the two in sync.

var { inBriefingAt } = require('./briefing');

var FACTS_VERSION = 3; // 2: exits within ±SCRATCH_R are neither wins nor losses for the rules; 3: trades keep their fills
var MAX_TRADE_FILLS = 60;              // fills kept per trade (for its chart)
var REVENGE_WINDOW_MS = 5 * 60 * 1000;   // entry this soon after a losing trade closed
var SIZE_UP_FACTOR = 1.5;                // size vs median of the day's earlier trades
var SCRATCH_R = 0.1;                     // |result| up to this share of 1R = a scratch (out at about zero)

// A closed trade's outcome for the rules: a scratch (out at about zero, fees
// only) is neither — re-entering after it is not revenge, it doesn't feed the
// stop-crane streak. scratchUsd: SCRATCH_R of 1R in USDT (0 = any minus is a loss).
function outcome(net, scratchUsd) {
  var band = scratchUsd > 0 ? scratchUsd : 0;
  return net > band ? 'win' : net < -band ? 'loss' : 'scratch';
}
var LEVEL_PROXIMITY_PCT = 0.5;           // entry within this % of a signal (alert) level
var OVERSIZE_TOLERANCE = 1.05;           // 5% over the volume limit still counts as ok
var EPS = 1e-9;

// Round trips (flat → position → flat) per symbol from Binance userTrades fills.
// One-way mode: a fill that crosses zero closes one trip and opens the next.
function buildTrips(fills) {
  var bySym = {};
  fills.forEach(function (f) { (bySym[f.symbol] = bySym[f.symbol] || []).push(f); });
  var trips = [];
  Object.keys(bySym).forEach(function (sym) {
    var list = bySym[sym].slice().sort(function (a, b) { return a.time - b.time || a.id - b.id; });
    var pos = 0, trip = null;
    list.forEach(function (f) {
      var qty = Number(f.qty), signed = f.side === 'BUY' ? qty : -qty;
      var price = Number(f.price);
      var fee = f.commissionAsset === 'USDT' || !f.commissionAsset ? Number(f.commission || 0) : 0;
      var pnl = Number(f.realizedPnl || 0);
      if (!trip) {
        trip = { symbol: sym, side: signed > 0 ? 'long' : 'short', openTime: f.time, closeTime: null, pnl: 0, fees: 0, fills: 0, maxNotional: 0, entryPrice: price, execs: [] };
      }
      // Each fill as the trade's chart draws it: time, price, qty, side (a flip splits its qty)
      var exec = function (t, q) { if (t.execs.length < MAX_TRADE_FILLS) t.execs.push({ t: f.time, p: price, q: q, s: f.side }); };
      // A fill that flips the position: split it into the closing and the opening part
      if (Math.abs(pos) > EPS && Math.sign(pos + signed) !== Math.sign(pos) && Math.abs(pos + signed) > EPS) {
        var closeShare = Math.abs(pos) / qty;
        exec(trip, Math.abs(pos));
        trip.pnl += pnl; trip.fees += fee * closeShare; trip.fills++;
        trip.closeTime = f.time;
        trips.push(trip);
        pos += signed;
        trip = { symbol: sym, side: pos > 0 ? 'long' : 'short', openTime: f.time, closeTime: null, pnl: 0, fees: fee * (1 - closeShare), fills: 1, maxNotional: Math.abs(pos) * price, entryPrice: price, execs: [] };
        exec(trip, Math.abs(pos));
        return;
      }
      exec(trip, qty);
      pos += signed;
      trip.pnl += pnl; trip.fees += fee; trip.fills++;
      trip.maxNotional = Math.max(trip.maxNotional, Math.abs(pos) * price);
      if (Math.abs(pos) < EPS) {
        trip.closeTime = f.time;
        trips.push(trip);
        trip = null;
        pos = 0;
      }
    });
    if (trip) trips.push(trip); // still open
  });
  return trips.sort(function (a, b) { return a.openTime - b.openTime; });
}

function median(xs) {
  if (!xs.length) return null;
  var s = xs.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function hourIn(tz, ms) {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour: '2-digit', hour12: false }).format(new Date(ms))) % 24;
  } catch (e) { return new Date(ms).getUTCHours(); }
}

// opts: { fills, dayStart, dayEnd, date, tz, limits: {maxVolume, maxTrades},
//         briefingSpans: { JCTUSDT: [[on, off | null], ...] } (journal/briefing.js) or
//         briefingSyms: ['JCTUSDT', ...] (in the briefing all day), levelsBySym: { JCTUSDT: [price, ...] } }
function computeDayFacts(opts) {
  var limits = opts.limits || {};
  // 1R = working volume × risk % (Account settings); a scratch is within ±SCRATCH_R of it
  var scratchUsd = limits.maxVolume > 0 && limits.riskPct > 0 ? limits.maxVolume * limits.riskPct / 100 * SCRATCH_R : 0;
  var planned = {};
  (opts.briefingSyms || []).forEach(function (s) { planned[String(s).toUpperCase()] = true; });
  var levels = opts.levelsBySym || {};

  // Trips opened today (fills from before the day only seed the running position)
  var all = buildTrips(opts.fills || []);
  var day = all.filter(function (t) { return t.openTime >= opts.dayStart && t.openTime < opts.dayEnd; });

  var trades = [];
  var craneAt = null, afterCrane = 0;
  day.forEach(function (t) {
    // Closed trades that finished before this one opened
    var before = day.filter(function (o) { return o.closeTime != null && o.closeTime <= t.openTime && o !== t; })
      .sort(function (a, b) { return a.closeTime - b.closeTime; });
    var prevResults = before.map(function (o) { return outcome(o.pnl - o.fees, scratchUsd); })
      .filter(function (r) { return r !== 'scratch'; });
    var last2 = prevResults.slice(-2);
    var lastLoss = before.filter(function (o) { return outcome(o.pnl - o.fees, scratchUsd) === 'loss'; }).slice(-1)[0];
    var sizes = before.map(function (o) { return o.maxNotional; });
    var med = median(sizes);

    // Stop-crane: two losing trades in a row closes the day
    var streak = 0;
    for (var i = prevResults.length - 1; i >= 0 && prevResults[i] === 'loss'; i--) streak++;
    var brokeCrane = streak >= 2;
    if (brokeCrane && craneAt == null) craneAt = t.openTime;
    if (brokeCrane) afterCrane++;

    var lv = levels[t.symbol] || [];
    var nearest = null;
    lv.forEach(function (p) {
      var d = Math.abs(t.entryPrice - p) / p * 100;
      if (nearest == null || d < nearest) nearest = d;
    });

    var net = t.pnl - t.fees;
    trades.push({
      symbol: t.symbol,
      side: t.side,
      execs: t.execs || [],          // the fills themselves (t, p, q, s), for the trade chart
      openTime: t.openTime,
      closeTime: t.closeTime,
      holdSec: t.closeTime ? Math.round((t.closeTime - t.openTime) / 1000) : null,
      hour: hourIn(opts.tz, t.openTime),
      maxNotional: Math.round(t.maxNotional * 100) / 100,
      pnlNet: Math.round(net * 10000) / 10000,
      fees: Math.round(t.fees * 10000) / 10000,
      fills: t.fills,
      result: t.closeTime == null ? 'open' : net > 0 ? 'win' : 'loss',
      planned: opts.briefingSpans ? inBriefingAt(opts.briefingSpans, t.symbol, t.openTime) : !!planned[t.symbol],
      atLevel: lv.length ? nearest <= LEVEL_PROXIMITY_PCT : null,
      oversize: limits.maxVolume > 0 ? t.maxNotional > limits.maxVolume * OVERSIZE_TOLERANCE : null,
      revenge: !!(lastLoss && t.openTime - lastLoss.closeTime <= REVENGE_WINDOW_MS),
      sizeUp: med && t.maxNotional > med * SIZE_UP_FACTOR && last2.length === 2 && last2[0] === last2[1]
        ? (last2[0] === 'win' ? 'after_wins' : 'after_losses') : null,
      afterCrane: brokeCrane,
    });
  });

  var closed = trades.filter(function (t) { return t.result !== 'open'; });
  var wins = closed.filter(function (t) { return t.result === 'win'; }).length;
  var pnlNet = closed.reduce(function (s, t) { return s + t.pnlNet; }, 0);
  var fees = trades.reduce(function (s, t) { return s + t.fees; }, 0);
  var holds = closed.map(function (t) { return t.holdSec; });
  function count(pred) { return trades.filter(pred).length; }

  return {
    version: FACTS_VERSION,
    date: opts.date,
    summary: {
      trades: closed.length,
      open: trades.length - closed.length,
      wins: wins,
      losses: closed.length - wins,
      winRate: closed.length ? Math.round(wins / closed.length * 100) : null,
      pnlNet: Math.round(pnlNet * 100) / 100,
      fees: Math.round(fees * 100) / 100,
      avgHoldSec: holds.length ? Math.round(holds.reduce(function (s, h) { return s + h; }, 0) / holds.length) : null,
    },
    violations: {
      craneBrokenAt: craneAt,
      tradesAfterCrane: afterCrane,
      overMaxTrades: limits.maxTrades > 0 ? trades.length > limits.maxTrades : null,
      oversize: count(function (t) { return t.oversize === true; }),
      revenge: count(function (t) { return t.revenge; }),
      sizeUpAfterLosses: count(function (t) { return t.sizeUp === 'after_losses'; }),
      sizeUpAfterWins: count(function (t) { return t.sizeUp === 'after_wins'; }),
      offPlan: count(function (t) { return !t.planned; }),
    },
    limits: { maxVolume: limits.maxVolume || null, maxTrades: limits.maxTrades || null },
    trades: trades,
  };
}

// UTC ms of local midnight for YYYY-MM-DD in an IANA zone (or fixed hour offset)
function zonedDayStart(dateStr, tz, offsetHours) {
  var p = dateStr.split('-').map(Number);
  var guess = Date.UTC(p[0], p[1] - 1, p[2]);
  if (!tz) return guess - (offsetHours || 0) * 3600000;
  function offsetAt(ms) {
    var parts = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .formatToParts(new Date(ms)).forEach(function (x) { parts[x.type] = x.value; });
    var wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    return wall - ms;
  }
  var start = guess - offsetAt(guess);
  return guess - offsetAt(start); // second pass handles DST edges
}

module.exports = {
  computeDayFacts, buildTrips, zonedDayStart,
  REVENGE_WINDOW_MS, SIZE_UP_FACTOR, LEVEL_PROXIMITY_PCT, FACTS_VERSION, SCRATCH_R, outcome,
};
