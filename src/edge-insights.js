// ── "Мой edge" labels ───────────────────────────────────────────────────────
// Russian names for the report's dimensions and the group keys the server
// sends in English (journal/edge.js). Used by src/edge-view.js.
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
