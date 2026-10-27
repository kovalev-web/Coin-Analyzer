// ── "My edge" conclusions ───────────────────────────────────────────────────
// Turns the grouped report (journal/edge.js, GET /api/journal/edge) into what a
// trader reads first: what makes money, what costs money and what to do about
// it. Ranked by money impact, not win rate. Used by src/edge-view.js.
// Tests: npm run test:insights

export var DIMENSIONS = {
  setup: 'Setup quality',
  emotion: 'What drove the entry',
  flags: 'Rule breaks',
  plan: 'Briefing plan',
  level: 'Signal level',
  hour: 'Time of day',
  sleep: 'Sleep',
  sleepQuality: 'Sleep quality',
  energy: 'Energy',
  carryover: 'Carrying yesterday',
  focus: 'Focus',
};

// Groups that say "we don't know" — never a conclusion on their own
var UNKNOWN = { 'not recorded': true, unknown: true, 'no levels set': true };

// What a group did beyond your average trade, in money: (its average − your
// average) × its trades. +0.85 = it earned 0.85 more than the same number of
// your average trades would have. Sums to ~0 over a dimension.
export function impact(group, overallAvg) {
  if (!group || !(group.n > 0)) return 0;
  return (group.avgPnl - (overallAvg || 0)) * group.n;
}

// A dimension says something only when trades fall into 2+ known groups
export function comparable(rows) {
  var known = (rows || []).filter(function (r) { return r.n > 0 && !UNKNOWN[r.key]; });
  return known.length >= 2;
}

// One line of advice per finding
export function advice(dim, key, good) {
  if (dim === 'setup') {
    if (key === 'not tagged') return 'Tag every trade right after it closes — untagged trades hide where the losses come from';
    return good ? 'This is your edge — look for exactly these entries' : 'Skip ' + key + 's or trade them at half size';
  }
  if (dim === 'emotion') {
    if (key === 'not tagged') return 'Tag every trade right after it closes';
    return good ? 'Only enter when it is in your plan' : 'When you feel ' + key.toLowerCase() + ', take your hands off the order book for 5 minutes';
  }
  if (dim === 'flags') {
    if (key === 'clean') return good ? 'Your rules work — keep them' : 'Even clean trades lose — the setups themselves need work';
    if (/revenge/.test(key)) return 'After a loss: 5 minutes without new entries';
    if (/size-up/.test(key)) return 'Keep the size the same after a winning streak';
    if (/stop-crane/.test(key)) return 'Stop-crane means the day is over';
    if (/volume/.test(key)) return 'Stay within your volume limit';
  }
  if (dim === 'plan') return key === 'in briefing' ? (good ? 'Your briefing picks work — trade from it' : 'Your briefing picks lose — review how you pick coins') : 'Trade only coins from your briefing';
  if (dim === 'level') return key === 'at a signal level' ? 'Enter at your levels' : 'Enter at your levels, not away from them';
  if (dim === 'hour') return good ? 'Your best window is ' + key + ' — trade your main size here' : 'Cut size or skip ' + key;
  var what = (DIMENSIONS[dim] || dim).toLowerCase() + ' ' + key;
  return good ? 'You trade best with ' + what : 'On days with ' + what + ' — trade smaller';
}

// edge: { total: {n, avgPnl, ...}, groups: {dim: rows}, minN }
// → { works: [...], costs: [...], flat: [dim titles], sample: {n, minN, ratio, early} }
// works / costs: up to `limit` findings, biggest money impact first; a finding
// is { dim, title, key, n, winRate, pnl, avgPnl, impact, advice }
export function insights(edge, limit) {
  limit = limit || 3;
  var total = (edge && edge.total) || { n: 0, avgPnl: 0 };
  var overall = total.n ? total.avgPnl : 0;
  var minN = (edge && edge.minN) || 20;
  var all = [], flat = [];
  Object.keys(DIMENSIONS).forEach(function (dim) {
    var rows = edge && edge.groups && edge.groups[dim];
    if (!rows || !rows.length) return;
    if (!comparable(rows)) { flat.push(DIMENSIONS[dim]); return; }
    rows.forEach(function (r) {
      if (UNKNOWN[r.key] || !(r.n > 0)) return;
      all.push({
        dim: dim, title: DIMENSIONS[dim], key: r.key, n: r.n, winRate: r.winRate,
        pnl: r.pnl, avgPnl: r.avgPnl, impact: Math.round(impact(r, overall) * 100) / 100,
      });
    });
  });
  // The same trades seen through two dimensions (an untagged trade is "not
  // tagged" for both setup and emotion) count once
  var seen = {};
  all = all.filter(function (f) {
    var k = f.key + '|' + f.n + '|' + f.pnl;
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
  // Works: earns money and beats your average; costs: loses money and drags it down
  var works = all.filter(function (f) { return f.pnl > 0 && f.impact > 0; })
    .sort(function (a, b) { return b.impact - a.impact; }).slice(0, limit);
  var costs = all.filter(function (f) { return f.pnl < 0 && f.impact < 0; })
    .sort(function (a, b) { return a.impact - b.impact; }).slice(0, limit);
  works.forEach(function (f) { f.advice = advice(f.dim, f.key, true); });
  costs.forEach(function (f) { f.advice = advice(f.dim, f.key, false); });
  return {
    works: works, costs: costs, flat: flat,
    sample: { n: total.n, minN: minN, ratio: Math.min(1, total.n / minN), early: total.n < minN },
  };
}
