// ── "Мой edge" on the journal page ──────────────────────────────────────────
// Below the chart: a summary for the page's period — execution (share of
// trades by your rules, the breaks), setups by result in R (trades by the rules)
// and a few conclusions — then the day table. A day opens into its own
// execution and its trades grouped by setup, with notes and re-tagging.
// The period is one filter for the whole journal page (state.journalPeriod).
// Numbers: journal/edge.js (GET /api/journal/edge).

import { fetchJournalEdge, saveTradeTag } from './api.js';
import { tzDateStr, tzTimeStr, escHtml } from './utils.js';
import { ensureSetups, changeSetup, setupButtons, diagramAttr } from './setups.js';
import { state } from './state.js';
import { on } from './events.js';
import { dateRangeHTML, bindDateRange } from './date-range.js';
import { ensureCoinNotes, notesOnDay } from './coin-notes.js';
import { conclusions } from './edge-insights.js';
import { openTradeChart, closeTradeChart } from './trade-chart.js';

var RANGES = [['week', 'Неделя'], ['month', 'Месяц'], ['all', 'Всё время']];
var JOURNAL_START = '2026-10-28';

var _openDays = {};      // date → day row open
var _openGroup = null;   // 'date|setupKey' open inside a day
var _editing = false;    // setup list editor open
var _last = null;        // { container, e } — redraw without asking the server
var _refresh = null;
var _chartKey = null;    // 'SYMBOL|closeTime' whose chart is open
var _tradeByKey = {};    // the same key → trade, for the chart

function money(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2); }
function rr(n) { return n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + 'R'; }
function plural(n, one, few, many) {
  var m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
}
function trades(n) { return n + ' ' + plural(n, 'сделка', 'сделки', 'сделок'); }
function shortDate(iso) { return iso.slice(8, 10) + '.' + iso.slice(5, 7); }
function info(text) { return '<span class="edge-info" title="' + escHtml(text) + '">ⓘ</span>'; }

// Rule breaks named as what happened (the server sends rule keys)
var BREAK_LABEL = {
  planned: 'Монета не из брифинга',
  stopHeld: 'Стоп не выдержан (убыток больше 1R)',
  size: 'Превышение объёма',
  noRevenge: 'Реванш после убытка',
  noCrane: 'Вход после стоп-крана',
  noSizeUp: 'Рост объёма после серии',
};

// ── Period: one filter for the whole journal page ───────────────────────────

export function journalPeriod() { return state.journalPeriod || (state.journalPeriod = { range: 'all' }); }

export function periodPickerHTML() {
  var p = journalPeriod();
  return '<div class="edge-ranges">'
    + RANGES.map(function (r) { return '<button data-edge-range="' + r[0] + '" class="' + (r[0] === p.range ? 'active' : '') + '">' + r[1] + '</button>'; }).join('')
    + dateRangeHTML('journal', p.from, p.to, 'Свои даты')
    + '</div>';
}

// onChange(): the period changed — the page reloads its parts
export function bindPeriodPicker(root, onChange) {
  root.querySelectorAll('[data-edge-range]').forEach(function (b) {
    b.onclick = function () { state.journalPeriod = { range: b.dataset.edgeRange }; onChange(); };
  });
  var p = journalPeriod();
  bindDateRange(root, 'journal', {
    min: JOURNAL_START, max: tzDateStr(), from: p.from, to: p.to,
    onChange: function (f, t) { state.journalPeriod = { from: f, to: t }; onChange(); },
  });
}

// ── Summary for the period ──────────────────────────────────────────────────

function executionHTML(x) {
  var head = '<div class="edge-panel"><h4 class="edge-h">Исполнение ' + info('Доля сделок без нарушений твоих правил: брифинг, стоп не больше 1R, объём в лимите, без реванша, без входов после стоп-крана, без роста объёма после серии.') + '</h4>';
  if (!x || !x.n) return head + '<div class="edge-empty">Сделок нет</div></div>';
  var broken = x.rules.filter(function (r) { return r.broken; }).sort(function (a, b) { return b.broken - a.broken; });
  var errs = broken.reduce(function (s, r) { return s + r.broken; }, 0);
  return head
    + '<div class="edge-big"><b class="' + (x.rate >= 80 ? 'up' : x.rate >= 50 ? '' : 'dn') + '">' + x.rate + '%</b>'
    + '<span>по правилам · ' + (errs ? errs + ' ' + plural(errs, 'ошибка', 'ошибки', 'ошибок') : 'ошибок нет') + '</span></div>'
    + (broken.length ? '<ul class="edge-breaks">' + broken.map(function (r) { return '<li><span>' + (BREAK_LABEL[r.key] || r.label) + '</span><b>' + r.broken + '</b></li>'; }).join('') + '</ul>' : '')
    + '</div>';
}

function setupsHTML(e) {
  var head = '<div class="edge-panel"><div class="edge-panel-head"><h4 class="edge-h">Сетапы '
    + info('Только сделки по правилам — сколько сетап даёт, если делать его правильно. R: 1R = ' + (e.oneR != null ? e.oneR.toFixed(2) + ' USDT, ' : '') + (e.riskPct || '?') + '% от рабочего объёма. Надёжно от ' + e.minN + ' сделок.')
    + '</h4><button type="button" class="edge-link" data-edge-edit>' + (_editing ? 'Готово' : 'Настроить') + '</button></div>'
    + (_editing ? editorHTML() : '');
  if (!e.riskPct) return head + '<div class="edge-empty">Укажи риск на сделку в настройках аккаунта (Trading limits → % per trade) — без него R не посчитать.</div></div>';
  var rows = e.setups.filter(function (s) { return s.n > 0; }).sort(function (a, b) { return b.totalR - a.totalR; });
  return head
    + (rows.length
      ? '<table class="edge-list edge-sum"><thead><tr><th>Сетап</th><th>Сделок</th><th>В плюс</th><th>Итог</th></tr></thead><tbody>'
        + rows.map(function (s) {
            return '<tr class="' + (s.enough ? '' : 'thin') + '"><td' + diagramAttr(s.key) + '>' + escHtml(s.name || s.key) + '</td><td>' + s.n + '</td><td>' + s.winRate + '%</td>'
              + '<td class="' + (s.totalR >= 0 ? 'up' : 'dn') + '"><b>' + rr(s.totalR) + '</b></td></tr>';
          }).join('')
        + (e.allTrades && e.allTrades.n ? '<tr class="real"><td>Все сделки, с ошибками</td><td>' + e.allTrades.n + '</td><td>' + e.allTrades.winRate + '%</td>'
            + '<td class="' + (e.allTrades.totalR >= 0 ? 'up' : 'dn') + '"><b>' + rr(e.allTrades.totalR) + '</b></td></tr>' : '')
        + '</tbody></table>'
      : '<div class="edge-empty">Пока нет сделок по правилам с отмеченным сетапом.</div>')
    + '</div>';
}

function conclusionsHTML(e) {
  var list = conclusions(e.groups, e.oneR, e.minN, 4);
  return '<div class="edge-conclusions"><h4 class="edge-h">Выводы ' + info('Где ты торгуешь лучше и хуже — по времени, качеству сетапа, эмоции, брифингу, уровням и утреннему состоянию, в R на сделку. Появляются, когда в группах есть разница.') + '</h4>'
    + (list.length
      ? '<ul class="edge-concl">' + list.map(function (c) {
          return '<li><b>' + c.title + ':</b> лучше — «' + c.best.label + '» (' + rr(c.best.avgR) + ' на сделку, ' + trades(c.best.n) + '), '
            + 'хуже — «' + c.worst.label + '» (' + rr(c.worst.avgR) + ', ' + trades(c.worst.n) + ').'
            + (c.early ? ' <span>Предварительно.</span>' : '') + '</li>';
        }).join('') + '</ul>'
      : '<div class="edge-empty">Пока не из чего: разницы между группами нет или в них меньше 2 сделок. Заполняй утро и пометки — появятся.</div>')
    + '</div>';
}

// ── Day table with the drill-down ───────────────────────────────────────────

function dayRowsHTML(e) {
  if (!e.byDay || !e.byDay.length) return '';
  return '<div class="edge-panel journal-days"><h4 class="edge-h">По дням</h4>'
    + '<table class="edge-list edge-days"><thead><tr><th>Дата</th><th>Сделок</th><th>По правилам</th><th>PnL, USDT</th><th></th></tr></thead><tbody>'
    + e.byDay.map(function (d) {
        var open = !!_openDays[d.date];
        var badges = (d.untagged ? '<span class="edge-badge">' + d.untagged + ' без сетапа</span>' : '');
        return '<tr class="edge-day' + (open ? ' open' : '') + '" data-day="' + d.date + '"><td>' + (open ? '▾ ' : '▸ ') + shortDate(d.date) + '</td><td>' + d.n + '</td>'
          + '<td class="' + (d.rate === 100 ? 'up' : d.rate != null && d.rate < 50 ? 'dn' : '') + '">' + (d.rate != null ? d.rate + '%' : '—') + '</td>'
          + '<td class="' + (d.pnl >= 0 ? 'up' : 'dn') + '">' + money(d.pnl) + '</td><td>' + badges + '</td></tr>'
          + (open ? '<tr class="edge-day-body"><td colspan="5">' + dayBodyHTML(d) + '</td></tr>' : '');
      }).join('')
    + '</tbody></table></div>';
}

function dayBodyHTML(d) {
  var exec = !d.breaks.length
    ? '<div class="edge-day-ok">' + (d.n ? '100% — все сделки по правилам' : 'Сделок в отчёте нет') + '</div>'
    : '<div class="edge-big small"><b class="' + (d.rate >= 80 ? 'up' : d.rate >= 50 ? '' : 'dn') + '">' + d.rate + '%</b><span>по правилам — ' + d.clean + ' из ' + d.n + '</span></div>'
      + '<ul class="edge-breaks">' + d.breaks.map(function (b) { return '<li><span>' + (BREAK_LABEL[b.key] || b.key) + '</span><b>' + b.count + '</b></li>'; }).join('') + '</ul>';
  var groups = d.setups.map(function (g) {
    var key = d.date + '|' + g.key;
    // Trades without a setup open by themselves — they're waiting for a click
    var open = _openGroup === key || (g.key === 'none' && _openGroup !== key + '|closed');
    var name = g.key === 'none' ? 'Без сетапа' : g.key === 'excluded' ? 'Не считаются' : escHtml(g.name || g.key);
    return '<div class="edge-group' + (open ? ' open' : '') + '"><div class="edge-group-head" data-group="' + key + '"' + diagramAttr(g.key) + '>'
      + '<span>' + (open ? '▾ ' : '▸ ') + name + '</span><span>' + trades(g.trades.length) + '</span>'
      + '<span class="' + ((g.totalR || 0) >= 0 ? 'up' : 'dn') + '">' + (g.key === 'excluded' ? '' : rr(g.totalR)) + '</span></div>'
      + (open ? tradesHTML(g.trades) : '') + '</div>';
  }).join('');
  return '<div class="edge-day-grid">'
    + '<div><h5 class="edge-h5">Исполнение</h5>' + exec + '</div>'
    + '<div><h5 class="edge-h5">Сделки ' + info('Все сделки дня по сетапам, как они были; ошибки отмечены у сделки. Клик по сетапу — сделки, заметки и смена пометок.') + '</h5>' + (groups || '<div class="edge-empty">Сделок нет</div>') + '</div>'
    + '</div>';
}

// A group's trades: one line each, your notes on the coin that day once (under
// its first trade), and chips to change the tags
function tradesHTML(list) {
  var seen = {};
  return '<div class="edge-trades">' + list.map(function (t) {
    var d = new Date(t.closeTime), coin = t.symbol.replace(/USDT$/, ''), day = tzDateStr(d);
    var notesHtml = '';
    if (!seen[coin + day]) {
      seen[coin + day] = true;
      ensureCoinNotes(coin);
      var notes = notesOnDay(coin, day);
      notesHtml = notes.length ? '<ul class="edge-trade-notes">' + notes.map(function (n) { return '<li><span>' + tzTimeStr(new Date(n.ts)) + '</span>' + escHtml(n.text) + '</li>'; }).join('') + '</ul>' : '';
    }
    var breaks = (t.broken || []).map(function (k) { return BREAK_LABEL[k] || k; });
    var key = t.symbol + '|' + t.closeTime;
    _tradeByKey[key] = t;
    return '<div class="edge-trade" data-retag-sym="' + t.symbol + '" data-retag-close="' + t.closeTime + '">'
      + notesHtml
      + '<div class="edge-trade-head"><span>' + tzTimeStr(d) + '</span><b>' + coin + ' ' + (t.side === 'long' ? 'лонг' : 'шорт') + '</b>'
      + '<span class="' + ((t.r != null ? t.r : t.pnlNet) >= 0 ? 'up' : 'dn') + '">' + (t.r != null ? rr(t.r) : money(t.pnlNet) + ' USDT') + '</span>'
      + (t.excluded ? '<span class="muted">не считается</span>' : breaks.length ? '<span class="dn">' + breaks.join(', ') + '</span>' : '<span class="muted">по правилам</span>')
      + '<button type="button" class="edge-link edge-chart-btn" data-trade-chart="' + key + '">' + (_chartKey === key ? 'Скрыть график' : 'График') + '</button></div>'
      + '<div class="edge-trade-chart" data-chart-host="' + key + '"></div>'
      + retagHTML(t.tag)
      + '</div>';
  }).join('') + '</div>';
}

// Change a trade's tags: setup, quality, emotion — the current ones highlighted
var QUALITY = [['A', 'A'], ['B', 'B'], ['C', 'C']];
var EMOTIONS = [['plan', 'По плану'], ['fomo', 'FOMO'], ['revenge', 'Отыграться'], ['boredom', 'Скука'], ['fear', 'Страх']];
function retagHTML(tag) {
  tag = tag || {};
  var chips = function (kind, list, cur) {
    return list.map(function (x) { return '<button type="button" data-retag="' + kind + '" data-val="' + x[0] + '" class="' + (cur === x[0] ? 'on' : '') + '">' + escHtml(x[1]) + '</button>'; }).join('');
  };
  return '<div class="edge-retag">'
    + '<span class="edge-tagbtns">' + chips('pattern', setupButtons(), tag.pattern) + '</span>'
    + '<span class="edge-tagbtns">' + chips('setup', QUALITY, tag.setup) + chips('emotion', EMOTIONS, tag.emotion) + '</span>'
    + '</div>';
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

// ── Render ──────────────────────────────────────────────────────────────────

// Notes arriving for an open day: redraw from the data we have
on('coin-notes:updated', function () {
  if (_last && _last.container.isConnected && Object.keys(_openDays).length) renderEdgeSection(_last.container, _last.e);
});

// cached: the last report, to redraw without asking the server again
export function renderEdgeSection(container, cached) {
  if (!container) return;
  closeTradeChart();
  if (!cached) container.innerHTML = '<div class="edge-section"><span class="big-spinner"></span></div>';
  Promise.all([cached ? Promise.resolve(cached) : fetchJournalEdge(journalPeriod()), ensureSetups()]).then(function (res) {
    var e = res[0];
    if (!container.isConnected) return;
    if (!e || !e.total || !e.total.n) {
      container.innerHTML = '<div class="edge-section"><div class="edge-empty">' + (e && e.period ? 'За ' + shortDate(e.period.from) + ' — ' + shortDate(e.period.to) + ' сделок нет. ' : '')
        + 'Журнал считается с ' + shortDate(JOURNAL_START) + '. Отмечай сетап в стакане сразу после выхода — что не успел, отметишь в таблице по дням.</div></div>';
      return;
    }
    container.innerHTML = '<div class="edge-section">'
      + '<div class="edge-panels">' + executionHTML(e.execution) + setupsHTML(e) + '</div>'
      + conclusionsHTML(e)
      + dayRowsHTML(e)
      + '</div>';
    _last = { container: container, e: e };
    bindEditor(container);
    container.querySelectorAll('[data-day]').forEach(function (tr) {
      tr.onclick = function () {
        if (_openDays[tr.dataset.day]) delete _openDays[tr.dataset.day]; else _openDays[tr.dataset.day] = true;
        renderEdgeSection(container, e);
      };
    });
    container.querySelectorAll('[data-group]').forEach(function (h) {
      h.onclick = function () {
        var k = h.dataset.group, wasOpen = h.parentNode.classList.contains('open');
        _openGroup = wasOpen ? (k.split('|')[1] === 'none' ? k + '|closed' : null) : k;
        renderEdgeSection(container, e);
      };
    });
    // A trade's chart: one at a time, built on click
    container.querySelectorAll('[data-trade-chart]').forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.tradeChart;
        _chartKey = _chartKey === k ? null : k;
        renderEdgeSection(container, e);
      };
    });
    if (_chartKey) {
      var host = container.querySelector('[data-chart-host="' + _chartKey + '"]');
      if (host && _tradeByKey[_chartKey]) openTradeChart(host, _tradeByKey[_chartKey]); else _chartKey = null;
    }
    // Re-tag a trade; the report recounts once you pause
    container.querySelectorAll('[data-retag]').forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var tr = b.closest('[data-retag-sym]');
        var tag = { symbol: tr.dataset.retagSym, closeTime: Number(tr.dataset.retagClose) };
        tag[b.dataset.retag] = b.dataset.val;
        saveTradeTag(tag).then(function () {
          b.parentNode.querySelectorAll('[data-retag="' + b.dataset.retag + '"]').forEach(function (x) { x.classList.toggle('on', x === b); });
          clearTimeout(_refresh);
          _refresh = setTimeout(function () { renderEdgeSection(container); }, 2500);
        });
      };
    });
  });
}

function bindEditor(root) {
  var redraw = function () { renderEdgeSection(root); };
  var toggle = root.querySelector('[data-edge-edit]');
  if (toggle) toggle.onclick = function () { _editing = !_editing; renderEdgeSection(root, _last && _last.e); };
  root.querySelectorAll('[data-setup-key]').forEach(function (row) {
    var key = row.dataset.setupKey;
    var name = row.querySelector('[data-setup-name]');
    name.onchange = function () { if (name.value.trim()) changeSetup({ action: 'rename', key: key, name: name.value.trim() }).then(redraw); };
    row.querySelector('[data-setup-exclude]').onchange = function (ev) { changeSetup({ action: 'exclude', key: key, exclude: ev.target.checked }).then(redraw); };
    row.querySelector('[data-setup-archive]').onclick = function () { changeSetup({ action: 'archive', key: key, archived: !row.classList.contains('hidden') }).then(redraw); };
  });
  var add = root.querySelector('[data-setup-add]'), input = root.querySelector('[data-setup-new]');
  if (add) {
    var doAdd = function () { if (input.value.trim()) changeSetup({ action: 'add', name: input.value.trim() }).then(redraw); };
    add.onclick = doAdd;
    input.onkeydown = function (ev) { if (ev.key === 'Enter') doAdd(); };
  }
}
