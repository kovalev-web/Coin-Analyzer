// ── "Мой edge" on the journal page ──────────────────────────────────────────
// Two questions, side by side: do you trade by your rules (execution), and does
// each setup make money when it's done by the rules (strategy, in R — units of
// your risk per trade, not dollars). PnL is one line on top, the old per-group
// tables are folded at the bottom. Numbers: journal/edge.js (GET /api/journal/edge).

import { fetchJournalEdge, saveTradeTag } from './api.js';
import { tzDateStr, tzTimeStr, escHtml } from './utils.js';
import { ensureSetups, changeSetup, setupButtons, diagramAttr } from './setups.js';
import { state } from './state.js';
import { on } from './events.js';
import { ensureCoinNotes, notesOnDay } from './coin-notes.js';
import { conclusions } from './edge-insights.js';

var RANGES = [['week', 'Неделя'], ['month', 'Месяц'], ['all', 'Всё время']];

var _period = { range: 'all' }; // or { from, to }
var _openSetup = null;         // setup row expanded to its trades
var _editing = false; // setup list editor open

function money(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2); }
function rr(n) { return n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + 'R'; }

function plural(n, one, few, many) {
  var m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
}

function shortDate(iso) { return iso.slice(8, 10) + '.' + iso.slice(5, 7); }

// Rule breaks named as what happened (the server sends rule keys)
var BREAK_LABEL = {
  planned: 'Монета не из брифинга',
  stopHeld: 'Стоп не выдержан (убыток больше 1R)',
  size: 'Превышение объёма',
  noRevenge: 'Реванш после убытка',
  noCrane: 'Вход после стоп-крана',
  noSizeUp: 'Рост объёма после серии',
};

// Execution: share of trades by the rules, which rules break, weekly trend
function executionHTML(x, cost, oneR) {
  if (!x || !x.n) return '<div class="edge-panel"><h4 class="edge-h">Исполнение</h4><div class="edge-empty">Сделок нет</div></div>';
  var rules = x.rules.slice().sort(function (a, b) { return b.broken - a.broken; });
  return '<div class="edge-panel"><h4 class="edge-h">Исполнение</h4>'
    + '<div class="edge-big"><b class="' + (x.rate >= 80 ? 'up' : x.rate >= 50 ? '' : 'dn') + '">' + x.rate + '%</b>'
    + '<span>сделок по правилам — ' + x.clean + ' из ' + x.n + '</span></div>'
    + (cost ? '<div class="edge-cost ' + (cost < 0 ? 'dn' : '') + '">Сделки с нарушениями дали <b>' + rr(cost) + '</b>' + (oneR ? ' (' + money(cost * oneR) + ' USDT)' : '') + '</div>' : '')
    + (x.weeks.length > 1 ? '<div class="edge-sub">По неделям: ' + x.weeks.map(function (w) { return 'с ' + shortDate(w.week) + ' — <b>' + w.rate + '%</b>'; }).join(' · ') + '</div>' : '')
    + '<table class="edge-list edge-rules"><thead><tr><th>Нарушение</th><th>Сколько раз</th></tr></thead><tbody>'
    + rules.map(function (r) {
        return '<tr class="' + (r.broken ? 'broken' : 'kept') + '"><td>' + (BREAK_LABEL[r.key] || r.label) + '</td><td>' + r.broken + '</td></tr>';
      }).join('')
    + '</tbody></table></div>';
}

// Strategy: each setup on trades done by the rules, in R
function setupsHTML(e) {
  var head = '<div class="edge-panel"><div class="edge-panel-head"><h4 class="edge-h">Сетапы — только сделки по правилам, в R</h4>'
    + '<button type="button" class="edge-link" data-edge-edit>' + (_editing ? 'Готово' : 'Настроить сетапы') + '</button></div>'
    + (_editing ? editorHTML() : '');
  if (!e.riskPct) return head + '<div class="edge-empty">Укажи риск на сделку в настройках аккаунта (Trading limits → % per trade) — без него R не посчитать.</div></div>';
  var rows = e.setups.concat([e.setupsAll]);
  if (e.allTrades && e.allTrades.n) rows.push(e.allTrades);
  return head
    + '<div class="edge-sub"><b>Строки сетапов — только сделки по правилам:</b> сколько сетап даёт, если делать его правильно. Твой реальный результат со всеми нарушениями — последняя строка.</div>'
    + '<div class="edge-sub">1R = ' + (e.oneR != null ? e.oneR.toFixed(2) + ' USDT — ' : '') + e.riskPct + '% от '
      + (e.workingVolume ? 'рабочего объёма ' + e.workingVolume + ' USDT' : 'объёма позиции (рабочий объём не задан в настройках)') + '. Ожидание — сколько R в среднем приносит одна такая сделка. Надёжно от ' + e.minN + ' сделок, строки бледнее — пока меньше.</div>'
    + '<table class="edge-list edge-setups"><thead><tr><th>Сетап</th><th>Сделок</th><th>В плюс</th><th>Ср. плюс</th><th>Ср. минус</th><th>Ожидание</th><th>Итого</th></tr></thead><tbody>'
    + rows.map(function (s) {
        var cls = (s.key === 'all' ? 'total ' : '') + (s.n && !s.enough ? 'thin' : '');
        var name = s.key === 'all' ? 'Все сетапы по правилам' : s.key === 'everything' ? 'Все сделки, с нарушениями' : escHtml(s.name || s.key);
        if (s.key === 'everything') cls = 'real';
        // A setup with trades opens its list (click the name)
        var open = s.trades && s.trades.length;
        if (open) cls += ' openable' + (_openSetup === s.key ? ' open' : '');
        var nameCell = '<td' + diagramAttr(s.key) + (open ? ' data-setup-open="' + s.key + '"' : '') + '>' + (open ? (_openSetup === s.key ? '▾ ' : '▸ ') : '') + name + '</td>';
        var tradesRow = open && _openSetup === s.key ? '<tr class="edge-trades-row"><td colspan="7">' + setupTradesHTML(s.trades) + '</td></tr>' : '';
        if (!s.n) return '<tr class="' + cls + ' none">' + nameCell + '<td>0</td><td colspan="5">нет сделок по правилам</td></tr>' + tradesRow;
        return '<tr class="' + cls + '">' + nameCell + '<td>' + s.n + '</td><td>' + s.winRate + '%</td>'
          + '<td class="up">' + rr(s.avgWinR) + '</td><td class="dn">' + rr(s.avgLossR) + '</td>'
          + '<td class="' + (s.expectancyR >= 0 ? 'up' : 'dn') + '"><b>' + rr(s.expectancyR) + '</b></td>'
          + '<td class="' + (s.totalR >= 0 ? 'up' : 'dn') + '">' + rr(s.totalR) + '</td></tr>' + tradesRow;
      }).join('')
    + '</tbody></table>'
    + (e.excluded ? '<div class="edge-sub">Не считаются: ' + e.excluded + ' ' + plural(e.excluded, 'сделка', 'сделки', 'сделок') + ' с сетапами «не считать» (мисклики и т.п.).</div>' : '')
    + (e.noPattern ? '<div class="edge-sub">' + e.noPattern + ' ' + plural(e.noPattern, 'сделка', 'сделки', 'сделок') + ' без сетапа — отметь их ниже, иначе они сюда не попадут.</div>' : '')
    + '</div>';
}

// A setup's trades with your notes on that coin that day — why you entered, next to how it went
function setupTradesHTML(trades) {
  return '<div class="edge-trades">' + trades.map(function (t) {
    var d = new Date(t.closeTime), coin = t.symbol.replace(/USDT$/, '');
    ensureCoinNotes(coin);
    var notes = notesOnDay(coin, tzDateStr(d));
    var breaks = (t.broken || []).map(function (k) { return BREAK_LABEL[k] || k; });
    return '<div class="edge-trade">'
      + '<div class="edge-trade-head"><span>' + shortDate(tzDateStr(d)) + ' ' + tzTimeStr(d) + '</span><b>' + coin + ' ' + (t.side === 'long' ? 'лонг' : 'шорт') + '</b>'
      + '<span class="' + ((t.r != null ? t.r : t.pnlNet) >= 0 ? 'up' : 'dn') + '">' + (t.r != null ? rr(t.r) : money(t.pnlNet) + ' USDT') + '</span>'
      + (breaks.length ? '<span class="dn">' + breaks.join(', ') + '</span>' : '<span class="muted">по правилам</span>') + '</div>'
      + (notes.length ? '<ul class="edge-trade-notes">' + notes.map(function (n) { return '<li><span>' + tzTimeStr(new Date(n.ts)) + '</span>' + escHtml(n.text) + '</li>'; }).join('') + '</ul>' : '<div class="edge-trade-nonotes">Заметок по ' + coin + ' в этот день нет</div>')
      + '</div>';
  }).join('') + '</div>';
}

// Your setup list: rename in place, leave out of the report, hide from the buttons, add
function editorHTML() {
  var list = state.setups || [];
  return '<div class="edge-editor">'
    + list.map(function (x) {
        return '<div class="edge-editor-row' + (x.archived ? ' hidden' : '') + '" data-setup-key="' + x.key + '">'
          + '<input class="ds-input" data-setup-name value="' + escHtml(x.name) + '" maxlength="40">'
          + '<label class="edge-check"><input type="checkbox" data-setup-exclude' + (x.exclude ? ' checked' : '') + '> не считать</label>'
          + '<button type="button" class="edge-link" data-setup-archive>' + (x.archived ? 'Вернуть' : 'Скрыть') + '</button></div>';
      }).join('')
    + '<div class="edge-editor-row"><input class="ds-input" data-setup-new placeholder="Новый сетап, например «Мисклик»" maxlength="40">'
    + '<button type="button" class="edge-link" data-setup-add>Добавить</button></div>'
    + '<div class="edge-sub">«Не считать» — сделки с этим сетапом не попадают в отчёт (мисклики, тесты). «Скрыть» — убрать из кнопок, статистика остаётся.</div>'
    + '</div>';
}

// Trades without a setup type: tag them right here (one click per trade)
function untaggedHTML(list) {
  if (!list || !list.length) return '';
  return '<div class="edge-panel edge-untagged"><h4 class="edge-h">Отметь сетап — ' + list.length + ' ' + plural(list.length, 'сделка', 'сделки', 'сделок') + '</h4>'
    + '<table class="edge-list"><thead><tr><th>Закрыта</th><th>Монета</th><th>Итог</th><th>Сетап</th></tr></thead><tbody>'
    + list.map(function (u) {
        var d = new Date(u.closeTime);
        return '<tr data-sym="' + u.symbol + '" data-close="' + u.closeTime + '"><td>' + tzDateStr(d).slice(5).split('-').reverse().join('.') + ' ' + tzTimeStr(d) + '</td>'
          + '<td>' + u.symbol.replace(/USDT$/, '') + ' ' + (u.side === 'long' ? 'лонг' : 'шорт') + '</td>'
          + '<td class="' + (u.pnlNet >= 0 ? 'up' : 'dn') + '">' + (u.r != null ? rr(u.r) : money(u.pnlNet) + ' USDT') + '</td>'
          + '<td><span class="edge-tagbtns">' + setupButtons().map(function (p) { return '<button type="button" data-edge-pattern="' + p[0] + '">' + escHtml(p[1]) + '</button>'; }).join('') + '</span></td></tr>';
      }).join('')
    + '</tbody></table></div>';
}

// A few plain conclusions from the rest of the data (time of day, setup quality,
// emotion, plan, morning state): where you do best and worst, in R per trade
function conclusionsHTML(e) {
  var list = conclusions(e.groups, e.oneR, e.minN, 4);
  var body = list.length
    ? '<ul class="edge-concl">' + list.map(function (c) {
        return '<li><b>' + c.title + ':</b> лучше всего — «' + c.best.label + '» (' + rr(c.best.avgR) + ' на сделку, ' + c.best.n + ' ' + plural(c.best.n, 'сделка', 'сделки', 'сделок') + '), '
          + 'хуже всего — «' + c.worst.label + '» (' + rr(c.worst.avgR) + ', ' + c.worst.n + ' ' + plural(c.worst.n, 'сделка', 'сделки', 'сделок') + ').'
          + (c.early ? ' <span>Предварительно — мало сделок.</span>' : '') + '</li>';
      }).join('') + '</ul>'
    : '<div class="edge-empty">Пока не из чего делать выводы: заметной разницы между группами нет или в каждой меньше 2 сделок. Выводы появятся, когда будут дни и часы с разным результатом.</div>';
  return '<div class="edge-panel edge-conclusions"><h4 class="edge-h">Выводы</h4>' + body + '</div>';
}

var _last = null;
// Notes arriving for an open setup's trades: redraw from the data we have
on('coin-notes:updated', function () {
  if (_openSetup && _last && _last.container.isConnected) renderEdgeSection(_last.container, _last.e);
});

// cached: the last report, to redraw without asking the server again
export function renderEdgeSection(container, cached) {
  if (!container) return;
  container.innerHTML = '<div class="edge-section"><div class="edge-head"><h3>Мой edge</h3><div class="edge-ranges">'
    + RANGES.map(function (r) { return '<button data-edge-range="' + r[0] + '" class="' + (r[0] === _period.range ? 'active' : '') + '">' + r[1] + '</button>'; }).join('')
    + '<span class="edge-dates"><input type="date" class="ds-input" data-edge-from value="' + (_period.from || '') + '"><span>—</span><input type="date" class="ds-input" data-edge-to value="' + (_period.to || '') + '"></span>'
    + '</div></div><div class="edge-body"><span class="big-spinner"></span></div></div>';
  container.querySelectorAll('[data-edge-range]').forEach(function (b) {
    b.onclick = function () { _period = { range: b.dataset.edgeRange }; renderEdgeSection(container); };
  });
  // Any period: both dates set → that range
  container.querySelectorAll('[data-edge-from],[data-edge-to]').forEach(function (inp) {
    inp.onchange = function () {
      var f = container.querySelector('[data-edge-from]').value, t = container.querySelector('[data-edge-to]').value;
      if (f && t && f <= t) { _period = { from: f, to: t }; renderEdgeSection(container); }
    };
  });
  Promise.all([cached ? Promise.resolve(cached) : fetchJournalEdge(_period), ensureSetups()]).then(function (res) {
    var e = res[0];
    var body = container.querySelector('.edge-body');
    if (!body) return;
    if (!e || !e.total || !e.total.n) {
      body.innerHTML = '<div class="edge-empty">' + (e && e.period ? 'За ' + shortDate(e.period.from) + ' — ' + shortDate(e.period.to) + ' сделок нет. ' : '')
        + (e && e.startDate ? 'Отчёт считается с ' + shortDate(e.startDate) + '. ' : '')
        + 'Отмечай сетап в стакане сразу после выхода — что не успел, отметишь здесь.</div>';
      return;
    }
    var t = e.total;
    body.innerHTML = '<div class="edge-summary">'
        + '<span><b>' + t.n + '</b> ' + plural(t.n, 'сделка', 'сделки', 'сделок') + ' за <b>' + e.days + '</b> ' + plural(e.days, 'день', 'дня', 'дней') + '</span>'
        + '<span>итог <b class="' + (t.pnl >= 0 ? 'up' : 'dn') + '">' + money(t.pnl) + ' USDT</b>' + (e.oneR ? ' = ' + rr(t.pnl / e.oneR) : '') + '</span>'
        + (e.period ? '<span>период ' + shortDate(e.period.from) + ' — ' + shortDate(e.period.to) + '</span>' : '')
      + '</div>'
      + '<div class="edge-panels">' + executionHTML(e.execution, e.breaksCostR, e.oneR) + setupsHTML(e) + '</div>'
      + conclusionsHTML(e)
      + untaggedHTML(e.untagged);
    bindEditor(body, container);
    body.querySelectorAll('[data-setup-open]').forEach(function (td) {
      td.onclick = function () { _openSetup = _openSetup === td.dataset.setupOpen ? null : td.dataset.setupOpen; renderEdgeSection(container, e); };
    });
    _last = { container: container, e: e };
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

function bindEditor(body, container) {
  var redraw = function () { renderEdgeSection(container); };
  var toggle = body.querySelector('[data-edge-edit]');
  if (toggle) toggle.onclick = function () { _editing = !_editing; redraw(); };
  body.querySelectorAll('[data-setup-key]').forEach(function (row) {
    var key = row.dataset.setupKey;
    var name = row.querySelector('[data-setup-name]');
    name.onchange = function () { if (name.value.trim()) changeSetup({ action: 'rename', key: key, name: name.value.trim() }).then(redraw); };
    row.querySelector('[data-setup-exclude]').onchange = function (ev) { changeSetup({ action: 'exclude', key: key, exclude: ev.target.checked }).then(redraw); };
    row.querySelector('[data-setup-archive]').onclick = function () { changeSetup({ action: 'archive', key: key, archived: !row.classList.contains('hidden') }).then(redraw); };
  });
  var add = body.querySelector('[data-setup-add]'), input = body.querySelector('[data-setup-new]');
  if (add) {
    var doAdd = function () { if (input.value.trim()) changeSetup({ action: 'add', name: input.value.trim() }).then(redraw); };
    add.onclick = doAdd;
    input.onkeydown = function (ev) { if (ev.key === 'Enter') doAdd(); };
  }
}
