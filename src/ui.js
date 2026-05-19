import { state, filteredCoins } from './state.js';
import { fmt, fmtPrice, escHtml, signalLabel, icon } from './utils.js';
import { on } from './events.js';
import { fetchMarketStrength, analyzeCoinBySymbol, fetchChartData, wsConnected, sendWS } from './api.js';

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

  return '<div class="coin-card' + (signal ? ' ' + signal : '') + '" data-sym="' + coin.symbol + '">' +
    '<div class="card-head">' +
    '<div class="card-head-left">' +
    '<span class="card-sym">' + coin.symbol.toUpperCase() + '</span>' +
    '<div class="card-inline-stats">' +
    '<span class="stat-val ' + (change >= 0 ? 'up' : 'dn') + '" title="Изменение за 24ч">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%</span>' +
    '<span class="stat-val ' + natr.cls + '" title="NATR — волатильность (5m × 30 свечей)">' + natr.val + '</span>' +
    '<span class="stat-val" title="Объём торгов за 24ч">' + fmt(coin.total_volume) + '</span>' +
    '</div>' +
    '</div>' +
    '<div class="card-head-right">' +
    '<button class="btn-clear-alerts" data-action="clear-alerts" data-sym="' + coin.symbol + '" title="Алерты (Shift+ПКМ для добавления)" style="display:' + ((_alerts[coin.symbol] && _alerts[coin.symbol].length) ? 'inline-flex' : 'none') + '">' + ((_alerts[coin.symbol] && _alerts[coin.symbol].length) || 0) + '</button>' +
    '<button class="btn-clear-levels" data-action="clear-levels" data-sym="' + coin.symbol + '" style="display:' + ((_levels[coin.symbol] && _levels[coin.symbol].length) ? 'inline-flex' : 'none') + '">' + ((_levels[coin.symbol] && _levels[coin.symbol].length) || 0) + '</button>' +
    tfPicker +
    badge +
    '</div>' +
    '</div>' +
    '<div class="chart-container" id="chart-' + coin.symbol + '"></div>' +
    '</div>';
}

export function renderCards() {
  var grid = document.getElementById('cards-grid');
  if (!grid) return;
  var coins = filteredCoins();
  var existing = {};
  grid.querySelectorAll('.coin-card').forEach(function (el) { existing[el.dataset.sym] = el; });
  var seen = {};
  coins.forEach(function (coin) {
    seen[coin.symbol] = true;
    if (existing[coin.symbol]) return;
    var card = document.createElement('div');
    card.innerHTML = renderCard(coin);
    grid.appendChild(card.firstElementChild);
  });
  Object.keys(existing).forEach(function (sym) {
    if (!seen[sym]) {
      var el = existing[sym]; if (el) el.remove();
      try { if (_charts[sym]) _charts[sym].remove(); } catch (e) {}
      if (_levels[sym]) _levels[sym].forEach(function (l) { l.line = null; });
      delete _charts[sym]; delete _fullSeries[sym]; delete _volSeries[sym]; delete _rulers[sym];
      window.__chartSeries = _fullSeries; window.__chartVolSeries = _volSeries; window.__charts = _charts;
    }
  });
  initCharts();
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
  fetch('/api/levels', {
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
  // Remove all existing price lines from charts before replacing _levels
  Object.keys(_levels).forEach(function (sym) {
    var s = _fullSeries[sym];
    (_levels[sym] || []).forEach(function (l) {
      if (l.line && s) { try { s.removePriceLine(l.line); } catch (e) {} }
    });
  });
  _levels = {};
  Object.keys(data).forEach(function (sym) {
    _levels[sym] = data[sym].map(function (p) { return { price: p, line: null }; });
  });
  try { localStorage.setItem('pa_levels', JSON.stringify(data)); } catch (e) {}
  reattachAllLevels();
}

function fetchServerLevels(code) {
  fetch('/api/levels', {
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
    } else {
      applyServerLevels(d.levels);
    }
  }).catch(function () {});
}

export function loadLevels() {
  try {
    var local = JSON.parse(localStorage.getItem('pa_levels') || '{}');
    Object.keys(local).forEach(function (sym) {
      _levels[sym] = local[sym].map(function (p) { return { price: p, line: null }; });
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
      '<h2>Синхронизация</h2>' +
      '<p>Придумайте код — он нужен чтобы видеть ваши уровни на любом устройстве.<br>Латинские буквы и цифры, от 2 до 40 символов.</p>' +
      '<input id="code-modal-input" type="text" placeholder="например: dmitrii или trader007" maxlength="40" autocomplete="off" spellcheck="false" />' +
      '<p style="margin-top:16px;margin-bottom:4px;">Telegram chat_id <span style="color:var(--graphite);font-size:11px;">(для алертов на цену)</span></p>' +
      '<input id="chat-id-input" type="text" placeholder="например: 123456789" maxlength="20" autocomplete="off" />' +
      '<p style="font-size:11px;color:var(--graphite);margin-top:6px;">Напишите /start боту, получите ваш chat_id.</p>' +
      '<div class="code-modal-actions">' +
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
  }

  saveBtn.addEventListener('click', save);
  skipBtn.addEventListener('click', function () { backdrop.remove(); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
  input.focus();
}

function attachLevel(sym, lvl) {
  var s = _fullSeries[sym];
  if (!s) return;
  lvl.line = s.createPriceLine({ price: lvl.price, color: getCSSVar('--level'), lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: '' });
}

function addLevel(sym, price) {
  if (!_levels[sym]) _levels[sym] = [];
  var lvl = { price: price, line: null };
  _levels[sym].push(lvl);
  attachLevel(sym, lvl);
  saveLevels();
  updateLevelsBtn(sym);
}

function removeLevel(sym, idx) {
  if (!_levels[sym] || _levels[sym][idx] == null) return;
  var s = _fullSeries[sym];
  if (s && _levels[sym][idx].line) { try { s.removePriceLine(_levels[sym][idx].line); } catch (e) {} }
  _levels[sym].splice(idx, 1);
  saveLevels();
  updateLevelsBtn(sym);
}

export function clearLevels(sym) {
  var s = _fullSeries[sym];
  (_levels[sym] || []).forEach(function (l) { if (s && l.line) { try { s.removePriceLine(l.line); } catch (e) {} } });
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

var _alerts = {}; // symbol → [{price, triggered, line}]
var _chatId = localStorage.getItem('pa_chat_id') || '';
var _alertSyncTimer = null;

function alertsData() {
  var data = {};
  Object.keys(_alerts).forEach(function (sym) {
    if (_alerts[sym] && _alerts[sym].length) {
      data[sym] = _alerts[sym].map(function (a) { return { price: a.price, triggered: a.triggered }; });
    }
  });
  return data;
}

function alertLineOpts(triggered) {
  return { color: triggered ? 'rgba(239,68,68,0.3)' : '#ef4444', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' };
}

function attachAlert(sym, a) {
  var s = _fullSeries[sym];
  if (!s) return;
  a.line = s.createPriceLine(Object.assign({ price: a.price }, alertLineOpts(a.triggered)));
}

function addAlert(sym, price) {
  if (!_alerts[sym]) _alerts[sym] = [];
  var a = { price: price, triggered: false, line: null };
  _alerts[sym].push(a);
  attachAlert(sym, a);
  saveAlerts();
  updateAlertsBtn(sym);
  redrawAlerts(sym);
}

function removeAlert(sym, idx) {
  if (!_alerts[sym] || _alerts[sym][idx] == null) return;
  var s = _fullSeries[sym];
  if (s && _alerts[sym][idx].line) { try { s.removePriceLine(_alerts[sym][idx].line); } catch (e) {} }
  _alerts[sym].splice(idx, 1);
  saveAlerts();
  updateAlertsBtn(sym);
  redrawAlerts(sym);
}

export function clearAlerts(sym) {
  var s = _fullSeries[sym];
  (_alerts[sym] || []).forEach(function (a) { if (s && a.line) { try { s.removePriceLine(a.line); } catch (e) {} } });
  _alerts[sym] = [];
  saveAlerts();
  updateAlertsBtn(sym);
  redrawAlerts(sym);
}

function updateAlertsBtn(sym) {
  var btn = document.querySelector('.btn-clear-alerts[data-sym="' + sym + '"]');
  if (!btn) return;
  var count = (_alerts[sym] || []).length;
  btn.style.display = count ? 'inline-flex' : 'none';
  btn.textContent = count;
}

function saveAlerts() {
  try { localStorage.setItem('pa_alerts', JSON.stringify(alertsData())); } catch (e) {}
  clearTimeout(_alertSyncTimer);
  _alertSyncTimer = setTimeout(syncAlertsToServer, 1000);
}

function syncAlertsToServer() {
  if (!_userCode) return;
  var data = alertsData();
  // Notify VPS directly via WS for instant alertsMemory update
  sendWS({ type: 'save_alerts', code: _userCode, chatId: _chatId, data: data });
  // Also persist to Redis via Vercel for cross-device sync and VPS restart recovery
  fetch('/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save', code: _userCode, chatId: _chatId, data: data }),
  }).catch(function () {});
}

function reattachAllAlerts() {
  Object.keys(_alerts).forEach(function (sym) {
    var s = _fullSeries[sym];
    (_alerts[sym] || []).forEach(function (a) {
      if (a.line) { try { if (s) s.removePriceLine(a.line); } catch (e) {} a.line = null; }
    });
    (_alerts[sym] || []).forEach(function (a) { attachAlert(sym, a); });
    updateAlertsBtn(sym);
    redrawAlerts(sym);
  });
}

function applyServerAlerts(entry) {
  Object.keys(_alerts).forEach(function (sym) {
    var s = _fullSeries[sym];
    (_alerts[sym] || []).forEach(function (a) { if (a.line && s) { try { s.removePriceLine(a.line); } catch (e) {} } });
  });
  _alerts = {};
  if (entry && entry.data) {
    Object.keys(entry.data).forEach(function (sym) {
      _alerts[sym] = entry.data[sym].map(function (a) { return { price: a.price, triggered: a.triggered || false, line: null }; });
    });
  }
  if (entry && entry.chatId) { _chatId = entry.chatId; localStorage.setItem('pa_chat_id', _chatId); }
  try { localStorage.setItem('pa_alerts', JSON.stringify(alertsData())); } catch (e) {}
  reattachAllAlerts();
}

function fetchServerAlerts(code) {
  fetch('/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', code: code }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (!d) return;
    var serverHasData = d.data && Object.keys(d.data).length > 0;
    var localHasData = Object.keys(alertsData()).length > 0;
    if (!serverHasData && localHasData) { syncAlertsToServer(); }
    else { applyServerAlerts(d); }
  }).catch(function () {});
}

export function loadAlerts() {
  try {
    var local = JSON.parse(localStorage.getItem('pa_alerts') || '{}');
    Object.keys(local).forEach(function (sym) {
      _alerts[sym] = local[sym].map(function (a) { return { price: a.price, triggered: a.triggered || false, line: null }; });
    });
  } catch (e) {}
  if (_userCode) fetchServerAlerts(_userCode);
}

export function handleAlertTriggered(sym, price) {
  (_alerts[sym] || []).forEach(function (a) {
    if (a.price === price && !a.triggered) {
      a.triggered = true;
      var s = _fullSeries[sym];
      if (s && a.line) { try { s.removePriceLine(a.line); } catch (e) {} a.line = null; }
      attachAlert(sym, a);
    }
  });
  redrawAlerts(sym);
  // Cancel any pending debounced save that might have stale triggered:false state
  saveAlerts();
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
}

function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getChartColors() {
  return {
    bg: getCSSVar('--canvas'),
    text: getCSSVar('--graphite'),
    grid: isDark() ? 'rgba(255,255,255,0.04)' : getCSSVar('--hairline'),
    border: getCSSVar('--hairline'),
  };
}

function getSeriesColors() {
  var up = getCSSVar('--ink'), dn = getCSSVar('--steel');
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

function getChartOpts(width, height) {
  var c = getChartColors();
  return {
    width: width, height: height || 300,
    layout: { background: { color: c.bg }, textColor: c.text },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    crosshair: { mode: 0 },
    rightPriceScale: { visible: true, borderColor: c.border, scaleMargins: { top: 0.05, bottom: 0.25 } },
    timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false },
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
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - 80), to: total - 1 });
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
  Object.keys(_alerts).forEach(function (sym) { if (_alerts[sym]) _alerts[sym].forEach(function (a) { a.line = null; }); });
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
  ctx.fillStyle = isUp ? getCSSVar('--bullish-bg') : 'rgba(220,38,38,0.07)';
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
    var chart = window.LightweightCharts.createChart(el, getChartOpts(el.offsetWidth || 400));
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
    (_alerts[c.symbol] || []).forEach(function (a) { attachAlert(c.symbol, a); });
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

    (function (sym, container, cs) {
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
        if (e.button === 0) {
          var rect = container.getBoundingClientRect();
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
          var alertRect = container.getBoundingClientRect();
          var alertY = e.clientY - alertRect.top;
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
        var rect = container.getBoundingClientRect();
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
          if (alertPrice != null && _alertDragging.alert.line) {
            _alertDragging.alert.price = alertPrice;
            _alertDragging.alert.line.applyOptions({ price: alertPrice });
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
        if (_charts[sym]) _charts[sym].resize(container.offsetWidth, 300);
        if (_rulers[sym] && _rulers[sym].canvas) { _rulers[sym].canvas.width = container.offsetWidth; _rulers[sym].canvas.height = container.offsetHeight; }
      }).observe(container);
    })(c.symbol, el, s);
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
      '<div style="display:flex;justify-content:flex-end;margin-bottom:4px;">' +
        '<button class="ms-popup-close" data-action="close-analysis">✕</button>' +
      '</div>' +
      '<div class="ao-spinner"><span class="spinner"></span></div>' +
      '<div class="ao-content"></div>';
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
      '<div style="display:flex;justify-content:flex-end;margin-bottom:4px;">' +
        '<button class="ms-popup-close" data-action="close-analysis">✕</button>' +
      '</div>' +
      '<div class="ao-spinner"><span class="spinner"></span></div>' +
      '<div class="ao-content"></div>';
  }
  if (popup.parentNode) popup.parentNode.removeChild(popup);

  popup._popupCard = card;
  card.style.overflow = 'visible';
  card.style.position = 'relative';
  card.appendChild(popup);

  var cache = state.analysisCache[sym];
  var spinner = popup.querySelector('.ao-spinner');
  var content = popup.querySelector('.ao-content');
  spinner.style.display = 'flex';
  content.style.display = 'none';
  popup.style.display = 'block';
  popup.dataset.sym = sym;

  var cardRect = card.getBoundingClientRect();
  var btnRect = btn.getBoundingClientRect();
  var topOffset = (btnRect.bottom - cardRect.top) + 8;
  popup.style.position = 'absolute';
  popup.style.transform = 'none';
  popup.style.top = topOffset + 'px';
  popup.style.right = '0';
  popup.style.left = 'auto';
  popup.style.width = '67%';
  popup.style.maxWidth = 'none';
  popup.style.zIndex = '1000';
  popup.style.margin = '0';
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
  var closeBtn = '<button class="ms-popup-close" data-action="close-ms">✕</button>';
  if (!ms || ms.status === 'loading') {
    return '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
      '<div class="ms-title">Сила рынка</div>' + closeBtn + '</div>' +
      '<div class="ms-loading"><span class="spinner"></span>Анализирую рынок...</div>';
  }
  if (ms.status === 'error') {
    return '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
      '<div class="ms-title">Сила рынка</div>' + closeBtn + '</div>' +
      '<div style="color:var(--bloom-deep);font-size:13px;font-weight:600;margin-bottom:12px;">Ошибка загрузки данных</div>' +
      '<button style="width:100%;height:36px;background:var(--ink);color:var(--on-ink);border-radius:8px;font-family:\'Manrope\',Arial,sans-serif;font-size:14px;cursor:pointer;" data-action="refresh-ms">Повторить</button>';
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

  return '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
    '<div class="ms-phase" style="font-size:13px;">' + phase.label + ' · ' + phase.time + ' МСК</div>' +
    closeBtn +
    '</div>' +
    '<div class="ms-metrics-grid">' +
    '<div class="ms-metric"><div class="ms-metric-label">Объём' + tip(tips.vol) + '</div>' + msBar(m.volumePulse) + '</div>' +
    '<div class="ms-metric"><div class="ms-metric-label">Направленность' + tip(tips.move) + '</div>' + msBar(m.movement) + '</div>' +
    '<div class="ms-metric"><div class="ms-metric-label">Волатильность' + tip(tips.vol2) + '</div>' + msBar(m.volatility) + '</div>' +
    '<div class="ms-metric"><div class="ms-metric-label">Open Interest' + tip(tips.oi) + '</div>' + oiHtml + '</div>' +
    '</div>' +
    inPlayHtml +
    '<div class="ms-footer">Оценка: ' + ms.score + ' · топ-20 по объёму · ' + ts + '</div>' +
    '<button style="width:100%;height:36px;margin-top:12px;background:var(--canvas);color:var(--ink);border:1px solid var(--ink);border-radius:8px;font-family:\'Manrope\',Arial,sans-serif;font-size:14px;cursor:pointer;" data-action="refresh-ms">Обновить</button>';
}

export function openMSPopup() {
  // Close any existing analysis popup
  var existingAp = document.getElementById('analysis-overlay');
  if (existingAp && existingAp._popupCard) {
    existingAp._popupCard.style.overflow = '';
    existingAp._popupCard = null;
  }
  if (existingAp) existingAp.style.display = 'none';
  var existingMs = document.getElementById('ms-popup');
  if (existingMs) existingMs.style.display = 'none';

  if (!state.marketStrength) fetchMarketStrength();
  var card = document.getElementById('ms-card');
  var metrics = card ? card.parentElement : null;

  var popup = document.getElementById('ms-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'ms-popup';
    popup.className = 'ms-popup';
  }
  if (popup.parentNode) popup.parentNode.removeChild(popup);

  if (metrics) {
    metrics.style.overflow = 'visible';
    metrics.style.position = 'relative';
    metrics.appendChild(popup);
  }

  popup.innerHTML = msPopupInner();
  popup.style.display = 'block';
  popup.style.position = 'absolute';
  popup.style.width = '400px';
  popup.style.maxWidth = 'none';

  var rect = card.getBoundingClientRect();
  var metricsRect = metrics.getBoundingClientRect();
  var topOffset = rect.bottom - metricsRect.top + 6;
  popup.style.top = topOffset + 'px';

  if (window.innerWidth <= 768) {
    // На мобильных — растягиваем на всю ширину контейнера
    popup.style.left = '0';
    popup.style.right = '0';
    popup.style.width = 'auto';
  } else {
    // На десктопе — правый край попапа совпадает с правым краем ms-card
    var rightOffset = metricsRect.right - rect.right;
    popup.style.right = rightOffset + 'px';
    popup.style.left = 'auto';
    popup.style.width = '400px';
  }
}

export function closeMSPopup() {
  var el = document.getElementById('ms-popup');
  if (el) el.style.display = 'none';
  var card = document.getElementById('ms-card');
  var metrics = card ? card.parentElement : null;
  if (metrics) {
    metrics.style.overflow = '';
    metrics.style.position = '';
  }
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
  var card = document.getElementById('ms-card');
  if (card) card.innerHTML = msCardInner();
  var popup = document.getElementById('ms-popup');
  if (popup && popup.style.display !== 'none') popup.innerHTML = msPopupInner();
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
      + '<div class="cards-sort">'
      + '<button class="sort-pill' + (state.sortCol === 'price_change_percentage_24h' ? ' active' : '') + '" data-action="sort" data-col="price_change_percentage_24h">По росту</button>'
      + '<button class="sort-pill' + (state.sortCol === 'total_volume' ? ' active' : '') + '" data-action="sort" data-col="total_volume">По объёму</button>'
      + '<button class="sort-pill' + (state.sortCol === 'symbol' ? ' active' : '') + '" data-action="sort" data-col="symbol">По тикеру</button>'
      + '</div><div class="cards-grid" id="cards-grid">'
      + coins.map(function (c) { return renderCard(c); }).join('')
      + '</div></div>'
    : '<div class="empty-state">Нет монет, соответствующих фильтру.</div>';

  var bc = coins.filter(function (c) { return state.analysisCache[c.symbol] && state.analysisCache[c.symbol].result && state.analysisCache[c.symbol].result.signal === 'bullish'; }).length;
  var maxRise = coins.length ? Math.max.apply(null, coins.map(function (c) { return c.price_change_percentage_24h || 0; })).toFixed(2) : '—';
  var mv = coins.length ? Math.max.apply(null, coins.map(function (c) { return c.total_volume || 0; })) : 0;

  app.innerHTML =
    '<div class="topbar"><div class="filters">'
    + '<div class="filter-group vol-desktop"><label>Объём:</label>'
    + [20, 30, 50, 100, 200].map(function (v) { return '<button class="filter-pill' + (state.minVolume === v ? ' active' : '') + '" data-action="pick-vol" data-val="' + v + '">' + v + 'M</button>'; }).join('')
    + '</div>'
    + '<div class="filter-group change-desktop"><label>Рост:</label>'
    + [1, 2, 5, 10].map(function (v) { return '<button class="filter-pill' + (state.minChange === v ? ' active' : '') + '" data-action="pick-change" data-val="' + v + '">' + v + '%</button>'; }).join('')
    + '</div>'
    + '<div class="mobile-filters-row">'
    + '<div class="tf-picker">'
    + '<button class="tf-pill" data-action="vol-pick">' + state.minVolume + 'M</button>'
    + '<div class="tf-dd" id="vol-dd" style="display:none">'
    + [20, 30, 50, 100, 200].map(function (v) { return '<button class="' + (v === state.minVolume ? 'active' : '') + '" data-action="pick-vol" data-val="' + v + '">' + v + 'M</button>'; }).join('')
    + '</div></div>'
    + '<div class="tf-picker">'
    + '<button class="tf-pill" data-action="change-pick">' + state.minChange + '%</button>'
    + '<div class="tf-dd" id="change-dd" style="display:none">'
    + [1, 2, 5, 10].map(function (v) { return '<button class="' + (v === state.minChange ? 'active' : '') + '" data-action="pick-change" data-val="' + v + '">' + v + '%</button>'; }).join('')
    + '</div></div>'
    + '<span class="ws-indicator ' + (wsConnected ? 'connected' : 'disconnected') + '" title="' + (wsConnected ? 'WebSocket: подключен — данные обновляются в реальном времени' : 'WebSocket: отключен — переподключение...') + '"></span>'
    + '<button class="btn-settings btn-settings-mob" data-action="open-settings" title="Настройки">' + icon('bell', 15) + '</button>'
    + '<button class="btn-refresh-icon" data-action="refresh" title="Обновить">'
    + icon('refresh-cw', 16)
    + '</button>'
    + '<button class="btn-theme btn-theme-mob" data-action="toggle-theme" title="Переключить тему">'
    + (isDark()
      ? icon('sun', 14)
      : icon('moon', 14))
    + '</button>'
    + '</div>'
    + '<div class="filters-right">'
    + '<span class="ws-indicator ' + (wsConnected ? 'connected' : 'disconnected') + '" title="' + (wsConnected ? 'WebSocket: подключен — данные обновляются в реальном времени' : 'WebSocket: отключен — переподключение...') + '"></span>'
    + '<button class="btn-settings" data-action="open-settings" title="Настройки: код синхронизации и Telegram">' + icon('bell', 15) + '</button>'
    + '<button class="btn-tv" data-action="tv" title="TV режим — сетка 6 графиков">TV</button>'
    + '<button class="btn-theme" data-action="toggle-theme" title="Переключить тему">'
    + (isDark()
      ? icon('sun', 14)
      : icon('moon', 14))
    + '</button>'
    + '</div>'
    + '</div></div>'
    + '<div class="metrics">'
    + '<div class="metric-card"><div class="label">Монет в фильтре</div><div class="value">' + coins.length + '</div></div>'
    + '<div class="metric-card"><div class="label">Максимальный рост</div><div class="value green">+' + maxRise + '%</div></div>'
    + '<div class="metric-card"><div class="label">Максимальный объем</div><div class="value">' + (function () { if (mv >= 1e9) return '$' + (mv / 1e9).toFixed(1) + 'B'; if (mv >= 1e6) return '$' + (mv / 1e6).toFixed(1) + 'M'; return '$' + (mv / 1e3).toFixed(1) + 'K'; })() + '</div></div>'
    + '<div class="metric-card"><div class="label">Bullish AI</div><div class="value green">' + bc + '</div></div>'
    + '<div class="metric-card ms-card" id="ms-card" data-action="open-ms">'
    + msCardInner()
    + '</div>'
    + '</div>'
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
