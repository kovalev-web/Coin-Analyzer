'use strict';
// When each coin was in the day's briefing. The briefing itself is the list
// the page saves (Redis `briefing:<user>`, entries { sym, date, addedAt, auto });
// removing a star deletes the entry, so the server keeps a log of spans
// (`briefing_log:<user>`: { date: { SYMUSDT: [[on, off | null], ...] } }) built
// by diffing every save. A trade is planned when its coin was in the briefing
// at the moment of entry (journal/facts.js); the ladder only opens entries on
// coins in today's briefing (server-vps.js). Tests: npm run test:journal

var KEEP_DAYS = 60;

function futSym(sym) { return String(sym).toUpperCase() + 'USDT'; }

// { SYMUSDT: entry } of the coins in the briefing on `date` (auto entries don't count)
function dayCoins(entries, date) {
  var out = {};
  (entries || []).forEach(function (e) {
    if (e && !e.auto && e.date === date && e.sym) out[futSym(e.sym)] = e;
  });
  return out;
}

function datesOf(entries) {
  var d = {};
  (entries || []).forEach(function (e) { if (e && e.date) d[e.date] = true; });
  return d;
}

function openSpan(spans) {
  for (var i = spans.length - 1; i >= 0; i--) if (spans[i][1] == null) return spans[i];
  return null;
}

// The log after a save: coins that appeared open a span (from their addedAt,
// never later than now), coins that disappeared close theirs at `now`.
function updateBriefingLog(log, prevEntries, nextEntries, now) {
  var out = JSON.parse(JSON.stringify(log || {}));
  var dates = Object.assign(datesOf(prevEntries), datesOf(nextEntries));
  Object.keys(dates).forEach(function (date) {
    var before = dayCoins(prevEntries, date), after = dayCoins(nextEntries, date);
    var day = out[date] || {};
    Object.keys(after).forEach(function (s) {
      var spans = day[s] || (day[s] = []);
      if (openSpan(spans)) return;
      var at = Number(after[s].addedAt) || now;
      var last = spans.length ? spans[spans.length - 1][1] : null;
      // A re-add starts no earlier than the previous removal
      spans.push([Math.max(Math.min(at, now), last || 0), null]);
    });
    Object.keys(before).forEach(function (s) {
      if (after[s]) return;
      var spans = day[s] || (day[s] = []);
      var open = openSpan(spans);
      if (open) open[1] = now;
      else if (!spans.length) spans.push([Number(before[s].addedAt) || 0, now]); // in the briefing before the log existed
    });
    if (Object.keys(day).length) out[date] = day;
  });
  return out;
}

// Drop days older than KEEP_DAYS before `today` (YYYY-MM-DD)
function pruneLog(log, today) {
  var t = new Date(today + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() - KEEP_DAYS);
  var from = t.toISOString().slice(0, 10), out = {};
  Object.keys(log || {}).forEach(function (d) { if (d >= from) out[d] = log[d]; });
  return out;
}

// { SYMUSDT: [[on, off | null]] } for `date`: the log, plus coins in the
// briefing that the log doesn't know as present (saved before it existed)
function briefingSpans(log, entries, date) {
  var day = (log && log[date]) || {}, out = {};
  Object.keys(day).forEach(function (s) { out[s] = day[s].map(function (x) { return x.slice(); }); });
  var now = dayCoins(entries, date);
  Object.keys(now).forEach(function (s) {
    var spans = out[s] || (out[s] = []);
    if (!openSpan(spans)) spans.push([Number(now[s].addedAt) || 0, null]);
  });
  return out;
}

// Was the coin in the briefing at time t?
function inBriefingAt(spans, symbol, t) {
  var list = (spans || {})[symbol] || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i][0] <= t && (list[i][1] == null || t < list[i][1])) return true;
  }
  return false;
}

module.exports = { dayCoins, updateBriefingLog, pruneLog, briefingSpans, inBriefingAt, futSym };
