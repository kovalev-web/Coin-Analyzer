// Numbers and words for the journal page

export const JOURNAL_START = '2026-10-28';

export function money(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2); }
export function rr(n) { return n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + 'R'; }
export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
}
export function trades(n) { return n + ' ' + plural(n, 'сделка', 'сделки', 'сделок'); }
export function shortDate(iso) { return iso.slice(8, 10) + '.' + iso.slice(5, 7); }
export function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
export function tone(n) { return n > 0 ? 'text-bullish' : n < 0 ? 'text-danger' : ''; }
export function rateTone(rate) { return rate == null ? '' : rate >= 80 ? 'text-bullish' : rate >= 50 ? '' : 'text-danger'; }

// What each rule checks (thresholds as in journal/facts.js and journal/edge.js)
export const RULES_HELP = 'Доля сделок, где не нарушено ни одно правило:\n\n'
  + '• Монета не из брифинга — монеты не было в брифинге (звёздочка) в день входа.\n'
  + '• Стоп не выдержан — убыток больше 1.2R (1R = рабочий объём × % риска).\n'
  + '• Превышение объёма — позиция в сделке больше рабочего объёма из настроек больше чем на 5%.\n'
  + '• Реванш после убытка — вход в течение 5 минут после убыточной сделки. Выход в пределах ±0.1R — ноль, не убыток.\n'
  + '• Вход после стоп-крана — вход после двух убыточных сделок подряд за день (нули не считаются).\n'
  + '• Рост объёма после серии — позиция больше 1.5× обычной за день (медиана прошлых сделок) после двух одинаковых исходов подряд.\n\n'
  + 'Отметка сетапа — не правило: на процент не влияет.';

// Rule breaks named as what happened (the server sends rule keys)
export const BREAK_LABEL = {
  planned: 'Монета не из брифинга',
  stopHeld: 'Стоп не выдержан (убыток больше 1R)',
  size: 'Превышение объёма',
  noRevenge: 'Реванш после убытка',
  noCrane: 'Вход после стоп-крана',
  noSizeUp: 'Рост объёма после серии',
};

export const QUALITY = [['A', 'A'], ['B', 'B'], ['C', 'C']];
export const EMOTIONS = [['plan', 'По плану'], ['fomo', 'FOMO'], ['revenge', 'Отыграться'], ['boredom', 'Скука'], ['fear', 'Страх']];

export const EXPORT_RANGES = [
  ['1w', '1 неделя'], ['2w', '2 недели'], ['1m', '1 месяц'], ['2m', '2 месяца'],
  ['3m', '3 месяца'], ['6m', '6 месяцев'], ['all', 'Всё время'],
];
