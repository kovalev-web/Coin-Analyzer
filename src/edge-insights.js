// ── "My edge" conclusions ───────────────────────────────────────────────────
// Turns the grouped report (journal/edge.js, GET /api/journal/edge) into what a
// trader reads first: what makes money, what costs money and what to do about
// it. Ranked by money impact, not win rate. Used by src/edge-view.js.
// Tests: npm run test:insights

export var DIMENSIONS = {
  setup: 'Качество сетапа',
  emotion: 'Эмоция входа',
  flags: 'Нарушения',
  plan: 'План брифинга',
  level: 'Уровень',
  hour: 'Время дня',
  sleep: 'Сон',
  sleepQuality: 'Качество сна',
  energy: 'Энергия',
  carryover: 'Груз вчерашнего',
  focus: 'Фокус',
};

// Group names come from the server in English (journal/edge.js) — shown in Russian
var KEY_RU = {
  'A setup': 'A-сетап', 'B setup': 'B-сетап', 'C setup': 'C-сетап', 'not tagged': 'без пометки',
  'Calm, by plan': 'спокойно, по плану', FOMO: 'FOMO', Revenge: 'отыграться', Boredom: 'скука', Fear: 'страх',
  clean: 'без нарушений', 'revenge (≤5 min after a loss)': 'реванш (≤5 мин после убытка)',
  'size-up after a streak': 'объём вырос после серии', 'after stop-crane': 'после стоп-крана', 'over volume limit': 'сверх лимита объёма',
  'in briefing': 'из брифинга', 'outside briefing': 'вне брифинга',
  'at a signal level': 'у уровня', 'away from levels': 'вдали от уровней', 'no levels set': 'уровней нет',
  'low (1–2)': 'низкая (1–2)', 'mid (3)': 'средняя (3)', 'high (4–5)': 'высокая (4–5)', 'not recorded': 'не записано',
  '< 6 h': '< 6 ч', '6–7.5 h': '6–7.5 ч', '7.5 h +': '7.5 ч +', unknown: 'неизвестно',
};
export function keyRu(key) { return KEY_RU[key] || key; }
// Same, capitalized — for a row label
export function keyLabel(key) { var k = keyRu(key); return k.charAt(0).toUpperCase() + k.slice(1); }

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
    if (key === 'not tagged') return 'Ставь пометку сразу после выхода — без неё не видно, откуда убытки';
    return good ? 'Это твой edge — ищи именно такие входы' : 'Пропускай ' + keyRu(key) + 'ы или торгуй их половинным объёмом';
  }
  if (dim === 'emotion') {
    if (key === 'not tagged') return 'Ставь пометку сразу после выхода';
    return good ? 'Входи только по своему плану' : 'Почувствовал «' + keyRu(key) + '» — 5 минут без входов';
  }
  if (dim === 'flags') {
    if (key === 'clean') return good ? 'Правила работают — держись их' : 'Даже без нарушений в минусе — дело в самих сетапах';
    if (/revenge/.test(key)) return 'После убытка — 5 минут без новых входов';
    if (/size-up/.test(key)) return 'Не увеличивай объём после серии';
    if (/stop-crane/.test(key)) return 'Стоп-кран — значит, день закончен';
    if (/volume/.test(key)) return 'Держись лимита объёма';
  }
  if (dim === 'plan') return key === 'in briefing' ? (good ? 'Монеты из брифинга работают — торгуй их' : 'Монеты из брифинга в минусе — пересмотри, как выбираешь') : 'Торгуй только монеты из брифинга';
  if (dim === 'level') return 'Входи от своих уровней';
  if (dim === 'hour') return good ? 'Твоё лучшее окно ' + key + ' — основной объём здесь' : 'Сократи объём или не торгуй ' + key;
  var what = (DIMENSIONS[dim] || dim).toLowerCase() + ': ' + keyRu(key);
  return good ? 'Лучше всего торгуешь, когда ' + what : 'В дни, когда ' + what + ', — меньше объём';
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
