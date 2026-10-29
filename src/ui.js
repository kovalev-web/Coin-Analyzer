import { state, filteredCoins, STABLE_SYMBOLS, SCREENER_EXCLUDE } from './state.js';
import { fmt, escHtml, signalLabel, icon, tzDateStr, tzTimeStr, tzParts, effectiveTZ } from './utils.js';
import { terminalOnFVOpen, terminalOnFVClose } from './terminal.js';
import { ensureSetups, setupButtons, setupName, diagramAttr } from './setups.js';
import { noteInputHTML, clearNoteIcons, ensureCoinNotes, drawNoteIcons, notesListHTML, notesOnDay } from './coin-notes.js';
import { on, emit } from './events.js';
import { openSurface, closeSurface, isSurfaceOpen, toast } from './react-bridge.js';
import { mountIsland, unmountIsland, unmountIslands } from './react/islands.jsx';
import { Topbar } from './react/home/Topbar.jsx';
import { SortBar } from './react/home/SortBar.jsx';
import { DaySummary } from './react/home/DaySummary.jsx';
import { CardHead } from './react/home/CardHead.jsx';
import { BriefingDrawer } from './react/home/Briefing.jsx';
import { FvControls, FvStats } from './react/fullview/FvControls.jsx';
import { getCurrentRoute } from './router.js';
import { analyzeCoinBySymbol, fetchChartData, wsConnected, sendWS, API_BASE, applyLivePriceUpdates, fetchNATR, getLastKlineAt, fetchTodayTrades, fetchTradesForDate, fetchTrades, markNotificationRead, fetchJournalToday, fetchJournalFacts, saveTradeTag } from './api.js';
import { connectOrderbook, disconnectOrderbook, softDisconnectOrderbook, msUntilWarm, AGGRESSION_WINDOW_MS } from './orderbook.js';
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip } from 'chart.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip);

// ── Utility ────────────────────────────────────────────────────────────────

function natrDisplay(symbol) {
  var nd = state.natrData[symbol];
  if (!nd || nd === 'loading' || nd === 'error') return { val: '—', cls: 'dim' };
  var v = nd.value, cls = v >= 1.8 ? 'natr-hi' : '';
  return { val: v.toFixed(2), cls: cls };
}

// ── Render ─────────────────────────────────────────────────────────────────

// A coin card: the box and its chart are vanilla (charts by #chart-<sym>), the
// head is a React island (src/react/home/CardHead.jsx) mounted by mountCardHeads
function renderCard(coin) {
  return '<div class="coin-card" data-sym="' + coin.symbol + '">'
    + '<div class="card-head-root" data-card-head="' + coin.symbol + '"></div>'
    + '<div class="chart-container" id="chart-' + coin.symbol + '"></div>'
    + '</div>';
}

function mountCardHeads(root) {
  (root || document).querySelectorAll('[data-card-head]').forEach(function (el) {
    if (!el.firstChild) mountIsland(el, CardHead, { sym: el.dataset.cardHead });
  });
}

export function renderCards() {
  var grid = document.getElementById('cards-grid');
  if (!grid) return;
  var coins = _screenerMode ? screenerCoins() : filteredCoins();
  var existing = {};
  grid.querySelectorAll('.coin-card').forEach(function (el) { existing[el.dataset.sym] = el; });

  // Добавляем новые карточки
  var seen = {};
  coins.forEach(function (coin) {
    seen[coin.symbol] = true;
    if (existing[coin.symbol]) return;
    var card = document.createElement('div');
    card.innerHTML = renderCard(coin);
    grid.appendChild(card.firstElementChild);
  });

  // Удаляем исчезнувшие монеты
  Object.keys(existing).forEach(function (sym) {
    if (!seen[sym]) {
      var el = existing[sym]; if (el) el.remove();
      unmountIslands(); // the removed card's head
      try { if (_charts[sym]) _charts[sym].remove(); } catch (e) {}
      if (_levels[sym]) _levels[sym].forEach(function (l) { l.line = null; });
      delete _charts[sym]; delete _fullSeries[sym]; delete _volSeries[sym]; delete _rulers[sym]; delete _chartReady[sym];
      window.__chartSeries = _fullSeries; window.__chartVolSeries = _volSeries; window.__charts = _charts;
    }
  });

  // Переставляем карточки в правильный порядок без уничтожения чартов.
  // insertBefore перемещает существующий DOM-узел — chart canvas едет вместе с ним.
  coins.forEach(function (coin, i) {
    var el = grid.querySelector('.coin-card[data-sym="' + coin.symbol + '"]');
    if (!el) return;
    var current = grid.children[i];
    if (current !== el) grid.insertBefore(el, current || null);
  });

  mountCardHeads(grid);
  initCharts();
  // Синхронизируем display с текущим state после каждого ре-ордера.
  // Без этого sort использует свежие значения state, а DOM показывает значения
  // из _liveTimer (2с-давности) — карточки визуально стоят "не по порядку".
  applyLivePriceUpdates();
}


// ── Page mode ──────────────────────────────────────────────────────────────

var _screenerMode = false;

export function setScreenerMode(val) { _screenerMode = val; }

export function screenerCoins() {
  return state.coins
    .filter(function (c) {
      var sym = c.symbol.toLowerCase();
      return !STABLE_SYMBOLS.has(sym) && !SCREENER_EXCLUDE.has(sym);
    })
    .sort(function (a, b) { return (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0); })
    .slice(0, 6);
}

// ── Charts ─────────────────────────────────────────────────────────────────

var _charts = {}, _fullSeries = {}, _volSeries = {}, _rulers = {}, _chartReady = {}, _dragging = null, _alertDragging = null, _alertDragMoved = false, _alertDragBtn = 2;
var _cardObserver = null;
var _fvChart = null, _fvSeries = null, _fvVolSeries = null, _fvSym = null, _fvLastVol = 0;
var _isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
// Fullscreen popups only on narrow viewports (phones + small tablets).
// Checked at open-time so orientation changes are handled correctly.

// Pre-render alert tag as SVG image for canvas drawing.
// Shape: flat left edge (against left wall), rounded right (into chart). 18×20px.
function _makeBellImg(color) {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="18" viewBox="0 0 16 18">' +
    '<path d="M0,0 L7,0 A9,9 0 0,1 7,18 L0,18 Z" fill="' + color + '"/>' +
    '<g transform="translate(6,9) scale(0.5) translate(-12,-12)">' +
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</g>' +
    '</svg>';
  var img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return img;
}
var _bellImg = _makeBellImg('#ff5050'); // активный — колокольчик
function _makeCheckImg(color) {         // отработанный — check-иконка
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="18" viewBox="0 0 16 18">' +
    '<path d="M0,0 L7,0 A9,9 0 0,1 7,18 L0,18 Z" fill="' + color + '"/>' +
    '<g transform="translate(6,9) scale(0.5) translate(-12,-12)">' +
    '<polyline points="20 6 9 17 4 12" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</g>' +
    '</svg>';
  var img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return img;
}
var _bellImgTriggeredDark  = _makeCheckImg('#6B6060'); // тёмная тема
var _bellImgTriggeredLight = _makeCheckImg('#D1BDBD'); // светлая тема
// Expose for api.js pollCharts (no circular dependency)
window.__chartSeries = _fullSeries;
window.__chartVolSeries = _volSeries;
window.__charts = _charts;

// ── Levels ─────────────────────────────────────────────────────────────────

var _levels = {}; // symbol → [{price, line}]
var _userId = null; // set by setUserId() after session check
var _userEmail = null;
var _userAvatar = null;
var _syncTimer = null;
var _raySyncTimer = null;

export function setUserId(id) {
  _userId = id;
  state.userId = id; // exposed via shared state so api.js can scope its own localStorage keys
  _briefingUserCode = id; // briefing section uses its own var
}

// Local caches (levels/alerts/chatId) must be scoped per account — otherwise
// data left in localStorage by one user leaks into another user's session
// (and even gets re-uploaded to their server-side storage) after switching accounts.
function _userScopedKey(base) { return base + ':' + (_userId || 'anon'); }

export function setUserEmail(email) { _userEmail = email; }
export function getUserEmail() { return _userEmail; }
export function getUserAvatar() { return _userAvatar; }

export function setUserAvatar(av) {
  if (!av) {
    _userAvatar = null;
    localStorage.removeItem(_userScopedKey('pa_avatar'));
  } else {
    _userAvatar = av;
    localStorage.setItem(_userScopedKey('pa_avatar'), av);
  }
  emit('avatar:changed'); // the React header shows it
}

function levelsData() {
  var data = {};
  Object.keys(_levels).forEach(function (sym) {
    if (_levels[sym] && _levels[sym].length) data[sym] = _levels[sym].map(function (l) { return l.price; });
  });
  return data;
}

function syncToServer() {
  if (!_userId) return;
  fetch(API_BASE + '/api/levels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'save', levels: levelsData() }),
  }).catch(function () {});
}

function saveLevels() {
  try { localStorage.setItem(_userScopedKey('pa_levels'), JSON.stringify(levelsData())); } catch (e) {}
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(syncToServer, 1000);
}

function reattachAllLevels() {
  Object.keys(_levels).forEach(function (sym) {
    var s = _fullSeries[sym];
    (_levels[sym] || []).forEach(function (l) {
      if (l.line) { try { if (s) s.removePriceLine(l.line); } catch (e) {} l.line = null; }
    });
    (_levels[sym] || []).forEach(function (l) { attachLevel(sym, l); });
    updateLevelsBtn(sym);
  });
}

function applyServerLevels(data) {
  // Safety guard: if server returned no level data, don't wipe local state.
  if (!data || Object.keys(data).length === 0) return;
  // Remove all existing price lines from charts before replacing _levels
  Object.keys(_levels).forEach(function (sym) {
    var s = _fullSeries[sym];
    (_levels[sym] || []).forEach(function (l) {
      if (l.line && s) { try { s.removePriceLine(l.line); } catch (e) {} }
      if (_fvSeries && _fvSym === sym && l.fvLine) { try { _fvSeries.removePriceLine(l.fvLine); } catch (e) {} }
    });
  });
  _levels = {};
  Object.keys(data).forEach(function (sym) {
    _levels[sym.toLowerCase()] = data[sym].map(function (p) { return { price: p, line: null }; });
  });
  try { localStorage.setItem(_userScopedKey('pa_levels'), JSON.stringify(data)); } catch (e) {}
  reattachAllLevels();
}

export function fetchServerLevels() {
  fetch(API_BASE + '/api/levels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'get' }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d || !d.levels) return;
    var serverEmpty = Object.keys(d.levels).length === 0;
    var localData = levelsData();
    var localHasData = Object.keys(localData).length > 0;
    if (serverEmpty && localHasData) {
      syncToServer();
    } else if (!serverEmpty) {
      applyServerLevels(d.levels);
    }
  }).catch(function () {});
}

export function loadLevels() {
  try {
    var local = JSON.parse(localStorage.getItem(_userScopedKey('pa_levels')) || '{}');
    Object.keys(local).forEach(function (sym) {
      _levels[sym.toLowerCase()] = local[sym].map(function (p) { return { price: p, line: null }; });
    });
  } catch (e) {}
  if (_userId) fetchServerLevels();
}


export var AVATAR_PRESETS = ['🐋','🚀','🎯','🦊','🌙','💎','🔥','⚡','🐂','🐻','🧠','👾'];

// Coins with levels, alerts or rays (the account's Levels & Alerts list)
export function accLevelsSyms() {
  var syms = {};
  Object.keys(_levels).forEach(function (s) { if (_levels[s] && _levels[s].length) syms[s] = 1; });
  Object.keys(_alerts).forEach(function (s) { if (_alerts[s] && _alerts[s].length) syms[s] = 1; });
  Object.keys(_rays).forEach(function (s) { if (_rays[s] && _rays[s].length) syms[s] = 1; });
  return Object.keys(syms).sort();
}


// ── Journal ────────────────────────────────────────────────────────────────

// Journal cards and the weekly report are shadcn dialogs (src/react/host);
// who may open the cards — src/journal-cards.js
export function showMorningModal() { openSurface('morning'); }
export function hideMorningModal() { closeSurface('morning'); }
export function showEveningModal() { openSurface('evening'); }
export function hideEveningModal() { closeSurface('evening'); }
export function showWeeklyReportModal(report) { openSurface('weekly', { report: report }); }
export function hideWeeklyReportModal() { closeSurface('weekly'); }

export function renderProfileJournal(container, entries) {
  if (!entries || !entries.length) {
    container.innerHTML = '<p style="color:var(--graphite);font-size:var(--text-sm);">No journal entries yet.</p>';
    return;
  }
  var header = '<div class="journal-history-header">'
    + '<div>Date</div><div>Trades</div><div>State</div><div>AM</div><div>PM</div><div>PnL</div><div></div>'
    + '</div>';
  container.innerHTML = header + '<div class="journal-history">' + entries.map(function (e) {
    var pnl = e.skipped
      ? '<span class="journal-pnl-pending">—</span>'
      : e.pnl != null
        ? '<span class="journal-pnl ' + (e.pnl > 0 ? 'up' : e.pnl < 0 ? 'dn' : 'neutral') + '">' + (e.pnl >= 0 ? '+' : '-') + '$' + Math.abs(e.pnl).toFixed(2) + '</span>'
        : '<span class="journal-pnl-pending" data-journal-pnl-date="' + e.date + '">…</span>';
    var dateParts = e.date.split('-');
    var dateLabel = dateParts.length === 3 ? dateParts[2] + '.' + dateParts[1] + '.' + dateParts[0].slice(2) : e.date;
    var cells = '<div class="journal-history-date">' + dateLabel + '</div>'
      + '<div class="journal-history-cell">' + (e.tradeCount != null ? e.tradeCount : '—') + '</div>'
      + '<div class="journal-history-text">' + (e.skipped ? 'Skip' : escHtml(e.morningState || '')) + '</div>'
      + '<div class="journal-history-cell">' + (e.morningAt ? icon('check', 14) : '—') + '</div>'
      + '<div class="journal-history-cell">' + (e.eveningAt ? icon('check', 14) : '—') + '</div>'
      + '<div>' + pnl + '</div>';

    var details = '';
    if (e.volume) details += '<div class="journal-history-detail"><span class="journal-history-detail-label">Volume</span>' + escHtml(e.volume) + '</div>';
    if (e.dayPlan) details += '<div class="journal-history-detail"><span class="journal-history-detail-label">Day plan</span>' + escHtml(e.dayPlan) + '</div>';
    if (e.plannedCoins) details += '<div class="journal-history-detail"><span class="journal-history-detail-label">Coins</span>' + escHtml(e.plannedCoins) + '</div>';
    if (e.freeConclusion) details += '<div class="journal-history-detail"><span class="journal-history-detail-label">Notes</span>' + escHtml(e.freeConclusion) + '</div>';

    var rowClass = 'journal-history-row' + (e.skipped ? ' journal-history-row--skipped' : '');
    if (!details) {
      return '<div class="' + rowClass + '">' + cells + '<div class="journal-history-chevron"></div></div>';
    }
    return '<details class="journal-history-item">'
      + '<summary class="' + rowClass + '">' + cells + '<div class="journal-history-chevron">' + icon('chevron-down', 14) + '</div></summary>'
      + '<div class="journal-history-details">' + details + '</div>'
      + '</details>';
  }).join('') + '</div>';

  container.querySelectorAll('[data-journal-pnl-date]').forEach(function (el) {
    var date = el.dataset.journalPnlDate;
    fetchTradesForDate(date).then(function (stats) {
      if (!el.isConnected) return;
      var pnl = stats ? stats.pnl : 0;
      el.outerHTML = '<span class="journal-pnl ' + (pnl > 0 ? 'up' : pnl < 0 ? 'dn' : 'neutral') + '">' + (pnl >= 0 ? '+' : '-') + '$' + Math.abs(pnl).toFixed(2) + '</span>';
    });
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────

export function showToast(message) {
  toast(message);
}

export function clearAllAlerts() {
  Object.keys(_alerts).forEach(function (sym) {
    (_alerts[sym] || []).forEach(function (a) { _removeAlertLine(sym, a); });
    _alerts[sym] = [];
    _updateAlertsBtn(sym);
    redrawAlerts(sym);
  });
  saveAlerts();
}

function attachLevel(sym, lvl) {
  var s = _fullSeries[sym];
  if (s) {
    if (lvl.line) { try { s.removePriceLine(lvl.line); } catch (e) {} }
    lvl.line = s.createPriceLine({ price: lvl.price, color: getCSSVar('--primary'), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, axisLabelColor: getCSSVar('--level-label-bg'), axisLabelTextColor: getCSSVar('--primary'), title: '' });
  }
  if (_fvSeries && _fvSym === sym) {
    if (lvl.fvLine) { try { _fvSeries.removePriceLine(lvl.fvLine); } catch (e) {} }
    lvl.fvLine = _fvSeries.createPriceLine({ price: lvl.price, color: getCSSVar('--primary'), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, axisLabelColor: getCSSVar('--level-label-bg'), axisLabelTextColor: getCSSVar('--primary'), title: '' });
  }
}

function addLevel(sym, price) {
  if (!_levels[sym]) _levels[sym] = [];
  var lvl = { price: price, line: null, fvLine: null };
  _levels[sym].push(lvl);
  attachLevel(sym, lvl);
  saveLevels();
  updateLevelsBtn(sym);
}

function removeLevel(sym, idx) {
  if (!_levels[sym] || _levels[sym][idx] == null) return;
  var lvl = _levels[sym][idx];
  var s = _fullSeries[sym];
  if (s && lvl.line) { try { s.removePriceLine(lvl.line); } catch (e) {} }
  if (_fvSeries && _fvSym === sym && lvl.fvLine) { try { _fvSeries.removePriceLine(lvl.fvLine); } catch (e) {} }
  _levels[sym].splice(idx, 1);
  saveLevels();
  updateLevelsBtn(sym);
}

export function clearLevels(sym) {
  var s = _fullSeries[sym];
  (_levels[sym] || []).forEach(function (l) {
    if (s && l.line) { try { s.removePriceLine(l.line); } catch (e) {} }
    if (_fvSeries && _fvSym === sym && l.fvLine) { try { _fvSeries.removePriceLine(l.fvLine); } catch (e) {} }
  });
  _levels[sym] = [];
  saveLevels();
  updateLevelsBtn(sym);
}

// Levels + alerts + rays of a coin (the full view's clear button shows when > 0)
export function drawingsCount(sym) {
  return (_levels[sym] || []).length + (_alerts[sym] || []).length + (_rays[sym] || []).length;
}

function updateClearBtn() { emit('drawings:changed'); }

function updateLevelsBtn(sym) { updateClearBtn(sym); }

// ── Rays ───────────────────────────────────────────────────────────────────
//
// Horizontal ray: anchored at (time1, price1), drawn from the anchor to the
// right edge of the chart (cross-TF, so time1 is extrapolated rather than
// snapped to a bar via timeToCoordinate — see _rayCoordMap).
//
// Desktop: Ctrl+left-click on empty space adds a ray; Ctrl+left-click on an
// existing ray removes it (or drags it if the mouse moves before release);
// Ctrl+right-click also removes it.

var _rays = {}; // sym → [{id, time1, price1, line, fvLine}]
var _rIdSeed = 0;
var _rayDragging = null;    // card drag: {sym, idx, ray, grabX, grabPrice, grabTime, origPrice1, origTime1}
var _fvRayDragging = null;  // FV drag: same shape (no sym)

var RAY_COLOR = '#d97706';

function _rNewId() { return 'r' + (++_rIdSeed) + '_' + Date.now(); }

// Maps between time and x-coordinate by extrapolating from the last loaded
// candle, so a ray's anchor stays put when switching timeframes (native
// timeToCoordinate snaps to the new TF's bar grid and would jump the anchor).
function _rayCoordMap(chart, sym, tf) {
  var cd = state.chartData[sym + '_' + tf];
  if (!cd || !cd.candles || cd.candles.length < 2) return null;
  var ts = chart.timeScale();
  var n = cd.candles.length;
  var lastT = cd.candles[n - 1].time;
  var prevT = cd.candles[n - 2].time;
  var lastX = ts.timeToCoordinate(lastT);
  var prevX = ts.timeToCoordinate(prevT);
  if (lastX == null || prevX == null || lastX === prevX) return null;
  var pxPerSec = (lastX - prevX) / (lastT - prevT);
  return {
    // Prefer the chart's own mapping when the anchor falls within loaded candles —
    // accurate and immune to drift from setData()+setVisibleRange() reflows after
    // a candle backfill. Extrapolation is the fallback for out-of-grid anchors
    // (e.g. right after a timeframe switch).
    timeToX: function (t) { var x = ts.timeToCoordinate(t); return x != null ? x : lastX + (t - lastT) * pxPerSec; },
    xToTime: function (x) { var t = ts.coordinateToTime(x); return t != null ? t : lastT + (x - lastX) / pxPerSec; },
  };
}

// Serialize rays for storage (no chart refs).
function raysData() {
  var out = {};
  Object.keys(_rays).forEach(function (sym) {
    var arr = _rays[sym];
    if (arr && arr.length) out[sym] = arr.map(function (r) { return { id: r.id, time1: r.time1, price1: r.price1 }; });
  });
  return out;
}

function syncRaysToServer() {
  if (!_userId) return;
  fetch(API_BASE + '/api/rays', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'save', rays: raysData() }),
  }).catch(function () {});
}

function saveRays() {
  try { localStorage.setItem(_userScopedKey('pa_rays'), JSON.stringify(raysData())); } catch (e) {}
  clearTimeout(_raySyncTimer);
  _raySyncTimer = setTimeout(syncRaysToServer, 1000);
}

function applyServerRays(data) {
  if (!data || Object.keys(data).length === 0) return;
  Object.keys(_rays).forEach(function (sym) {
    var s = _fullSeries[sym];
    (_rays[sym] || []).forEach(function (r) {
      if (r.line && s) { try { s.removePriceLine(r.line); } catch (e) {} }
      if (_fvSeries && _fvSym === sym && r.fvLine) { try { _fvSeries.removePriceLine(r.fvLine); } catch (e) {} }
    });
  });
  _rays = {};
  Object.keys(data).forEach(function (sym) {
    _rays[sym.toLowerCase()] = data[sym].map(function (r) {
      return { id: r.id || _rNewId(), time1: r.time1, price1: r.price1, line: null, fvLine: null };
    });
  });
  try { localStorage.setItem(_userScopedKey('pa_rays'), JSON.stringify(data)); } catch (e) {}
  Object.keys(_rays).forEach(function (sym) {
    (_rays[sym] || []).forEach(function (r) { attachRay(sym, r); });
    updateClearBtn(sym);
  });
}

export function fetchServerRays() {
  fetch(API_BASE + '/api/rays', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'get' }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d || !d.rays) return;
    var serverEmpty = Object.keys(d.rays).length === 0;
    var localData = raysData();
    var localHasData = Object.keys(localData).length > 0;
    if (serverEmpty && localHasData) {
      syncRaysToServer();
    } else if (!serverEmpty) {
      applyServerRays(d.rays);
    }
  }).catch(function () {});
}

export function loadRays() {
  try {
    var local = JSON.parse(localStorage.getItem(_userScopedKey('pa_rays')) || '{}');
    Object.keys(local).forEach(function (sym) {
      _rays[sym.toLowerCase()] = local[sym].map(function (r) {
        return { id: r.id || _rNewId(), time1: r.time1, price1: r.price1, line: null, fvLine: null };
      });
    });
  } catch (e) {}
  if (_userId) fetchServerRays();
}

// Price line used only for its axis label (lineVisible:false) — the ray
// itself is drawn on the canvas overlay so it can stop at the anchor.
function attachRay(sym, ray) {
  var opts = { color: RAY_COLOR, lineWidth: 1, lineVisible: false, axisLabelVisible: true, axisLabelColor: getCSSVar('--ray-label-bg'), axisLabelTextColor: RAY_COLOR, title: '' };
  var s = _fullSeries[sym];
  if (s) {
    if (ray.line) { try { s.removePriceLine(ray.line); } catch (e) {} }
    ray.line = s.createPriceLine(Object.assign({ price: ray.price1 }, opts));
  }
  if (_fvSeries && _fvSym === sym) {
    if (ray.fvLine) { try { _fvSeries.removePriceLine(ray.fvLine); } catch (e) {} }
    ray.fvLine = _fvSeries.createPriceLine(Object.assign({ price: ray.price1 }, opts));
  }
}

function addRay(sym, time1, price1) {
  if (!_rays[sym]) _rays[sym] = [];
  var ray = { id: _rNewId(), time1: time1, price1: price1, line: null, fvLine: null };
  _rays[sym].push(ray);
  attachRay(sym, ray);
  saveRays();
  updateClearBtn(sym);
}

function removeRay(sym, idx) {
  if (!_rays[sym] || _rays[sym][idx] == null) return;
  var ray = _rays[sym][idx];
  var s = _fullSeries[sym];
  if (s && ray.line) { try { s.removePriceLine(ray.line); } catch (e) {} }
  if (_fvSeries && _fvSym === sym && ray.fvLine) { try { _fvSeries.removePriceLine(ray.fvLine); } catch (e) {} }
  _rays[sym].splice(idx, 1);
  saveRays();
  updateClearBtn(sym);
}

// Hit-test: within 6px vertically of the ray's price, and not to the left of its anchor (-4px slack for the dot).
function _nearRayIdx(sym, chart, series, tf, px, py) {
  var rays = _rays[sym] || [];
  var map = _rayCoordMap(chart, sym, tf);
  if (!map) return -1;
  for (var i = 0; i < rays.length; i++) {
    var ry = series.priceToCoordinate(rays[i].price1);
    if (ry == null || Math.abs(ry - py) >= 6) continue;
    var rx = map.timeToX(rays[i].time1);
    if (px >= rx - 4) return i;
  }
  return -1;
}

// Draw all rays for sym from their anchor to the right edge of the pane (before the price scale).
function _drawRays(sym, chart, series, ctx, rc) {
  if (!chart || !series) return;
  if (_chartReady[sym] === false) return;
  var tf = state.chartTF[sym] || '5m';
  var map = _rayCoordMap(chart, sym, tf);
  if (!map) return;
  var dpr = window.devicePixelRatio || 1;
  var cssW = rc.width / dpr, cssH = rc.height / dpr;
  var timeAxisH = 0; try { timeAxisH = chart.timeScale().height(); } catch (_) {}
  var paneH = cssH - timeAxisH;
  var psW = 0; try { psW = chart.priceScale('right').width(); } catch (_) {}
  var endX = cssW - psW;
  (_rays[sym] || []).forEach(function (r) {
    var y = series.priceToCoordinate(r.price1);
    if (y == null || y < 0 || y > paneH) return;
    var x = map.timeToX(r.time1);
    if (x >= endX) return;
    ctx.save();
    ctx.strokeStyle = RAY_COLOR; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.max(0, x), y); ctx.lineTo(endX, y); ctx.stroke();
    if (x >= 0) { ctx.fillStyle = RAY_COLOR; ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  });
}

function drawCardRays(sym, ctx, rc) { _drawRays(sym, _charts[sym], _fullSeries[sym], ctx, rc); }

export function clearRays(sym) {
  var s = _fullSeries[sym];
  (_rays[sym] || []).forEach(function (r) {
    if (s && r.line) { try { s.removePriceLine(r.line); } catch (e) {} }
    if (_fvSeries && _fvSym === sym && r.fvLine) { try { _fvSeries.removePriceLine(r.fvLine); } catch (e) {} }
  });
  _rays[sym] = [];
  saveRays();
  updateClearBtn(sym);
}

// Price marks drawn on the chart, for the order book ladder: levels,
// horizontal rays and alerts that have not fired yet. Live objects are read
// on every call, so a dragged line moves in the ladder on its next render.
export function chartMarks(sym) {
  var k = String(sym).toLowerCase(), out = [];
  (_levels[k] || []).forEach(function (l) { out.push({ kind: 'level', price: Number(l.price) }); });
  (_rays[k] || []).forEach(function (r) { out.push({ kind: 'ray', price: Number(r.price1) }); });
  (_alerts[k] || []).forEach(function (a) { if (!a.triggered) out.push({ kind: 'alert', price: Number(a.price) }); });
  return out;
}

// ── Alerts ─────────────────────────────────────────────────────────────────
//
// Architecture: pure data in _alerts, chart references in _aLines (keyed by alert id).
// Lines are updated via applyOptions() — never removed+recreated — so no visual jumps.
//
// _alerts  : sym → [{ id, price, triggered, createdAt }]
// _aLines  : alertId → { card: PriceLine|null, fv: PriceLine|null }

var _alerts = {};
var _aLines = {};       // alertId → { card, fv }
var _aIdSeed = 0;

var _chatId = '';
var _alertSyncTimer = null;

function _aNewId() { return 'a' + (++_aIdSeed) + '_' + Date.now(); }

// Serialize alerts for storage / server (no chart refs).
function alertsData() {
  var out = {};
  Object.keys(_alerts).forEach(function (sym) {
    var arr = _alerts[sym];
    if (arr && arr.length) {
      out[sym] = arr.map(function (a) {
        return { id: a.id, price: a.price, triggered: a.triggered, createdAt: a.createdAt };
      });
    }
  });
  return out;
}

function alertLineOpts(a) {
  return { color: a.triggered ? (isDark() ? '#6B6060' : '#D1BDBD') : getCSSVar('--danger'), lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' };
}

// Create or update the price lines for a single alert (idempotent).
// Uses applyOptions() when the line already exists — no flickering, no coordinate jumps.
function _syncAlertLine(sym, a) {
  if (!_aLines[a.id]) _aLines[a.id] = { card: null, fv: null };
  var refs = _aLines[a.id];
  var opts = Object.assign({ price: a.price }, alertLineOpts(a));

  // Card chart line
  var s = _fullSeries[sym];
  if (s) {
    if (refs.card) {
      try { refs.card.applyOptions(opts); } catch (e) { refs.card = null; }
    }
    if (!refs.card) {
      try { refs.card = s.createPriceLine(opts); } catch (e) {}
    }
  } else {
    refs.card = null;
  }

  // FV chart line
  if (_fvSeries && _fvSym === sym) {
    if (refs.fv) {
      try { refs.fv.applyOptions(opts); } catch (e) { refs.fv = null; }
    }
    if (!refs.fv) {
      try { refs.fv = _fvSeries.createPriceLine(opts); } catch (e) {}
    }
  }
}

// Permanently remove both chart lines for an alert and delete its entry.
function _removeAlertLine(sym, a) {
  var refs = _aLines[a.id];
  if (!refs) return;
  var s = _fullSeries[sym];
  if (refs.card && s) { try { s.removePriceLine(refs.card); } catch (e) {} }
  if (refs.fv && _fvSeries && _fvSym === sym) { try { _fvSeries.removePriceLine(refs.fv); } catch (e) {} }
  delete _aLines[a.id];
}

// Remove FV line only (called when FV switches to a different coin).
// Always nulls refs.fv — even if _fvSeries is already gone (chart destroyed before this call).
function _detachFvLine(a) {
  var refs = _aLines[a.id];
  if (!refs) return;
  if (refs.fv && _fvSeries) { try { _fvSeries.removePriceLine(refs.fv); } catch (e) {} }
  refs.fv = null;
}

// Sync all lines for a sym (call after data changes or chart becomes ready).
function _syncAlerts(sym) {
  (_alerts[sym] || []).forEach(function (a) { _syncAlertLine(sym, a); });
  _updateAlertsBtn(sym);
  redrawAlerts(sym);
}

// Sync all syms (after applyServerAlerts or full reattach).
function _syncAllAlerts() {
  Object.keys(_alerts).forEach(function (sym) { _syncAlerts(sym); });
}

function _updateAlertsBtn(sym) { updateClearBtn(sym); }

function saveAlerts() {
  try { localStorage.setItem(_userScopedKey('pa_alerts'), JSON.stringify(alertsData())); } catch (e) {}
  // Push via WS immediately so server is up-to-date before any pending HTTP response.
  if (_userId) sendWS({ type: 'save_alerts', code: _userId, chatId: _chatId, data: alertsData() });
  clearTimeout(_alertSyncTimer);
  _alertSyncTimer = setTimeout(syncAlertsToServer, 1000);
}

function syncAlertsToServer() {
  if (!_userId) return;
  var data = alertsData();
  sendWS({ type: 'save_alerts', code: _userId, chatId: _chatId, data: data });
  fetch(API_BASE + '/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'save', chatId: _chatId, data: data }),
  }).catch(function () {});
}

function applyServerAlerts(entry) {
  // Guard: server returned nothing — preserve local state, only update chatId.
  if (!entry || !entry.data || Object.keys(entry.data).length === 0) {
    if (entry && entry.chatId) { _chatId = entry.chatId; localStorage.setItem(_userScopedKey('pa_chat_id'), _chatId); }
    return;
  }
  // Remove chart lines for every current alert before replacing data.
  Object.keys(_alerts).forEach(function (sym) {
    (_alerts[sym] || []).forEach(function (a) { _removeAlertLine(sym, a); });
  });
  _alerts = {};
  Object.keys(entry.data).forEach(function (sym) {
    var symLc = sym.toLowerCase();
    _alerts[symLc] = entry.data[sym].map(function (a) {
      return { id: a.id || _aNewId(), price: a.price, triggered: a.triggered || false, createdAt: a.createdAt };
    });
  });
  if (entry.chatId) { _chatId = entry.chatId; localStorage.setItem(_userScopedKey('pa_chat_id'), _chatId); }
  try { localStorage.setItem(_userScopedKey('pa_alerts'), JSON.stringify(alertsData())); } catch (e) {}
  _syncAllAlerts();
}

function fetchServerAlerts() {
  fetch(API_BASE + '/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'get' }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d) return;
    var serverHasData = d.data && Object.keys(d.data).length > 0;
    if (serverHasData) {
      // Skip applying server data if there's a pending local save — the save will
      // commit the correct state (including newly added alerts) to the server.
      // Without this guard, a fast GET response can overwrite a just-added alert
      // before the 1s debounced syncAlertsToServer fires.
      if (!_alertSyncTimer) applyServerAlerts(d);
    } else {
      var localHasData = Object.keys(alertsData()).length > 0;
      if (localHasData) syncAlertsToServer();
    }
  }).catch(function () {});
}

export function loadAlerts() {
  try {
    var local = JSON.parse(localStorage.getItem(_userScopedKey('pa_alerts')) || '{}');
    Object.keys(local).forEach(function (sym) {
      _alerts[sym.toLowerCase()] = local[sym].map(function (a) {
        return { id: a.id || _aNewId(), price: a.price, triggered: a.triggered || false, createdAt: a.createdAt };
      });
    });
    _chatId = localStorage.getItem(_userScopedKey('pa_chat_id')) || '';
  } catch (e) {}
  if (_userId) fetchServerAlerts();
}

function addAlert(sym, price) {
  if (state.isDemoMode) {
    toast('Price alerts require an account', { duration: 4000, action: { label: 'Sign up free', onClick: function () { window.location.href = '/login'; } } });
    return;
  }
  if (!_alerts[sym]) _alerts[sym] = [];
  var a = { id: _aNewId(), price: price, triggered: false, createdAt: Date.now() };
  _alerts[sym].push(a);
  _syncAlertLine(sym, a);
  saveAlerts();
  _updateAlertsBtn(sym);
  redrawAlerts(sym);
}

function removeAlert(sym, idx) {
  if (!_alerts[sym] || !_alerts[sym][idx]) return;
  _removeAlertLine(sym, _alerts[sym][idx]);
  _alerts[sym].splice(idx, 1);
  saveAlerts();
  _updateAlertsBtn(sym);
  redrawAlerts(sym);
}

export function clearAlerts(sym) {
  (_alerts[sym] || []).forEach(function (a) { _removeAlertLine(sym, a); });
  _alerts[sym] = [];
  saveAlerts();
  _updateAlertsBtn(sym);
  redrawAlerts(sym);
}

// Triggered by WS event from server. Matches by price with a small tolerance
// to handle any floating-point round-trip differences.
export function handleAlertTriggered(sym, price) {
  var arr = _alerts[sym] || [];
  for (var i = 0; i < arr.length; i++) {
    var a = arr[i];
    if (a.triggered) continue;
    var tol = Math.max(Math.abs(a.price) * 1e-9, 1e-12);
    if (Math.abs(a.price - price) <= tol) {
      a.triggered = true;
      _syncAlertLine(sym, a); // updates existing line via applyOptions — no coordinate jump
      redrawAlerts(sym);
      saveAlerts();
      return; // only mark the first matching untriggered alert
    }
  }
  // Price didn't match any known alert (can happen if opened in new window after trigger).
  // Don't call saveAlerts() here — don't overwrite server state with stale local data.
  redrawAlerts(sym);
}

function isDark() {
  var t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function initTheme() {
  var saved = localStorage.getItem('theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
}

export function toggleTheme() {
  var next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  render();
  reattachAllLevels();
  if (_fvChart) {
    var fc = getChartColors();
    _fvChart.applyOptions({ layout: { background: { color: getCSSVar('--cloud') }, textColor: fc.text }, grid: { vertLines: { color: fc.grid }, horzLines: { color: fc.grid } }, rightPriceScale: { borderColor: fc.border }, timeScale: { borderColor: fc.border } });
    if (_fvSeries) _fvSeries.applyOptions(getSeriesColors());
  }
}

export function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getChartColors() {
  return {
    bg: getCSSVar('--canvas'),
    text: isDark() ? getCSSVar('--graphite') : getCSSVar('--steel'),
    grid: isDark() ? 'rgba(255,255,255,0.04)' : 'rgba(232,232,232,0.5)',
    border: getCSSVar('--steel'),
  };
}

export function getSeriesColors() {
  var up = getCSSVar('--candle-up'), dn = getCSSVar('--candle-dn') || getCSSVar('--steel');
  var grey = getCSSVar('--graphite');
  return { upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn, priceLineColor: grey };
}

export function calcPriceFormat(price) {
  if (!price || price <= 0) return { type: 'price', precision: 4, minMove: 0.0001 };
  if (price < 0.00001) return { type: 'price', precision: 8, minMove: 0.00000001 };
  if (price < 0.0001)  return { type: 'price', precision: 7, minMove: 0.0000001 };
  if (price < 0.001)   return { type: 'price', precision: 6, minMove: 0.000001 };
  if (price < 0.01)    return { type: 'price', precision: 5, minMove: 0.00001 };
  if (price < 0.1)     return { type: 'price', precision: 4, minMove: 0.0001 };
  if (price < 1)       return { type: 'price', precision: 4, minMove: 0.0001 };
  if (price < 10)      return { type: 'price', precision: 3, minMove: 0.001 };
  if (price < 100)     return { type: 'price', precision: 2, minMove: 0.01 };
  if (price < 10000)   return { type: 'price', precision: 1, minMove: 0.1 };
  return { type: 'price', precision: 0, minMove: 1 };
}

// Форматирует Unix timestamp (секунды) в эффективном часовом поясе
// (настройка Account, либо часовой пояс браузера, если не задана).
function _localTimeFmt(ts) {
  var p = tzParts(new Date(ts * 1000));
  return p.weekday + ', ' + p.day + ' ' + p.month + ', ' + p.hour + ':' + p.minute;
}

// Форматирует метки на оси времени с учётом уровня детализации
function _tickMarkFmt(ts, type) {
  var p = tzParts(new Date(ts * 1000));
  // type: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
  if (type <= 1) return p.month + ' ' + p.year;
  if (type === 2) return p.day + ' ' + p.month;
  return p.hour + ':' + p.minute;
}

export function getChartOpts() {
  var c = getChartColors();
  return {
    autoSize: true,
    layout: { background: { color: c.bg }, textColor: c.text, fontSize: 11, fontFamily: 'Manrope, Arial, sans-serif' },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    crosshair: { mode: 0 },
    rightPriceScale: { visible: true, borderColor: c.border, scaleMargins: { top: 0.05, bottom: 0.25 } },
    timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false, tickMarkFormatter: _tickMarkFmt, rightOffset: 5 },
    localization: { timeFormatter: _localTimeFmt },
    handleScroll: true, handleScale: true,
  };
}

function fetchChart(symbol, tf) {
  tf = tf || state.chartTF[symbol] || '5m';
  var key = symbol + '_' + tf;
  if (state.chartData[key] && state.chartData[key].status === 'ok') { updateChart(symbol); return; }
  fetchChartData(symbol, tf).then(function () { updateChart(symbol); });
}

function updateChart(symbol) {
  var s = _fullSeries[symbol], chart = _charts[symbol];
  if (!s || !chart) return;
  var tf = state.chartTF[symbol] || '5m';
  var cd = state.chartData[symbol + '_' + tf];
  if (!cd || cd.status !== 'ok' || !cd.candles.length) return;
  var lastClose = cd.candles[cd.candles.length - 1].close;
  s.applyOptions({ priceFormat: calcPriceFormat(lastClose) });
  s.setData(cd.candles);
  var vs = _volSeries[symbol];
  if (vs) vs.setData(cd.candles.map(function (c) {
    var vu = getCSSVar('--vol-up'), vd = getCSSVar('--vol-dn'); return { time: c.time, value: c.volume || 0, color: c.close >= c.open ? vu : vd };
  }));
  var total = cd.candles.length;
  var visibleCandles = 80;
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - visibleCandles), to: total + 4 });
  _syncAlerts(symbol);
  // Дать time scale один кадр на пересчёт координат под новый видимый диапазон,
  // прежде чем разрешить рисовать лучи — иначе _drawRays успевает поймать
  // промежуточные координаты (под старый диапазон) и луч "доезжает" на следующем кадре.
  requestAnimationFrame(function () { _chartReady[symbol] = true; });
}

export function setChartTF(symbol, tf) {
  state.chartTF[symbol] = tf;
  clearRuler(symbol);
  fetchChart(symbol, tf); // the card head (React) shows the new timeframe on its tick
}

export function clearAllCrosshairs() {
  Object.keys(_charts).forEach(function (sym) {
    try { _charts[sym].clearCrosshairPosition(); } catch (e) {}
  });
  if (_fvChart) { try { _fvChart.clearCrosshairPosition(); } catch (e) {} }
}

// ── Scroll lock (iOS-safe) ──────────────────────────────────────────────────
// On iOS, body{overflow:hidden} alone doesn't prevent elastic scroll.
// The body-freeze pattern (position:fixed + saved scrollY) is reliable.
var _scrollLockCount = 0;
var _scrollLockY = 0;

function lockScroll() {
  _scrollLockCount++;
  if (_scrollLockCount > 1) return; // already locked
  _scrollLockY = window.scrollY || 0;
  document.body.style.overflow = 'hidden';
  document.body.style.position = 'fixed';
  document.body.style.top = '-' + _scrollLockY + 'px';
  document.body.style.width = '100%';
}

function unlockScroll() {
  _scrollLockCount = Math.max(0, _scrollLockCount - 1);
  if (_scrollLockCount > 0) return; // another modal still open
  document.body.style.overflow = '';
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  window.scrollTo(0, _scrollLockY);
  _scrollLockY = 0;
}

// Hard reset — call when closing all modals at once (e.g. back button)
export function forceUnlockScroll() {
  _scrollLockCount = 0;
  document.body.style.overflow = '';
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
}

// Force repaint of all open fixed overlays after orientation change
export function reapplyOverlayPositions() {
  var ids = ['fv-overlay'];
  ids.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    var d = el.style.display;
    if (!d || d === 'none') return;
    // Trigger reflow — iOS needs this after viewport resize
    el.style.transform = 'translateZ(0)';
    // eslint-disable-next-line no-unused-expressions
    el.offsetHeight;
    requestAnimationFrame(function () { el.style.transform = ''; });
  });
}


export function destroyCharts() {
  if (_cardObserver) { _cardObserver.disconnect(); _cardObserver = null; }
  Object.keys(_charts).forEach(function (sym) { try { _charts[sym].remove(); } catch (e) { } });
  Object.keys(_levels).forEach(function (sym) { if (_levels[sym]) _levels[sym].forEach(function (l) { l.line = null; }); });
  // Nullify card-chart line refs in _aLines (chart is gone, refs are stale).
  Object.keys(_alerts).forEach(function (sym) {
    (_alerts[sym] || []).forEach(function (a) { if (_aLines[a.id]) _aLines[a.id].card = null; });
  });
  _charts = {}; _fullSeries = {}; _volSeries = {}; _rulers = {};
  window.__chartSeries = _fullSeries;
  window.__chartVolSeries = _volSeries;
  window.__charts = _charts;
}

// Force lightweight-charts to re-measure against the current container size.
// On mobile, returning from background can leave the chart's internal time-scale
// layout desynced from the canvas (rays/alerts drift horizontally) until a full
// page reload — this nudges each chart to recompute without recreating it.
export function resyncChartLayouts() {
  Object.keys(_charts).forEach(function (sym) {
    var el = document.getElementById('chart-' + sym);
    var chart = _charts[sym];
    if (!el || !chart) return;
    try { chart.resize(el.offsetWidth, el.offsetHeight || 300, true); } catch (e) {}
    if (_rulers[sym] && _rulers[sym].canvas) _setCanvasSize(_rulers[sym].canvas, el.offsetWidth, el.offsetHeight || 300);
  });
  if (_fvChart) {
    var fvEl = document.getElementById('fv-chart');
    if (fvEl) { try { _fvChart.resize(fvEl.offsetWidth, fvEl.offsetHeight, true); } catch (e) {} }
    if (_fvRuler && _fvRuler.canvas) {
      var fvWrap = document.querySelector('.fv-chart-wrap');
      if (fvWrap) _setCanvasSize(_fvRuler.canvas, fvWrap.offsetWidth, fvWrap.offsetHeight);
    }
  }
}
window.__resyncChartLayouts = resyncChartLayouts;

function _setCanvasSize(rc, cssW, cssH) {
  var dpr = window.devicePixelRatio || 1;
  rc.width = Math.round(cssW * dpr); rc.height = Math.round(cssH * dpr);
  rc.style.width = cssW + 'px'; rc.style.height = cssH + 'px';
}

function drawRuler(sym, p1, p2, pr1, pr2) {
  var ruler = _rulers[sym]; if (!ruler || !ruler.canvas) return;
  var rc = ruler.canvas, ctx = rc.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, rc.width, rc.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  var cw = rc.width / dpr, ch = rc.height / dpr;
  drawAlertIcons(sym, ctx, rc);
  drawCardRays(sym, ctx, rc);
  if (!p1 || !p2 || pr1 == null || pr2 == null) return;
  var pct = ((pr2 - pr1) / Math.abs(pr1) * 100);
  var pctStr = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  var durStr = '';
  var chart = _charts[sym];
  if (chart) {
    var ts = chart.timeScale();
    var t1 = ts.coordinateToTime(p1.x), t2 = ts.coordinateToTime(p2.x);
    if (t1 == null || t2 == null) {
      var vr = ts.getVisibleRange();
      if (vr) {
        if (t1 == null) t1 = p1.x < p2.x ? vr.from : vr.to;
        if (t2 == null) t2 = p2.x > p1.x ? vr.to : vr.from;
      }
    }
    if (t1 != null && t2 != null) {
      var d = Math.abs(t2 - t1);
      durStr = d < 60 ? Math.round(d) + 's' : d < 3600 ? Math.round(d / 60) + 'm' : d < 86400 ? Math.floor(d / 3600) + 'h ' + Math.round((d % 3600) / 60) + 'm' : Math.floor(d / 86400) + 'd ' + Math.floor((d % 86400) / 3600) + 'h';
    }
  }
  var color = isDark() ? getCSSVar('--ink-deep') : getCSSVar('--graphite');
  var priceAxisW = 0; try { if (chart) priceAxisW = chart.priceScale('right').width(); } catch (_) {}
  // Fill zone between the two price levels
  ctx.fillStyle = 'rgba(150,150,150,0.07)';
  ctx.fillRect(0, Math.min(p1.y, p2.y), cw, Math.abs(p2.y - p1.y) || 1);
  // Horizontal dashed line at start price level only
  ctx.strokeStyle = isDark() ? getCSSVar('--graphite') : getCSSVar('--graphite'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, p1.y); ctx.lineTo(cw, p1.y); ctx.stroke();
  // Diagonal line from start to end point
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
  // Dots at endpoints
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(p1.x, p1.y, 2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(p2.x, p2.y, 2, 0, Math.PI * 2); ctx.fill();
  // Label — div overlay (avoids canvas sub-pixel jitter)
  var lbl = ruler.label;
  if (lbl) {
    ctx.font = '500 10px Manrope,Arial,sans-serif';
    var sign = pctStr[0], digits = pctStr.slice(1);
    var maxW = Math.max(ctx.measureText(digits).width, durStr ? ctx.measureText(durStr).width : 0);
    var flipLeft = p2.x + 16 + maxW + 16 > cw - priceAxisW;
    var plateHalf = durStr ? 16 : 8;
    var dpr = window.devicePixelRatio || 1;
    var snappedY = Math.round(p2.y * dpr) / dpr;
    var clampedY = Math.max(plateHalf, Math.min(ch - plateHalf, snappedY));
    lbl.style.left = p2.x + 'px';
    lbl.style.top = clampedY + 'px';
    lbl.style.transform = flipLeft ? 'translate(calc(-100% - 16px),-50%)' : 'translate(16px,-50%)';
    lbl.innerHTML =
      '<div style="display:flex"><span style="min-width:.55em;text-align:right">' + sign + '</span><span>' + digits + '</span></div>' +
      (durStr ? '<div style="display:flex"><span style="min-width:.55em"></span><span>' + durStr + '</span></div>' : '');
    lbl.style.display = 'flex';
  }
}

function drawAlertLabel(ctx, a, y, labelX) {
  if (!a.createdAt) return;
  var d = new Date(a.createdAt);
  var label = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: effectiveTZ() }) +
              ' ' + d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: effectiveTZ() });
  ctx.font = '10px Manrope, Arial, sans-serif';
  var tw = ctx.measureText(label).width;
  var px = 4, bh = 14;
  var bx = labelX;
  var by = Math.round(y - bh / 2);
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(bx, by, tw + px * 2, bh);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, bx + px, by + 10);
}

function drawAlertIcons(sym, ctx, rc) {
  var s = _fullSeries[sym]; if (!s) return;
  if (!_bellImg || !_bellImg.complete) return;
  var dpr = window.devicePixelRatio || 1;
  var cssW = rc.width / dpr, cssH = rc.height / dpr;
  var chart = _charts[sym];
  var timeAxisH = 0; try { if (chart) timeAxisH = chart.timeScale().height(); } catch (_) {}
  var paneH = cssH - timeAxisH;
  var alerts = _alerts[sym] || [];
  var tagW = 16, tagH = 18;
  alerts.forEach(function (a) {
    // During drag use exact mouse Y so icon tracks cursor without lag
    var y = (_alertDragging && _alertDragging.sym === sym && _alertDragging.alert === a && _alertDragging.dragY != null)
      ? _alertDragging.dragY
      : s.priceToCoordinate(a.price);
    if (y == null || y < 0 || y + tagH / 2 > paneH) return;
    var bellX = 0;
    ctx.save();
    ctx.drawImage(a.triggered ? (isDark() ? _bellImgTriggeredDark : _bellImgTriggeredLight) : _bellImg, bellX, y - tagH / 2, tagW, tagH);
    drawAlertLabel(ctx, a, y, bellX + tagW + 4);
    ctx.restore();
  });
}

function redrawAlerts(sym) {
  var ruler = _rulers[sym]; if (!ruler || !ruler.canvas) return;
  if (ruler.start) return; // ruler draw cycle is active, it handles the canvas
  var rc = ruler.canvas, ctx = rc.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, rc.width, rc.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawAlertIcons(sym, ctx, rc);
  drawCardRays(sym, ctx, rc);
}

function clearRuler(sym) {
  var ruler = _rulers[sym]; if (!ruler) return;
  ruler.start = null;
  if (ruler.label) ruler.label.style.display = 'none';
  redrawAlerts(sym);
}

// Attach mouse/resize event listeners to a chart container once.
// Uses dynamic _fullSeries[sym] / _charts[sym] lookups so listeners survive chart recreate.
function _attachChartEvents(sym, container) {
  if (container.dataset.eventsAttached) return;
  container.dataset.eventsAttached = '1';

  // On Mac trackpads: vertical scroll passes through to the page; horizontal pans the chart.
  // Skipped on non-Mac (Windows/Linux) so mouse wheel zoom works normally.
  container.addEventListener('wheel', function (e) {
    if (!/Mac/.test(navigator.platform)) return;
    if (e.ctrlKey) return; // pinch-to-zoom — let chart handle
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal swipe — let chart pan
    e.stopPropagation();
  }, { passive: true, capture: true });

  container.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var cs = _fullSeries[sym]; if (!cs) return;
    var rect = container.getBoundingClientRect();
    var y = e.clientY - rect.top;
    var price = cs.coordinateToPrice(y);
    if (price == null) return;
    if (e.ctrlKey) {
      // On macOS, Ctrl+click is rewritten by the OS into a contextmenu event
      // (no plain mousedown ever fires), so "add ray" must be handled here too.
      var x = e.clientX - rect.left;
      var tfCm = state.chartTF[sym] || '5m';
      var idx = _nearRayIdx(sym, _charts[sym], cs, tfCm, x, y);
      if (idx >= 0) { removeRay(sym, idx); return; }
      var mapCm = _rayCoordMap(_charts[sym], sym, tfCm);
      var timeCm = mapCm ? mapCm.xToTime(x) : null;
      if (price != null && timeCm != null) addRay(sym, timeCm, price);
      return;
    }
    if (e.shiftKey) {
      if (_alertDragMoved) { _alertDragMoved = false; return; }
      var alerts = _alerts[sym] || [];
      for (var i = 0; i < alerts.length; i++) {
        var ay = cs.priceToCoordinate(alerts[i].price);
        if (ay != null && Math.abs(ay - y) < 10) { removeAlert(sym, i); return; }
      }
      addAlert(sym, price);
    } else {
      var levels = _levels[sym] || [];
      for (var i = 0; i < levels.length; i++) {
        var ly = cs.priceToCoordinate(levels[i].price);
        if (ly != null && Math.abs(ly - y) < 10) { removeLevel(sym, i); return; }
      }
      addLevel(sym, price);
    }
  });

  container.addEventListener('mousedown', function (e) {
    var cs = _fullSeries[sym], ch = _charts[sym];
    var rect = container.getBoundingClientRect();
    var priceAxisW = 0;
    try { if (ch) priceAxisW = ch.priceScale('right').width(); } catch (_) {}
    if (e.clientX - rect.left > rect.width - priceAxisW - 2) return;

    if (e.button === 0) {
      if (!cs) return;
      var y = e.clientY - rect.top;
      // Ctrl+left: add a ray, or grab an existing one to drag
      if (e.ctrlKey) {
        var ch0 = _charts[sym];
        var x0 = e.clientX - rect.left;
        var tf0 = state.chartTF[sym] || '5m';
        e.stopPropagation(); e.preventDefault();
        var rIdx = _nearRayIdx(sym, ch0, cs, tf0, x0, y);
        if (rIdx >= 0) {
          var ray = _rays[sym][rIdx];
          var map0 = _rayCoordMap(ch0, sym, tf0);
          var grabPrice = cs.coordinateToPrice(y), grabTime = map0 ? map0.xToTime(x0) : null;
          if (grabPrice != null && grabTime != null) {
            _rayDragging = { sym: sym, idx: rIdx, ray: ray, grabPrice: grabPrice, grabTime: grabTime, origPrice1: ray.price1, origTime1: ray.time1, moved: false };
            container.style.cursor = 'move';
          }
          return;
        }
        var map1 = _rayCoordMap(ch0, sym, tf0);
        var price1 = cs.coordinateToPrice(y), time1 = map1 ? map1.xToTime(x0) : null;
        if (price1 != null && time1 != null) addRay(sym, time1, price1);
        return;
      }
      // Shift+Alt+left: drag alert (trackpad alternative to Shift+right-drag)
      if (e.altKey && e.shiftKey) {
        var alertArr0 = _alerts[sym] || [];
        for (var ai0 = 0; ai0 < alertArr0.length; ai0++) {
          var aCoord0 = cs.priceToCoordinate(alertArr0[ai0].price);
          if (aCoord0 != null && Math.abs(aCoord0 - y) < 8) {
            if (alertArr0[ai0].triggered) return;
            e.stopPropagation(); e.preventDefault();
            _alertDragging = { sym: sym, idx: ai0, alert: alertArr0[ai0] };
            _alertDragMoved = false; _alertDragBtn = 0;
            container.style.cursor = 'ns-resize';
            return;
          }
        }
        return;
      }
      // Alt+left: ruler (trackpad alternative to middle-click drag)
      if (e.altKey) {
        e.stopPropagation(); e.preventDefault();
        var pt0 = { x: e.clientX - rect.left, y: y };
        var pr0 = cs.coordinateToPrice(y);
        if (pr0 != null && _rulers[sym]) { _rulers[sym].start = { pt: pt0, price: pr0 }; _rulers[sym]._altRuler = true; }
        return;
      }
      var levels = _levels[sym] || [];
      for (var i = 0; i < levels.length; i++) {
        var ly = cs.priceToCoordinate(levels[i].price);
        if (ly != null && Math.abs(ly - y) < 6) {
          e.stopPropagation(); e.preventDefault();
          _dragging = { sym: sym, idx: i, lvl: levels[i] };
          container.style.cursor = 'ns-resize';
          return;
        }
      }
      return;
    }
    if (e.button === 2 && e.shiftKey) {
      if (!cs) return;
      var alertY = e.clientY - rect.top;
      var alertArr = _alerts[sym] || [];
      for (var ai = 0; ai < alertArr.length; ai++) {
        var aCoord = cs.priceToCoordinate(alertArr[ai].price);
        if (aCoord != null && Math.abs(aCoord - alertY) < 8) {
          if (alertArr[ai].triggered) return;
          e.stopPropagation(); e.preventDefault();
          _alertDragging = { sym: sym, idx: ai, alert: alertArr[ai] };
          _alertDragMoved = false; _alertDragBtn = 2;
          container.style.cursor = 'ns-resize';
          return;
        }
      }
    }
    if (e.button !== 1) return;
    if (!cs) return;
    e.preventDefault();
    var pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    var pr = cs.coordinateToPrice(pt.y);
    if (pr != null && _rulers[sym]) _rulers[sym].start = { pt: pt, price: pr };
  }, { capture: true });

  container.addEventListener('mousemove', function (e) {
    var cs = _fullSeries[sym];
    var rect = container.getBoundingClientRect();
    var y = e.clientY - rect.top;
    if (_rayDragging && _rayDragging.sym === sym && (e.buttons & 1)) {
      if (cs) {
        var ch1 = _charts[sym], x1 = e.clientX - rect.left;
        var map2 = _rayCoordMap(ch1, sym, state.chartTF[sym] || '5m');
        var curPrice = cs.coordinateToPrice(y), curTime = map2 ? map2.xToTime(x1) : null;
        if (curPrice != null && curTime != null) {
          var ray = _rayDragging.ray;
          ray.price1 = _rayDragging.origPrice1 + (curPrice - _rayDragging.grabPrice);
          ray.time1 = _rayDragging.origTime1 + (curTime - _rayDragging.grabTime);
          _rayDragging.moved = true;
          if (ray.line) ray.line.applyOptions({ price: ray.price1 });
          if (ray.fvLine) ray.fvLine.applyOptions({ price: ray.price1 });
        }
      }
      return;
    }
    if (_dragging && _dragging.sym === sym && (e.buttons & 1)) {
      if (cs) {
        var price = cs.coordinateToPrice(y);
        if (price != null && _dragging.lvl.line) { _dragging.lvl.price = price; _dragging.lvl.line.applyOptions({ price: price }); }
      }
      return;
    }
    if (_alertDragging && _alertDragging.sym === sym && (e.buttons & (_alertDragBtn === 0 ? 1 : 2))) {
      if (cs) {
        var alertPrice = cs.coordinateToPrice(y);
        if (alertPrice != null) {
          _alertDragging.alert.price = alertPrice;
          var _dragRefs = _aLines[_alertDragging.alert.id];
          if (_dragRefs) {
            if (_dragRefs.card) { try { _dragRefs.card.applyOptions({ price: alertPrice }); } catch (e) {} }
            if (_dragRefs.fv)   { try { _dragRefs.fv.applyOptions({ price: alertPrice }); } catch (e) {} }
          }
          _alertDragging.dragY = y;
          _alertDragMoved = true;
          redrawAlerts(sym);
        }
      }
      return;
    }
    if (cs) {
      var levels = _levels[sym] || [];
      var near = false;
      for (var j = 0; j < levels.length; j++) {
        var ly2 = cs.priceToCoordinate(levels[j].price);
        if (ly2 != null && Math.abs(ly2 - y) < 6) { near = true; break; }
      }
      if (!near && e.shiftKey) {
        var alertsHint = _alerts[sym] || [];
        for (var ak = 0; ak < alertsHint.length; ak++) {
          var ayk = cs.priceToCoordinate(alertsHint[ak].price);
          if (ayk != null && Math.abs(ayk - y) < 8) { near = true; break; }
        }
      }
      container.style.cursor = near ? 'ns-resize' : '';
      var ruler = _rulers[sym];
      if (ruler && ruler.start && ((e.buttons & 4) || (ruler._altRuler && (e.buttons & 1)))) {
        var pt = { x: e.clientX - rect.left, y: y };
        drawRuler(sym, ruler.start.pt, pt, ruler.start.price, cs.coordinateToPrice(y));
      }
    }
  });

  container.addEventListener('mouseup', function (e) {
    if (e.button === 0 && _rayDragging && _rayDragging.sym === sym) {
      var rd = _rayDragging; _rayDragging = null; container.style.cursor = '';
      if (!rd.moved) removeRay(sym, rd.idx); else saveRays();
      return;
    }
    if (e.button === 0 && _dragging && _dragging.sym === sym) {
      _dragging = null; container.style.cursor = ''; saveLevels(); return;
    }
    if (_alertDragging && _alertDragging.sym === sym && e.button === _alertDragBtn) {
      var adSym = _alertDragging.sym; _alertDragging = null; _alertDragBtn = 2; container.style.cursor = ''; saveAlerts(); redrawAlerts(adSym); return;
    }
    if (e.button === 1 || (e.button === 0 && _rulers[sym] && _rulers[sym]._altRuler)) {
      if (_rulers[sym]) _rulers[sym]._altRuler = false;
      clearRuler(sym);
    }
  });

  container.addEventListener('mouseleave', function () {
    if (_rayDragging && _rayDragging.sym === sym) { _rayDragging = null; container.style.cursor = ''; saveRays(); }
    if (_dragging && _dragging.sym === sym) { _dragging = null; saveLevels(); }
    if (_alertDragging && _alertDragging.sym === sym) { var adLeaveSym = _alertDragging.sym; _alertDragging = null; _alertDragBtn = 2; saveAlerts(); redrawAlerts(adLeaveSym); }
    container.style.cursor = '';
    if (_rulers[sym]) _rulers[sym]._altRuler = false;
    clearRuler(sym);
  });

  new ResizeObserver(function () {
    if (_charts[sym]) _charts[sym].resize(container.offsetWidth, container.offsetHeight || 300);
    if (_rulers[sym] && _rulers[sym].canvas) { _setCanvasSize(_rulers[sym].canvas, container.offsetWidth, container.offsetHeight); }
  }).observe(container);
}

function _initChartForSym(sym) {
  if (!window.LightweightCharts) return;
  var el = document.getElementById('chart-' + sym);
  if (!el || _charts[sym]) return;
  var chart = window.LightweightCharts.createChart(el, getChartOpts());
  var s = chart.addCandlestickSeries(getSeriesColors());
  var vs = chart.addHistogramSeries({ color: getCSSVar('--steel'), priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  _charts[sym] = chart; _fullSeries[sym] = s; _volSeries[sym] = vs; _chartReady[sym] = false;
  window.__chartSeries = _fullSeries; window.__chartVolSeries = _volSeries; window.__charts = _charts;
  var rc = document.createElement('canvas');
  rc.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:5;';
  el.style.position = 'relative'; el.appendChild(rc);
  _setCanvasSize(rc, el.offsetWidth || 400, el.offsetHeight || 300);
  var lbl = document.createElement('div');
  lbl.className = 'ruler-lbl';
  el.appendChild(lbl);
  _rulers[sym] = { start: null, canvas: rc, label: lbl };
  (_levels[sym] || []).forEach(function (l) { attachLevel(sym, l); });
  (_rays[sym] || []).forEach(function (r) { attachRay(sym, r); });
  _syncAlerts(sym);
  (function alertIconLoop(s) {
    if (!_charts[s]) return;
    var ruler = _rulers[s];
    if (ruler && ruler.canvas && !ruler.start) {
      var rc2 = ruler.canvas, ctx = rc2.getContext('2d');
      var dpr2 = window.devicePixelRatio || 1;
      // Resize canvas if dpr changed (e.g. browser zoom or display change)
      if (rc2._lastDpr !== dpr2) {
        var cel = document.getElementById('chart-' + s);
        if (cel) _setCanvasSize(rc2, cel.offsetWidth, cel.offsetHeight);
        rc2._lastDpr = dpr2;
      }
      ctx.clearRect(0, 0, rc2.width, rc2.height);
      ctx.setTransform(dpr2, 0, 0, dpr2, 0, 0);
      drawAlertIcons(s, ctx, rc2);
      drawCardRays(s, ctx, rc2);
    }
    requestAnimationFrame(function () { alertIconLoop(s); });
  }(sym));
  _attachChartEvents(sym, el);
  if (!state.chartTF[sym]) state.chartTF[sym] = state.globalTF || '5m';
  fetchChart(sym, state.chartTF[sym]);
}

function _destroyChartForSym(sym) {
  if (!_charts[sym]) return;
  try { _charts[sym].remove(); } catch (e) {}
  if (_levels[sym]) _levels[sym].forEach(function (l) { l.line = null; });
  if (_rays[sym]) _rays[sym].forEach(function (r) { r.line = null; });
  (_alerts[sym] || []).forEach(function (a) { if (_aLines[a.id]) _aLines[a.id].card = null; });
  if (_rulers[sym] && _rulers[sym].canvas) { try { _rulers[sym].canvas.remove(); } catch (e) {} }
  delete _charts[sym]; delete _fullSeries[sym]; delete _volSeries[sym]; delete _rulers[sym]; delete _chartReady[sym];
  window.__chartSeries = _fullSeries; window.__chartVolSeries = _volSeries; window.__charts = _charts;
}

function initCharts() {
  if (!window.LightweightCharts) return;
  if (!_cardObserver) {
    _cardObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var sym = entry.target.dataset.sym;
        if (!sym) return;
        if (entry.isIntersecting) {
          _initChartForSym(sym);
        } else {
          _destroyChartForSym(sym);
        }
      });
    }, { rootMargin: '150px 0px', threshold: 0 });
  }
  document.querySelectorAll('.coin-card').forEach(function (card) {
    _cardObserver.observe(card);
  });
}

// Diagnostic snapshot for "charts stop rendering after hours" bug.
// Run window._chartDiag() in devtools when it happens to capture state.
window._chartDiag = function () {
  return Array.from(document.querySelectorAll('.coin-card[data-sym]')).map(function (card) {
    var sym = card.dataset.sym;
    var rect = card.getBoundingClientRect();
    var chartEl = document.getElementById('chart-' + sym);
    var canvas = chartEl ? chartEl.querySelector('canvas') : null;
    var tf = state.chartTF[sym] || '5m';
    var cd = state.chartData[sym + '_' + tf];
    return {
      sym: sym,
      cardVisible: rect.width > 0 && rect.height > 0,
      hasChartInstance: !!_charts[sym],
      hasSeries: !!_fullSeries[sym],
      chartElSize: chartEl ? chartEl.offsetWidth + 'x' + chartEl.offsetHeight : null,
      canvasSize: canvas ? canvas.width + 'x' + canvas.height : null,
      chartDataStatus: cd ? cd.status : null,
      candleCount: cd && cd.candles ? cd.candles.length : 0,
      msSinceLastKline: Date.now() - getLastKlineAt(sym),
    };
  });
};

// ── Analysis Popup ─────────────────────────────────────────────────────────

// AI analysis of a coin — shadcn popover (src/react/host/AnalysisPopover.jsx)
export function openAnalysisPopup(sym, btn) {
  if (isSurfaceOpen('analysis')) { closeSurface('analysis'); return; }
  var r = btn.getBoundingClientRect();
  openSurface('analysis', { sym: sym, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
}


export { openTVMode, closeTVMode } from './tv.js';

// ── Metric cards live update ────────────────────────────────────────────────

function updateMetricCards() {
  var coins = filteredCoins();
  var c1 = document.querySelector('.metric-card:nth-child(1) .value');
  if (c1) c1.textContent = coins.length;
  if (!coins.length) return;
  var maxRise = Math.max.apply(null, coins.map(function (c) { return c.price_change_percentage_24h || 0; })).toFixed(2);
  var c2 = document.querySelector('.metric-card:nth-child(2) .value');
  if (c2) c2.textContent = '+' + maxRise + '%';
  var mv = Math.max.apply(null, coins.map(function (c) { return c.total_volume || 0; }));
  var c3 = document.querySelector('.metric-card:nth-child(3) .value');
  if (c3) c3.textContent = mv >= 1e9 ? '$' + (mv / 1e9).toFixed(1) + 'B' : mv >= 1e6 ? '$' + (mv / 1e6).toFixed(1) + 'M' : '$' + (mv / 1e3).toFixed(1) + 'K';
  var bc = coins.filter(function (c) { return state.analysisCache[c.symbol] && state.analysisCache[c.symbol].result && state.analysisCache[c.symbol].result.signal === 'bullish'; }).length;
  var c4 = document.querySelector('.metric-card:nth-child(4) .value');
  if (c4) c4.textContent = bc;
}


// ── Topbar HTML (shared between main render and full view) ─────────────────

export var LOGO_SVG = '<svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.25519 4.37208C5.8536 5.29726 5.97716 6.4839 6.59499 7.69065C6.75974 8.01245 6.9245 8.38453 6.95539 8.52532C7.04806 8.84712 7.52173 9.34993 8.3249 10.0036C8.82945 10.4058 9.06629 10.5265 9.45757 10.5768C10.8374 10.7578 10.7447 10.7176 10.58 11.0293C10.374 11.4316 9.79738 11.8238 8.57203 12.407C7.9748 12.6886 7.39816 13.0205 7.29519 13.1411C7.18192 13.2518 6.99657 13.3523 6.87301 13.3523C6.73915 13.3523 6.27578 13.5333 5.82271 13.7546C4.88568 14.2071 3.91775 15.1122 3.50587 15.9167C3.16606 16.5603 2.87775 17.7771 3.0528 17.7771C3.21755 17.7771 3.70151 17.2441 4.19577 16.5402C4.70033 15.7859 5.48291 15.1122 6.47142 14.5591C7.03776 14.2473 7.35697 14.1267 7.6041 14.1367C7.94391 14.1669 8.73678 13.835 9.33401 13.4227L9.63262 13.2115L9.57084 13.4629C9.52965 13.5937 9.44728 13.9456 9.3752 14.2373C9.28252 14.6496 9.12807 14.911 8.72648 15.3535C7.5938 16.6005 6.82152 17.6866 6.82152 18.0486C6.82152 18.1693 6.65677 18.5313 6.46113 18.8531C5.46231 20.5023 5.1328 22.5639 5.62706 24.1628C5.71974 24.4444 5.8536 24.7561 5.92568 24.8567C6.06984 25.0478 6.08014 25.0478 6.18311 24.8567C6.23459 24.7561 6.31697 24.1427 6.35816 23.5092C6.44053 22.0912 6.62588 21.2767 7.15103 19.909C7.41875 19.2051 7.64529 18.7928 7.83064 18.6319C7.98509 18.5011 8.29401 18.0888 8.52054 17.7167L8.93242 17.0329L8.95302 17.4251C9.04569 18.9034 9.50906 20.442 10.1681 21.4476C11.2287 23.0667 12.8968 23.9315 14.9562 23.9215C16.717 23.9215 17.8909 23.4689 19.0339 22.3627C20.1871 21.2465 20.8255 19.7481 21.0109 17.7871L21.083 17.0329L21.5669 17.8475C21.8347 18.3 22.1436 18.6922 22.2465 18.7224C22.3701 18.7626 22.5554 19.1246 22.8232 19.8386C23.4204 21.4577 23.5131 21.8499 23.5955 23.3382C23.6675 24.3941 23.7293 24.7762 23.8426 24.8969C24.0279 25.0779 24.0588 25.0277 24.3986 23.9416C24.862 22.4231 24.4089 20.1303 23.3174 18.5011C23.2351 18.3704 23.1527 18.1391 23.1424 17.9883C23.1115 17.6363 22.5143 16.7715 21.5463 15.6753C20.877 14.9211 20.7638 14.7401 20.5578 14.0362C20.4343 13.6037 20.3519 13.2518 20.3725 13.2518C20.3828 13.2518 20.7123 13.4428 21.0933 13.6741C21.6287 14.006 21.8964 14.1065 22.298 14.1166C22.6996 14.1367 22.9776 14.2473 23.6263 14.6295C24.6561 15.2329 25.3871 15.9167 25.9947 16.8419C26.4374 17.5156 26.839 17.8776 26.9729 17.7369C27.0965 17.6262 26.7772 16.5603 26.4271 15.8765C26.1903 15.4038 25.8711 15.0016 25.4592 14.6295C24.8723 14.0965 23.5543 13.3523 23.2042 13.3523C23.1012 13.3523 22.8644 13.2317 22.6687 13.0909C22.4731 12.9501 21.8552 12.6082 21.2889 12.3366C20.0327 11.7333 19.5796 11.4215 19.4148 11.0394C19.2707 10.7176 19.2707 10.7075 20.4343 10.5869C20.8976 10.5366 21.1139 10.4461 21.4125 10.2047C22.1539 9.60134 22.9879 8.7365 22.9879 8.5756C22.9879 8.49515 23.1527 8.10296 23.3483 7.72082C24.0176 6.42356 24.1309 5.46821 23.7396 4.42236C23.4719 3.72848 23.2659 3.92961 23.1527 4.98551C23.0188 6.30289 22.4937 7.83144 22.123 8.00239C21.9891 8.06273 21.6905 8.38453 21.464 8.7365L21.0418 9.35999L20.3416 9.39016C19.9606 9.41027 19.5281 9.43038 19.384 9.44044C18.9927 9.46055 18.3645 9.18903 18.1792 8.91751C17.8703 8.46498 17.2731 7.90183 16.8921 7.71076C16.5523 7.53981 16.5008 7.46941 16.5008 7.16772C16.5008 6.42356 15.7182 5.00563 15.3063 5.00563C15.1313 5.00563 15.1107 5.62911 15.2754 5.9308C15.3681 6.10176 15.3475 6.17215 15.1827 6.33305C14.9768 6.53418 14.9768 6.53418 14.7812 6.34311C14.5958 6.1621 14.5855 6.11182 14.7091 5.90063C14.9047 5.55872 14.8944 5.00563 14.6988 5.00563C14.2766 5.00563 13.6176 6.14198 13.5352 6.97665C13.494 7.4493 13.4528 7.51969 13.113 7.71076C12.6291 7.99234 12.4128 8.17335 11.9289 8.74656C11.7126 9.01808 11.4861 9.22926 11.4346 9.22926C11.3728 9.22926 11.1772 9.29965 10.9815 9.39016C10.7035 9.52089 10.58 9.53095 10.2813 9.43038C10.0754 9.37005 9.69441 9.32982 9.42668 9.33988L8.94272 9.37005L8.43816 8.64599C8.17044 8.24374 7.88212 7.92194 7.79975 7.92194C7.54232 7.92194 6.82152 5.74979 6.82152 4.94529C6.82152 4.46259 6.67737 4 6.51261 4C6.46113 4 6.33756 4.17096 6.25519 4.37208Z" fill="currentColor"/></svg>';

// ── Session timer (Asia / Europe / America, desktop nav) ────────────────────

var TRADING_SESSIONS = [
  { key: 'asia', label: 'Asia', short: 'AS', start: 0, end: 9 },
  { key: 'europe', label: 'Europe', short: 'EU', start: 7, end: 16 },
  { key: 'america', label: 'America', short: 'US', start: 12, end: 21 },
];

var SESSION_WHEEL_CIRCUMFERENCE = 2 * Math.PI * 5;

function _sessionInfo() {
  var nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  var activeKeys = [];
  var activeLabels = [];
  var events = [];
  TRADING_SESSIONS.forEach(function (s) {
    var startMin = s.start * 60, endMin = s.end * 60;
    var isActive = nowMin >= startMin && nowMin < endMin;
    if (isActive) { activeKeys.push(s.key); activeLabels.push(s.label); }
    var untilStart = startMin - nowMin; if (untilStart <= 0) untilStart += 1440;
    events.push({ type: 'opens', label: s.label, short: s.short, minutes: untilStart });
    if (isActive) {
      var untilEnd = endMin - nowMin; if (untilEnd <= 0) untilEnd += 1440;
      events.push({ type: 'closes', label: s.label, short: s.short, minutes: untilEnd });
    }
  });
  if (activeLabels.length >= 2) {
    var overlapText = 'Overlap: ' + activeLabels.join(' & ');
    return { activeKeys: activeKeys, nextText: overlapText, nextTextShort: overlapText };
  }
  events.sort(function (a, b) { return a.minutes - b.minutes; });
  var next = events[0];
  var h = Math.floor(next.minutes / 60), m = next.minutes % 60;
  var dur = h > 0 ? (h + 'h ' + m + 'm') : (m + 'm');
  return {
    activeKeys: activeKeys,
    nextText: next.label + ' ' + next.type + ' in ' + dur,
    nextTextShort: next.short + ' ' + next.type + ' in ' + dur,
  };
}

// Displays a session-boundary UTC hour in the effective timezone (Account setting, else browser's).
// The session windows themselves stay UTC (real market hours) — only this label is localized.
function _localHourStr(utcHour) {
  var d = new Date();
  d.setUTCHours(utcHour, 0, 0, 0);
  return tzTimeStr(d);
}

// Open sessions for the header: { dots: [{ key, label, short, local, percent, ending, circ }], nextText, nextTextShort }
export function sessionInfo() {
  var info = _sessionInfo();
  var nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  var active = TRADING_SESSIONS.filter(function (s) { return info.activeKeys.indexOf(s.key) !== -1; });
  var minUntilEnd = null;
  active.forEach(function (s) {
    var untilEnd = s.end * 60 - nowMin; if (untilEnd <= 0) untilEnd += 1440;
    if (minUntilEnd === null || untilEnd < minUntilEnd) minUntilEnd = untilEnd;
  });
  info.dots = active.map(function (s) {
    var untilEnd = s.end * 60 - nowMin; if (untilEnd <= 0) untilEnd += 1440;
    var idx = TRADING_SESSIONS.indexOf(s);
    var nextOpen = TRADING_SESSIONS[(idx + 1) % TRADING_SESSIONS.length].start * 60;
    var interval = (nextOpen - s.start * 60 + 1440) % 1440;
    var elapsed = (nowMin - s.start * 60 + 1440) % 1440;
    return {
      key: s.key, label: s.label, short: s.short,
      local: _localHourStr(s.start) + '–' + _localHourStr(s.end) + ' local',
      percent: Math.min(elapsed / interval, 1),
      ending: active.length > 1 && untilEnd === minUntilEnd,
      circ: SESSION_WHEEL_CIRCUMFERENCE,
    };
  });
  return info;
}

// The header re-reads sessionInfo() on its own timer; kept for main.js
export function updateSessionTimer() { emit('timezone:changed'); }

export function injectDemoBanner() {
  if (document.getElementById('demo-banner')) return;
  var el = document.createElement('div');
  el.id = 'demo-banner';
  el.className = 'demo-banner';
  el.innerHTML = '<span class="demo-banner-text">Sync watchlist · Price alerts · Track PnL · Journal · AI analysis</span>'
    + '<a href="/login" class="demo-banner-cta">Sign up free →</a>';
  document.body.appendChild(el);
  document.body.classList.add('demo-mode');
}

// ── Global timeframe (every card) ──────────────────────────────────────────

export function setGlobalTF(tf) {
  state.globalTF = tf;
  state.coins.forEach(function (c) { state.chartTF[c.symbol] = tf; });
  document.querySelectorAll('.coin-card[data-sym]').forEach(function (card) { setChartTF(card.dataset.sym, tf); });
}

// ── Main Render ────────────────────────────────────────────────────────────

export function render() {
  var app = document.getElementById('app');
  if (state.loading) {
    destroyCharts();
    unmountIslands(app);
    app.innerHTML = '<div class="loading-overlay"><div class="big-spinner"></div><p>Loading data from Binance Futures...</p></div>';
    return;
  }
  var coins = _screenerMode ? screenerCoins() : filteredCoins();

  destroyCharts();
  var emptyHtml;
  if (state.error) {
    emptyHtml = '<div class="error-banner">' + state.error + '</div>';
  } else if (state.coins.length === 0) {
    emptyHtml = '<div class="error-banner">Waiting for server data...</div>';
  } else {
    emptyHtml = '<div class="empty-state">No coins match the current filter.</div>';
  }
  var coinsHtml = coins.length
    ? '<div class="cards-area">'
      + '<div class="cards-grid" id="cards-grid">'
      + coins.map(function (c) { return renderCard(c); }).join('')
      + '</div></div>'
    : emptyHtml;

  // Header and filter bar are React (shadcn) islands: src/react/home
  unmountIslands(app);
  app.innerHTML =
    '<div id="topbar-root"></div>'
    + (_screenerMode ? '' : '<div id="day-summary-root"></div>') // day strip on the main (Tear) screen
    + '<div id="sortbar-root"></div>'
    + coinsHtml;
  mountIsland(document.getElementById('topbar-root'), Topbar, { screener: _screenerMode });
  if (!_screenerMode) mountIsland(document.getElementById('day-summary-root'), DaySummary);
  mountIsland(document.getElementById('sortbar-root'), SortBar, { screener: _screenerMode });
  mountCardHeads(app);
  initCharts();
}


// ── Event listeners ────────────────────────────────────────────────────────

initTheme();
loadLevels();
on('render', function () {
  var route = getCurrentRoute();
  if (route === '/' || route === '/gainers') render();
});
on('cards:sync', renderCards);
on('metrics:update', updateMetricCards);
on('ws:status', function () {
  var els = document.querySelectorAll('.ws-indicator');
  for (var i = 0; i < els.length; i++) {
    els[i].className = 'ws-indicator ' + (wsConnected ? 'connected' : 'disconnected');
    els[i].title = wsConnected ? 'WebSocket connected' : 'WebSocket disconnected';
  }
  // the filter bar's dot is React and listens to 'ws:status' itself
});

// ── Full View ──────────────────────────────────────────────────────────────

var _fvRuler = null;
var _fvTradeMarkersData = [];
// Review mode: the coin's chart opened from the journal on one trade — history
// from Binance REST (scroll back and forward loads more), no live updates, the
// trade's fills as the usual triangles. null when the chart is live.
var _fvReplay = null; // { openTime, closeTime, execs, loading, done: { back, fwd } }
var _fvTimerInterval = null;

var _TF_SECS = { '1m':60,'3m':180,'5m':300,'15m':900,'30m':1800,'1h':3600,'4h':14400,'1d':86400 };

function _startFVTimer(tf) {
  if (_fvTimerInterval) { clearInterval(_fvTimerInterval); _fvTimerInterval = null; }
  window.__fvTimerAnchorMs = null;
  var secs = _TF_SECS[tf];
  if (!secs) return;
  function _tick() {
    var el = document.getElementById('fv-timer');
    if (!el) return;
    var rem;
    var anchorMs = window.__fvTimerAnchorMs;
    if (anchorMs != null) {
      rem = secs - Math.floor((Date.now() - anchorMs) / 1000);
      if (rem <= 0) { window.__fvTimerAnchorMs = null; rem = secs - (Math.floor(Date.now() / 1000) % secs); }
    } else {
      rem = secs - (Math.floor(Date.now() / 1000) % secs);
    }
    if (tf === '1m') {
      el.textContent = rem + 's';
    } else {
      var m = Math.floor(rem / 60);
      var s = rem % 60;
      el.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    }
  }
  _tick();
  _fvTimerInterval = setInterval(_tick, 1000);
}

// ── Briefing ───────────────────────────────────────────────────────────────

var _briefingUserCode = null; // set by setUserId()
var _briefingServerLoaded = false; // true after first successful server GET
var _briefingSyncTimer = null;

function todayDate() {
  return tzDateStr();
}

// `d` is always a UTC-midnight-anchored Date produced by _currentWeekMonday() —
// must read UTC fields, not local ones, to avoid drifting a day near the browser's own midnight.
function _dateStr(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function _currentWeekMonday() {
  var parts = todayDate().split('-');
  var d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
  var dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d;
}

// Keep ~4 weeks of accumulated history (cheap in Redis, enables future weekly-trend AI reports)
function _briefingHistoryCutoff() {
  var mon = _currentWeekMonday();
  mon.setUTCDate(mon.getUTCDate() - 21);
  return _dateStr(mon);
}

function briefingDates() {
  var dates = {};
  (state.briefing || []).forEach(function (e) { dates[e.date] = true; });
  return Object.keys(dates).sort().reverse();
}

function briefingForDate(date) {
  return (state.briefing || []).filter(function (e) { return e.date === date; });
}

export function briefingThisWeekEntries() {
  var weekMonday = _dateStr(_currentWeekMonday());
  return (state.briefing || []).filter(function (e) { return e.date >= weekMonday; });
}

export function isInBriefing(sym) {
  var today = todayDate();
  return (state.briefing || []).some(function (e) { return e.sym === sym && e.date === today; });
}

export function autoSetTradedStatus() {
  var changed = false;
  (state.briefing || []).forEach(function (e) {
    var t = state.trades[e.sym + ':' + e.date];
    if (t && t.status === 'ok' && t.count > 0 && e.status !== 'traded') {
      e.status = 'traded';
      changed = true;
    }
  });
  if (changed) saveBriefingLocal();
}

function saveBriefingLocal() {
  try { localStorage.setItem(_userScopedKey('pa_briefing'), JSON.stringify(state.briefing)); } catch (e) {}
  clearTimeout(_briefingSyncTimer);
  _briefingSyncTimer = setTimeout(syncBriefingToServer, 1000);
}

function syncBriefingToServer() {
  if (!_briefingUserCode) return;
  if (!_briefingServerLoaded) return;
  fetch(API_BASE + '/api/briefing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'save', entries: state.briefing, utcOffset: Math.round(new Date().getTimezoneOffset() / -60) }),
  }).catch(function () {});
}
var _lastSyncAt = 0;
var _syncVersion = 0;
export function syncBriefingNow() {
  clearTimeout(_briefingSyncTimer);
  _lastSyncAt = Date.now();
  _syncVersion++;
  syncBriefingToServer();
}
export function briefingJustSynced() { return Date.now() - _lastSyncAt < 2000; }
export function refreshBriefingFromServer() {
  if (briefingJustSynced()) return;
  if (!_briefingUserCode) return;
  var _versionAtStart = _syncVersion;
  var _mondayStr = _briefingHistoryCutoff();
  fetch(API_BASE + '/api/briefing', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'get' }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (_syncVersion !== _versionAtStart) return; // sync happened while fetching — discard stale data
    if (!d || !Array.isArray(d.entries)) return;
    var _serverEntries = d.entries.filter(function (e) { return e.date >= _mondayStr; });
    var _localMap = {};
    (state.briefing || []).forEach(function (le) { _localMap[le.sym + ':' + le.date] = le; });
    // Server is authoritative for which entries exist.
    // But if local note is newer (noteUpdatedAt) — keep local note and push it back.
    var _merged = _serverEntries.map(function (se) {
      var le = _localMap[se.sym + ':' + se.date];
      if (le && (le.noteUpdatedAt || 0) > (se.noteUpdatedAt || 0)) {
        return Object.assign({}, se, { note: le.note, noteUpdatedAt: le.noteUpdatedAt });
      }
      return se;
    });
    var _needsSync = _merged.some(function (e, i) { return e !== _serverEntries[i]; });
    state.briefing = _merged;
    _briefingServerLoaded = true;
    if (_needsSync) syncBriefingToServer(); // only if local note was newer
    try { localStorage.setItem(_userScopedKey('pa_briefing'), JSON.stringify(state.briefing)); } catch (e) {} // no debounce sync — don't push server data back
    renderBriefingPanel();
    updateAllStarButtons();
    var _fvd = document.getElementById('fv-briefing-drawer');
    if (_fvd && _fvd.classList.contains('open')) renderFVBriefingDrawer();
  }).catch(function () {});
}

export function loadBriefing() {
  // Keep ~4 weeks of history — old entries disappear once they roll past that window
  var _mondayStr = _briefingHistoryCutoff();

  try {
    var local = JSON.parse(localStorage.getItem(_userScopedKey('pa_briefing')) || '[]');
    if (Array.isArray(local)) state.briefing = local.filter(function (e) { return e.date >= _mondayStr; });
  } catch (e) {}
  if (!_briefingUserCode) return;
  fetch(API_BASE + '/api/briefing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'get' }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && Array.isArray(d.entries)) {
      var _serverEntries = d.entries.filter(function (e) { return e.date >= _mondayStr; });
      var _localMap = {};
      (state.briefing || []).forEach(function (le) { _localMap[le.sym + ':' + le.date] = le; });
      // Server is authoritative for which entries exist.
      // Only prefer local note if it has a newer noteUpdatedAt (typed locally, not yet synced).
      var _merged = _serverEntries.map(function (se) {
        var le = _localMap[se.sym + ':' + se.date];
        if (le && (le.noteUpdatedAt || 0) > (se.noteUpdatedAt || 0)) {
          return Object.assign({}, se, { note: le.note, noteUpdatedAt: le.noteUpdatedAt });
        }
        return se;
      });
      var _needsSync = _merged.some(function (e, i) { return e !== _serverEntries[i]; });
      state.briefing = _merged;
      _briefingServerLoaded = true;
      if (_needsSync) syncBriefingToServer();
      saveBriefingLocal();
      renderBriefingPanel();
      updateAllStarButtons();
      var _fvd = document.getElementById('fv-briefing-drawer');
      if (_fvd && _fvd.classList.contains('open')) renderFVBriefingDrawer();
    }
  }).catch(function () {});
}

export function toggleBriefing(sym) {
  var today = todayDate();
  var idx = (state.briefing || []).findIndex(function (e) { return e.sym === sym && e.date === today; });
  if (idx >= 0) {
    var entry = state.briefing[idx];
    if (entry.note && entry.note.trim()) {
      if (!confirm('Remove ' + sym + ' from watchlist?')) return;
    }
    state.briefing.splice(idx, 1);
  } else {
    if (!state.briefing) state.briefing = [];
    var coin = state.coins.find(function (c) { return c.symbol === sym; });
    state.briefing.push({ sym: sym, date: today, addedAt: Date.now(), addedPrice: (coin && coin.current_price) || null, status: 'watching', note: '' });
  }
  saveBriefingLocal();
  syncBriefingNow();
  updateStarButton(sym);
  renderBriefingPanel();
  var _fvd = document.getElementById('fv-briefing-drawer');
  if (_fvd && _fvd.classList.contains('open')) renderFVBriefingDrawer();
}

function cycleBriefingStatus(sym, date) {
  var entry = (state.briefing || []).find(function (e) { return e.sym === sym && e.date === date; });
  if (!entry) return;
  var order = ['watching', 'traded', 'skip', 'missed'];
  var cur = order.indexOf(entry.status);
  entry.status = order[(cur + 1) % order.length];
  saveBriefingLocal();
  syncBriefingNow();
  renderBriefingPanel();
  var _fvd = document.getElementById('fv-briefing-drawer');
  if (_fvd && _fvd.classList.contains('open')) renderFVBriefingDrawer();
}

function updateStarButton(sym) {
  emit('briefing:changed'); // card heads (React)
  var active = isInBriefing(sym);
  document.querySelectorAll('.btn-icon.star[data-sym="' + sym + '"]').forEach(function (btn) {
    btn.classList.toggle('active', active);
    btn.title = active ? 'Remove from watchlist' : 'Add to watchlist';
  });
}

function updateAllStarButtons() {
  emit('briefing:changed');
  document.querySelectorAll('.btn-icon.star').forEach(function (btn) {
    var sym = btn.dataset.sym;
    var active = isInBriefing(sym);
    btn.classList.toggle('active', active);
    btn.title = active ? 'Remove from watchlist' : 'Add to watchlist';
  });
}

// ── Briefing panel and drawer: shadcn (src/react/home/Briefing.jsx) ─────────
// The list redraws on 'briefing:render'; these keep their old names for callers.

export function openBriefingPanel() {
  if (!state.briefingViewDate) state.briefingViewDate = todayDate();
  if (isSurfaceOpen('briefing')) { closeBriefingPanel(); return; }
  var fvOverlay = document.getElementById('fv-overlay');
  var _btns = fvOverlay && fvOverlay.style.display !== 'none'
    ? Array.from(fvOverlay.querySelectorAll('[data-action="open-briefing"]'))
    : Array.from(document.querySelectorAll('[data-action="open-briefing"]'));
  var btn = _btns.find(function (b) { return b.offsetParent !== null; });
  var r = btn ? btn.getBoundingClientRect() : { left: window.innerWidth - 48, top: 8, width: 36, height: 36 };
  emit('briefing:changed'); // the full view hides its star while the panel is open
  openSurface('briefing', { rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
  refreshBriefingFromServer();
  // Subscribe all briefing coins to kline stream so the server pushes per-trade
  // kline_update messages for them. Without this, only coins previously viewed in
  // FV (with loaded chart data) get per-trade price updates; the rest only update
  // on the slow bulk ticker, making them appear frozen in the panel.
  var _bpSyms = Array.from(new Set((state.briefing || []).map(function (e) { return e.sym; })));
  if (_bpSyms.length) sendWS({ type: 'subscribe_klines', symbols: _bpSyms, tf: '5m' });
}

export function closeBriefingPanel() {
  closeSurface('briefing');
  emit('briefing:changed');
}

export function isBriefingPanelOpen() { return isSurfaceOpen('briefing'); }

export function renderBriefingPanel() { emit('briefing:render'); }

// Full-view chrome is shadcn (src/react/fullview/FvControls.jsx): the island
// over the chart (desktop), the bottom bar (phones) and the stats line —
// placeholders here, mounted by _mountFvChrome
function _fvBottomBarHTML() { return '<div class="fv-bottom-bar" data-fv-bar></div>'; }

function _fvCoinInfoHTML() {
  return '<div class="fv-coin-info" data-fv-island></div><div class="fv-info-stats" data-fv-stats></div>';
}

function _mountFvChrome(overlay, sym) {
  unmountIslands(); // the previous coin's (detached)
  var review = !!_fvReplay;
  mountIsland(overlay.querySelector('[data-fv-island]'), FvControls, { sym: sym, review: review });
  mountIsland(overlay.querySelector('[data-fv-bar]'), FvControls, { sym: sym, review: review, bar: true });
  mountIsland(overlay.querySelector('[data-fv-stats]'), FvStats, { sym: sym });
}

var TAPE_MAX_ROWS = 20;
var TAPE_MIN_USDT = 50;
var TAPE_NOTIONAL_WINDOW = 50; // rolling sample of recent trade sizes, for the relative "large" threshold below
var TAPE_LARGE_MULTIPLIER = 3; // a trade is "large" once it's this many times the coin's recent median size
var _tapeNotionals = [];

function _tapeMedian(arr) {
  var sorted = arr.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Liquidity panel (spread, depth, aggression, big trades): a shadcn popover
// under its button (src/react/host/LiquidityPopover.jsx). The order book feed
// fills _liq; the popover reads liquidityData() and redraws on 'liq:update',
// at most once a frame and only while it's open.
var _liq = { metrics: null, tape: [], n: 0 };
var _liqQueued = false;

function _resetLiquidity() {
  _tapeNotionals = [];
  _liq = { metrics: null, tape: [], n: 0 };
  closeSurface('liquidity');
}

export function liquidityData() { return _liq; }

export function openLiquidityPopup(btn) {
  if (isSurfaceOpen('liquidity')) { closeSurface('liquidity'); return; }
  var r = btn.getBoundingClientRect();
  openSurface('liquidity', { rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
}

function _liqChanged() {
  if (_liqQueued || !isSurfaceOpen('liquidity')) return;
  _liqQueued = true;
  requestAnimationFrame(function () { _liqQueued = false; emit('liq:update'); });
}

function renderLiquidityMetrics(metrics) {
  _liq.metrics = metrics;
  _liqChanged();
}

function appendTapeRow(trade) {
  var notional = trade.price * trade.qty;
  if (notional < TAPE_MIN_USDT) return;
  // "Large" is relative to this coin's own recent trades, not a fixed USDT amount —
  // a $500 trade is huge on a thin altcoin and unremarkable on BTC.
  var isLarge = _tapeNotionals.length >= 5 && notional >= _tapeMedian(_tapeNotionals) * TAPE_LARGE_MULTIPLIER;
  _tapeNotionals.push(notional);
  if (_tapeNotionals.length > TAPE_NOTIONAL_WINDOW) _tapeNotionals.shift();
  _liq.tape = [{ id: ++_liq.n, price: trade.price, qty: trade.qty, large: isLarge, buy: trade.isBuy }].concat(_liq.tape.slice(0, TAPE_MAX_ROWS - 1));
  _liqChanged();
}

// Draw alert bells + trade triangles on the FV canvas overlay.
// Called from both the rAF loop and the ruler mousemove handler so
// they always stay visible regardless of ruler state.
function _drawFVOverlays(ctx, rc, sym) {
  if (!_fvSeries) return;
  var dpr = window.devicePixelRatio || 1;
  var cssW = rc.width / dpr, cssH = rc.height / dpr;
  var timeAxisH = 0; try { if (_fvChart) timeAxisH = _fvChart.timeScale().height(); } catch (_) {}
  var paneH = cssH - timeAxisH;
  if (!_fvReplay) _drawRays(sym, _fvChart, _fvSeries, ctx, rc);
  // Alert bell icons
  if (_bellImg && _bellImg.complete && !_fvReplay) {
    (_alerts[sym] || []).forEach(function (a) {
      var y = _fvSeries.priceToCoordinate(a.price);
      var tagW = 16, tagH = 18;
      if (y == null || y < 0 || y + tagH / 2 > paneH) return;
      var bellX = 0;
      ctx.save();
      ctx.drawImage(a.triggered ? (isDark() ? _bellImgTriggeredDark : _bellImgTriggeredLight) : _bellImg, bellX, y - tagH / 2, tagW, tagH);
      drawAlertLabel(ctx, a, y, bellX + tagW + 4);
      ctx.restore();
    });
  }
  // Trade entry/exit triangles
  var tfSec = {'1m':60,'3m':180,'5m':300,'15m':900,'30m':1800,'1h':3600,'2h':7200,'4h':14400,'1d':86400}[state.chartTF[sym] || '5m'] || 300;
  _fvTradeMarkersData.forEach(function (m) {
    var snapped = Math.floor(m.time / tfSec) * tfSec;
    var y = _fvSeries.priceToCoordinate(m.price);
    var x = _fvChart && _fvChart.timeScale().timeToCoordinate(snapped);
    if (y == null || x == null || x < 0 || x > cssW || y < 0 || y > cssH) return;
    var hb = 8, h = 14; // equilateral: halfBase=8, height≈8×√3
    ctx.save();
    ctx.fillStyle = m.buy ? '#22c55e' : '#ff5050';
    ctx.beginPath();
    if (m.buy) { ctx.moveTo(x, y); ctx.lineTo(x - hb, y + h); ctx.lineTo(x + hb, y + h); }
    else        { ctx.moveTo(x, y); ctx.lineTo(x - hb, y - h); ctx.lineTo(x + hb, y - h); }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  });
  // Your notes on this coin: a bubble at the time and price each was written
  drawNoteIcons(ctx, _fvSeries, _fvChart, sym, tfSec, cssW, paneH);
}

// Entry/exit triangles: with the briefing drawer open — every briefing day of
// this coin; otherwise today's fills on it (loaded when the coin is opened and
// refetched after each fill), so a plain open of the coin shows where you got in
function _applyFVTradeMarkers(sym) {
  if (!sym) { _fvTradeMarkersData = []; return; }
  if (_fvReplay) {
    _fvTradeMarkersData = (_fvReplay.execs || []).map(function (e) { return { time: Math.floor(e.t / 1000), price: e.p, buy: e.s === 'BUY' }; });
    return;
  }
  var _drawer = document.getElementById('fv-briefing-drawer');
  var dates = _drawer && _drawer.classList.contains('open')
    ? (state.briefing || []).filter(function (e) { return e.sym === sym; }).map(function (e) { return e.date; })
    : [todayDate()];
  var markers = [];
  dates.forEach(function (date) {
    var t = state.trades[sym + ':' + date];
    if (!t || t.status !== 'ok' || !t.entries || !t.entries.length) return;
    t.entries.forEach(function (trade) {
      markers.push({
        time: Math.floor(parseInt(trade.time, 10) / 1000),
        price: parseFloat(trade.price),
        buy: trade.side === 'BUY',
      });
    });
  });
  _fvTradeMarkersData = markers;
}

// Briefing rows list the coin's notes of that day; redraw when they change
on('coin-notes:updated', function () {
  renderBriefingPanel();
  var _d = document.getElementById('fv-briefing-drawer');
  if (_d && _d.classList.contains('open')) renderFVBriefingDrawer();
});

export function applyFVTradeMarkers() { _applyFVTradeMarkers(_fvSym); }

// Note button in the island: write a note; a note also puts the coin into
// today's briefing (writing a thought about it means you're watching it)
// Notes on the coin — shadcn popover under the note button (src/react/host/NotesPopover.jsx);
// a note also puts the coin into today's briefing
export function openFVNote(sym) {
  if (isSurfaceOpen('notes')) { closeSurface('notes'); return; }
  var btn = Array.from(document.querySelectorAll('#fv-overlay [data-action="fv-note"]')).find(function (b) { return b.offsetParent !== null; });
  if (!btn) return;
  var r = btn.getBoundingClientRect();
  openSurface('notes', { sym: sym, addToBriefing: true, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
}

function _setFVData(sym, cd) {
  if (!_fvSeries || !_fvChart || !cd || cd.status !== 'ok' || !cd.candles.length) return;
  var lastClose = cd.candles[cd.candles.length - 1].close;
  _fvSeries.applyOptions({ priceFormat: calcPriceFormat(lastClose) });
  _fvSeries.setData(cd.candles);
  if (_fvVolSeries) {
    _fvVolSeries.setData(cd.candles.map(function (c) {
      var vu = getCSSVar('--vol-up'), vd = getCSSVar('--vol-dn');
      return { time: c.time, value: c.volume || 0, color: c.close >= c.open ? vu : vd };
    }));
  }
  _fvLastVol = cd.candles[cd.candles.length - 1].volume || 0;
  var _volLbl = document.getElementById('fv-vol-label');
  if (_volLbl) _volLbl.textContent = 'vol. ' + fmt(_fvLastVol).replace('$', '');
  // Review mode shows the trade (set by _loadFVReplay) and none of the live chart's
  // levels / rays / alerts — only the review's own levels and your notes
  if (_fvReplay) { _applyFVTradeMarkers(sym); return; }
  var _fvVisibleCandles = window.innerWidth < 768 ? 120 : 240;
  _fvChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, cd.candles.length - _fvVisibleCandles), to: cd.candles.length + 4 });
  // Attach existing levels and alerts to fv series
  (_levels[sym] || []).forEach(function (l) {
    if (l.price && !l.fvLine) l.fvLine = _fvSeries.createPriceLine({ price: l.price, color: getCSSVar('--primary'), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, axisLabelColor: getCSSVar('--level-label-bg'), axisLabelTextColor: getCSSVar('--primary'), title: '' });
  });
  (_rays[sym] || []).forEach(function (r) { if (!r.fvLine) attachRay(sym, r); });
  // Sync alert lines — _syncAlertLine handles create-or-update for both card and FV
  (_alerts[sym] || []).forEach(function (a) { _syncAlertLine(sym, a); });
  // Trade entry/exit markers from briefing history
  _applyFVTradeMarkers(sym);
}

var TF_MS = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000, '1d': 86400000 };

// One page of Binance futures candles (REST, no subscription)
function _fetchKlinesRest(sym, tf, params) {
  var q = 'symbol=' + String(sym).toUpperCase() + 'USDT&interval=' + tf + '&limit=1000'
    + (params.endTime ? '&endTime=' + params.endTime : '') + (params.startTime ? '&startTime=' + params.startTime : '');
  return fetch('https://fapi.binance.com/fapi/v1/klines?' + q).then(function (r) { return r.json(); }).then(function (rows) {
    return Array.isArray(rows) ? rows.map(function (k) {
      return { time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
    }) : [];
  });
}

// Review mode: candles around the trade, then more as you scroll to either edge
function _loadFVReplay(sym, tf) {
  var rp = _fvReplay, ms = TF_MS[tf] || 300000;
  rp.candles = []; rp.done = { back: false, fwd: false }; rp.tf = tf;
  var end = Math.min(Date.now(), rp.closeTime + 300 * ms);
  _fetchKlinesRest(sym, tf, { endTime: end }).then(function (c) {
    if (_fvReplay !== rp || rp.tf !== tf || !c.length) return;
    rp.candles = c;
    if (end >= Date.now() - ms) rp.done.fwd = true;
    _setFVData(sym, { status: 'ok', candles: c });
    if (!rp.levelsLoaded) { rp.levelsLoaded = true; _loadReviewLevels(rp); }
    // Show the trade with some room around it
    var pad = Math.max(60 * ms, (rp.closeTime - rp.openTime));
    try { _fvChart.timeScale().setVisibleRange({ from: Math.floor((rp.openTime - pad) / 1000), to: Math.floor((rp.closeTime + pad) / 1000) }); } catch (e) {}
  });
}

function _extendFVReplay(sym, back) {
  var rp = _fvReplay;
  if (!rp || rp.loading || !rp.candles.length || rp.done[back ? 'back' : 'fwd']) return;
  var tf = rp.tf, ms = TF_MS[tf] || 300000;
  rp.loading = true;
  var params = back ? { endTime: rp.candles[0].time * 1000 - 1 } : { startTime: rp.candles[rp.candles.length - 1].time * 1000 + ms };
  _fetchKlinesRest(sym, tf, params).then(function (c) {
    rp.loading = false;
    if (_fvReplay !== rp || rp.tf !== tf) return;
    if (!c.length) { rp.done[back ? 'back' : 'fwd'] = true; return; }
    var range = _fvChart.timeScale().getVisibleRange();
    rp.candles = back ? c.concat(rp.candles) : rp.candles.concat(c);
    if (!back && c.length < 1000) rp.done.fwd = true;
    _fvSeries.setData(rp.candles);
    if (_fvVolSeries) {
      var vu = getCSSVar('--vol-up'), vd = getCSSVar('--vol-dn');
      _fvVolSeries.setData(rp.candles.map(function (x) { return { time: x.time, value: x.volume || 0, color: x.close >= x.open ? vu : vd }; }));
    }
    if (range) try { _fvChart.timeScale().setVisibleRange(range); } catch (e) {}
  }).catch(function () { rp.loading = false; });
}

// Levels drawn on a trade's review chart are kept with that trade (server,
// review_levels) — never on the live chart
function _reviewLine(price) {
  return _fvSeries.createPriceLine({ price: price, color: getCSSVar('--primary'), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, axisLabelColor: getCSSVar('--level-label-bg'), axisLabelTextColor: getCSSVar('--primary'), title: '' });
}
function _loadReviewLevels(rp) {
  fetch(API_BASE + '/api/journal/review-levels?symbol=' + encodeURIComponent(rp.symbol) + '&close=' + rp.closeTime, { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || _fvReplay !== rp || !_fvSeries) return;
      (d.prices || []).forEach(function (p) { rp.levels.push({ price: p, line: _reviewLine(p) }); });
    }).catch(function () {});
}
function _saveReviewLevels(rp) {
  fetch(API_BASE + '/api/journal/review-levels', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ symbol: rp.symbol, close: rp.closeTime, prices: rp.levels.map(function (l) { return l.price; }) }),
  }).catch(function () {});
}

// Open a coin's chart on one of your trades (from the journal): full history to
// scroll and any timeframe, nothing live. trade: { openTime, closeTime, execs }
export function openTradeInChart(sym, trade) {
  _fvReplay = { openTime: trade.openTime, closeTime: trade.closeTime || trade.openTime, execs: trade.execs || [], candles: [],
    symbol: trade.symbol || String(sym).toUpperCase() + 'USDT', levels: [] };
  window.__fvReplay = true;
  openCoinFullView(sym);
}

function _loadFVData(sym, tf) {
  if (_fvReplay) { _loadFVReplay(sym, tf); return; }
  var key = sym + '_' + tf;
  var cd = state.chartData[key];
  if (cd && cd.status === 'ok' && cd.candles.length) {
    _setFVData(sym, cd);
  } else {
    fetchChartData(sym, tf).then(function () { _setFVData(sym, state.chartData[key]); });
  }
}

function _pauseCardCharts() {
  if (_cardObserver) _cardObserver.disconnect();
  Object.keys(_charts).slice().forEach(function (sym) { _destroyChartForSym(sym); });
}

export function openCoinFullView(sym) {
  if (!window.LightweightCharts) return;
  // Destroy previous
  if (_fvChart) { try { _fvChart.remove(); } catch (e) {} _fvChart = null; }
  _fvSeries = null; _fvVolSeries = null; _fvRuler = null;
  window.__fvSeries = null; window.__fvVolSeries = null; window.__fvSymbol = null; window.__fvTF = null;
  // Detach FV lines from the previous coin (chart is being destroyed above)
  if (_fvSym) {
    (_levels[_fvSym] || []).forEach(function (l) { l.fvLine = null; });
    (_rays[_fvSym] || []).forEach(function (r) { r.fvLine = null; });
    (_alerts[_fvSym] || []).forEach(function (a) { _detachFvLine(a); });
  }
  _fvSym = sym;
  if (!_fvReplay) fetchTrades(sym, todayDate()).then(function () { if (_fvSym === sym) _applyFVTradeMarkers(sym); });
  closeSurface('notes');
  ensureCoinNotes(sym);

  var overlay = document.getElementById('fv-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'fv-overlay'; overlay.className = 'overlay'; document.body.appendChild(overlay); }

  var tf = state.chartTF[sym] || '5m';
  var switchingCoins = overlay.style.display === 'flex';
  if (!switchingCoins) {
    _pauseCardCharts();
    // First open — build full structure including drawer
    overlay.innerHTML = '<div class="fv-body">'
      + '<div class="fv-chart-wrap">'
      + _fvCoinInfoHTML()
      + '<div id="fv-chart"></div>'
      + '</div>'
      + '</div>'
      + _fvBottomBarHTML()
      + '<div id="fv-briefing-drawer"></div>';
  } else {
    // Switching coins — update chart-wrap only, leave drawer untouched
    var _chartWrap = overlay.querySelector('.fv-chart-wrap');
    if (_chartWrap) {
      _chartWrap.innerHTML = _fvCoinInfoHTML() + '<div id="fv-chart"></div>';
      var _bb = overlay.querySelector('.fv-bottom-bar');
      if (_bb) _bb.outerHTML = _fvBottomBarHTML();
      var _fvdEl = document.getElementById('fv-briefing-drawer');
      if (_fvdEl && _fvdEl.classList.contains('open')) renderFVBriefingDrawer();
    }
  }
  overlay.style.display = 'flex';
  overlay.classList.toggle('fv-review', !!_fvReplay);
  _mountFvChrome(overlay, sym);
  lockScroll();

  // Init chart
  var el = document.getElementById('fv-chart');
  var c = getChartColors();
  _fvChart = window.LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: getCSSVar('--cloud') }, textColor: c.text, fontSize: 11, fontFamily: 'Manrope, Arial, sans-serif' },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    crosshair: { mode: 0 },
    rightPriceScale: { visible: true, borderColor: c.border, scaleMargins: { top: 0.05, bottom: 0.25 } },
    timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false, tickMarkFormatter: _tickMarkFmt, rightOffset: 5 },
    localization: { timeFormatter: _localTimeFmt },
    handleScroll: true, handleScale: true,
  });
  _fvSeries = _fvChart.addCandlestickSeries(getSeriesColors());
  _fvVolSeries = _fvChart.addHistogramSeries({ color: getCSSVar('--steel'), priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
  _fvChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });


  window.__fvSeries = _fvSeries;
  window.__fvVolSeries = _fvVolSeries;
  window.__fvChart = _fvChart;
  window.__fvSymbol = sym;
  window.__fvTF = tf;

  // Liquidity panel: (re)connect order book + trade tape WS for this symbol
  _resetLiquidity();
  if (!_fvReplay) {
    connectOrderbook(sym, function (msg) {
      renderLiquidityMetrics(msg.metrics);
      if (msg.type === 'trade') appendTapeRow(msg.trade);
    });
    terminalOnFVOpen(sym);
  } else {
    // Review mode: scrolling to an edge loads more history
    _fvChart.timeScale().subscribeVisibleLogicalRangeChange(function (r) {
      if (!r || !_fvReplay || !_fvReplay.candles.length) return;
      if (r.from < 30) _extendFVReplay(sym, true);
      else if (r.to > _fvReplay.candles.length - 30) _extendFVReplay(sym, false);
    });
  }

  // The liquidity button waits for the order book to warm up by itself (FvControls)

  // Volume label overlay
  var wrap = document.querySelector('.fv-chart-wrap');
  var volLbl = document.createElement('div');
  volLbl.id = 'fv-vol-label';
  volLbl.className = 'fv-vol-label';
  wrap.appendChild(volLbl);

  // Countdown timer overlay
  var timerEl = document.createElement('div');
  timerEl.id = 'fv-timer';
  timerEl.className = 'fv-timer';
  wrap.appendChild(timerEl);
  _startFVTimer(tf);

  // Volume label tracks crosshair
  _fvChart.subscribeCrosshairMove(function (param) {
    var lbl = document.getElementById('fv-vol-label');
    if (!lbl) return;
    var volData = param.seriesData && param.seriesData.get(_fvVolSeries);
    if (volData && volData.value != null) {
      lbl.dataset.hovered = '1';
      lbl.textContent = 'vol. ' + fmt(volData.value).replace('$', '');
    } else {
      delete lbl.dataset.hovered;
      lbl.textContent = _fvLastVol ? 'vol. ' + fmt(_fvLastVol).replace('$', '') : '';
    }
  });

  // Canvas overlay for alert bells + ruler
  var rc = document.createElement('canvas');
  rc.className = 'fv-canvas';
  wrap.appendChild(rc);
  function _syncFVCanvas() { _setCanvasSize(rc, wrap.offsetWidth || window.innerWidth, wrap.offsetHeight || window.innerHeight); }
  _syncFVCanvas();
  window.addEventListener('resize', _syncFVCanvas);
  var _fvWrapObs = new ResizeObserver(_syncFVCanvas);
  _fvWrapObs.observe(wrap);
  function _onEscKey(e) { if (e.key === 'Escape' && !e.defaultPrevented && !isSurfaceOpen()) closeCoinFullView(); }
  document.addEventListener('keydown', _onEscKey);
  var fvLblEl = document.createElement('div');
  fvLblEl.className = 'ruler-lbl';
  wrap.appendChild(fvLblEl);
  _fvRuler = { start: null, canvas: rc, label: fvLblEl, _resizeHandler: _syncFVCanvas, _resizeObserver: _fvWrapObs, _escHandler: _onEscKey };

  // On Mac trackpads: vertical scroll passes through; horizontal pans the chart.
  el.addEventListener('wheel', function (e) {
    if (!/Mac/.test(navigator.platform)) return;
    if (e.ctrlKey) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.stopPropagation();
  }, { passive: true, capture: true });

  // Event handlers (contextmenu: add/remove level or alert; mousedown: drag level/alert)
  var _fvDragging = null;
  var _fvAlertDragging = null, _fvAlertDragMoved = false, _fvAlertDragBtn = 2;
  el.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var rect = el.getBoundingClientRect();
    if (_fvReplay) {
      // Review mode: right click adds a level just for this view (never saved to
      // the live chart); right click on it removes it. No alerts, no rays.
      var ry = e.clientY - rect.top, rp = _fvSeries.coordinateToPrice(ry);
      if (rp == null) return;
      var lv = _fvReplay.levels = _fvReplay.levels || [];
      for (var ri = 0; ri < lv.length; ri++) {
        var rly = _fvSeries.priceToCoordinate(lv[ri].price);
        if (rly != null && Math.abs(rly - ry) < 10) { try { _fvSeries.removePriceLine(lv[ri].line); } catch (x) {} lv.splice(ri, 1); _saveReviewLevels(_fvReplay); return; }
      }
      lv.push({ price: rp, line: _reviewLine(rp) });
      _saveReviewLevels(_fvReplay);
      return;
    }
    var y = e.clientY - rect.top;
    var price = _fvSeries.coordinateToPrice(y);
    if (price == null) return;
    if (e.ctrlKey) {
      // On macOS, Ctrl+click is rewritten by the OS into a contextmenu event
      // (no plain mousedown ever fires), so "add ray" must be handled here too.
      var x = e.clientX - rect.left;
      var tfCm = state.chartTF[sym] || '5m';
      var idx = _nearRayIdx(sym, _fvChart, _fvSeries, tfCm, x, y);
      if (idx >= 0) { removeRay(sym, idx); return; }
      var mapCm = _rayCoordMap(_fvChart, sym, tfCm);
      var timeCm = mapCm ? mapCm.xToTime(x) : null;
      if (price != null && timeCm != null) addRay(sym, timeCm, price);
      return;
    }
    if (e.shiftKey) {
      if (_fvAlertDragMoved) { _fvAlertDragMoved = false; return; }
      var alerts = _alerts[sym] || [];
      for (var i = 0; i < alerts.length; i++) {
        var ay = _fvSeries.priceToCoordinate(alerts[i].price);
        if (ay != null && Math.abs(ay - y) < 10) { removeAlert(sym, i); return; }
      }
      addAlert(sym, price);
    } else {
      var levels = _levels[sym] || [];
      for (var i = 0; i < levels.length; i++) {
        var ly = _fvSeries.priceToCoordinate(levels[i].price);
        if (ly != null && Math.abs(ly - y) < 10) { removeLevel(sym, i); return; }
      }
      addLevel(sym, price);
    }
  });
  el.addEventListener('mousedown', function (e) {
    if (_fvReplay && (e.ctrlKey || e.altKey || e.shiftKey || e.button === 1)) { e.stopPropagation(); e.preventDefault(); return; } // review: no tools
    var rect = el.getBoundingClientRect();
    // Ignore clicks on the price axis (right side) — let chart handle vertical zoom natively
    var priceAxisW = 0;
    try { priceAxisW = _fvChart.priceScale('right').width(); } catch (_) {}
    if (e.clientX - rect.left > rect.width - priceAxisW - 2) return;

    // Ctrl+left: add a ray, or grab an existing one to drag
    if (e.button === 0 && e.ctrlKey) {
      var fvY0 = e.clientY - rect.top, fvX0 = e.clientX - rect.left;
      var fvTf0 = state.chartTF[sym] || '5m';
      e.stopPropagation(); e.preventDefault();
      var fvRIdx = _nearRayIdx(sym, _fvChart, _fvSeries, fvTf0, fvX0, fvY0);
      if (fvRIdx >= 0) {
        var fvRay = _rays[sym][fvRIdx];
        var fvMap0 = _rayCoordMap(_fvChart, sym, fvTf0);
        var fvGrabPrice = _fvSeries.coordinateToPrice(fvY0), fvGrabTime = fvMap0 ? fvMap0.xToTime(fvX0) : null;
        if (fvGrabPrice != null && fvGrabTime != null) {
          _fvRayDragging = { idx: fvRIdx, ray: fvRay, grabPrice: fvGrabPrice, grabTime: fvGrabTime, origPrice1: fvRay.price1, origTime1: fvRay.time1, moved: false };
          el.style.cursor = 'move';
        }
        return;
      }
      var fvMap1 = _rayCoordMap(_fvChart, sym, fvTf0);
      var fvPrice1 = _fvSeries.coordinateToPrice(fvY0), fvTime1 = fvMap1 ? fvMap1.xToTime(fvX0) : null;
      if (fvPrice1 != null && fvTime1 != null) addRay(sym, fvTime1, fvPrice1);
      return;
    }

    if (e.button === 1) {
      e.preventDefault();
      var pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      var pr = _fvSeries.coordinateToPrice(pt.y);
      if (pr != null) _fvRuler.start = { pt: pt, price: pr };
      return;
    }
    // Alt+left: ruler or alert drag (trackpad alternatives)
    if (e.button === 0 && e.altKey) {
      if (e.shiftKey) {
        // Shift+Alt+left: drag alert
        var fvAltAY = e.clientY - rect.top;
        var fvAltArr = _alerts[sym] || [];
        for (var fvAi = 0; fvAi < fvAltArr.length; fvAi++) {
          var fvACoord = _fvSeries.priceToCoordinate(fvAltArr[fvAi].price);
          if (fvACoord != null && Math.abs(fvACoord - fvAltAY) < 8) {
            if (fvAltArr[fvAi].triggered) return;
            e.stopPropagation(); e.preventDefault();
            _fvAlertDragging = { idx: fvAi, alert: fvAltArr[fvAi] };
            _fvAlertDragMoved = false; _fvAlertDragBtn = 0;
            el.style.cursor = 'ns-resize';
            return;
          }
        }
        return;
      }
      // Alt+left: ruler
      e.stopPropagation(); e.preventDefault();
      var fvAltPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      var fvAltPr = _fvSeries.coordinateToPrice(fvAltPt.y);
      if (fvAltPr != null) { _fvRuler.start = { pt: fvAltPt, price: fvAltPr }; _fvRuler._altRuler = true; }
      return;
    }
    // Alert drag: shift + right-button (button 2)
    if (e.button === 2 && e.shiftKey) {
      var ay2 = e.clientY - rect.top;
      var alertArr = _alerts[sym] || [];
      for (var ai = 0; ai < alertArr.length; ai++) {
        var aCoord = _fvSeries.priceToCoordinate(alertArr[ai].price);
        if (aCoord != null && Math.abs(aCoord - ay2) < 8) {
          if (alertArr[ai].triggered) return; // triggered alerts are not draggable
          e.stopPropagation(); e.preventDefault();
          _fvAlertDragging = { idx: ai, alert: alertArr[ai] };
          _fvAlertDragMoved = false; _fvAlertDragBtn = 2;
          el.style.cursor = 'ns-resize';
          return;
        }
      }
    }
    if (e.button !== 0) return;
    if (_fvReplay) return; // review mode: the live chart's levels aren't here — nothing to drag
    var y = e.clientY - rect.top;
    var levels = _levels[sym] || [];
    for (var i = 0; i < levels.length; i++) {
      var ly = _fvSeries.priceToCoordinate(levels[i].price);
      if (ly != null && Math.abs(ly - y) < 6) { e.stopPropagation(); e.preventDefault(); _fvDragging = { idx: i, lvl: levels[i] }; el.style.cursor = 'ns-resize'; return; }
    }
  }, { capture: true });
  el.addEventListener('mousemove', function (e) {
    var rect = el.getBoundingClientRect();
    var y = e.clientY - rect.top;
    if (_fvRayDragging && (e.buttons & 1)) {
      var fvX1 = e.clientX - rect.left;
      var fvMap2 = _rayCoordMap(_fvChart, sym, state.chartTF[sym] || '5m');
      var fvCurPrice = _fvSeries.coordinateToPrice(y), fvCurTime = fvMap2 ? fvMap2.xToTime(fvX1) : null;
      if (fvCurPrice != null && fvCurTime != null) {
        var fvRay = _fvRayDragging.ray;
        fvRay.price1 = _fvRayDragging.origPrice1 + (fvCurPrice - _fvRayDragging.grabPrice);
        fvRay.time1 = _fvRayDragging.origTime1 + (fvCurTime - _fvRayDragging.grabTime);
        _fvRayDragging.moved = true;
        if (fvRay.line) fvRay.line.applyOptions({ price: fvRay.price1 });
        if (fvRay.fvLine) fvRay.fvLine.applyOptions({ price: fvRay.price1 });
      }
      return;
    }
    if (_fvDragging && (e.buttons & 1)) {
      var price = _fvSeries.coordinateToPrice(y);
      if (price != null) {
        _fvDragging.lvl.price = price;
        if (_fvDragging.lvl.fvLine) _fvDragging.lvl.fvLine.applyOptions({ price: price });
        if (_fvDragging.lvl.line) _fvDragging.lvl.line.applyOptions({ price: price });
      }
      return;
    }
    // Alert drag (shift+right or Shift+Alt+left)
    if (_fvAlertDragging && (e.buttons & (_fvAlertDragBtn === 0 ? 1 : 2))) {
      var alertPrice = _fvSeries.coordinateToPrice(y);
      if (alertPrice != null) {
        _fvAlertDragging.alert.price = alertPrice;
        var _fvARefs = _aLines[_fvAlertDragging.alert.id];
        if (_fvARefs) {
          if (_fvARefs.fv)   { try { _fvARefs.fv.applyOptions({ price: alertPrice }); } catch (_e) {} }
          if (_fvARefs.card) { try { _fvARefs.card.applyOptions({ price: alertPrice }); } catch (_e) {} }
        }
        _fvAlertDragMoved = true;
      }
      return;
    }
    var fvNear = false;
    var fvLvls = _levels[sym] || [];
    for (var fvi = 0; fvi < fvLvls.length; fvi++) {
      var fvLy = _fvSeries.priceToCoordinate(fvLvls[fvi].price);
      if (fvLy != null && Math.abs(fvLy - y) < 6) { fvNear = true; break; }
    }
    if (!fvNear && e.shiftKey) {
      var fvAlertHints = _alerts[sym] || [];
      for (var fvAk = 0; fvAk < fvAlertHints.length; fvAk++) {
        var fvAyk = _fvSeries.priceToCoordinate(fvAlertHints[fvAk].price);
        if (fvAyk != null && Math.abs(fvAyk - y) < 8) { fvNear = true; break; }
      }
    }
    el.style.cursor = fvNear ? 'ns-resize' : '';
    var ruler = _fvRuler;
    if (!ruler || !ruler.start || (!(e.buttons & 4) && !(ruler._altRuler && (e.buttons & 1)))) return;
    var pt = { x: e.clientX - rect.left, y: y };
    var pr2 = _fvSeries.coordinateToPrice(y);
    if (pr2 == null) return;
    var rc = ruler.canvas, ctx = rc.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, rc.width, rc.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cw = rc.width / dpr, ch = rc.height / dpr;
    _drawFVOverlays(ctx, rc, sym);
    var p1 = ruler.start.pt, pr1 = ruler.start.price;
    var color = isDark() ? getCSSVar('--ink-deep') : getCSSVar('--graphite');
    var pct = ((pr2 - pr1) / Math.abs(pr1) * 100);
    var pctStr = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    var durStr = '';
    if (_fvChart) {
      var fvTs = _fvChart.timeScale();
      var t1 = fvTs.coordinateToTime(p1.x), t2 = fvTs.coordinateToTime(pt.x);
      if (t1 == null || t2 == null) {
        var vr = fvTs.getVisibleRange();
        if (vr) {
          if (t1 == null) t1 = p1.x < pt.x ? vr.from : vr.to;
          if (t2 == null) t2 = pt.x > p1.x ? vr.to : vr.from;
        }
      }
      if (t1 != null && t2 != null) {
        var d = Math.abs(t2 - t1);
        durStr = d < 60 ? Math.round(d) + 's' : d < 3600 ? Math.round(d / 60) + 'm' : d < 86400 ? Math.floor(d / 3600) + 'h ' + Math.round((d % 3600) / 60) + 'm' : Math.floor(d / 86400) + 'd ' + Math.floor((d % 86400) / 3600) + 'h';
      }
    }
    ctx.fillStyle = 'rgba(150,150,150,0.07)';
    ctx.fillRect(0, Math.min(p1.y, pt.y), cw, Math.abs(pt.y - p1.y) || 1);
    ctx.strokeStyle = isDark() ? getCSSVar('--graphite') : getCSSVar('--graphite'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, p1.y); ctx.lineTo(cw, p1.y); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(pt.x, pt.y); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p1.x, p1.y, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2); ctx.fill();
    var fvLbl = _fvRuler && _fvRuler.label;
    if (fvLbl) {
      ctx.font = '500 10px Manrope,Arial,sans-serif';
      var sign = pctStr[0], digits = pctStr.slice(1);
      var maxW = Math.max(ctx.measureText(digits).width, durStr ? ctx.measureText(durStr).width : 0);
      var fvPriceAxisW = 0; try { fvPriceAxisW = _fvChart.priceScale('right').width(); } catch (_) {}
      var flipLeft = pt.x + 16 + maxW + 16 > cw - fvPriceAxisW;
      var fvPlateHalf = durStr ? 16 : 8;
      var fvDpr = window.devicePixelRatio || 1;
      var fvSnappedY = Math.round(pt.y * fvDpr) / fvDpr;
      var fvClampedY = Math.max(fvPlateHalf, Math.min(ch - fvPlateHalf, fvSnappedY));
      fvLbl.style.left = pt.x + 'px';
      fvLbl.style.top = fvClampedY + 'px';
      fvLbl.style.transform = flipLeft ? 'translate(calc(-100% - 16px),-50%)' : 'translate(16px,-50%)';
      fvLbl.innerHTML =
        '<div style="display:flex"><span style="min-width:.55em;text-align:right">' + sign + '</span><span>' + digits + '</span></div>' +
        (durStr ? '<div style="display:flex"><span style="min-width:.55em"></span><span>' + durStr + '</span></div>' : '');
      fvLbl.style.display = 'flex';
    }
  });
  el.addEventListener('mouseup', function (e) {
    if ((e.button === 1 || (e.button === 0 && _fvRuler && _fvRuler._altRuler)) && _fvRuler) { _fvRuler.start = null; _fvRuler._altRuler = false; if (_fvRuler.label) _fvRuler.label.style.display = 'none'; }
    if (_fvRayDragging && e.button === 0) {
      var frd = _fvRayDragging; _fvRayDragging = null; el.style.cursor = '';
      if (!frd.moved) removeRay(sym, frd.idx); else saveRays();
    }
    if (_fvDragging && e.button === 0) { saveLevels(); _fvDragging = null; el.style.cursor = ''; }
    if (_fvAlertDragging && e.button === _fvAlertDragBtn) { saveAlerts(); _fvAlertDragging = null; _fvAlertDragBtn = 2; el.style.cursor = ''; }
  });
  el.addEventListener('mouseleave', function () {
    if (_fvRayDragging) { _fvRayDragging = null; el.style.cursor = ''; saveRays(); }
    if (_fvDragging) { _fvDragging = null; saveLevels(); }
    if (_fvAlertDragging) { _fvAlertDragging = null; _fvAlertDragBtn = 2; saveAlerts(); }
    if (_fvRuler) { _fvRuler._altRuler = false; _fvRuler.start = null; if (_fvRuler.label) _fvRuler.label.style.display = 'none'; }
    el.style.cursor = '';
  });

  // ── Touch: drag levels/alerts + long-press to add/delete ─────────────────
  var _fvTD = {
    active: false, mode: null, item: null,  // currently dragging
    near: false, nearMode: null, nearItem: null, nearIdx: null, // touched near a level/alert
    dragReady: false,                       // true after 200ms hold — drag unlocked
    addTimer: null,                         // long-press timer for empty area → show menu
    readyTimer: null, deleteTimer: null,    // 200ms / 600ms timers
    startX: 0, startY: 0,
  };


  function _fvTMShowMenu(y, price, delMode, delIdx, time1) {
    _fvTMHideMenu();
    var p = price.toFixed(calcPriceFormat(price).precision);
    var m = document.createElement('div');
    m.id = 'fv-touch-menu';
    m.className = 'fv-touch-menu context-menu';
    var html;
    if (delMode === 'level') {
      html = '<button class="fv-touch-menu-item fv-tmi-danger" data-tm="del-level" data-idx="' + delIdx + '">' +
        '<span class="fv-tmi-icon">' + icon('trash', 16) + '</span><span>Delete level · ' + p + '</span></button>';
    } else if (delMode === 'alert') {
      html = '<button class="fv-touch-menu-item fv-tmi-danger" data-tm="del-alert" data-idx="' + delIdx + '">' +
        '<span class="fv-tmi-icon">' + icon('trash', 16) + '</span><span>Delete alert · ' + p + '</span></button>';
    } else if (delMode === 'ray') {
      html = '<button class="fv-touch-menu-item fv-tmi-danger" data-tm="del-ray" data-idx="' + delIdx + '">' +
        '<span class="fv-tmi-icon">' + icon('trash', 16) + '</span><span>Delete ray · ' + p + '</span></button>';
    } else {
      html = '<button class="fv-touch-menu-item" data-tm="level">' +
          '<span class="fv-tmi-icon">' + icon('minus', 16) + '</span><span>Price level · ' + p + '</span></button>' +
        '<button class="fv-touch-menu-item" data-tm="alert">' +
          '<span class="fv-tmi-icon">' + icon('bell', 16) + '</span><span>Add alert · ' + p + '</span></button>' +
        '<button class="fv-touch-menu-item" data-tm="ray" data-time="' + time1 + '">' +
          '<span class="fv-tmi-icon">' + icon('arrow-right', 16) + '</span><span>Ray · ' + p + '</span></button>';
    }
    m.innerHTML = html;
    var menuH = delMode ? 54 : 162;
    var chartH = wrap.offsetHeight;
    var top = (y + 10 + menuH > chartH) ? Math.max(4, y - menuH - 10) : y + 10;
    m.style.top = top + 'px';
    wrap.appendChild(m);
    m.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tm]');
      if (!btn) { _fvTMHideMenu(); return; }
      var a = btn.dataset.tm, idx = parseInt(btn.dataset.idx);
      if (a === 'level') addLevel(sym, price);
      else if (a === 'alert') addAlert(sym, price);
      else if (a === 'ray') { var t1 = parseFloat(btn.dataset.time); if (!isNaN(t1)) addRay(sym, t1, price); }
      else if (a === 'del-level') removeLevel(sym, idx);
      else if (a === 'del-alert') removeAlert(sym, idx);
      else if (a === 'del-ray') removeRay(sym, idx);
      _fvTMHideMenu();
    });
    // Close on next touchstart outside the menu (not touchend — that fires
    // when the user lifts from the long-press before they can tap a menu item)
    function _cTM(ev) {
      var m2 = document.getElementById('fv-touch-menu');
      if (!m2) { document.removeEventListener('touchstart', _cTM); return; }
      if (!m2.contains(ev.target)) { _fvTMHideMenu(); document.removeEventListener('touchstart', _cTM); }
    }
    document.addEventListener('touchstart', _cTM);
  }

  function _fvTMHideMenu() { var m = document.getElementById('fv-touch-menu'); if (m) m.remove(); }
  function _fvTMShowHandle(y) {
    var h = document.getElementById('fv-drag-handle');
    if (!h) { h = document.createElement('div'); h.id = 'fv-drag-handle'; h.className = 'fv-drag-handle'; wrap.appendChild(h); }
    h.style.top = (y - 8) + 'px'; h.style.display = 'block';
  }
  function _fvTMMoveHandle(y) { var h = document.getElementById('fv-drag-handle'); if (h) h.style.top = (y - 8) + 'px'; }
  function _fvTMHideHandle() { var h = document.getElementById('fv-drag-handle'); if (h) h.style.display = 'none'; }

  el.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    var t = e.touches[0], rect = el.getBoundingClientRect();
    var x = t.clientX - rect.left, y = t.clientY - rect.top;
    _fvTD.startX = x; _fvTD.startY = y;

    // Reset all state
    _fvTD.active = false; _fvTD.mode = null; _fvTD.item = null;
    _fvTD.near = false; _fvTD.nearMode = null; _fvTD.nearItem = null; _fvTD.nearIdx = null;
    _fvTD.dragReady = false; _fvTD.rayGrab = null;
    clearTimeout(_fvTD.readyTimer); _fvTD.readyTimer = null;
    clearTimeout(_fvTD.deleteTimer); _fvTD.deleteTimer = null;
    clearTimeout(_fvTD.addTimer); _fvTD.addTimer = null;
    _fvTMHideMenu();

    // Ignore touches on the price scale area (rightmost ~75px)
    var psW = (_fvChart && _fvChart.priceScale('right').width) ? _fvChart.priceScale('right').width() : 75;
    if (x > el.offsetWidth - psW) { _fvTMHideHandle(); return; }

    // ── Touch near a level — 200ms to unlock drag, 600ms to delete ──────────
    var levels = _levels[sym] || [];
    for (var i = 0; i < levels.length; i++) {
      var ly = _fvSeries.priceToCoordinate(levels[i].price);
      if (ly != null && Math.abs(ly - y) < 10) {
        _fvTD.near = true; _fvTD.nearMode = 'level'; _fvTD.nearItem = levels[i]; _fvTD.nearIdx = i;
        _fvTMShowHandle(ly);
        if (e.cancelable) e.preventDefault();
        _fvTD.readyTimer = setTimeout(function () { _fvTD.dragReady = true; }, 200);
        _fvTD.deleteTimer = setTimeout(function () {
          if (_fvTD.near && !_fvTD.active) {
            _fvTMHideHandle(); _fvTD.near = false;
            var item = _fvTD.nearItem, idx = _fvTD.nearIdx;
            if (item) _fvTMShowMenu(_fvTD.startY, item.price, 'level', idx);
          }
        }, 600);
        return;
      }
    }
    var alerts = _alerts[sym] || [];
    for (var j = 0; j < alerts.length; j++) {
      var ay = _fvSeries.priceToCoordinate(alerts[j].price);
      if (ay != null && Math.abs(ay - y) < 10) {
        _fvTD.near = true; _fvTD.nearMode = 'alert'; _fvTD.nearItem = alerts[j]; _fvTD.nearIdx = j;
        _fvTMShowHandle(ay);
        if (e.cancelable) e.preventDefault();
        _fvTD.readyTimer = setTimeout(function () { _fvTD.dragReady = true; }, 200);
        _fvTD.deleteTimer = setTimeout(function () {
          if (_fvTD.near && !_fvTD.active) {
            _fvTMHideHandle(); _fvTD.near = false;
            var item = _fvTD.nearItem, idx = _fvTD.nearIdx;
            if (item) _fvTMShowMenu(_fvTD.startY, item.price, 'alert', idx);
          }
        }, 600);
        return;
      }
    }
    var rTf = state.chartTF[sym] || '5m';
    var rIdx = _nearRayIdx(sym, _fvChart, _fvSeries, rTf, x, y);
    if (rIdx >= 0) {
      var ray = _rays[sym][rIdx];
      var rMap = _rayCoordMap(_fvChart, sym, rTf);
      var ry = _fvSeries.priceToCoordinate(ray.price1);
      _fvTD.near = true; _fvTD.nearMode = 'ray'; _fvTD.nearItem = ray; _fvTD.nearIdx = rIdx;
      _fvTD.rayGrab = { grabPrice: _fvSeries.coordinateToPrice(y), grabTime: rMap ? rMap.xToTime(x) : null, origPrice1: ray.price1, origTime1: ray.time1 };
      _fvTMShowHandle(ry != null ? ry : y);
      if (e.cancelable) e.preventDefault();
      _fvTD.readyTimer = setTimeout(function () { _fvTD.dragReady = true; }, 200);
      _fvTD.deleteTimer = setTimeout(function () {
        if (_fvTD.near && !_fvTD.active) {
          _fvTMHideHandle(); _fvTD.near = false;
          var item = _fvTD.nearItem, idx = _fvTD.nearIdx;
          if (item) _fvTMShowMenu(_fvTD.startY, item.price1, 'ray', idx);
        }
      }, 600);
      return;
    }

    // Empty area — 900ms long-press shows add menu directly (no "+" button)
    _fvTD.addTimer = setTimeout(function () {
      _fvTD.addTimer = null;
      var price = _fvSeries ? _fvSeries.coordinateToPrice(_fvTD.startY) : null;
      var addMap = _rayCoordMap(_fvChart, sym, state.chartTF[sym] || '5m');
      var time1 = addMap ? addMap.xToTime(_fvTD.startX) : null;
      if (price != null) _fvTMShowMenu(_fvTD.startY, price, null, null, time1);
    }, 900);

  }, { passive: false });

  el.addEventListener('touchmove', function (e) {
    if (e.touches.length !== 1) return;
    var t = e.touches[0], rect = el.getBoundingClientRect();
    var x = t.clientX - rect.left, y = t.clientY - rect.top;
    var dx = x - _fvTD.startX, dy = y - _fvTD.startY;
    var moved = Math.sqrt(dx * dx + dy * dy);

    // Cancel add-menu timer if finger moved (treat as scroll)
    if (_fvTD.addTimer && moved > 8) {
      clearTimeout(_fvTD.addTimer); _fvTD.addTimer = null;
    }

    // Near an item but drag not ready yet — if finger moved, cancel (treat as scroll)
    if (_fvTD.near && !_fvTD.dragReady && !_fvTD.active) {
      if (moved > 4) {
        clearTimeout(_fvTD.readyTimer); _fvTD.readyTimer = null;
        clearTimeout(_fvTD.deleteTimer); _fvTD.deleteTimer = null;
        _fvTD.near = false; _fvTD.nearItem = null;
        _fvTMHideHandle();
      }
      return;
    }

    // Drag is ready and finger started moving — begin drag
    if (_fvTD.dragReady && _fvTD.near && !_fvTD.active && moved > 2) {
      if (_fvTD.nearMode === 'alert' && _fvTD.nearItem && _fvTD.nearItem.triggered) return; // triggered alerts are not draggable
      _fvTD.active = true; _fvTD.mode = _fvTD.nearMode; _fvTD.item = _fvTD.nearItem;
      _fvTD.near = false;
      clearTimeout(_fvTD.deleteTimer); _fvTD.deleteTimer = null;
    }

    if (_fvTD.active) {
      if (e.cancelable) e.preventDefault();
      var item = _fvTD.item;
      if (_fvTD.mode === 'ray') {
        var rTfMove = state.chartTF[sym] || '5m';
        var rMapMove = _rayCoordMap(_fvChart, sym, rTfMove);
        var curPrice = _fvSeries.coordinateToPrice(y);
        var curTime = rMapMove ? rMapMove.xToTime(x) : null;
        if (curPrice != null && curTime != null && _fvTD.rayGrab) {
          var g = _fvTD.rayGrab;
          item.price1 = g.origPrice1 + (curPrice - g.grabPrice);
          item.time1 = g.origTime1 + (curTime - g.grabTime);
          if (item.line) item.line.applyOptions({ price: item.price1 });
          if (item.fvLine) item.fvLine.applyOptions({ price: item.price1 });
        }
        _fvTMMoveHandle(y);
        return;
      }
      var price = _fvSeries.coordinateToPrice(y);
      if (price == null) return;
      item.price = price;
      if (_fvTD.mode === 'level') {
        if (item.fvLine) item.fvLine.applyOptions({ price: price });
        if (item.line)   item.line.applyOptions({ price: price });
      } else {
        var _trefs = _aLines[item.id];
        if (_trefs) {
          if (_trefs.fv)   { try { _trefs.fv.applyOptions({ price: price }); } catch (_e) {} }
          if (_trefs.card) { try { _trefs.card.applyOptions({ price: price }); } catch (_e) {} }
        }
        redrawAlerts(sym);
      }
      _fvTMMoveHandle(y);
      return;
    }

  }, { passive: false });

  el.addEventListener('touchend', function () {
    clearTimeout(_fvTD.readyTimer); _fvTD.readyTimer = null;
    clearTimeout(_fvTD.deleteTimer); _fvTD.deleteTimer = null;
    clearTimeout(_fvTD.addTimer); _fvTD.addTimer = null;
    _fvTD.dragReady = false;
    _fvTD.near = false; _fvTD.nearItem = null;
    if (_fvTD.active) {
      if (_fvTD.mode === 'level') saveLevels();
      else if (_fvTD.mode === 'ray') saveRays();
      else saveAlerts();
      _fvTMHideHandle();
      _fvTD.active = false; _fvTD.mode = null; _fvTD.item = null;
    } else {
      _fvTMHideHandle();
    }
  });

  // rAF loop: alert bells + trade markers (only when ruler is idle)
  (function fvBellLoop() {
    if (!_fvChart) return;
    var ruler = _fvRuler;
    if (ruler && ruler.canvas && !ruler.start) {
      var ctx = ruler.canvas.getContext('2d');
      var fvDpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, ruler.canvas.width, ruler.canvas.height);
      ctx.setTransform(fvDpr, 0, 0, fvDpr, 0, 0);
      _drawFVOverlays(ctx, ruler.canvas, sym);
    }
    requestAnimationFrame(fvBellLoop);
  }());

  _loadFVData(sym, tf);
}

export function closeCoinFullView() {
  _fvReplay = null;
  window.__fvReplay = false;
  closeSurface('notes');
  closeSurface('liquidity');
  clearNoteIcons();
  softDisconnectOrderbook();
  terminalOnFVClose();
  if (_fvChart) { try { _fvChart.remove(); } catch (e) {} _fvChart = null; }
  if (_fvRuler && _fvRuler._resizeHandler) window.removeEventListener('resize', _fvRuler._resizeHandler);
  if (_fvRuler && _fvRuler._resizeObserver) _fvRuler._resizeObserver.disconnect();
  if (_fvRuler && _fvRuler._escHandler) document.removeEventListener('keydown', _fvRuler._escHandler);
  if (_fvTimerInterval) { clearInterval(_fvTimerInterval); _fvTimerInterval = null; }
  _fvSeries = null; _fvVolSeries = null; _fvRuler = null; _fvTradeMarkersData = [];
  window.__fvSeries = null; window.__fvVolSeries = null; window.__fvSymbol = null; window.__fvTF = null;
  if (_fvSym) {
    (_levels[_fvSym] || []).forEach(function (l) { l.fvLine = null; });
    (_rays[_fvSym] || []).forEach(function (r) { r.fvLine = null; });
    (_alerts[_fvSym] || []).forEach(function (a) { _detachFvLine(a); });
    // TF switched inside FV doesn't touch the grid card's chart — sync it now
    // so the card reflects state.chartTF without waiting for a tab switch.
    setChartTF(_fvSym, state.chartTF[_fvSym] || '5m');
  }
  _fvSym = null;
  var overlay = document.getElementById('fv-overlay');
  if (overlay) overlay.style.display = 'none';
  closeSurface('analysis');
  forceUnlockScroll();
  initCharts();
}

export function setFVChartTF(tf) {
  if (!_fvSym || !_fvSeries) return;
  state.chartTF[_fvSym] = tf;
  window.__fvTF = tf;
  _startFVTimer(tf);
  emit('fv:tf');
  // Remove price lines from series before reload to prevent duplicate orphaned lines
  (_levels[_fvSym] || []).forEach(function (l) { if (l.fvLine) { try { _fvSeries.removePriceLine(l.fvLine); } catch (e) {} l.fvLine = null; } });
  (_rays[_fvSym] || []).forEach(function (r) { if (r.fvLine) { try { _fvSeries.removePriceLine(r.fvLine); } catch (e) {} r.fvLine = null; } });
  (_alerts[_fvSym] || []).forEach(function (a) { _detachFvLine(a); });
  _fvSeries.setData([]);
  _loadFVData(_fvSym, tf);
}

export function briefingCycleStatus(sym, date) {
  cycleBriefingStatus(sym, date);
}

// force: already confirmed (the React list asks with a dialog)
export function briefingRemove(sym, date, force) {
  var idx = (state.briefing || []).findIndex(function (e) { return e.sym === sym && e.date === date; });
  if (idx >= 0) {
    var entry = state.briefing[idx];
    if (!force && entry.note && entry.note.trim()) {
      if (!confirm('Remove ' + sym + ' from watchlist?')) return;
    }
    state.briefing.splice(idx, 1);
    saveBriefingLocal();
    syncBriefingNow();
    updateStarButton(sym);
    renderBriefingPanel();
    var _fvd2 = document.getElementById('fv-briefing-drawer');
    if (_fvd2 && _fvd2.classList.contains('open')) renderFVBriefingDrawer();
  }
}

// The drawer beside the full-view chart is a React island while open
export function renderFVBriefingDrawer() { emit('briefing:render'); }

export function openFVBriefingDrawer() {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (!drawer) return;
  drawer.classList.add('open');
  mountIsland(drawer, BriefingDrawer);
  refreshBriefingFromServer();
  if (!state.isDemoMode) fetchJournalToday().then(renderFVBriefingDrawer);
}

export function closeFVBriefingDrawer() {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (drawer) { drawer.classList.remove('open'); unmountIsland(drawer); }
  _applyFVTradeMarkers(null);
}

export function toggleFVBriefingDrawer() {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (!drawer) return;
  if (drawer.classList.contains('open')) { closeFVBriefingDrawer(); } else { openFVBriefingDrawer(); }
}

// ── Search (shadcn Command dialog, src/react/host/SearchDialog.jsx) ─────────

// Coin search — a popover under the visible search button (src/react/host/SearchPopover.jsx);
// from ⌘K with no button on screen (full view) it opens at the top centre
export function openSearchPopup() {
  if (isSurfaceOpen('search')) { closeSurface('search'); return; }
  var btn = Array.from(document.querySelectorAll('[data-action="open-search"]')).find(function (b) { return b.offsetParent !== null; });
  var r = btn ? btn.getBoundingClientRect() : { left: window.innerWidth / 2 + 192, top: 12, width: 0, height: 36 };
  openSurface('search', { rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
}
export function closeSearchPopup() { closeSurface('search'); }

// ── Clear popup ──────────────────────────────────────────────────────────────

export function closeClearPopup() { closeSurface('clear'); }

// The coin's levels / rays / alerts to clear, anchored to the chart's button
export function openClearPopup(sym, btn) {
  var counts = { levels: (_levels[sym] || []).length, alerts: (_alerts[sym] || []).length, rays: (_rays[sym] || []).length };
  if (!counts.levels && !counts.alerts && !counts.rays) return;
  if (isSurfaceOpen('clear')) { closeSurface('clear'); return; }
  var r = btn.getBoundingClientRect();
  openSurface('clear', { sym: sym, counts: counts, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
}

// ── Hints popup ─────────────────────────────────────────────────────────────

export function openHintsPopup() { openSurface('hints'); }
export function closeHintsPopup() { closeSurface('hints'); }

// ── Screener ────────────────────────────────────────────────────────────────

export function renderScreener() {
  _screenerMode = true;
  render();
}

// ── Notifications ────────────────────────────────────────────────────────────

function _timeAgo(ts) {
  var diff = Date.now() - ts;
  var m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function _playNotifSound() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1047, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {}
}

export function showNotifToast(entry) {
  _playNotifSound();
  // Tab not focused — show an OS-level notification too, since the in-page toast won't be seen.
  if (window.Notification && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    try { new Notification('Pump Analyzer', { body: entry.message, icon: '/apple-touch-icon.png' }); } catch (e) {}
  }
  toast(entry.message, { duration: 30000 });
}

// The bell's dot is in the React header (src/react/home/Topbar.jsx)
export function updateNotifBadge() { emit('notifications:updated'); }

// The list under the bell is a shadcn popover (src/react/host/NotificationsPopover.jsx)
function _renderNotifDropdown() { emit('notifications:updated'); }

export function requestDesktopNotifPermission() {
  if (!window.Notification) return Promise.resolve();
  return Notification.requestPermission().then(function () { _renderNotifDropdown(); });
}


export function markNotificationAsRead(id) {
  var n = state.notifications.find(function (n) { return n.id === id; });
  if (!n || n.read) return;
  n.read = true;
  state.notifUnread = Math.max(0, state.notifUnread - 1);
  updateNotifBadge();
  _renderNotifDropdown();
  markNotificationRead(id);
}

export function clearNotifications() {
  state.notifications = [];
  state.notifUnread = 0;
  updateNotifBadge();
  _renderNotifDropdown();
  fetch(API_BASE + '/api/notifications', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'clear' }),
  }).catch(function () {});
}

export function toggleNotifDropdown() {
  if (isSurfaceOpen('notifications')) { closeSurface('notifications'); return; }
  var btn = document.getElementById('notif-btn');
  if (!btn) return;
  var r = btn.getBoundingClientRect();
  openSurface('notifications', { rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
}

