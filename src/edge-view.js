// ── "Мой edge" on the journal page ──────────────────────────────────────────
// Two questions, side by side: do you trade by your rules (execution), and does
// each setup make money when it's done by the rules (strategy, in R — units of
// your risk per trade, not dollars). PnL is one line on top, the old per-group
// tables are folded at the bottom. Numbers: journal/edge.js (GET /api/journal/edge).

import { fetchJournalEdge, saveTradeTag } from './api.js';
import { tzDateStr, tzTimeStr } from './utils.js';
import { keyLabel, DIMENSIONS } from './edge-insights.js';

var RANGES = [['1m', '1 мес'], ['3m', '3 мес'], ['6m', '6 мес'], ['all', 'Всё']];
var SECTIONS = Object.keys(DIMENSIONS).map(function (k) { return [k, DIMENSIONS[k]]; });
var PATTERN_LABEL = { breakout: 'Пробой', bounce_trend: 'Отскок по тренду', bounce_counter: 'Отскок против тренда', range_hold: 'Удержание границы', all: 'Все сетапы' };

var _range = '3m';

function money(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2); }
function rr(n) { return n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + 'R'; }

function plural(n, one, few, many) {
  var m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
}

function shortDate(iso) { return iso.slice(8, 10) + '.' + iso.slice(5, 7); }

// Execution: share of trades by the rules, which rules break, weekly trend
function executionHTML(x) {
  if (!x || !x.n) return '<div class="edge-panel"><h4 class="edge-h">Исполнение</h4><div class="edge-empty">Сделок нет</div></div>';
  var rules = x.rules.slice().sort(function (a, b) { return b.broken - a.broken; });
  return '<div class="edge-panel"><h4 class="edge-h">Исполнение</h4>'
    + '<div class="edge-big"><b class="' + (x.rate >= 80 ? 'up' : x.rate >= 50 ? '' : 'dn') + '">' + x.rate + '%</b>'
    + '<span>сделок по правилам — ' + x.clean + ' из ' + x.n + '</span></div>'
    + (x.weeks.length > 1 ? '<div class="edge-sub">По неделям: ' + x.weeks.map(function (w) { return 'с ' + shortDate(w.week) + ' — <b>' + w.rate + '%</b>'; }).join(' · ') + '</div>' : '')
    + '<table class="edge-list edge-rules"><thead><tr><th>Правило</th><th>Нарушений</th></tr></thead><tbody>'
    + rules.map(function (r) {
        return '<tr class="' + (r.broken ? 'broken' : 'kept') + '"><td>' + (r.broken ? '✕ ' : '✓ ') + r.label + '</td><td>' + (r.broken || '—') + '</td></tr>';
      }).join('')
    + '</tbody></table></div>';
}

// Strategy: each setup on trades done by the rules, in R
function setupsHTML(e) {
  var head = '<div class="edge-panel"><h4 class="edge-h">Сетапы — только сделки по правилам, в R</h4>';
  if (!e.riskPct) return head + '<div class="edge-empty">Укажи риск на сделку в настройках аккаунта (Trading limits → % per trade) — без него R не посчитать.</div></div>';
  var rows = e.setups.concat([e.setupsAll]);
  return head
    + '<div class="edge-sub">1R = ' + e.riskPct + '% от объёма позиции. Ожидание — сколько R в среднем приносит одна такая сделка. Надёжно от ' + e.minN + ' сделок, строки бледнее — пока меньше.</div>'
    + '<table class="edge-list edge-setups"><thead><tr><th>Сетап</th><th>Сделок</th><th>В плюс</th><th>Ср. плюс</th><th>Ср. минус</th><th>Ожидание</th><th>Итого</th></tr></thead><tbody>'
    + rows.map(function (s) {
        var cls = (s.key === 'all' ? 'total ' : '') + (s.n && !s.enough ? 'thin' : '');
        if (!s.n) return '<tr class="' + cls + ' none"><td>' + PATTERN_LABEL[s.key] + '</td><td>0</td><td colspan="5">нет сделок по правилам</td></tr>';
        return '<tr class="' + cls + '"><td>' + PATTERN_LABEL[s.key] + '</td><td>' + s.n + '</td><td>' + s.winRate + '%</td>'
          + '<td class="up">' + rr(s.avgWinR) + '</td><td class="dn">' + rr(s.avgLossR) + '</td>'
          + '<td class="' + (s.expectancyR >= 0 ? 'up' : 'dn') + '"><b>' + rr(s.expectancyR) + '</b></td>'
          + '<td class="' + (s.totalR >= 0 ? 'up' : 'dn') + '">' + rr(s.totalR) + '</td></tr>';
      }).join('')
    + '</tbody></table>'
    + (e.noPattern ? '<div class="edge-sub">' + e.noPattern + ' ' + plural(e.noPattern, 'сделка', 'сделки', 'сделок') + ' без сетапа — отметь их ниже, иначе они сюда не попадут.</div>' : '')
    + '</div>';
}

// Trades without a setup type: tag them right here (one click per trade)
var PATTERN_BUTTONS = [['breakout', 'Пробой'], ['bounce_trend', 'Отскок-тренд'], ['bounce_counter', 'Отскок-контр'], ['range_hold', 'Удержание']];
function untaggedHTML(list) {
  if (!list || !list.length) return '';
  return '<div class="edge-panel edge-untagged"><h4 class="edge-h">Отметь сетап — ' + list.length + ' ' + plural(list.length, 'сделка', 'сделки', 'сделок') + '</h4>'
    + '<table class="edge-list"><thead><tr><th>Закрыта</th><th>Монета</th><th>Итог</th><th>Сетап</th></tr></thead><tbody>'
    + list.map(function (u) {
        var d = new Date(u.closeTime);
        return '<tr data-sym="' + u.symbol + '" data-close="' + u.closeTime + '"><td>' + tzDateStr(d).slice(5).split('-').reverse().join('.') + ' ' + tzTimeStr(d) + '</td>'
          + '<td>' + u.symbol.replace(/USDT$/, '') + ' ' + (u.side === 'long' ? 'лонг' : 'шорт') + '</td>'
          + '<td class="' + (u.pnlNet >= 0 ? 'up' : 'dn') + '">' + (u.r != null ? rr(u.r) : money(u.pnlNet) + ' USDT') + '</td>'
          + '<td><span class="edge-tagbtns">' + PATTERN_BUTTONS.map(function (p) { return '<button type="button" data-edge-pattern="' + p[0] + '">' + p[1] + '</button>'; }).join('') + '</span></td></tr>';
      }).join('')
    + '</tbody></table></div>';
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
      body.innerHTML = '<div class="edge-empty">Пока пусто. Факты сохраняются с каждой вечерней карточкой; отмечай сетап сразу после сделки.</div>';
      return;
    }
    var t = e.total;
    body.innerHTML = '<div class="edge-summary">'
        + '<span><b>' + t.n + '</b> ' + plural(t.n, 'сделка', 'сделки', 'сделок') + ' за <b>' + e.days + '</b> ' + plural(e.days, 'день', 'дня', 'дней') + '</span>'
        + '<span>итог ' + money(t.pnl) + ' USDT</span>'
      + '</div>'
      + '<div class="edge-panels">' + executionHTML(e.execution) + setupsHTML(e) + '</div>'
      + untaggedHTML(e.untagged)
      + '<details class="edge-details"><summary>Все разрезы (в USDT)</summary>'
      + '<div class="edge-grid">' + SECTIONS.map(function (s) {
          return '<div class="edge-card"><div class="edge-card-title">' + s[1] + '</div>' + tableHTML(e.groups[s[0]]) + '</div>';
        }).join('') + '</div></details>';
    body.querySelectorAll('[data-edge-pattern]').forEach(function (b) {
      b.onclick = function () {
        var row = b.closest('tr');
        b.disabled = true;
        saveTradeTag({ symbol: row.dataset.sym, closeTime: Number(row.dataset.close), pattern: b.dataset.edgePattern }).then(function () {
          row.remove();
          clearTimeout(_refresh);
          _refresh = setTimeout(function () { renderEdgeSection(container); }, 1500); // recount once you pause tagging
        }).catch(function () { b.disabled = false; });
      };
    });
  });
}

var _refresh = null;
