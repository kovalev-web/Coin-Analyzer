// ── "Мой edge" labels ───────────────────────────────────────────────────────
// Russian names for the report's dimensions and the group keys the server
// sends in English (journal/edge.js). Used by src/journal-app (EdgeSummary.jsx).
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

// ── Conclusions from the groups ─────────────────────────────────────────────
// A dimension says something when trades fall into 2+ known groups with at
// least MIN_GROUP trades each, and the best and worst differ by at least
// MIN_GAP_R per trade. Rule breaks are left out — the execution panel has them.

var MIN_GROUP = 2;
var MIN_GAP_R = 0.3;
var UNKNOWN = { 'not recorded': true, unknown: true, 'no levels set': true };
var SKIP = { flags: true };

// One conclusion per dimension: { dim, title, best, worst, gapR, early, weight }
// best / worst: { key, label, n, avgR }. oneR: 1R in USDT (groups carry USDT).
// Order: reliable ones first (both groups ≥ minN trades) by gap; then early ones
// by gap × how close the smaller group is to minN, so a big gap on 2 trades
// doesn't push out a solid one on 100. At most `limit`.
export function conclusions(groups, oneR, minN, limit) {
  if (!groups || !(oneR > 0)) return [];
  var out = [];
  Object.keys(DIMENSIONS).forEach(function (dim) {
    if (SKIP[dim] || !groups[dim]) return;
    var rows = groups[dim].filter(function (r) { return !UNKNOWN[r.key] && r.n >= MIN_GROUP; })
      .map(function (r) { return { key: r.key, label: keyLabel(r.key), n: r.n, avgR: Math.round(r.avgPnl / oneR * 100) / 100 }; });
    if (rows.length < 2) return;
    rows.sort(function (a, b) { return b.avgR - a.avgR; });
    var best = rows[0], worst = rows[rows.length - 1];
    var gap = Math.round((best.avgR - worst.avgR) * 100) / 100;
    if (gap < MIN_GAP_R) return;
    var need = minN || 20;
    var weight = Math.min(1, Math.min(best.n, worst.n) / need);
    out.push({ dim: dim, title: DIMENSIONS[dim], best: best, worst: worst, gapR: gap, early: weight < 1, weight: weight });
  });
  return out.sort(function (a, b) {
    if (a.early !== b.early) return a.early ? 1 : -1;
    return b.gapR * b.weight - a.gapR * a.weight;
  }).slice(0, limit || 4);
}
