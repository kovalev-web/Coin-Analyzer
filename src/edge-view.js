// ── "My edge" section on the journal page (journal stage 5) ─────────────────
// Reads top-down: the result, how much data there is, what makes money, what
// costs money (each with what to do), dimensions with nothing to compare yet,
// and the full tables folded at the bottom. Conclusions: src/edge-insights.js.

import { fetchJournalEdge } from './api.js';
import { insights, keyLabel, DIMENSIONS } from './edge-insights.js';

var RANGES = [['1m', '1 мес'], ['3m', '3 мес'], ['6m', '6 мес'], ['all', 'Всё']];
var SECTIONS = Object.keys(DIMENSIONS).map(function (k) { return [k, DIMENSIONS[k]]; });

var _range = '3m';

function money(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2); }

function plural(n, one, few, many) {
  var m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
}

// Findings as one plain table: what, how it went, effect, what to do
function findingsHTML(title, list, good, empty) {
  if (!list.length) return '<h4 class="edge-h">' + title + '</h4><div class="edge-empty">' + empty + '</div>';
  return '<h4 class="edge-h">' + title + '</h4><table class="edge-list"><thead><tr>'
    + '<th>Что</th><th>Сделок</th><th>В плюс</th><th>Итог, USDT</th><th title="Сколько принесло или унесло сверх того же числа твоих средних сделок">Влияние</th><th>Что делать</th>'
    + '</tr></thead><tbody>' + list.map(function (f) {
      return '<tr><td><b>' + keyLabel(f.key) + '</b><span>' + f.title + '</span></td>'
        + '<td>' + f.n + '</td><td>' + f.winRate + '%</td>'
        + '<td class="' + (f.pnl >= 0 ? 'up' : 'dn') + '">' + money(f.pnl) + '</td>'
        + '<td class="' + (good ? 'up' : 'dn') + '"><b>' + money(f.impact) + '</b></td>'
        + '<td>' + f.advice + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function tableHTML(rows) {
  if (!rows || !rows.length) return '<div class="edge-empty">Сделок нет</div>';
  return '<table class="edge-table"><thead><tr><th></th><th>Сделок</th><th>В плюс</th><th>Итог</th><th>Средняя</th></tr></thead><tbody>'
    + rows.map(function (r) {
        return '<tr class="' + (r.enough ? '' : 'thin') + '"><td>' + keyLabel(r.key) + '</td><td>' + r.n + '</td><td>' + r.winRate + '%</td>'
          + '<td class="' + (r.pnl >= 0 ? 'up' : 'dn') + '">' + money(r.pnl) + '</td>'
          + '<td class="' + (r.avgPnl >= 0 ? 'up' : 'dn') + '">' + money(r.avgPnl) + '</td></tr>';
      }).join('')
    + '</tbody></table>';
}

export function renderEdgeSection(container) {
  if (!container) return;
  container.innerHTML = '<div class="edge-section"><div class="edge-head"><h3>Мой edge</h3><div class="edge-ranges">'
    + RANGES.map(function (r) { return '<button data-edge-range="' + r[0] + '" class="' + (r[0] === _range ? 'active' : '') + '">' + r[1] + '</button>'; }).join('')
    + '</div></div><div class="edge-body"><span class="big-spinner"></span></div></div>';
  container.querySelectorAll('[data-edge-range]').forEach(function (b) {
    b.onclick = function () { _range = b.dataset.edgeRange; renderEdgeSection(container); };
  });
  fetchJournalEdge(_range).then(function (e) {
    var body = container.querySelector('.edge-body');
    if (!body) return;
    if (!e || !e.total || !e.total.n) {
      body.innerHTML = '<div class="edge-empty">Пока пусто. Факты сохраняются с каждой вечерней карточкой; ставь пометку сразу после сделки, чтобы видеть сетапы и эмоции.</div>';
      return;
    }
    var t = e.total;
    var x = insights(e);
    body.innerHTML = '<div class="edge-summary">'
        + '<span class="' + (t.pnl >= 0 ? 'up' : 'dn') + '"><b>' + money(t.pnl) + ' USDT</b></span>'
        + '<span><b>' + t.n + '</b> ' + plural(t.n, 'сделка', 'сделки', 'сделок') + '</span>'
        + '<span><b>' + t.winRate + '%</b> в плюс</span>'
        + '<span><b>' + e.days + '</b> ' + plural(e.days, 'день', 'дня', 'дней') + ' разобрано</span>'
        + '<span>пометок <b>' + e.tagged + ' из ' + t.n + '</b></span>'
      + '</div>'
      + (x.sample.early
        ? '<div class="edge-sample"><div class="edge-sample-bar"><i style="width:' + Math.round(x.sample.ratio * 100) + '%"></i></div>'
          + '<span>Данных мало: ' + t.n + ' из ' + x.sample.minN + ' сделок. Выводы предварительные.</span></div>'
        : '')
      + findingsHTML('Что работает', x.works, true, 'Пока ничего не выделяется')
      + findingsHTML('Что стоит денег', x.costs, false, 'Ничего не теряет больше твоей средней сделки')
      + (x.flat.length ? '<div class="edge-flat">Не с чем сравнить: ' + x.flat.join(', ').toLowerCase()
        + ' — все сделки в одной группе. Появятся, когда дни будут разными.</div>' : '')
      + '<details class="edge-details"><summary>Все разрезы</summary>'
      + '<div class="edge-grid">' + SECTIONS.map(function (s) {
          return '<div class="edge-card"><div class="edge-card-title">' + s[1] + '</div>' + tableHTML(e.groups[s[0]]) + '</div>';
        }).join('') + '</div></details>';
  });
}
