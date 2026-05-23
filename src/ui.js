import { state, filteredCoins } from './state.js';
import { fmt, fmtPrice, escHtml, signalLabel, icon } from './utils.js';
import { on } from './events.js';
import { fetchMarketStrength, analyzeCoinBySymbol, fetchChartData, wsConnected, sendWS, API_BASE, applyLivePriceUpdates } from './api.js';

// ── Utility ────────────────────────────────────────────────────────────────

function natrDisplay(symbol) {
  var nd = state.natrData[symbol];
  if (!nd || nd === 'loading' || nd === 'error') return { val: '—', cls: 'dim' };
  var v = nd.value, cls = v < 1 ? 'dn' : v < 2.5 ? 'warn' : 'up';
  return { val: v.toFixed(2), cls: cls };
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderCard(coin) {
  var cache = state.analysisCache[coin.symbol];
  var hasA = cache && cache.status === 'ok', isL = cache && cache.status === 'loading', isE = cache && cache.status === 'error';
  var signal = hasA ? cache.result.signal : null;
  var tf = state.chartTF[coin.symbol] || '5m';
  var change = coin.price_change_percentage_24h || 0;
  var natr = natrDisplay(coin.symbol);

  var badge = '';
  if (isL) badge = '<span class="btn-pressed">' + icon('zap', 14) + '</span>';
  else if (isE) badge = '<button class="btn-retry" data-action="analyze" data-sym="' + coin.symbol + '">Повтор</button>';
  else if (hasA) badge = '<span class="signal-badge ' + signal + '" data-action="open-analysis" data-sym="' + coin.symbol + '">' + signalLabel(signal) + '</span>';
  else badge = '<button class="btn-analyze-one" data-action="analyze" data-sym="' + coin.symbol + '">' + icon('zap', 14) + '</button>';

  var tfPicker = '<div class="tf-picker">' +
    '<button class="tf-pill" data-action="tf-pick" data-sym="' + coin.symbol + '">' + tf + '</button>' +
    '<div class="tf-dd" style="display:none">' +
    ['1m', '5m', '15m', '1h', '4h'].map(function (t) {
      return '<button class="' + (t === tf ? 'active' : '') + '" data-action="tf-opt" data-sym="' + coin.symbol + '" data-tf="' + t + '">' + t + '</button>';
    }).join('') +
    '</div>' +
    '</div>';

  var statsHtml = '<div class="card-chart-stats">' +
    '<span class="stat-val ' + (change >= 0 ? 'up' : 'dn') + '" title="Изменение за 24ч">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%</span>' +
    '<span class="stat-val ' + natr.cls + '" title="NATR — волатильность (5m × 30 свечей)">' + natr.val + '</span>' +
    '<span class="stat-val" title="Объём торгов за 24ч">' + fmt(coin.total_volume).replace('$', '') + '</span>' +
    '</div>';

  return '<div class="coin-card' + (signal ? ' ' + signal : '') + '" data-sym="' + coin.symbol + '">' +
    '<div class="card-head">' +
    '<div class="card-sym-row">' +
    '<span class="card-sym">' + coin.symbol.toUpperCase() + '</span>' +
    tfPicker +
    '</div>' +
    '<div class="card-head-right">' +
    '<button class="btn-clear-alerts" data-action="clear-alerts" data-sym="' + coin.symbol + '" title="Алерты (Shift+ПКМ для добавления)" style="display:' + ((_alerts[coin.symbol] && _alerts[coin.symbol].length) ? 'inline-flex' : 'none') + '">' + ((_alerts[coin.symbol] && _alerts[coin.symbol].length) || 0) + '</button>' +
    '<button class="btn-clear-levels" data-action="clear-levels" data-sym="' + coin.symbol + '" style="display:' + ((_levels[coin.symbol] && _levels[coin.symbol].length) ? 'inline-flex' : 'none') + '">' + ((_levels[coin.symbol] && _levels[coin.symbol].length) || 0) + '</button>' +
    badge +
    '<button class="btn-star' + (isInBriefing(coin.symbol) ? ' active' : '') + '" data-action="toggle-briefing" data-sym="' + coin.symbol + '" title="' + (isInBriefing(coin.symbol) ? 'Убрать из брифинга' : 'В брифинг') + '">' + icon('star', 15) + '</button>' +
    '<button class="btn-expand" data-action="expand" data-sym="' + coin.symbol + '" title="Полный экран">' + icon('maximize-2', 15) + '</button>' +
    '</div>' +
    '</div>' +
    '<div class="chart-container" id="chart-' + coin.symbol + '"></div>' +
    statsHtml +
    '</div>';
}

export function renderCards() {
  var grid = document.getElementById('cards-grid');
  if (!grid) return;
  var coins = filteredCoins();
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
      try { if (_charts[sym]) _charts[sym].remove(); } catch (e) {}
      if (_levels[sym]) _levels[sym].forEach(function (l) { l.line = null; });
      delete _charts[sym]; delete _fullSeries[sym]; delete _volSeries[sym]; delete _rulers[sym];
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

  initCharts();
  // Синхронизируем display с текущим state после каждого ре-ордера.
  // Без этого sort использует свежие значения state, а DOM показывает значения
  // из _liveTimer (2с-давности) — карточки визуально стоят "не по порядку".
  applyLivePriceUpdates();
}

export function updateCardBadge(symbol) {
  var el = document.querySelector('[data-ck="' + symbol + '"]');
  if (!el) el = document.querySelector('[data-action="open-analysis"][data-sym="' + symbol + '"]');
  if (!el) el = document.querySelector('[data-action="analyze"][data-sym="' + symbol + '"]');
  var cache = state.analysisCache[symbol];
  var hasA = cache && cache.status === 'ok', isL = cache && cache.status === 'loading', isE = cache && cache.status === 'error';
  var signal = hasA ? cache.result.signal : null;
  var tag = 'span';
  var html = '';
  if (isL) { tag = 'span'; html = '' + icon('zap', 14) + ''; }
  else if (isE) { tag = 'button'; html = 'Повтор'; }
  else if (hasA) { tag = 'span'; html = signalLabel(signal); }
  else { tag = 'button'; html = '' + icon('zap', 14) + ''; }

  var newEl = document.createElement(tag);
  if (isE) { newEl.className = 'btn-retry'; newEl.dataset.action = 'analyze'; newEl.dataset.sym = symbol; }
  else if (hasA) { newEl.className = 'signal-badge ' + signal; newEl.dataset.action = 'open-analysis'; newEl.dataset.sym = symbol; }
  else if (isL) { newEl.className = 'btn-pressed'; }
  else { newEl.className = 'btn-analyze-one'; newEl.dataset.action = 'analyze'; newEl.dataset.sym = symbol; }
  newEl.innerHTML = html;

  if (el && el.parentNode) {
    var ckAttr = document.createAttribute('data-ck');
    ckAttr.value = symbol;
    newEl.setAttributeNode(ckAttr);
    el.parentNode.replaceChild(newEl, el);
  }

  var coins = filteredCoins();
  var bc = coins.filter(function (c) { return state.analysisCache[c.symbol] && state.analysisCache[c.symbol].result && state.analysisCache[c.symbol].result.signal === 'bullish'; }).length;
  var metric = document.querySelector('.metric-card:nth-child(4) .value');
  if (metric) metric.textContent = bc;
}

// ── Charts ─────────────────────────────────────────────────────────────────

var _charts = {}, _fullSeries = {}, _volSeries = {}, _rulers = {}, _dragging = null, _alertDragging = null, _alertDragMoved = false;
var _fvChart = null, _fvSeries = null, _fvVolSeries = null, _fvSym = null;

// Pre-render Lucide bell as SVG image for canvas drawing
var _bellImg = (function () {
  // Bell paths scaled to ~60% and centered — leaves visible padding inside the circle
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24">' +
    '<circle cx="12" cy="12" r="11" fill="#ef4444"/>' +
    '<g transform="translate(12,12) scale(0.58) translate(-12,-11)">' +
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</g>' +
    '</svg>';
  var img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  return img;
}());
// Expose for api.js pollCharts (no circular dependency)
window.__chartSeries = _fullSeries;
window.__chartVolSeries = _volSeries;
window.__charts = _charts;

// ── Levels ─────────────────────────────────────────────────────────────────

var _levels = {}; // symbol → [{price, line}]
var _userCode = localStorage.getItem('pa_user_code') || null;
var _syncTimer = null;

function levelsData() {
  var data = {};
  Object.keys(_levels).forEach(function (sym) {
    if (_levels[sym] && _levels[sym].length) data[sym] = _levels[sym].map(function (l) { return l.price; });
  });
  return data;
}

function syncToServer() {
  if (!_userCode) return;
  fetch(API_BASE + '/api/levels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save', code: _userCode, levels: levelsData() }),
  }).catch(function () {});
}

function saveLevels() {
  try { localStorage.setItem('pa_levels', JSON.stringify(levelsData())); } catch (e) {}
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
  try { localStorage.setItem('pa_levels', JSON.stringify(data)); } catch (e) {}
  reattachAllLevels();
}

function fetchServerLevels(code) {
  fetch(API_BASE + '/api/levels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', code: code }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d || !d.levels) return;
    var serverEmpty = Object.keys(d.levels).length === 0;
    var localData = levelsData();
    var localHasData = Object.keys(localData).length > 0;
    // If server is empty but we have local levels, push them up
    if (serverEmpty && localHasData) {
      syncToServer();
    } else if (!serverEmpty) {
      applyServerLevels(d.levels);
    }
    // If both empty: do nothing — preserve local state
  }).catch(function () {});
}

export function loadLevels() {
  try {
    var local = JSON.parse(localStorage.getItem('pa_levels') || '{}');
    Object.keys(local).forEach(function (sym) {
      _levels[sym.toLowerCase()] = local[sym].map(function (p) { return { price: p, line: null }; });
    });
  } catch (e) {}
  if (_userCode) fetchServerLevels(_userCode);
}

export function showCodeModal() {
  if (document.getElementById('code-modal-backdrop')) return;
  var backdrop = document.createElement('div');
  backdrop.id = 'code-modal-backdrop';
  backdrop.className = 'code-modal-backdrop';
  backdrop.innerHTML =
    '<div class="code-modal">' +
      '<div class="popup-header"><span class="popup-title">Синхронизация</span><button class="popup-close" id="code-modal-close">' + icon('x', 15) + '</button></div>' +
      '<div class="popup-body">' +
        '<p>Придумайте код — он нужен чтобы видеть ваши уровни на любом устройстве.<br>Латинские буквы и цифры, от 2 до 40 символов.</p>' +
        '<input id="code-modal-input" type="text" placeholder="например: dmitrii или trader007" maxlength="40" autocomplete="off" spellcheck="false" />' +
        '<p style="margin-top:16px;margin-bottom:4px;">Telegram chat_id <span style="color:var(--graphite);font-size:11px;">(для алертов на цену)</span></p>' +
        '<input id="chat-id-input" type="text" placeholder="например: 123456789" maxlength="20" autocomplete="off" />' +
        '<p style="font-size:11px;color:var(--graphite);margin-top:6px;">Напишите /start боту, получите ваш chat_id.</p>' +
      '</div>' +
      '<div class="popup-footer code-modal-actions">' +
        '<button class="code-modal-save" id="code-modal-save">Сохранить</button>' +
        '<button class="code-modal-skip" id="code-modal-skip">Пропустить</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(backdrop);

  var input = document.getElementById('code-modal-input');
  var chatInput = document.getElementById('chat-id-input');
  var saveBtn = document.getElementById('code-modal-save');
  var skipBtn = document.getElementById('code-modal-skip');

  if (_userCode) input.value = _userCode;
  if (_chatId) chatInput.value = _chatId;

  function save() {
    var code = input.value.trim();
    if (!/^[a-zA-Z0-9_\-]{2,40}$/.test(code)) {
      input.style.borderColor = 'var(--danger)';
      input.focus();
      return;
    }
    var newChatId = chatInput.value.trim();
    if (newChatId) { _chatId = newChatId; localStorage.setItem('pa_chat_id', newChatId); }
    _userCode = code;
    localStorage.setItem('pa_user_code', code);
    backdrop.remove();
    fetchServerLevels(code);
    fetchServerAlerts(code);
    loadBriefing();
  }

  saveBtn.addEventListener('click', save);
  skipBtn.addEventListener('click', function () { backdrop.remove(); });
  document.getElementById('code-modal-close').addEventListener('click', function () { backdrop.remove(); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
  input.focus();
}

function attachLevel(sym, lvl) {
  var s = _fullSeries[sym];
  if (s) {
    if (lvl.line) { try { s.removePriceLine(lvl.line); } catch (e) {} }
    lvl.line = s.createPriceLine({ price: lvl.price, color: getCSSVar('--level'), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' });
  }
  if (_fvSeries && _fvSym === sym) {
    if (lvl.fvLine) { try { _fvSeries.removePriceLine(lvl.fvLine); } catch (e) {} }
    lvl.fvLine = _fvSeries.createPriceLine({ price: lvl.price, color: getCSSVar('--level'), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' });
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

function updateLevelsBtn(sym) {
  var btn = document.querySelector('.btn-clear-levels[data-sym="' + sym + '"]');
  if (!btn) return;
  var count = (_levels[sym] || []).length;
  btn.style.display = count ? 'inline-flex' : 'none';
  btn.textContent = count;
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

var _chatId = localStorage.getItem('pa_chat_id') || '';
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

function alertLineOpts(triggered) {
  return { color: triggered ? 'rgba(239,68,68,0.35)' : '#ef4444', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' };
}

// Create or update the price lines for a single alert (idempotent).
// Uses applyOptions() when the line already exists — no flickering, no coordinate jumps.
function _syncAlertLine(sym, a) {
  if (!_aLines[a.id]) _aLines[a.id] = { card: null, fv: null };
  var refs = _aLines[a.id];
  var opts = Object.assign({ price: a.price }, alertLineOpts(a.triggered));

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

function _updateAlertsBtn(sym) {
  var count = (_alerts[sym] || []).length;
  document.querySelectorAll('.btn-clear-alerts[data-sym="' + sym + '"]').forEach(function (btn) {
    btn.style.display = count ? 'inline-flex' : 'none';
    btn.textContent = count;
  });
}

function saveAlerts() {
  try { localStorage.setItem('pa_alerts', JSON.stringify(alertsData())); } catch (e) {}
  // Push via WS immediately (no debounce) so server is up-to-date before
  // any pending fetchServerAlerts response can arrive and overwrite local state.
  if (_userCode) sendWS({ type: 'save_alerts', code: _userCode, chatId: _chatId, data: alertsData() });
  // Debounced HTTP as backup when WS is unavailable.
  clearTimeout(_alertSyncTimer);
  _alertSyncTimer = setTimeout(syncAlertsToServer, 1000);
}

function syncAlertsToServer() {
  if (!_userCode) return;
  var data = alertsData();
  sendWS({ type: 'save_alerts', code: _userCode, chatId: _chatId, data: data });
  fetch(API_BASE + '/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save', code: _userCode, chatId: _chatId, data: data }),
  }).catch(function () {});
}

function applyServerAlerts(entry) {
  // Guard: server returned nothing — preserve local state, only update chatId.
  if (!entry || !entry.data || Object.keys(entry.data).length === 0) {
    if (entry && entry.chatId) { _chatId = entry.chatId; localStorage.setItem('pa_chat_id', _chatId); }
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
  if (entry.chatId) { _chatId = entry.chatId; localStorage.setItem('pa_chat_id', _chatId); }
  try { localStorage.setItem('pa_alerts', JSON.stringify(alertsData())); } catch (e) {}
  _syncAllAlerts();
}

function fetchServerAlerts(code) {
  fetch(API_BASE + '/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', code: code }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d) return;
    var serverHasData = d.data && Object.keys(d.data).length > 0;
    if (serverHasData) {
      // Server is the source of truth — always apply.
      // Race condition (local has alerts not yet synced) is handled by the
      // immediate WS push in saveAlerts(), so server already has them.
      applyServerAlerts(d);
    } else {
      // Server empty: push local data up (e.g. first session on this device).
      var localHasData = Object.keys(alertsData()).length > 0;
      if (localHasData) syncAlertsToServer();
    }
  }).catch(function () {});
}

export function loadAlerts() {
  try {
    var local = JSON.parse(localStorage.getItem('pa_alerts') || '{}');
    Object.keys(local).forEach(function (sym) {
      _alerts[sym.toLowerCase()] = local[sym].map(function (a) {
        return { id: a.id || _aNewId(), price: a.price, triggered: a.triggered || false, createdAt: a.createdAt };
      });
    });
  } catch (e) {}
  if (_userCode) fetchServerAlerts(_userCode);
}

function addAlert(sym, price) {
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
  if (_fvChart) {
    var fc = getChartColors();
    _fvChart.applyOptions({ layout: { background: { color: fc.bg }, textColor: fc.text }, grid: { vertLines: { color: fc.grid }, horzLines: { color: fc.grid } }, rightPriceScale: { borderColor: fc.border }, timeScale: { borderColor: fc.border } });
    if (_fvSeries) _fvSeries.applyOptions(getSeriesColors());
  }
}

function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getChartColors() {
  return {
    bg: getCSSVar('--canvas'),
    text: getCSSVar('--graphite'),
    grid: isDark() ? 'rgba(255,255,255,0.04)' : 'rgba(232,232,232,0.5)',
    border: getCSSVar('--hairline'),
  };
}

function getSeriesColors() {
  var up = getCSSVar('--candle-up'), dn = getCSSVar('--steel');
  var grey = getCSSVar('--graphite');
  return { upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn, priceLineColor: grey };
}

function calcPriceFormat(price) {
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

// Форматирует Unix timestamp (секунды) в локальное время устройства
function _localTimeFmt(ts) {
  var d = new Date(ts * 1000);
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

// Форматирует метки на оси времени с учётом уровня детализации
function _tickMarkFmt(ts, type) {
  var d = new Date(ts * 1000);
  var h = d.getHours().toString().padStart(2, '0');
  var m = d.getMinutes().toString().padStart(2, '0');
  var day = d.getDate().toString().padStart(2, '0');
  var mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  // type: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
  if (type <= 1) return mon + ' ' + d.getFullYear();
  if (type === 2) return day + ' ' + mon;
  return h + ':' + m;
}

function getChartOpts(width, height) {
  var c = getChartColors();
  return {
    width: width, height: height || 300,
    layout: { background: { color: c.bg }, textColor: c.text },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    crosshair: { mode: 0 },
    rightPriceScale: { visible: true, borderColor: c.border, scaleMargins: { top: 0.05, bottom: 0.25 } },
    timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false, tickMarkFormatter: _tickMarkFmt },
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
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - visibleCandles), to: total - 1 });
  redrawAlerts(symbol);
}

export function setChartTF(symbol, tf) {
  state.chartTF[symbol] = tf;
  clearRuler(symbol);
  var card = document.querySelector('.coin-card[data-sym="' + symbol + '"]');
  if (card) {
    var pill = card.querySelector('.tf-pill');
    if (pill) pill.textContent = tf;
    card.querySelectorAll('.tf-dd button').forEach(function (btn) {
      btn.className = btn.dataset.tf === tf ? 'active' : '';
    });
  }
  fetchChart(symbol, tf);
}

export function destroyCharts() {
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

function drawRuler(sym, p1, p2, pr1, pr2) {
  var ruler = _rulers[sym]; if (!ruler || !ruler.canvas) return;
  var rc = ruler.canvas, ctx = rc.getContext('2d');
  ctx.clearRect(0, 0, rc.width, rc.height);
  drawAlertIcons(sym, ctx, rc);
  if (!p1 || !p2 || pr1 == null || pr2 == null) return;
  var isUp = pr2 >= pr1, color = isUp ? getCSSVar('--bullish') : getCSSVar('--danger');
  var pct = ((pr2 - pr1) / Math.abs(pr1) * 100);
  var pctStr = (isUp ? '+' : '') + pct.toFixed(2) + '%';
  var chart = _charts[sym];
  if (chart) {
    var t1 = chart.timeScale().coordinateToTime(p1.x), t2 = chart.timeScale().coordinateToTime(p2.x);
    if (t1 != null && t2 != null) {
      var d = Math.abs(t2 - t1);
      var dur = d < 60 ? Math.round(d) + 'с' : d < 3600 ? Math.round(d / 60) + 'м' : d < 86400 ? Math.floor(d / 3600) + 'ч ' + Math.round((d % 3600) / 60) + 'м' : Math.floor(d / 86400) + 'д ' + Math.floor((d % 86400) / 3600) + 'ч';
      pctStr += '  ·  ' + dur;
    }
  }
  // Fill zone between the two price levels
  ctx.fillStyle = isUp ? 'rgba(22,163,74,0.07)' : 'rgba(220,38,38,0.07)';
  ctx.fillRect(0, Math.min(p1.y, p2.y), rc.width, Math.abs(p2.y - p1.y) || 1);
  // Horizontal dashed lines at each price level
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, p1.y); ctx.lineTo(rc.width, p1.y);
  ctx.moveTo(0, p2.y); ctx.lineTo(rc.width, p2.y);
  ctx.stroke(); ctx.setLineDash([]);
  // Diagonal line from start to end point
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
  // Dots at endpoints
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(p1.x, p1.y, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(p2.x, p2.y, 3.5, 0, Math.PI * 2); ctx.fill();
  // Label
  ctx.font = 'bold 16px Manrope,Arial,sans-serif'; ctx.fillStyle = color;
  var lx = p2.x + 12, ly = p2.y - 10;
  if (lx + 170 > rc.width) lx = p2.x - 175; if (lx < 2) lx = 2;
  if (ly < 14) ly = p2.y + 20; if (ly > rc.height - 4) ly = rc.height - 4;
  ctx.fillText(pctStr, lx, ly);
}

function drawAlertIcons(sym, ctx, rc) {
  var s = _fullSeries[sym]; if (!s) return;
  if (!_bellImg || !_bellImg.complete) return;
  var alerts = _alerts[sym] || [];
  var sz = 18;
  alerts.forEach(function (a) {
    // During drag use exact mouse Y so icon tracks cursor without lag
    var y = (_alertDragging && _alertDragging.sym === sym && _alertDragging.alert === a && _alertDragging.dragY != null)
      ? _alertDragging.dragY
      : s.priceToCoordinate(a.price);
    if (y == null || y < 0 || y > rc.height) return;
    ctx.save();
    ctx.globalAlpha = a.triggered ? 0.35 : 1;
    ctx.drawImage(_bellImg, rc.width / 2 - sz / 2, y - sz / 2, sz, sz);
    ctx.restore();
  });
}

function redrawAlerts(sym) {
  var ruler = _rulers[sym]; if (!ruler || !ruler.canvas) return;
  if (ruler.start) return; // ruler draw cycle is active, it handles the canvas
  var rc = ruler.canvas, ctx = rc.getContext('2d');
  ctx.clearRect(0, 0, rc.width, rc.height);
  drawAlertIcons(sym, ctx, rc);
}

function clearRuler(sym) {
  var ruler = _rulers[sym]; if (!ruler) return;
  ruler.start = null;
  redrawAlerts(sym);
}

function initCharts() {
  if (!window.LightweightCharts) return;
  filteredCoins().forEach(function (c) {
    var el = document.getElementById('chart-' + c.symbol);
    if (!el) return;
    if (_charts[c.symbol]) return;
    var chart = window.LightweightCharts.createChart(el, getChartOpts(el.offsetWidth || 400, el.offsetHeight || 300));
    var s = chart.addCandlestickSeries(getSeriesColors());
    var vs = chart.addHistogramSeries({ color: getCSSVar('--steel'), priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    _charts[c.symbol] = chart; _fullSeries[c.symbol] = s; _volSeries[c.symbol] = vs;
    var rc = document.createElement('canvas');
    rc.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:5;';
    el.style.position = 'relative'; el.appendChild(rc);
    rc.width = el.offsetWidth || 400; rc.height = el.offsetHeight || 300;
    _rulers[c.symbol] = { start: null, canvas: rc };
    // Restore saved levels and alerts
    (_levels[c.symbol] || []).forEach(function (l) { attachLevel(c.symbol, l); });
    _syncAlerts(c.symbol);
    // Keep alert bell icons in sync with chart on every frame
    (function alertIconLoop(sym) {
      if (!_charts[sym]) return; // chart was destroyed, stop loop
      var ruler = _rulers[sym];
      if (ruler && ruler.canvas && !ruler.start) {
        var rc = ruler.canvas, ctx = rc.getContext('2d');
        ctx.clearRect(0, 0, rc.width, rc.height);
        drawAlertIcons(sym, ctx, rc);
      }
      requestAnimationFrame(function () { alertIconLoop(sym); });
    }(c.symbol));

    (function (sym, container, cs, ch) {
      // Right-click: add/remove level; Shift+right-click: add/remove alert
      container.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var rect = container.getBoundingClientRect();
        var y = e.clientY - rect.top;
        var price = cs.coordinateToPrice(y);
        if (price == null) return;
        if (e.shiftKey) {
          // If we were dragging, suppress the context menu action
          if (_alertDragMoved) { _alertDragMoved = false; return; }
          var alerts = _alerts[sym] || [];
          for (var i = 0; i < alerts.length; i++) {
            var ay = cs.priceToCoordinate(alerts[i].price);
            if (ay != null && Math.abs(ay - y) < 14) { removeAlert(sym, i); return; }
          }
          addAlert(sym, price);
        } else {
          var levels = _levels[sym] || [];
          for (var i = 0; i < levels.length; i++) {
            var ly = cs.priceToCoordinate(levels[i].price);
            if (ly != null && Math.abs(ly - y) < 14) { removeLevel(sym, i); return; }
          }
          addLevel(sym, price);
        }
      });
      // Left mousedown: start drag if near a level, else ruler (middle)
      container.addEventListener('mousedown', function (e) {
        // Ignore clicks on price axis (right side) — let chart handle vertical zoom natively
        var rect = container.getBoundingClientRect();
        var priceAxisW = 0;
        try { priceAxisW = ch.priceScale('right').width(); } catch (_) {}
        if (e.clientX - rect.left > rect.width - priceAxisW - 2) return;

        if (e.button === 0) {
          var y = e.clientY - rect.top;
          var levels = _levels[sym] || [];
          for (var i = 0; i < levels.length; i++) {
            var ly = cs.priceToCoordinate(levels[i].price);
            if (ly != null && Math.abs(ly - y) < 8) {
              e.stopPropagation();
              e.preventDefault();
              _dragging = { sym: sym, idx: i, lvl: levels[i] };
              container.style.cursor = 'ns-resize';
              return;
            }
          }
          return;
        }
        // Alert drag: shift + right-click (button 2)
        if (e.button === 2 && e.shiftKey) {
          var alertY = e.clientY - rect.top;
          var alertArr = _alerts[sym] || [];
          for (var ai = 0; ai < alertArr.length; ai++) {
            var aCoord = cs.priceToCoordinate(alertArr[ai].price);
            if (aCoord != null && Math.abs(aCoord - alertY) < 10) {
              e.stopPropagation();
              e.preventDefault();
              _alertDragging = { sym: sym, idx: ai, alert: alertArr[ai] };
              _alertDragMoved = false;
              container.style.cursor = 'ns-resize';
              return;
            }
          }
        }
        if (e.button !== 1) return;
        e.preventDefault();
        var pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        var pr = cs.coordinateToPrice(pt.y);
        if (pr != null) _rulers[sym].start = { pt: pt, price: pr };
      }, { capture: true });
      container.addEventListener('mousemove', function (e) {
        var rect = container.getBoundingClientRect();
        var y = e.clientY - rect.top;
        // Drag level
        if (_dragging && _dragging.sym === sym && (e.buttons & 1)) {
          var price = cs.coordinateToPrice(y);
          if (price != null && _dragging.lvl.line) {
            _dragging.lvl.price = price;
            _dragging.lvl.line.applyOptions({ price: price });
          }
          return;
        }
        // Drag alert (shift + right button)
        if (_alertDragging && _alertDragging.sym === sym && (e.buttons & 2)) {
          var alertPrice = cs.coordinateToPrice(y);
          if (alertPrice != null) {
            _alertDragging.alert.price = alertPrice;
            // Update both card and FV lines via _aLines so neither jumps
            var _dragRefs = _aLines[_alertDragging.alert.id];
            if (_dragRefs) {
              if (_dragRefs.card) { try { _dragRefs.card.applyOptions({ price: alertPrice }); } catch (e) {} }
              if (_dragRefs.fv)   { try { _dragRefs.fv.applyOptions({ price: alertPrice }); } catch (e) {} }
            }
            _alertDragging.dragY = y;
            _alertDragMoved = true;
            redrawAlerts(sym);
          }
          return;
        }
        // Cursor hint near level or alert (when shift held)
        var levels = _levels[sym] || [];
        var near = false;
        for (var j = 0; j < levels.length; j++) {
          var ly2 = cs.priceToCoordinate(levels[j].price);
          if (ly2 != null && Math.abs(ly2 - y) < 8) { near = true; break; }
        }
        if (!near && e.shiftKey) {
          var alertsHint = _alerts[sym] || [];
          for (var ak = 0; ak < alertsHint.length; ak++) {
            var ayk = cs.priceToCoordinate(alertsHint[ak].price);
            if (ayk != null && Math.abs(ayk - y) < 10) { near = true; break; }
          }
        }
        container.style.cursor = near ? 'ns-resize' : '';
        // Ruler
        var ruler = _rulers[sym];
        if (!ruler.start || !(e.buttons & 4)) return;
        var pt = { x: e.clientX - rect.left, y: y };
        drawRuler(sym, ruler.start.pt, pt, ruler.start.price, cs.coordinateToPrice(y));
      });
      container.addEventListener('mouseup', function (e) {
        if (e.button === 0 && _dragging && _dragging.sym === sym) {
          _dragging = null;
          container.style.cursor = '';
          saveLevels();
          return;
        }
        if (e.button === 2 && _alertDragging && _alertDragging.sym === sym) {
          var adSym = _alertDragging.sym;
          _alertDragging = null;
          container.style.cursor = '';
          saveAlerts();
          redrawAlerts(adSym);
          return;
        }
        if (e.button === 1) clearRuler(sym);
      });
      container.addEventListener('mouseleave', function () {
        if (_dragging && _dragging.sym === sym) { _dragging = null; saveLevels(); }
        if (_alertDragging && _alertDragging.sym === sym) { var adLeaveSym = _alertDragging.sym; _alertDragging = null; saveAlerts(); redrawAlerts(adLeaveSym); }
        container.style.cursor = '';
        clearRuler(sym);
      });
      new ResizeObserver(function () {
        if (_charts[sym]) _charts[sym].resize(container.offsetWidth, container.offsetHeight || 300);
        if (_rulers[sym] && _rulers[sym].canvas) { _rulers[sym].canvas.width = container.offsetWidth; _rulers[sym].canvas.height = container.offsetHeight; }
      }).observe(container);
    })(c.symbol, el, s, chart);
    fetchChart(c.symbol, state.chartTF[c.symbol] || '5m');
  });
}

// ── Analysis Popup ─────────────────────────────────────────────────────────

function getPopupHost() {
  var el = document.getElementById('popup-host');
  if (!el) {
    el = document.createElement('div');
    el.id = 'popup-host';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:9999;overflow:hidden;';
    document.body.appendChild(el);
  }
  return el;
}

function getOverlay() {
  var el = document.getElementById('analysis-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'analysis-overlay';
    el.className = 'analysis-overlay';
    el.innerHTML =
      '<div class="popup-header"><span class="popup-title">Анализ</span>' +
        '<button class="popup-close" data-action="close-analysis">' + icon('x', 15) + '</button>' +
      '</div>' +
      '<div class="popup-body">' +
        '<div class="ao-spinner"><span class="spinner"></span></div>' +
        '<div class="ao-content"></div>' +
      '</div>';
    getPopupHost().appendChild(el);
  }
  return el;
}

export function openAnalysisPopup(sym, btn) {
  var existingPopup = document.getElementById('analysis-overlay');
  if (existingPopup && existingPopup._popupCard) {
    existingPopup._popupCard.style.overflow = '';
    existingPopup._popupCard = null;
  }
  if (existingPopup) existingPopup.style.display = 'none';
  var existingMs = document.getElementById('ms-popup');
  if (existingMs && existingMs.style.display !== 'none') closeMSPopup();

  var card = btn.closest('.coin-card');

  var popup = document.getElementById('analysis-overlay');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'analysis-overlay';
    popup.className = 'analysis-overlay';
    popup.innerHTML =
      '<div class="popup-header"><span class="popup-title">Анализ</span>' +
        '<button class="popup-close" data-action="close-analysis">' + icon('x', 15) + '</button>' +
      '</div>' +
      '<div class="popup-body">' +
        '<div class="ao-spinner"><span class="spinner"></span></div>' +
        '<div class="ao-content"></div>' +
      '</div>';
  }
  if (popup.parentNode) popup.parentNode.removeChild(popup);

  popup._popupCard = card;

  if (card) {
    // Normal card mode
    card.style.overflow = 'visible';
    card.style.position = 'relative';
    card.appendChild(popup);
    var cardRect = card.getBoundingClientRect();
    var btnRect = btn.getBoundingClientRect();
    var topOffset = (btnRect.bottom - cardRect.top) + 6;
    popup.style.position = 'absolute';
    popup.style.top = topOffset + 'px';
    popup.style.right = '0';
    popup.style.left = 'auto';
    popup.style.width = '67%';
    popup.style.maxWidth = 'none';
    popup.style.zIndex = '1000';
  } else {
    // Full View mode — fixed above fv-overlay (z-index:400)
    document.body.appendChild(popup);
    var btnRect2 = btn.getBoundingClientRect();
    var viewportW = document.documentElement.clientWidth;
    var popupW = Math.min(380, viewportW - 16);
    var leftIfRightAligned = btnRect2.right - popupW;
    popup.style.position = 'fixed';
    popup.style.top = (btnRect2.bottom + 6) + 'px';
    popup.style.width = popupW + 'px';
    popup.style.maxWidth = 'none';
    if (leftIfRightAligned < 8) {
      popup.style.left = '8px';
      popup.style.right = 'auto';
    } else {
      popup.style.right = Math.max(8, viewportW - btnRect2.right) + 'px';
      popup.style.left = 'auto';
    }
    popup.style.zIndex = '99999';
  }

  popup.style.transform = 'none';
  popup.style.margin = '0';

  var cache = state.analysisCache[sym];
  var spinner = popup.querySelector('.ao-spinner');
  var content = popup.querySelector('.ao-content');
  spinner.style.display = 'flex';
  content.style.display = 'none';
  popup.style.display = 'block';
  popup.dataset.sym = sym;
  if (cache && cache.status === 'loading') return;
  if (cache && (cache.status === 'ok' || cache.status === 'error')) { updateAnalysisPopup(sym); return; }
  analyzeCoinBySymbol(sym);
}

export function updateAnalysisPopup(sym) {
  var popup = document.getElementById('analysis-overlay');
  if (!popup || popup.style.display !== 'block' || popup.dataset.sym !== sym) return;
  var cache = state.analysisCache[sym];
  var content = popup.querySelector('.ao-content');
  var spinner = popup.querySelector('.ao-spinner');
  if (!cache || cache.status === 'loading') return;
  spinner.style.display = 'none';
  content.style.display = 'block';
  if (cache.status === 'ok' && cache.result) {
    var r = cache.result;
    var ts = cache.timestamp ? new Date(cache.timestamp).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    var extIcon = icon('external-link', 11, 'vertical-align:middle;margin-left:3px;margin-bottom:1px');
    var newsBlock = '';
    if (r.news_summary) {
      var hasRealNews = r.news_url && !r.news_summary.toLowerCase().includes('не найдено');
      if (hasRealNews) {
        newsBlock = '<div class="ao-row"><a href="' + escHtml(r.news_url) + '" target="_blank" rel="noopener" style="color:var(--primary);font-weight:700;text-decoration:none;">Новости' + extIcon + '</a><br>' + escHtml(r.news_summary) + '</div>';
      } else {
        newsBlock = '<div class="ao-row">' + escHtml(r.news_summary) + '</div>';
      }
    }
    content.innerHTML = '<div style="font-size:16px;font-weight:700;color:var(--ink);letter-spacing:0.4px;margin-bottom:10px;">' + escHtml(sym.toUpperCase()) + '</div>' +
      '<div class="ao-row"><strong>Катализатор:</strong> ' + escHtml(r.catalyst) + '</div>' +
      newsBlock +
      (ts ? '<div style="margin-top:12px;font-size:11px;color:var(--graphite);font-weight:600;">Анализ: ' + ts + '</div>' : '') +
      '<button class="ao-reanalyze" data-action="reanalyze" data-sym="' + sym + '">Повторный анализ</button>';
  } else {
    content.innerHTML = '<div class="ao-err">' + (cache.error || 'Ошибка') + '</div>' +
      '<button class="ao-reanalyze" data-action="reanalyze" data-sym="' + sym + '">Повторный анализ</button>';
  }
}

// ── Market Strength ─────────────────────────────────────────────────────────

function getMSKPhase() {
  var utcMs = Date.now() + new Date().getTimezoneOffset() * 60000;
  var msk = new Date(utcMs + 3 * 3600 * 1000);
  var h = msk.getHours() + msk.getMinutes() / 60;
  var timeStr = msk.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (h >= 0 && h < 2) return { label: 'Ночь', time: timeStr };
  if (h >= 2 && h < 9) return { label: 'Азия', time: timeStr };
  if (h >= 9 && h < 11) return { label: 'Открытие Европы', time: timeStr };
  if (h >= 11 && h < 15.5) return { label: 'Обед Европы', time: timeStr };
  if (h >= 15.5 && h < 19.5) return { label: 'Оверлап США+Европа', time: timeStr };
  return { label: 'Вечер Америки', time: timeStr };
}

function msBar(val) {
  var cls = val >= 65 ? 'strong' : val >= 40 ? 'medium' : 'weak';
  return '<div class="ms-bar-row"><div class="ms-bar"><div class="ms-bar-fill ' + cls + '" style="width:' + val + '%"></div></div><span class="ms-bar-pct">' + val + '</span></div>';
}

function msCardInner() {
  var ms = state.marketStrength;
  if (!ms) {
    return '<div class="label">Сила рынка</div>' +
      '<div style="font-size:18px;font-weight:700;color:var(--primary);margin-top:8px;">Оценить →</div>';
  }
  if (ms.status === 'loading') {
    return '<div class="label">Сила рынка</div>' +
      '<div style="font-size:18px;font-weight:700;color:var(--primary);margin-top:8px;">Анализирую...</div>';
  }
  if (ms.status === 'error') {
    return '<div class="label">Сила рынка</div>' +
      '<div style="font-size:16px;font-weight:700;color:var(--bloom-deep);margin-top:8px;">Ошибка</div>' +
      '<div class="ms-card-sub">Нажмите для повтора</div>';
  }
  var vLabel = ms.verdict === 'strong' ? '💪 Сильный' : ms.verdict === 'medium' ? '😐 Средний' : '😵 Слабый';
  var vColor = ms.verdict === 'strong' ? 'var(--bullish)' : ms.verdict === 'medium' ? 'var(--caution)' : 'var(--bloom-deep)';
  return '<div class="label">Сила рынка</div>' +
    '<div style="font-size:20px;font-weight:700;color:' + vColor + ';margin-top:6px;">' + vLabel + '</div>';
}

function msPopupInner() {
  var ms = state.marketStrength;
  var phase = getMSKPhase();
  var closeBtn = '<button class="popup-close" data-action="close-ms">' + icon('x', 15) + '</button>';
  if (!ms || ms.status === 'loading') {
    return '<div class="popup-header"><span class="popup-title">Сила рынка</span>' + closeBtn + '</div>' +
      '<div class="popup-body"><div class="ms-loading"><span class="spinner"></span>Анализирую рынок...</div></div>';
  }
  if (ms.status === 'error') {
    return '<div class="popup-header"><span class="popup-title">Сила рынка</span>' + closeBtn + '</div>' +
      '<div class="popup-body"><div style="color:var(--bloom-deep);font-size:13px;font-weight:600;margin-bottom:12px;">Ошибка загрузки данных</div></div>' +
      '<div class="popup-footer"><button class="popup-btn" data-action="refresh-ms">Повторить</button></div>';
  }
  var m = ms.metrics;
  var vLabel = ms.verdict === 'strong' ? '💪 Сильный' : ms.verdict === 'medium' ? '😐 Средний' : '😵 Слабый';
  var vClass = 'ms-verdict-' + ms.verdict;
  var oiHtml = '<span class="ms-oi-badge ' + (m.oiDir === 'up' ? 'up' : m.oiDir === 'down' ? 'down' : 'neutral') + '">' + (m.oiDir === 'up' ? '▲ Подтверждён' : m.oiDir === 'down' ? '▼ Ликвидации' : '— Нейтрально') + '</span>';
  var ts = new Date(ms.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  var inPlayHtml = ms.inPlay.length ?
    '<div class="ms-inplay"><div class="ms-inplay-label">⚡ In-play (объём ×3+)</div><div class="ms-inplay-coins">' +
    ms.inPlay.map(function (s) { return '<span class="ms-inplay-pill">' + s + '</span>'; }).join('') +
    '</div></div>' : '';

  function tip(text) {
    return '<span class="ms-tip-wrap" tabindex="0">' +
      '<span class="ms-tip-icon">i</span>' +
      '<span class="ms-tip-text">' + text + '</span>' +
      '</span>';
  }

  var tips = {
    vol: 'Сравниваем объём последних 5 свечей (1м) с предыдущими 25. Высокий — рынок разогрет, деньги заходят. Низкий — всё вяло, даже хорошая точка входа может не отработать.',
    move: 'Насколько тело свечи заполняет её диапазон на 1ч. Высокая — движение устойчивое, свечи закрываются уверенно. Низкая — много хвостов и неопределённости, рынок болтает без чёткого вектора.',
    vol2: 'ATR — средний размах свечи за последние 5 часов против базового. Высокая — диапазоны расширяются, есть куда двигаться. Низкая — рынок зажат, пробои часто оказываются ложными.',
    oi: '▲ Подтверждён — цена растёт и открытых позиций больше: реальные покупатели заходят, движение надёжное. ▼ Ликвидации — цена растёт, но OI падает: выносят шортистов. Рост резкий, но может не удержаться. — Нейтрально — картина неоднозначная, сигнала нет.',
  };

  return '<div class="popup-header"><span class="popup-title">Сила рынка</span>' + closeBtn + '</div>' +
    '<div class="popup-body"><div class="ms-phase" style="margin-bottom:10px;">' + phase.label + ' · ' + phase.time + ' МСК</div><div class="ms-metrics-grid">' +
    '<div class="ms-metric"><div class="ms-metric-label">Объём' + tip(tips.vol) + '</div>' + msBar(m.volumePulse) + '</div>' +
    '<div class="ms-metric"><div class="ms-metric-label">Направленность' + tip(tips.move) + '</div>' + msBar(m.movement) + '</div>' +
    '<div class="ms-metric"><div class="ms-metric-label">Волатильность' + tip(tips.vol2) + '</div>' + msBar(m.volatility) + '</div>' +
    '<div class="ms-metric"><div class="ms-metric-label">Open Interest' + tip(tips.oi) + '</div>' + oiHtml + '</div>' +
    '</div>' +
    inPlayHtml +
    '<div class="ms-footer">Оценка: ' + ms.score + ' · топ-20 по объёму · ' + ts + '</div></div>' +
    '<div class="popup-footer"><button class="popup-btn" data-action="refresh-ms">Обновить</button></div>';
}

export function openMSPopup() {
  var existingAp = document.getElementById('analysis-overlay');
  if (existingAp && existingAp._popupCard) { existingAp._popupCard.style.overflow = ''; existingAp._popupCard = null; }
  if (existingAp) existingAp.style.display = 'none';

  if (!state.marketStrength) fetchMarketStrength();

  var popup = document.getElementById('ms-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'ms-popup';
    popup.className = 'ms-popup';
  }
  if (popup.parentNode) popup.parentNode.removeChild(popup);
  document.body.appendChild(popup);

  popup.innerHTML = msPopupInner();
  popup.style.display = 'block';
  popup.style.position = 'absolute';

  var btn = document.querySelector('.mob-ms-chip');
  if (btn) {
    var btnRect = btn.getBoundingClientRect();
    popup.style.top = (btnRect.bottom + window.scrollY + 6) + 'px';
    if (window.innerWidth <= 768) {
      popup.style.left = '8px';
      popup.style.right = '8px';
      popup.style.width = 'auto';
      popup.style.maxWidth = 'none';
    } else {
      popup.style.right = (document.documentElement.clientWidth - btnRect.right) + 'px';
      popup.style.left = 'auto';
      popup.style.width = '400px';
      popup.style.maxWidth = 'none';
    }
  }
}

export function closeMSPopup() {
  var el = document.getElementById('ms-popup');
  if (el) el.style.display = 'none';
}

// ── TV Mode ────────────────────────────────────────────────────────────────

var _tvCharts = {};
window.__tvChartSeries = {};
window.__tvChartVolSeries = {};

export function openTVMode() {
  var coins = filteredCoins().slice(0, 6);
  if (!coins.length) return;

  var overlay = document.getElementById('tv-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tv-overlay';
    overlay.className = 'tv-overlay';
    document.body.appendChild(overlay);
  }

  overlay.innerHTML =
    '<button class="tv-exit-btn" data-action="close-tv">Выйти из TV</button>' +
    '<div class="tv-grid">' +
    coins.map(function (c) {
      var ch = c.price_change_percentage_24h || 0;
      return '<div class="tv-slot">' +
        '<div class="tv-slot-head" data-tv-sym="' + c.symbol + '">' +
          '<span class="tv-sym">' + c.symbol.toUpperCase() + '</span>' +
          '<span class="tv-chg ' + (ch >= 0 ? 'up' : 'dn') + '">' + (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%</span>' +
          '<span class="tv-price">' + (c.current_price || '') + '</span>' +
        '</div>' +
        '<div class="tv-chart" id="tvchart-' + c.symbol + '"></div>' +
      '</div>';
    }).join('') +
    '</div>';

  overlay.style.display = 'block';
  if (overlay.requestFullscreen) overlay.requestFullscreen().catch(function () {});
  else if (overlay.webkitRequestFullscreen) overlay.webkitRequestFullscreen();

  // destroy previous TV charts
  Object.keys(_tvCharts).forEach(function (sym) { try { _tvCharts[sym].remove(); } catch (e) {} });
  _tvCharts = {};
  window.__tvChartSeries = {};
  window.__tvChartVolSeries = {};

  // create charts after layout settles
  setTimeout(function () {
    coins.forEach(function (c) {
      var el = document.getElementById('tvchart-' + c.symbol);
      if (!el || !window.LightweightCharts) return;
      var chart = window.LightweightCharts.createChart(el, getChartOpts(el.offsetWidth || 600, el.offsetHeight || 380));
      var s = chart.addCandlestickSeries(getSeriesColors());
      var volClr = getCSSVar('--vol-up');
      var vs = chart.addHistogramSeries({ color: volClr, priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      _tvCharts[c.symbol] = chart;
      window.__tvChartSeries[c.symbol] = s;
      window.__tvChartVolSeries[c.symbol] = vs;

      var tf = state.chartTF[c.symbol] || '5m';
      var cd = state.chartData[c.symbol + '_' + tf];
      if (cd && cd.status === 'ok' && cd.candles.length) {
        var lastClose = cd.candles[cd.candles.length - 1].close;
        s.applyOptions({ priceFormat: calcPriceFormat(lastClose) });
        s.setData(cd.candles);
        var tvVolDn = getCSSVar('--vol-dn'); vs.setData(cd.candles.map(function (k) { return { time: k.time, value: k.volume || 0, color: k.close >= k.open ? volClr : tvVolDn }; }));
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, cd.candles.length - 80), to: cd.candles.length - 1 });
      }

      new ResizeObserver(function () {
        if (_tvCharts[c.symbol]) _tvCharts[c.symbol].resize(el.offsetWidth, el.offsetHeight);
      }).observe(el);
    });
  }, 80);
}

export function closeTVMode() {
  var overlay = document.getElementById('tv-overlay');
  if (overlay) overlay.style.display = 'none';
  if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
  Object.keys(_tvCharts).forEach(function (sym) { try { _tvCharts[sym].remove(); } catch (e) {} });
  _tvCharts = {};
  window.__tvChartSeries = {};
  window.__tvChartVolSeries = {};
}

// close TV mode when user presses ESC / exits fullscreen
document.addEventListener('fullscreenchange', function () {
  if (!document.fullscreenElement) {
    var overlay = document.getElementById('tv-overlay');
    if (overlay && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
      Object.keys(_tvCharts).forEach(function (sym) { try { _tvCharts[sym].remove(); } catch (e) {} });
      _tvCharts = {};
      window.__tvChartSeries = {};
      window.__tvChartVolSeries = {};
    }
  }
});

// ── Metric cards live update ────────────────────────────────────────────────

function updateMetricCards() {
  var coins = filteredCoins();
  var sortCount = document.querySelector('.sort-coin-count');
  if (sortCount) sortCount.textContent = coins.length + ' монет';
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

export function updateMSPanel() {
  var popup = document.getElementById('ms-popup');
  if (popup && popup.style.display !== 'none') popup.innerHTML = msPopupInner();
  var ms = state.marketStrength;
  var msLabel = !ms ? 'Рынок' : ms.status === 'loading' ? 'Рынок...' : ms.status === 'error' ? 'Рынок: ?' : (ms.verdict === 'strong' ? '<span>💪</span><span>Сильный</span>' : ms.verdict === 'medium' ? '<span>😐</span><span>Средний</span>' : '<span>😵</span><span>Слабый</span>');
  var chip = document.querySelector('.mob-ms-chip');
  if (chip) chip.innerHTML = msLabel;
}

// ── Topbar HTML (shared between main render and full view) ─────────────────

var _LOGO_SVG = '<svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.25519 4.37208C5.8536 5.29726 5.97716 6.4839 6.59499 7.69065C6.75974 8.01245 6.9245 8.38453 6.95539 8.52532C7.04806 8.84712 7.52173 9.34993 8.3249 10.0036C8.82945 10.4058 9.06629 10.5265 9.45757 10.5768C10.8374 10.7578 10.7447 10.7176 10.58 11.0293C10.374 11.4316 9.79738 11.8238 8.57203 12.407C7.9748 12.6886 7.39816 13.0205 7.29519 13.1411C7.18192 13.2518 6.99657 13.3523 6.87301 13.3523C6.73915 13.3523 6.27578 13.5333 5.82271 13.7546C4.88568 14.2071 3.91775 15.1122 3.50587 15.9167C3.16606 16.5603 2.87775 17.7771 3.0528 17.7771C3.21755 17.7771 3.70151 17.2441 4.19577 16.5402C4.70033 15.7859 5.48291 15.1122 6.47142 14.5591C7.03776 14.2473 7.35697 14.1267 7.6041 14.1367C7.94391 14.1669 8.73678 13.835 9.33401 13.4227L9.63262 13.2115L9.57084 13.4629C9.52965 13.5937 9.44728 13.9456 9.3752 14.2373C9.28252 14.6496 9.12807 14.911 8.72648 15.3535C7.5938 16.6005 6.82152 17.6866 6.82152 18.0486C6.82152 18.1693 6.65677 18.5313 6.46113 18.8531C5.46231 20.5023 5.1328 22.5639 5.62706 24.1628C5.71974 24.4444 5.8536 24.7561 5.92568 24.8567C6.06984 25.0478 6.08014 25.0478 6.18311 24.8567C6.23459 24.7561 6.31697 24.1427 6.35816 23.5092C6.44053 22.0912 6.62588 21.2767 7.15103 19.909C7.41875 19.2051 7.64529 18.7928 7.83064 18.6319C7.98509 18.5011 8.29401 18.0888 8.52054 17.7167L8.93242 17.0329L8.95302 17.4251C9.04569 18.9034 9.50906 20.442 10.1681 21.4476C11.2287 23.0667 12.8968 23.9315 14.9562 23.9215C16.717 23.9215 17.8909 23.4689 19.0339 22.3627C20.1871 21.2465 20.8255 19.7481 21.0109 17.7871L21.083 17.0329L21.5669 17.8475C21.8347 18.3 22.1436 18.6922 22.2465 18.7224C22.3701 18.7626 22.5554 19.1246 22.8232 19.8386C23.4204 21.4577 23.5131 21.8499 23.5955 23.3382C23.6675 24.3941 23.7293 24.7762 23.8426 24.8969C24.0279 25.0779 24.0588 25.0277 24.3986 23.9416C24.862 22.4231 24.4089 20.1303 23.3174 18.5011C23.2351 18.3704 23.1527 18.1391 23.1424 17.9883C23.1115 17.6363 22.5143 16.7715 21.5463 15.6753C20.877 14.9211 20.7638 14.7401 20.5578 14.0362C20.4343 13.6037 20.3519 13.2518 20.3725 13.2518C20.3828 13.2518 20.7123 13.4428 21.0933 13.6741C21.6287 14.006 21.8964 14.1065 22.298 14.1166C22.6996 14.1367 22.9776 14.2473 23.6263 14.6295C24.6561 15.2329 25.3871 15.9167 25.9947 16.8419C26.4374 17.5156 26.839 17.8776 26.9729 17.7369C27.0965 17.6262 26.7772 16.5603 26.4271 15.8765C26.1903 15.4038 25.8711 15.0016 25.4592 14.6295C24.8723 14.0965 23.5543 13.3523 23.2042 13.3523C23.1012 13.3523 22.8644 13.2317 22.6687 13.0909C22.4731 12.9501 21.8552 12.6082 21.2889 12.3366C20.0327 11.7333 19.5796 11.4215 19.4148 11.0394C19.2707 10.7176 19.2707 10.7075 20.4343 10.5869C20.8976 10.5366 21.1139 10.4461 21.4125 10.2047C22.1539 9.60134 22.9879 8.7365 22.9879 8.5756C22.9879 8.49515 23.1527 8.10296 23.3483 7.72082C24.0176 6.42356 24.1309 5.46821 23.7396 4.42236C23.4719 3.72848 23.2659 3.92961 23.1527 4.98551C23.0188 6.30289 22.4937 7.83144 22.123 8.00239C21.9891 8.06273 21.6905 8.38453 21.464 8.7365L21.0418 9.35999L20.3416 9.39016C19.9606 9.41027 19.5281 9.43038 19.384 9.44044C18.9927 9.46055 18.3645 9.18903 18.1792 8.91751C17.8703 8.46498 17.2731 7.90183 16.8921 7.71076C16.5523 7.53981 16.5008 7.46941 16.5008 7.16772C16.5008 6.42356 15.7182 5.00563 15.3063 5.00563C15.1313 5.00563 15.1107 5.62911 15.2754 5.9308C15.3681 6.10176 15.3475 6.17215 15.1827 6.33305C14.9768 6.53418 14.9768 6.53418 14.7812 6.34311C14.5958 6.1621 14.5855 6.11182 14.7091 5.90063C14.9047 5.55872 14.8944 5.00563 14.6988 5.00563C14.2766 5.00563 13.6176 6.14198 13.5352 6.97665C13.494 7.4493 13.4528 7.51969 13.113 7.71076C12.6291 7.99234 12.4128 8.17335 11.9289 8.74656C11.7126 9.01808 11.4861 9.22926 11.4346 9.22926C11.3728 9.22926 11.1772 9.29965 10.9815 9.39016C10.7035 9.52089 10.58 9.53095 10.2813 9.43038C10.0754 9.37005 9.69441 9.32982 9.42668 9.33988L8.94272 9.37005L8.43816 8.64599C8.17044 8.24374 7.88212 7.92194 7.79975 7.92194C7.54232 7.92194 6.82152 5.74979 6.82152 4.94529C6.82152 4.46259 6.67737 4 6.51261 4C6.46113 4 6.33756 4.17096 6.25519 4.37208Z" fill="currentColor"/></svg>';

function _topbarHTML() {
  var tierPills = [['high', 'High'], ['mid', 'Mid'], ['low', 'Low']].map(function (t) {
    return '<button class="filter-pill' + (state.volTier === t[0] ? ' active' : '') + '" data-action="pick-tier" data-val="' + t[0] + '">' + t[1] + '</button>';
  }).join('');
  return '<div class="topbar"><div class="filters">'
    + '<button class="topbar-logo" data-action="refresh" title="Обновить">' + _LOGO_SVG + '</button>'
    + '<div class="filter-group">' + tierPills + '</div>'
    + '<div class="topbar-actions">'
    + '<button class="btn-topbar" data-action="open-search" title="Поиск">' + icon('search', 15) + '</button>'
    + '<button class="btn-topbar" data-action="open-briefing" title="Брифинг">' + icon('bookmark', 15) + '</button>'
    + '<button class="btn-topbar desktop-nav-btn" data-action="tv" title="TV режим">' + icon('monitor', 15) + '</button>'
    + '<button class="btn-topbar desktop-nav-btn" data-action="toggle-theme" title="Сменить тему">' + (isDark() ? icon('sun', 15) : icon('moon', 15)) + '</button>'
    + '<button class="btn-topbar desktop-nav-btn" data-action="open-settings" title="Настройки">' + icon('bell', 15) + '</button>'
    + '<div class="burger-wrap">'
    + '<button class="btn-topbar" data-action="toggle-burger">' + icon('menu', 15) + '</button>'
    + '<div class="burger-dd" id="burger-dd">'
    + '<button class="burger-dd-item" data-action="tv">' + icon('monitor', 14) + 'TV режим</button>'
    + '<button class="burger-dd-item" data-action="toggle-theme">' + (isDark() ? icon('sun', 14) : icon('moon', 14)) + 'Сменить тему</button>'
    + '<button class="burger-dd-item" data-action="open-settings">' + icon('bell', 14) + 'Настройки</button>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '</div></div>';
}

// ── Sort Bar ───────────────────────────────────────────────────────────────

function _sortBarHTML(coins) {
  var ws = wsConnected;
  var wsTitle = ws ? 'WebSocket: подключен' : 'WebSocket: отключен';
  var ms = state.marketStrength;
  var msLabel = !ms ? 'Рынок' : ms.status === 'loading' ? 'Рынок...' : ms.status === 'error' ? 'Рынок: ?' : (ms.verdict === 'strong' ? '<span>💪</span><span>Сильный</span>' : ms.verdict === 'medium' ? '<span>😐</span><span>Средний</span>' : '<span>😵</span><span>Слабый</span>');
  return '<div class="sort-bar">'
    + '<div class="sort-bar-btns">'
    + '<button class="btn-topbar' + (state.sortCol === 'price_change_percentage_24h' ? ' active' : '') + '" data-action="sort" data-col="price_change_percentage_24h" title="По росту">' + icon('percent', 15) + '</button>'
    + '<button class="btn-topbar' + (state.sortCol === 'total_volume' ? ' active' : '') + '" data-action="sort" data-col="total_volume" title="По объёму">' + icon('bar-chart-2', 15) + '</button>'
    + '</div>'
    + '<span class="ws-indicator ' + (ws ? 'connected' : 'disconnected') + '" title="' + wsTitle + '"></span>'
    + '<span class="sort-coin-count">' + coins.length + ' монет</span>'
    + '<button class="mob-ms-chip" data-action="open-ms">' + msLabel + '</button>'
    + '</div>';
}

// ── Main Render ────────────────────────────────────────────────────────────

export function render() {
  var app = document.getElementById('app');
  if (state.loading) {
    destroyCharts();
    app.innerHTML = '<div class="loading-overlay"><div class="big-spinner"></div><p>Загружаю данные с Binance Futures...</p></div>';
    return;
  }
  var coins = filteredCoins();

  destroyCharts();
  var coinsHtml = coins.length
    ? '<div class="cards-area">'
      + '<div class="cards-grid" id="cards-grid">'
      + coins.map(function (c) { return renderCard(c); }).join('')
      + '</div></div>'
    : '<div class="empty-state">Нет монет, соответствующих фильтру.</div>';

  app.innerHTML =
    _topbarHTML()
    + _sortBarHTML(coins)
    + coinsHtml;
  initCharts();
}

// ── Tooltip positioning ────────────────────────────────────────────────────

var _activeTip = null;
var _activeWrap = null;

function showTip(wrap) {
  var tip = wrap.querySelector('.ms-tip-text');
  if (!tip) return;
  if (_activeTip && _activeTip !== tip) { _activeTip.style.display = 'none'; }
  _activeTip = tip;
  _activeWrap = wrap;
  // Render off-screen first to measure height
  tip.style.top = '-9999px'; tip.style.left = '-9999px';
  tip.style.display = 'block';
  var TIP_W = 210, MARGIN = 8;
  var rect = wrap.getBoundingClientRect();
  var tipH = tip.offsetHeight || 100;
  var top = rect.bottom + 4;
  var left = rect.left;
  // Flip above if goes below viewport
  if (top + tipH > window.innerHeight - MARGIN) top = rect.top - tipH - 4;
  if (top < MARGIN) top = MARGIN;
  // Clamp horizontally
  if (left + TIP_W > window.innerWidth - MARGIN) left = window.innerWidth - TIP_W - MARGIN;
  if (left < MARGIN) left = MARGIN;
  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
}

function hideTip(wrap) {
  var tip = wrap.querySelector('.ms-tip-text');
  if (tip) { tip.style.display = 'none'; _activeTip = null; _activeWrap = null; }
}

// Reposition tooltip on page scroll so it follows the icon
window.addEventListener('scroll', function () {
  if (_activeWrap) showTip(_activeWrap);
}, { passive: true });

document.body.addEventListener('mouseover', function (e) {
  var wrap = e.target.closest('.ms-tip-wrap');
  if (wrap) showTip(wrap);
});
document.body.addEventListener('mouseout', function (e) {
  var wrap = e.target.closest('.ms-tip-wrap');
  if (!wrap) return;
  if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
  hideTip(wrap);
});
document.body.addEventListener('focus', function (e) {
  var wrap = e.target.closest('.ms-tip-wrap');
  if (wrap) showTip(wrap);
}, true);
document.body.addEventListener('blur', function (e) {
  var wrap = e.target.closest('.ms-tip-wrap');
  if (wrap) hideTip(wrap);
}, true);

// ── Event listeners ────────────────────────────────────────────────────────

initTheme();
loadLevels();
on('render', render);
on('cards:sync', renderCards);
on('card:update', function (sym) { updateCardBadge(sym); updateAnalysisPopup(sym); });
on('ms:update', updateMSPanel);
on('metrics:update', updateMetricCards);
on('ws:status', function () {
  var els = document.querySelectorAll('.ws-indicator');
  for (var i = 0; i < els.length; i++) {
    els[i].className = 'ws-indicator ' + (wsConnected ? 'connected' : 'disconnected');
    els[i].title = wsConnected ? 'WebSocket подключен' : 'WebSocket отключен';
  }
});

// ── Full View ──────────────────────────────────────────────────────────────

var _fvRuler = null;

// ── Briefing ───────────────────────────────────────────────────────────────

var _briefingUserCode = localStorage.getItem('pa_user_code') || null;
var _briefingSyncTimer = null;

function todayDate() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fmtBriefingDate(iso) {
  var parts = iso.split('-');
  return parts[2] + '.' + parts[1] + '.' + parts[0];
}

function briefingDates() {
  var dates = {};
  (state.briefing || []).forEach(function (e) { dates[e.date] = true; });
  return Object.keys(dates).sort().reverse();
}

function briefingForDate(date) {
  return (state.briefing || []).filter(function (e) { return e.date === date; });
}

function isInBriefing(sym) {
  var today = todayDate();
  return (state.briefing || []).some(function (e) { return e.sym === sym && e.date === today; });
}

function saveBriefingLocal() {
  try { localStorage.setItem('pa_briefing', JSON.stringify(state.briefing)); } catch (e) {}
  clearTimeout(_briefingSyncTimer);
  _briefingSyncTimer = setTimeout(syncBriefingToServer, 1000);
}

function syncBriefingToServer() {
  var code = _briefingUserCode || localStorage.getItem('pa_user_code');
  if (!code) return;
  fetch(API_BASE + '/api/briefing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save', code: code, entries: state.briefing }),
  }).catch(function () {});
}

export function loadBriefing() {
  try {
    var local = JSON.parse(localStorage.getItem('pa_briefing') || '[]');
    if (Array.isArray(local)) state.briefing = local;
  } catch (e) {}
  var code = localStorage.getItem('pa_user_code');
  if (!code) return;
  _briefingUserCode = code;
  fetch(API_BASE + '/api/briefing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', code: code }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && Array.isArray(d.entries)) {
      state.briefing = d.entries;
      saveBriefingLocal();
      renderBriefingPanel();
      updateAllStarButtons();
    }
  }).catch(function () {});
}

export function toggleBriefing(sym) {
  var today = todayDate();
  var idx = (state.briefing || []).findIndex(function (e) { return e.sym === sym && e.date === today; });
  if (idx >= 0) {
    var entry = state.briefing[idx];
    if (entry.note && entry.note.trim()) {
      if (!confirm('Удалить ' + sym + ' из брифинга?')) return;
    }
    state.briefing.splice(idx, 1);
  } else {
    if (!state.briefing) state.briefing = [];
    state.briefing.push({ sym: sym, date: today, addedAt: Date.now(), status: 'watching', note: '' });
  }
  saveBriefingLocal();
  updateStarButton(sym);
  renderBriefingPanel();
}

function briefingStatusLabel(status) {
  if (status === 'watching') return icon('eye', 15);
  if (status === 'worked')   return icon('check', 15);
  if (status === 'skip')     return icon('ban', 15);
  return icon('circle', 15);
}

function briefingStatusClass(status) {
  if (status === 'watching') return 'bp-s-watching';
  if (status === 'worked')   return 'bp-s-worked';
  if (status === 'skip')     return 'bp-s-skip';
  return 'bp-s-none';
}

function cycleBriefingStatus(sym, date) {
  var entry = (state.briefing || []).find(function (e) { return e.sym === sym && e.date === date; });
  if (!entry) return;
  var order = ['watching', 'worked', 'skip'];
  var cur = order.indexOf(entry.status);
  entry.status = order[(cur + 1) % order.length];
  saveBriefingLocal();
  renderBriefingPanel();
  var _fvd = document.getElementById('fv-briefing-drawer');
  if (_fvd && _fvd.classList.contains('open')) renderFVBriefingDrawer();
}

function updateStarButton(sym) {
  var active = isInBriefing(sym);
  document.querySelectorAll('.btn-star[data-sym="' + sym + '"]').forEach(function (btn) {
    btn.classList.toggle('active', active);
    btn.title = active ? 'Убрать из брифинга' : 'В брифинг';
  });
}

function updateAllStarButtons() {
  document.querySelectorAll('.btn-star').forEach(function (btn) {
    var sym = btn.dataset.sym;
    var active = isInBriefing(sym);
    btn.classList.toggle('active', active);
    btn.title = active ? 'Убрать из брифинга' : 'В брифинг';
  });
}

// ── Briefing Panel ─────────────────────────────────────────────────────────

export function openBriefingPanel() {
  if (!state.briefingViewDate) state.briefingViewDate = todayDate();
  var fvOverlay = document.getElementById('fv-overlay');
  var _btns = fvOverlay && fvOverlay.style.display !== 'none'
    ? Array.from(fvOverlay.querySelectorAll('[data-action="open-briefing"]'))
    : Array.from(document.querySelectorAll('[data-action="open-briefing"]'));
  var btn = _btns.find(function (b) { return b.offsetParent !== null; });

  var popup = document.getElementById('bp-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'bp-popup';
    popup.className = 'bp-popup';
    document.body.appendChild(popup);
  } else if (!popup.parentNode || popup.parentNode !== document.body) {
    document.body.appendChild(popup);
  }
  popup.style.display = 'block';
  var _fvStar = document.querySelector('.btn-fv-star');
  if (_fvStar) _fvStar.style.display = 'none';
  renderBriefingPanel();

  if (btn) {
    var btnRect = btn.getBoundingClientRect();
    // If inside a fixed overlay (full view), use fixed positioning — no scrollY needed
    var inFixed = !!btn.closest('#fv-overlay');
    popup.style.position = inFixed ? 'fixed' : 'absolute';
    popup.style.top = (btnRect.bottom + (inFixed ? 0 : window.scrollY) + 6) + 'px';
    if (window.innerWidth <= 768) {
      popup.style.left = '8px';
      popup.style.right = '8px';
      popup.style.width = 'auto';
    } else {
      popup.style.right = (document.documentElement.clientWidth - btnRect.right) + 'px';
      popup.style.left = 'auto';
      popup.style.width = '360px';
    }
  }
}

export function closeBriefingPanel() {
  var popup = document.getElementById('bp-popup');
  if (popup) popup.style.display = 'none';
  var _fvStar = document.querySelector('.btn-fv-star');
  if (_fvStar) _fvStar.style.display = '';
}

export function renderBriefingPanel() {
  var popup = document.getElementById('bp-popup');
  if (!popup || popup.style.display === 'none') return;
  var viewDate = state.briefingViewDate || todayDate();
  var today = todayDate();
  var entries = briefingForDate(viewDate);
  var dates = briefingDates();
  if (dates.indexOf(today) < 0) dates.unshift(today);
  if (dates.indexOf(viewDate) < 0) dates.unshift(viewDate);
  var dateIdx = dates.indexOf(viewDate);
  var canPrev = dateIdx < dates.length - 1;
  var canNext = dateIdx > 0;
  var isToday = viewDate === today;
  var todayEntries = briefingForDate(today);

  var rowsHTML = entries.length ? entries.map(function (e) {
    var coin = state.coins.find(function (c) { return c.symbol === e.sym; });
    var change = coin ? (coin.price_change_percentage_24h || 0) : 0;
    var price = coin ? fmtPrice(coin.current_price) : '—';
    var vol = coin ? fmt(coin.total_volume) : '—';
    return '<div class="bp-row">' +
      '<button class="bp-sym-btn" data-action="bp-open" data-sym="' + e.sym + '">' + e.sym.toUpperCase() + '</button>' +
      '<span class="bp-chg stat-val ' + (change >= 0 ? 'up' : 'dn') + '">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%</span>' +
      (isToday
        ? '<button class="bp-status ' + briefingStatusClass(e.status) + '" data-action="bp-cycle-status" data-sym="' + e.sym + '" data-date="' + e.date + '">' + briefingStatusLabel(e.status) + '</button>'
        : '<span class="bp-status ' + briefingStatusClass(e.status) + '">' + briefingStatusLabel(e.status) + '</span>') +
      '<button class="bp-note-btn ' + (e.note ? 'has-note' : '') + '" data-action="bp-toggle-note" data-sym="' + e.sym + '" data-date="' + e.date + '" title="Заметка">' + icon('sticky-note', 15) + '</button>' +
      (isToday ? '<button class="bp-remove" data-action="bp-remove" data-sym="' + e.sym + '" data-date="' + e.date + '" title="Убрать">' + icon('trash', 15) + '</button>' : '') +
      '</div>' +
      '<div class="bp-note-row" id="bp-note-' + e.sym + '-' + e.date + '" style="display:none">' +
        '<textarea placeholder="Заметка..." data-sym="' + e.sym + '" data-date="' + e.date + '">' + escHtml(e.note || '') + '</textarea>' +
      '</div>';
  }).join('') : '<div class="bp-empty">На сегодня монет нет — отметь звёздочкой на дашборде</div>';

  popup.innerHTML =
    '<div class="popup-header">' +
      '<span class="popup-title">Брифинг</span>' +
      '<button class="popup-close" data-action="close-briefing">' + icon('x', 15) + '</button>' +
    '</div>' +
    '<div class="bp-list">' + rowsHTML + '</div>' +
    '<div class="popup-footer">' +
      '<button class="popup-btn" data-action="go-briefing"' + (todayEntries.length ? '' : ' disabled') + '>Режим брифинг</button>' +
    '</div>';

  // Re-attach note textarea listeners
  popup.querySelectorAll('textarea[data-sym]').forEach(function (ta) {
    ta.addEventListener('input', function () {
      var sym = ta.dataset.sym, date = ta.dataset.date;
      var entry = (state.briefing || []).find(function (e) { return e.sym === sym && e.date === date; });
      if (entry) { entry.note = ta.value; saveBriefingLocal(); }
      var noteBtn = popup.querySelector('.bp-note-btn[data-sym="' + sym + '"][data-date="' + date + '"]');
      if (noteBtn) noteBtn.classList.toggle('has-note', !!ta.value);
    });
  });
}

function _fvCoinInfoHTML(sym, tf) {
  var coin = state.coins.find(function (c) { return c.symbol === sym; });
  var change = coin ? (coin.price_change_percentage_24h || 0) : 0;
  var nd = natrDisplay(sym);

  var cache = state.analysisCache[sym];
  var hasA = cache && cache.status === 'ok', isL = cache && cache.status === 'loading', isE = cache && cache.status === 'error';
  var signal = hasA ? cache.result.signal : null;
  var fvBadge = '';
  if (isL) fvBadge = '<span class="btn-pressed">' + icon('zap', 14) + '</span>';
  else if (isE) fvBadge = '<button class="btn-retry" data-action="analyze" data-sym="' + sym + '">Повтор</button>';
  else if (hasA) fvBadge = '<span class="signal-badge ' + signal + '" data-action="open-analysis" data-sym="' + sym + '">' + signalLabel(signal) + '</span>';
  else fvBadge = '<button class="btn-analyze-one" data-action="analyze" data-sym="' + sym + '">' + icon('zap', 14) + '</button>';

  var alertCount = (_alerts[sym] && _alerts[sym].length) || 0;
  var levelCount = (_levels[sym] && _levels[sym].length) || 0;

  return '<div class="fv-coin-info">'
    + '<div class="fv-info-top">'
    + '<button class="fv-back-btn" data-action="close-fv" title="Назад">' + icon('arrow-left', 15) + '</button>'
    + '<span class="fv-sym-label">' + sym.toUpperCase() + '</span>'
    + '<div class="tf-picker">'
    + '<button class="tf-pill" data-action="fv-tf-pick">' + tf + '</button>'
    + '<div class="tf-dd fv-tf-dd" style="display:none">'
    + ['1m', '5m', '15m', '1h', '4h'].map(function (t) { return '<button class="' + (t === tf ? 'active' : '') + '" data-action="fv-tf-opt" data-tf="' + t + '">' + t + '</button>'; }).join('')
    + '</div>'
    + '</div>'
    + '<button class="btn-star btn-fv-star' + (isInBriefing(sym) ? ' active' : '') + '" data-action="toggle-briefing" data-sym="' + sym + '" title="' + (isInBriefing(sym) ? 'Убрать из брифинга' : 'В брифинг') + '">' + icon('star', 14) + '</button>'
    + '<button class="btn-clear-alerts" data-action="clear-alerts" data-sym="' + sym + '" title="Алерты" style="display:' + (alertCount ? 'inline-flex' : 'none') + '">' + alertCount + '</button>'
    + '<button class="btn-clear-levels" data-action="clear-levels" data-sym="' + sym + '" title="Уровни" style="display:' + (levelCount ? 'inline-flex' : 'none') + '">' + levelCount + '</button>'
    + fvBadge
    + '</div>'
    + '<div class="fv-info-stats">'
    + '<span class="stat-val ' + (change >= 0 ? 'up' : 'dn') + '">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%</span>'
    + '<span class="stat-val ' + nd.cls + '">' + nd.val + '</span>'
    + '<span class="stat-val">' + fmt(coin ? coin.total_volume : 0).replace('$', '') + '</span>'
    + '</div>'
    + '</div>';
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
  _fvChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, cd.candles.length - 80), to: cd.candles.length - 1 });
  // Attach existing levels and alerts to fv series
  (_levels[sym] || []).forEach(function (l) {
    if (l.price && !l.fvLine) l.fvLine = _fvSeries.createPriceLine({ price: l.price, color: getCSSVar('--level'), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' });
  });
  // Sync alert lines — _syncAlertLine handles create-or-update for both card and FV
  (_alerts[sym] || []).forEach(function (a) { _syncAlertLine(sym, a); });
}

function _loadFVData(sym, tf) {
  var key = sym + '_' + tf;
  var cd = state.chartData[key];
  if (cd && cd.status === 'ok' && cd.candles.length) {
    _setFVData(sym, cd);
  } else {
    fetchChartData(sym, tf).then(function () { _setFVData(sym, state.chartData[key]); });
  }
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
    (_alerts[_fvSym] || []).forEach(function (a) { _detachFvLine(a); });
  }
  _fvSym = sym;

  var overlay = document.getElementById('fv-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'fv-overlay'; document.body.appendChild(overlay); }

  var tf = state.chartTF[sym] || '5m';
  var switchingCoins = overlay.style.display === 'flex';
  if (!switchingCoins) {
    // First open — build full structure including drawer
    overlay.innerHTML = '<div class="fv-body">'
      + '<div class="fv-chart-wrap">'
      + _fvCoinInfoHTML(sym, tf)
      + '<div id="fv-chart"></div>'
      + '</div>'
      + '<div id="fv-briefing-drawer"></div>'
      + '</div>';
  } else {
    // Switching coins — update chart-wrap only, leave drawer untouched
    var _chartWrap = overlay.querySelector('.fv-chart-wrap');
    if (_chartWrap) {
      _chartWrap.innerHTML = _fvCoinInfoHTML(sym, tf) + '<div id="fv-chart"></div>';
      // If briefing popup or drawer is open — hide the new star and re-highlight current coin
      var _bpPopup = document.getElementById('bp-popup');
      var _fvdEl = document.getElementById('fv-briefing-drawer');
      var briefingOpen = (_bpPopup && _bpPopup.style.display !== 'none') || (_fvdEl && _fvdEl.classList.contains('open'));
      if (briefingOpen) {
        var _newStar = _chartWrap.querySelector('.btn-fv-star');
        if (_newStar) _newStar.style.display = 'none';
      }
      if (_fvdEl && _fvdEl.classList.contains('open')) renderFVBriefingDrawer();
    }
  }
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Init chart
  var el = document.getElementById('fv-chart');
  var c = getChartColors();
  _fvChart = window.LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: c.bg }, textColor: c.text },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    crosshair: { mode: 0 },
    rightPriceScale: { visible: true, borderColor: c.border, scaleMargins: { top: 0.05, bottom: 0.25 } },
    timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false, tickMarkFormatter: _tickMarkFmt },
    localization: { timeFormatter: _localTimeFmt },
    handleScroll: true, handleScale: true,
  });
  _fvSeries = _fvChart.addCandlestickSeries(getSeriesColors());
  _fvVolSeries = _fvChart.addHistogramSeries({ color: getCSSVar('--steel'), priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
  _fvChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  // ── "+" button tracks crosshair — instant, no timer ──────────────────────
  _fvChart.subscribeCrosshairMove(function (param) {
    if (window.innerWidth > 768) return;
    var btn = document.getElementById('fv-add-btn');
    if (!param.point || _fvTD.active || _fvTD.near || document.getElementById('fv-touch-menu')) {
      if (btn) btn.style.display = 'none';
      return;
    }
    var y = param.point.y;
    var levels = _levels[sym] || [], alerts = _alerts[sym] || [];
    for (var i = 0; i < levels.length; i++) {
      var ly = _fvSeries.priceToCoordinate(levels[i].price);
      if (ly != null && Math.abs(ly - y) < 15) { if (btn) btn.style.display = 'none'; return; }
    }
    for (var j = 0; j < alerts.length; j++) {
      var ay = _fvSeries.priceToCoordinate(alerts[j].price);
      if (ay != null && Math.abs(ay - y) < 15) { if (btn) btn.style.display = 'none'; return; }
    }
    var price = _fvSeries.coordinateToPrice(y);
    if (price != null) _fvTMShowBtn(y, price);
  });

  window.__fvSeries = _fvSeries;
  window.__fvVolSeries = _fvVolSeries;
  window.__fvSymbol = sym;
  window.__fvTF = tf;

  // Canvas overlay for alert bells + ruler
  var wrap = document.querySelector('.fv-chart-wrap');
  var rc = document.createElement('canvas');
  rc.className = 'fv-canvas';
  wrap.appendChild(rc);
  function _syncFVCanvas() { rc.width = wrap.offsetWidth || window.innerWidth; rc.height = wrap.offsetHeight || window.innerHeight; }
  _syncFVCanvas();
  window.addEventListener('resize', _syncFVCanvas);
  function _onEscKey(e) { if (e.key === 'Escape') closeCoinFullView(); }
  document.addEventListener('keydown', _onEscKey);
  _fvRuler = { start: null, canvas: rc, _resizeHandler: _syncFVCanvas, _escHandler: _onEscKey };

  // Event handlers (contextmenu: add/remove level or alert; mousedown: drag level/alert)
  var _fvDragging = null;
  var _fvAlertDragging = null, _fvAlertDragMoved = false;
  el.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var rect = el.getBoundingClientRect();
    var y = e.clientY - rect.top;
    var price = _fvSeries.coordinateToPrice(y);
    if (price == null) return;
    if (e.shiftKey) {
      if (_fvAlertDragMoved) { _fvAlertDragMoved = false; return; }
      var alerts = _alerts[sym] || [];
      for (var i = 0; i < alerts.length; i++) {
        var ay = _fvSeries.priceToCoordinate(alerts[i].price);
        if (ay != null && Math.abs(ay - y) < 14) { removeAlert(sym, i); return; }
      }
      addAlert(sym, price);
    } else {
      var levels = _levels[sym] || [];
      for (var i = 0; i < levels.length; i++) {
        var ly = _fvSeries.priceToCoordinate(levels[i].price);
        if (ly != null && Math.abs(ly - y) < 14) { removeLevel(sym, i); return; }
      }
      addLevel(sym, price);
    }
  });
  el.addEventListener('mousedown', function (e) {
    var rect = el.getBoundingClientRect();
    // Ignore clicks on the price axis (right side) — let chart handle vertical zoom natively
    var priceAxisW = 0;
    try { priceAxisW = _fvChart.priceScale('right').width(); } catch (_) {}
    if (e.clientX - rect.left > rect.width - priceAxisW - 2) return;

    if (e.button === 1) {
      e.preventDefault();
      var pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      var pr = _fvSeries.coordinateToPrice(pt.y);
      if (pr != null) _fvRuler.start = { pt: pt, price: pr };
      return;
    }
    // Alert drag: shift + right-button (button 2)
    if (e.button === 2 && e.shiftKey) {
      var ay2 = e.clientY - rect.top;
      var alertArr = _alerts[sym] || [];
      for (var ai = 0; ai < alertArr.length; ai++) {
        var aCoord = _fvSeries.priceToCoordinate(alertArr[ai].price);
        if (aCoord != null && Math.abs(aCoord - ay2) < 10) {
          e.stopPropagation(); e.preventDefault();
          _fvAlertDragging = { idx: ai, alert: alertArr[ai] };
          _fvAlertDragMoved = false;
          el.style.cursor = 'ns-resize';
          return;
        }
      }
    }
    if (e.button !== 0) return;
    var y = e.clientY - rect.top;
    var levels = _levels[sym] || [];
    for (var i = 0; i < levels.length; i++) {
      var ly = _fvSeries.priceToCoordinate(levels[i].price);
      if (ly != null && Math.abs(ly - y) < 8) { e.stopPropagation(); e.preventDefault(); _fvDragging = { idx: i, lvl: levels[i] }; el.style.cursor = 'ns-resize'; return; }
    }
  }, { capture: true });
  el.addEventListener('mousemove', function (e) {
    var rect = el.getBoundingClientRect();
    var y = e.clientY - rect.top;
    if (_fvDragging && (e.buttons & 1)) {
      var price = _fvSeries.coordinateToPrice(y);
      if (price != null) {
        _fvDragging.lvl.price = price;
        if (_fvDragging.lvl.fvLine) _fvDragging.lvl.fvLine.applyOptions({ price: price });
        if (_fvDragging.lvl.line) _fvDragging.lvl.line.applyOptions({ price: price });
      }
      return;
    }
    // Alert drag (shift + right button)
    if (_fvAlertDragging && (e.buttons & 2)) {
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
    var ruler = _fvRuler;
    if (!ruler || !ruler.start || !(e.buttons & 4)) return;
    var pt = { x: e.clientX - rect.left, y: y };
    var pr2 = _fvSeries.coordinateToPrice(y);
    if (pr2 == null) return;
    var rc = ruler.canvas, ctx = rc.getContext('2d');
    ctx.clearRect(0, 0, rc.width, rc.height);
    var p1 = ruler.start.pt, pr1 = ruler.start.price;
    var isUp = pr2 >= pr1, color = isUp ? getCSSVar('--bullish') : getCSSVar('--danger');
    var pct = ((pr2 - pr1) / Math.abs(pr1) * 100);
    var pctStr = (isUp ? '+' : '') + pct.toFixed(2) + '%';
    if (_fvChart) {
      var t1 = _fvChart.timeScale().coordinateToTime(p1.x), t2 = _fvChart.timeScale().coordinateToTime(pt.x);
      if (t1 != null && t2 != null) {
        var d = Math.abs(t2 - t1);
        var dur = d < 60 ? Math.round(d) + 'с' : d < 3600 ? Math.round(d / 60) + 'м' : d < 86400 ? Math.floor(d / 3600) + 'ч ' + Math.round((d % 3600) / 60) + 'м' : Math.floor(d / 86400) + 'д ' + Math.floor((d % 86400) / 3600) + 'ч';
        pctStr += '  ·  ' + dur;
      }
    }
    ctx.fillStyle = isUp ? 'rgba(22,163,74,0.07)' : 'rgba(220,38,38,0.07)';
    ctx.fillRect(0, Math.min(p1.y, pt.y), rc.width, Math.abs(pt.y - p1.y) || 1);
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(0, p1.y); ctx.lineTo(rc.width, p1.y); ctx.moveTo(0, pt.y); ctx.lineTo(rc.width, pt.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(pt.x, pt.y); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p1.x, p1.y, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.font = 'bold 16px Manrope,Arial,sans-serif'; ctx.fillStyle = color;
    var lx = pt.x + 12, lyt = pt.y - 10;
    if (lx + 170 > rc.width) lx = pt.x - 175; if (lx < 2) lx = 2;
    if (lyt < 14) lyt = pt.y + 20; if (lyt > rc.height - 4) lyt = rc.height - 4;
    ctx.fillText(pctStr, lx, lyt);
  });
  el.addEventListener('mouseup', function (e) {
    if (e.button === 1 && _fvRuler) _fvRuler.start = null;
    if (_fvDragging) { saveLevels(); _fvDragging = null; el.style.cursor = ''; }
    if (e.button === 2 && _fvAlertDragging) { saveAlerts(); _fvAlertDragging = null; el.style.cursor = ''; }
  });
  el.addEventListener('mouseleave', function () {
    if (_fvDragging) { _fvDragging = null; saveLevels(); }
    if (_fvAlertDragging) { _fvAlertDragging = null; saveAlerts(); }
    if (_fvRuler) _fvRuler.start = null;
    el.style.cursor = '';
  });

  // ── Touch: drag levels/alerts + long-press to add/delete ─────────────────
  var _fvTD = {
    active: false, mode: null, item: null,  // currently dragging
    near: false, nearMode: null, nearItem: null, nearIdx: null, // touched near a level/alert
    dragReady: false,                       // true after 200ms hold — drag unlocked
    readyTimer: null, deleteTimer: null,    // 200ms / 600ms timers
    startX: 0, startY: 0,
  };

  function _fvTMShowBtn(y, price) {
    var btn = document.getElementById('fv-add-btn');
    if (!btn) { btn = document.createElement('button'); btn.id = 'fv-add-btn'; btn.className = 'fv-add-btn'; wrap.appendChild(btn); }
    btn.innerHTML = icon('plus', 14);
    btn.style.top = Math.max(4, y - 14) + 'px';
    btn.style.display = 'flex';
    btn.onclick = function () { btn.style.display = 'none'; _fvTMShowMenu(y, price, null, null); };
  }

  function _fvTMShowMenu(y, price, delMode, delIdx) {
    _fvTMHideMenu();
    var p = price.toFixed(calcPriceFormat(price).precision);
    var m = document.createElement('div');
    m.id = 'fv-touch-menu';
    m.className = 'fv-touch-menu';
    var html;
    if (delMode === 'level') {
      html = '<button class="fv-touch-menu-item fv-tmi-danger" data-tm="del-level" data-idx="' + delIdx + '">' +
        '<span class="fv-tmi-icon">' + icon('trash-2', 15) + '</span><span>Удалить уровень · ' + p + '</span></button>';
    } else if (delMode === 'alert') {
      html = '<button class="fv-touch-menu-item fv-tmi-danger" data-tm="del-alert" data-idx="' + delIdx + '">' +
        '<span class="fv-tmi-icon">' + icon('trash-2', 15) + '</span><span>Удалить алерт · ' + p + '</span></button>';
    } else {
      html = '<button class="fv-touch-menu-item" data-tm="level">' +
          '<span class="fv-tmi-icon">' + icon('minus', 15) + '</span><span>Горизонтальный уровень · ' + p + '</span></button>' +
        '<button class="fv-touch-menu-item" data-tm="alert">' +
          '<span class="fv-tmi-icon">' + icon('bell', 15) + '</span><span>Добавить алерт · ' + p + '</span></button>';
    }
    m.innerHTML = html;
    var menuH = delMode ? 54 : 108;
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
      else if (a === 'del-level') removeLevel(sym, idx);
      else if (a === 'del-alert') removeAlert(sym, idx);
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
    _fvTD.dragReady = false;
    clearTimeout(_fvTD.readyTimer); _fvTD.readyTimer = null;
    clearTimeout(_fvTD.deleteTimer); _fvTD.deleteTimer = null;
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

  }, { passive: false });

  el.addEventListener('touchmove', function (e) {
    if (e.touches.length !== 1) return;
    var t = e.touches[0], rect = el.getBoundingClientRect();
    var y = t.clientY - rect.top;
    var dx = t.clientX - rect.left - _fvTD.startX, dy = y - _fvTD.startY;
    var moved = Math.sqrt(dx * dx + dy * dy);

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
      _fvTD.active = true; _fvTD.mode = _fvTD.nearMode; _fvTD.item = _fvTD.nearItem;
      _fvTD.near = false;
      clearTimeout(_fvTD.deleteTimer); _fvTD.deleteTimer = null;
    }

    if (_fvTD.active) {
      if (e.cancelable) e.preventDefault();
      var price = _fvSeries.coordinateToPrice(y);
      if (price == null) return;
      var item = _fvTD.item;
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
    _fvTD.dragReady = false;
    _fvTD.near = false; _fvTD.nearItem = null;
    if (_fvTD.active) {
      if (_fvTD.mode === 'level') saveLevels();
      else saveAlerts();
      _fvTMHideHandle();
      _fvTD.active = false; _fvTD.mode = null; _fvTD.item = null;
    } else {
      _fvTMHideHandle();
    }
  });

  // rAF loop: alert bell icons on canvas
  (function fvBellLoop() {
    if (!_fvChart) return;
    var ruler = _fvRuler;
    if (ruler && ruler.canvas && !ruler.start) {
      var ctx = ruler.canvas.getContext('2d');
      ctx.clearRect(0, 0, ruler.canvas.width, ruler.canvas.height);
      if (_fvSeries && _bellImg && _bellImg.complete) {
        (_alerts[sym] || []).forEach(function (a) {
          var y = _fvSeries.priceToCoordinate(a.price);
          if (y == null || y < 0 || y > ruler.canvas.height) return;
          var sz = 18;
          ctx.save(); ctx.globalAlpha = a.triggered ? 0.35 : 1;
          ctx.drawImage(_bellImg, ruler.canvas.width / 2 - sz / 2, y - sz / 2, sz, sz);
          ctx.restore();
        });
      }
    }
    requestAnimationFrame(fvBellLoop);
  }());

  _loadFVData(sym, tf);
}

export function closeCoinFullView() {
  if (_fvChart) { try { _fvChart.remove(); } catch (e) {} _fvChart = null; }
  if (_fvRuler && _fvRuler._resizeHandler) window.removeEventListener('resize', _fvRuler._resizeHandler);
  if (_fvRuler && _fvRuler._escHandler) document.removeEventListener('keydown', _fvRuler._escHandler);
  _fvSeries = null; _fvVolSeries = null; _fvRuler = null;
  window.__fvSeries = null; window.__fvVolSeries = null; window.__fvSymbol = null; window.__fvTF = null;
  if (_fvSym) {
    (_levels[_fvSym] || []).forEach(function (l) { l.fvLine = null; });
    (_alerts[_fvSym] || []).forEach(function (a) { _detachFvLine(a); });
  }
  _fvSym = null;
  var overlay = document.getElementById('fv-overlay');
  if (overlay) overlay.style.display = 'none';
  var ap = document.getElementById('analysis-overlay');
  if (ap) { ap.style.display = 'none'; if (ap._popupCard) { ap._popupCard.style.overflow = ''; ap._popupCard = null; } }
  document.body.style.overflow = '';
}

export function setFVChartTF(tf) {
  if (!_fvSym || !_fvSeries) return;
  state.chartTF[_fvSym] = tf;
  window.__fvTF = tf;
  var pill = document.querySelector('#fv-overlay .tf-pill');
  if (pill) pill.textContent = tf;
  var dd = document.querySelector('#fv-overlay .fv-tf-dd');
  if (dd) dd.querySelectorAll('button').forEach(function (btn) { btn.className = btn.dataset.tf === tf ? 'active' : ''; });
  // Remove price lines from series before reload to prevent duplicate orphaned lines
  (_levels[_fvSym] || []).forEach(function (l) { if (l.fvLine) { try { _fvSeries.removePriceLine(l.fvLine); } catch (e) {} l.fvLine = null; } });
  (_alerts[_fvSym] || []).forEach(function (a) { _detachFvLine(a); });
  _fvSeries.setData([]);
  _loadFVData(_fvSym, tf);
}

export function briefingNavDate(dir) {
  var today = todayDate();
  var dates = briefingDates();
  if (dates.indexOf(today) < 0) dates.unshift(today);
  var cur = state.briefingViewDate || today;
  var ci = dates.indexOf(cur);
  var ni = ci - dir; // dir=+1 means next (newer), dir=-1 means prev (older)
  if (ni >= 0 && ni < dates.length) state.briefingViewDate = dates[ni];
  renderBriefingPanel();
}

export function briefingCycleStatus(sym, date) {
  cycleBriefingStatus(sym, date);
}

export function briefingRemove(sym, date) {
  var idx = (state.briefing || []).findIndex(function (e) { return e.sym === sym && e.date === date; });
  if (idx >= 0) {
    var entry = state.briefing[idx];
    if (entry.note && entry.note.trim()) {
      if (!confirm('Удалить ' + sym + ' из брифинга?')) return;
    }
    state.briefing.splice(idx, 1);
    saveBriefingLocal();
    updateStarButton(sym);
    renderBriefingPanel();
    var _fvd2 = document.getElementById('fv-briefing-drawer');
    if (_fvd2 && _fvd2.classList.contains('open')) renderFVBriefingDrawer();
  }
}

export function renderFVBriefingDrawer() {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (!drawer) return;
  var today = todayDate();
  var allEntries = state.briefing || [];
  if (!allEntries.length) {
    drawer.innerHTML = '<div class="fvbd-header"><span class="fvbd-title">Брифинг</span></div><div class="fvbd-empty">Брифинг пуст</div>';
    return;
  }
  // Group by date descending
  var dateMap = {};
  allEntries.forEach(function (e) { if (!dateMap[e.date]) dateMap[e.date] = []; dateMap[e.date].push(e); });
  var dates = Object.keys(dateMap).sort().reverse();
  var html = '<div class="fvbd-header"><span class="fvbd-title">Брифинг</span></div>';
  dates.forEach(function (date) {
    var isToday = date === today;
    if (!isToday) html += '<div class="fvbd-date-label">' + fmtBriefingDate(date) + '</div>';
    dateMap[date].forEach(function (e) {
      var coin = state.coins.find(function (c) { return c.symbol === e.sym; });
      var change = coin ? (coin.price_change_percentage_24h || 0) : 0;
      var isCurrent = _fvSym === e.sym;
      html += '<div class="bp-row' + (isCurrent ? ' fvbd-current' : '') + '">'
        + '<button class="bp-sym-btn" data-action="fvbd-open" data-sym="' + e.sym + '">' + e.sym.toUpperCase() + '</button>'
        + '<span class="bp-chg stat-val ' + (change >= 0 ? 'up' : 'dn') + '">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%</span>'
        + (isToday
          ? '<button class="bp-status ' + briefingStatusClass(e.status) + '" data-action="bp-cycle-status" data-sym="' + e.sym + '" data-date="' + e.date + '">' + briefingStatusLabel(e.status) + '</button>'
          : '<span class="bp-status ' + briefingStatusClass(e.status) + '">' + briefingStatusLabel(e.status) + '</span>')
        + '<button class="bp-note-btn ' + (e.note ? 'has-note' : '') + '" data-action="bp-toggle-note" data-sym="' + e.sym + '" data-date="' + e.date + '" title="Заметка">' + icon('sticky-note', 15) + '</button>'
        + (isToday ? '<button class="bp-remove" data-action="bp-remove" data-sym="' + e.sym + '" data-date="' + e.date + '" title="Убрать">' + icon('trash', 15) + '</button>' : '')
        + '</div>'
        + '<div class="bp-note-row" id="bp-note-' + e.sym + '-' + e.date + '" style="display:none">'
        + '<textarea placeholder="Заметка..." data-sym="' + e.sym + '" data-date="' + e.date + '">' + escHtml(e.note || '') + '</textarea>'
        + '</div>';
    });
  });
  drawer.innerHTML = html;
  // Re-attach textarea listeners
  drawer.querySelectorAll('textarea[data-sym]').forEach(function (ta) {
    ta.addEventListener('input', function () {
      var sym = ta.dataset.sym, date = ta.dataset.date;
      var entry = (state.briefing || []).find(function (e) { return e.sym === sym && e.date === date; });
      if (entry) { entry.note = ta.value; saveBriefingLocal(); }
      var noteBtn = drawer.querySelector('.bp-note-btn[data-sym="' + sym + '"][data-date="' + date + '"]');
      if (noteBtn) noteBtn.classList.toggle('has-note', !!ta.value);
    });
  });
}

export function openFVBriefingDrawer() {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (!drawer) return;
  drawer.classList.add('open');
  var star = document.querySelector('.btn-fv-star');
  if (star) star.style.display = 'none';
  renderFVBriefingDrawer();
}

export function closeFVBriefingDrawer() {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (drawer) drawer.classList.remove('open');
  var star = document.querySelector('.btn-fv-star');
  if (star) star.style.display = '';
}

export function toggleFVBriefingDrawer() {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (!drawer) return;
  if (drawer.classList.contains('open')) { closeFVBriefingDrawer(); } else { openFVBriefingDrawer(); }
}

// ── Search Popup ───────────────────────────────────────────────────────────

function _renderSearchList(popup, query) {
  var listEl = popup.querySelector('.search-popup-list');
  if (!listEl) return;
  var q = (query || '').trim().toLowerCase();
  var coins = state.coins;
  var filtered = q
    ? coins.filter(function (c) {
        return c.symbol.toLowerCase().indexOf(q) !== -1 ||
               (c.name && c.name.toLowerCase().indexOf(q) !== -1);
      }).sort(function (a, b) {
        // Starts-with match ranks above contains
        var aStarts = a.symbol.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        var bStarts = b.symbol.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return (b.total_volume || 0) - (a.total_volume || 0);
      })
    : coins.slice().sort(function (a, b) { return (b.total_volume || 0) - (a.total_volume || 0); });
  if (!filtered.length) {
    listEl.innerHTML = '<div class="search-popup-empty">Ничего не найдено</div>';
    return;
  }
  listEl.innerHTML = filtered.map(function (c) {
    var change = c.price_change_percentage_24h || 0;
    var chgCls = change >= 0 ? 'up' : 'dn';
    var chgStr = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
    return '<button class="search-popup-row" data-action="search-pick" data-sym="' + c.symbol + '">' +
      '<span class="search-row-sym">' + c.symbol.toUpperCase() + '</span>' +
      '<span class="search-row-name">' + escHtml(c.name || '') + '</span>' +
      '<span class="search-row-chg ' + chgCls + '">' + chgStr + '</span>' +
      '</button>';
  }).join('');
}

export function openSearchPopup() {
  var popup = document.getElementById('search-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'search-popup';
    popup.className = 'search-popup';
  }
  if (popup.parentNode) popup.parentNode.removeChild(popup);

  var isMobile = window.innerWidth <= 768;

  popup.innerHTML =
    '<div class="popup-header">' +
      '<span class="popup-title">Поиск монеты</span>' +
      '<button class="popup-close" data-action="close-search">' + icon('x', 15) + '</button>' +
    '</div>' +
    '<div class="search-popup-input-wrap">' +
      '<input class="search-popup-input" id="search-popup-input" type="text" placeholder="BTC, Ethereum..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">' +
    '</div>' +
    '<div class="search-popup-list"></div>';

  document.body.appendChild(popup);
  _renderSearchList(popup, '');

  var input = popup.querySelector('.search-popup-input');
  input.addEventListener('input', function () {
    _renderSearchList(popup, input.value);
  });

  popup.style.display = 'flex';

  // Position on desktop below the search button
  if (!isMobile) {
    var btn = document.querySelector('[data-action="open-search"]');
    if (btn) {
      var btnRect = btn.getBoundingClientRect();
      popup.style.top = (btnRect.bottom + window.scrollY + 6) + 'px';
      popup.style.right = (document.documentElement.clientWidth - btnRect.right) + 'px';
      popup.style.left = 'auto';
    }
  }

  setTimeout(function () { if (input) input.focus(); }, 60);
}

export function closeSearchPopup() {
  var popup = document.getElementById('search-popup');
  if (popup) popup.style.display = 'none';
}
