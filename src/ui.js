import { state, filteredCoins, STABLE_SYMBOLS, SCREENER_EXCLUDE } from './state.js';
import { fmt, fmtPrice, escHtml, signalLabel, icon } from './utils.js';
import { on } from './events.js';
import { analyzeCoinBySymbol, fetchChartData, wsConnected, sendWS, API_BASE, applyLivePriceUpdates } from './api.js';

// ── Utility ────────────────────────────────────────────────────────────────

function natrDisplay(symbol) {
  var nd = state.natrData[symbol];
  if (!nd || nd === 'loading' || nd === 'error') return { val: '—', cls: 'dim' };
  var v = nd.value, cls = v >= 1.8 ? 'natr-hi' : '';
  return { val: v.toFixed(2), cls: cls };
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderCard(coin) {
  var cache = state.analysisCache[coin.symbol];
  var hasA = cache && cache.status === 'ok', isE = cache && cache.status === 'error';
  var signal = hasA ? cache.result.signal : null;
  var tf = state.chartTF[coin.symbol] || '5m';
  var change = (coin.open_24h > 0 && coin.current_price > 0)
    ? (coin.current_price - coin.open_24h) / coin.open_24h * 100
    : (coin.price_change_percentage_24h || 0);
  var natr = natrDisplay(coin.symbol);

  var badge = '';
  if (isE) badge = '<button class="btn-retry" data-action="analyze" data-sym="' + coin.symbol + '">Retry</button>';
  else if (hasA) badge = '<span class="signal-badge ' + signal + '" data-action="open-analysis" data-sym="' + coin.symbol + '">' + signalLabel(signal) + '</span>';
  else badge = '<button class="btn-icon analyze" data-action="analyze" data-sym="' + coin.symbol + '">' + icon('zap', 16) + '</button>';

  var tfPicker = '<div class="tf-picker">' +
    '<button class="pill" data-action="tf-pick" data-sym="' + coin.symbol + '">' + tf + '</button>' +
    '<div class="tf-dd dropdown">' +
    ['1m', '5m', '15m', '30m', '1h', '4h', '1d'].map(function (t) {
      return '<button class="' + (t === tf ? 'active' : '') + '" data-action="tf-opt" data-sym="' + coin.symbol + '" data-tf="' + t + '">' + t + '</button>';
    }).join('') +
    '</div>' +
    '</div>';

  var statsHtml = '<div class="card-chart-stats">' +
    '<span class="stat-val ' + (change >= 0 ? 'up' : 'dn') + '" title="24h change">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%</span>' +
    '<span class="stat-val ' + natr.cls + '" title="NATR — volatility (5m × 30 candles)">' + natr.val + '</span>' +
    '<span class="stat-val" title="24h trading volume">' + fmt(coin.total_volume).replace('$', '') + '</span>' +
    '</div>';

  return '<div class="coin-card' + (signal ? ' ' + signal : '') + '" data-sym="' + coin.symbol + '">' +
    '<div class="card-head">' +
    '<div class="card-sym-row">' +
    '<span class="card-sym" data-action="copy-sym" data-sym="' + coin.symbol + '" title="Copy ticker">' + coin.symbol.toUpperCase() + '</span>' +
    statsHtml +
    '</div>' +
    '<div class="card-head-right">' +
    badge +
    tfPicker +
    '<button class="btn-icon star' + (isInBriefing(coin.symbol) ? ' active' : '') + '" data-action="toggle-briefing" data-sym="' + coin.symbol + '" title="' + (isInBriefing(coin.symbol) ? 'Remove from watchlist' : 'Add to watchlist') + '">' + icon('star', 16) + '</button>' +
    '<button class="btn-icon" data-action="expand" data-sym="' + coin.symbol + '" title="Fullscreen">' + icon('maximize', 16) + '</button>' +
    '</div>' +
    '</div>' +
    '<div class="chart-container" id="chart-' + coin.symbol + '"></div>' +
    '</div>';
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
  var hasA = cache && cache.status === 'ok', isE = cache && cache.status === 'error';
  var signal = hasA ? cache.result.signal : null;
  var tag = 'span';
  var html = '';
  if (isE) { tag = 'button'; html = 'Retry'; }
  else if (hasA) { tag = 'span'; html = signalLabel(signal); }
  else { tag = 'button'; html = '' + icon('zap', 16) + ''; }

  var newEl = document.createElement(tag);
  if (isE) { newEl.className = 'btn-retry'; newEl.dataset.action = 'analyze'; newEl.dataset.sym = symbol; }
  else if (hasA) { newEl.className = 'signal-badge ' + signal; newEl.dataset.action = 'open-analysis'; newEl.dataset.sym = symbol; }
  else { newEl.className = 'btn-icon analyze'; newEl.dataset.action = 'analyze'; newEl.dataset.sym = symbol; }
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

var _charts = {}, _fullSeries = {}, _volSeries = {}, _rulers = {}, _dragging = null, _alertDragging = null, _alertDragMoved = false, _alertDragBtn = 2;
var _cardObserver = null;
var _fvChart = null, _fvSeries = null, _fvVolSeries = null, _fvSym = null, _fvLastVol = 0;
var _isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
// Fullscreen popups only on narrow viewports (phones + small tablets).
// Checked at open-time so orientation changes are handled correctly.
function _useFullscreenPopup() { return window.innerWidth < 768; }

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

export function setUserId(id) {
  _userId = id;
  _briefingUserCode = id; // briefing section uses its own var
}

export function setUserEmail(email) { _userEmail = email; }

export function setUserAvatar(av) {
  if (!av) {
    _userAvatar = null;
    localStorage.removeItem('pa_avatar');
  } else {
    _userAvatar = av;
    localStorage.setItem('pa_avatar', av);
  }
  // Desktop: avatar button in topbar-actions
  var btn = document.getElementById('avatar-btn');
  var iconSpan = document.getElementById('avatar-btn-icon');
  if (iconSpan) {
    iconSpan.innerHTML = av ? av : icon('user-round', 16);
    if (btn) btn.classList.toggle('has-emoji', !!av);
  }
  // Mobile: logo button in topbar
  var logoBtn = document.getElementById('topbar-logo-btn');
  if (logoBtn) {
    logoBtn.classList.toggle('mob-has-avatar', !!av);
    var mobAv = logoBtn.querySelector('.logo-mob-av');
    if (mobAv) mobAv.textContent = av || '';
  }
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
    var local = JSON.parse(localStorage.getItem('pa_levels') || '{}');
    Object.keys(local).forEach(function (sym) {
      _levels[sym.toLowerCase()] = local[sym].map(function (p) { return { price: p, line: null }; });
    });
  } catch (e) {}
  if (_userId) fetchServerLevels();
}


var _AVATAR_PRESETS = ['🐋','🚀','🎯','🦊','🌙','💎','🔥','⚡','🐂','🐻','🧠','👾'];

export function showAccountModal() {
  if (document.getElementById('account-overlay')) return;


  var el = document.createElement('div');
  el.id = 'account-overlay';
  el.className = 'account-overlay overlay';
  el.innerHTML =
    '<div class="account-panel">'
    + '<div class="popup-header"><span class="popup-title">Account settings</span><button class="btn-topbar" id="account-close">' + icon('x', 14) + '</button></div>'
    + '<div class="acc-tabs">'
      + '<button class="nav-pill active" data-tab="profile">Profile</button>'
      + '<button class="nav-pill" data-tab="integrations">Integrations</button>'
      + '<button class="nav-pill" data-tab="security">Security</button>'
    + '</div>'
    + '<div class="account-body">'

      + '<div class="acc-pane" id="acc-pane-profile">'

        + '<div class="acc-avatar-card">'
          + '<div class="acc-avatar-inner">'
            + '<span id="acc-avatar-display">'
              + (_userAvatar ? _userAvatar : _LOGO_SVG)
            + '</span>'
            + '<div class="acc-avatar-info">'
              + '<span class="acc-username">' + escHtml((_userEmail || '').split('@')[0] || 'Profile') + '</span>'
              + '<button id="acc-avatar-change-btn" class="acc-row-edit">Change</button>'
            + '</div>'
          + '</div>'
        + '</div>'

        + '<div class="avatar-grid acc-avatar-collapsed" id="account-avatar-grid">'
          + '<button class="avatar-preset avatar-logo-btn' + (!_userAvatar ? ' selected' : '') + '" data-preset="" title="Default">' + _LOGO_SVG + '</button>'
          + _AVATAR_PRESETS.map(function (p) {
              return '<button class="avatar-preset' + (p === _userAvatar ? ' selected' : '') + '" data-preset="' + p + '">' + p + '</button>';
            }).join('')
        + '</div>'

        + '<div class="acc-row" id="acc-tz-row">'
          + '<div class="acc-row-left">'
            + '<div class="acc-row-label">Timezone</div>'
            + '<div class="acc-row-val" id="acc-tz-current"></div>'
          + '</div>'
          + '<button id="acc-tz-change-btn" class="acc-row-edit">Change</button>'
        + '</div>'
        + '<div id="acc-tz-editor" class="acc-editor">'
          + '<div class="ds-select" id="acc-tz-select"><button class="ds-select-btn" type="button"><span class="ds-select-val"></span><span class="ds-select-chevron">' + icon('chevron-down',14) + '</span></button><div class="ds-select-dd"></div></div>'
          + '<div class="acc-field-err" id="acc-tz-msg"></div>'
          + '<div class="acc-bin-actions">'
            + '<button class="btn-cta" id="acc-tz-save">Save</button>'
          + '</div>'
        + '</div>'


        + '<button class="btn-cta danger" id="acc-logout-btn">Sign out</button>'

      + '</div>'

      + '<div class="acc-pane" id="acc-pane-integrations">'

        + '<div class="acc-row" id="acc-bin-row-hd">'
          + '<div class="acc-row-left">'
            + '<div class="acc-row-label">BINANCE API</div>'
            + '<span id="acc-bin-val" class="acc-row-val"></span>'
          + '</div>'
          + '<div id="acc-bin-btn-wrap"></div>'
        + '</div>'
        + '<div id="acc-bin-form">'
          + '<div style="margin-bottom:var(--v-sm);padding:var(--space-5) var(--space-6);background:var(--fog);border-radius:var(--radius-md);font-size:var(--text-xs);color:var(--graphite);line-height:1.5;">'
            + '<strong style="color:var(--ink-deep);">Read-only keys only.</strong> We only accept keys with no trading or withdrawal permissions. Your funds stay safe — the key is used solely to display your PnL on the watchlist.'
          + '</div>'
          + '<div style="margin-bottom:var(--v-sm);">'
            + '<div class="acc-row-label">API Key</div>'
            + '<input type="text" id="acc-bin-key" placeholder="Paste API key..." autocomplete="off" class="ds-input">'
            + '<div class="acc-field-err" id="acc-bin-err-key"></div>'
          + '</div>'
          + '<div>'
            + '<div class="acc-row-label">Secret Key</div>'
            + '<input type="password" id="acc-bin-sec" placeholder="Paste Secret key..." autocomplete="off" class="ds-input">'
            + '<div class="acc-field-err" id="acc-bin-err-sec"></div>'
          + '</div>'
          + '<div class="acc-field-err" id="acc-bin-err"></div>'
          + '<div class="acc-bin-actions">'
            + '<button class="btn-cta" id="acc-bin-save">Save</button>'
            + '<button id="acc-bin-del" class="acc-delete-cancel">Delete</button>'
          + '</div>'
        + '</div>'

        + '<div class="acc-row" id="acc-tg-row">'
          + '<div class="acc-row-left">'
            + '<div class="acc-row-label">TELEGRAM</div>'
            + '<div id="acc-tg-badge"></div>'
          + '</div>'
          + '<div id="acc-tg-btn-wrap"></div>'
        + '</div>'
        + '<div id="acc-tg-link-area"></div>'

      + '</div>'

      + '<div class="acc-pane" id="acc-pane-security">'

        + '<div class="acc-row" id="acc-email-row">'
          + '<div class="acc-row-left">'
            + '<div class="acc-row-label">Email</div>'
            + '<div class="acc-row-val" id="acc-email-display">' + escHtml(_userEmail || '') + '</div>'
          + '</div>'
          + '<button id="acc-email-change-btn" class="acc-row-edit">Change</button>'
        + '</div>'
        + '<div id="acc-email-step1" class="acc-editor"></div>'
        + '<div id="acc-email-step2" class="acc-editor">'
          + '<input type="email" id="acc-email-new1" placeholder="New email" autocomplete="off" class="ds-input">'
          + '<div class="acc-field-err" id="acc-email-err-1"></div>'
          + '<input type="email" id="acc-email-new2" placeholder="Confirm new email" autocomplete="off" class="ds-input" style="margin-top:var(--v-sm)">'
          + '<div class="acc-field-err" id="acc-email-err-2"></div>'
          + '<div class="acc-bin-actions">'
            + '<button class="btn-cta" id="acc-email-s2-btn">Send code</button>'
          + '</div>'
        + '</div>'
        + '<div id="acc-email-step3" class="acc-editor">'
          + '<div id="acc-email-s3-hint"></div>'
          + '<input type="text" id="acc-email-code" inputmode="numeric" maxlength="6" placeholder="Code from email" autocomplete="one-time-code" class="ds-input">'
          + '<div class="acc-field-err" id="acc-email-step3-err"></div>'
          + '<div class="acc-bin-actions">'
            + '<button class="btn-cta" id="acc-email-s3-btn">Confirm</button>'
          + '</div>'
        + '</div>'
        + '<div class="acc-field-err" id="acc-email-msg"></div>'

        + '<div id="acc-pass-change-section"></div>'

        + '<div class="acc-security-actions">'
          + '<button class="btn-cta" id="acc-revoke-btn">Sign out other devices</button>'
          + '<div class="acc-field-err" id="acc-revoke-msg"></div>'
        + '</div>'

        + '<div id="acc-delete-wrap">'
          + '<button class="acc-delete-btn" id="acc-delete-btn">Delete account</button>'
          + '<div id="acc-delete-confirm">'
            + '<div id="acc-delete-hint">Type "delete account" to confirm:</div>'
            + '<input type="text" id="acc-delete-input" placeholder="delete account" autocomplete="off" class="ds-input">'
            + '<div class="acc-bin-actions">'
              + '<button class="btn-cta danger" id="acc-delete-yes" disabled>Delete account</button>'
              + '<button class="acc-delete-cancel" id="acc-delete-no">Cancel</button>'
            + '</div>'
          + '</div>'
        + '</div>'
      + '</div>'

    + '</div>'
  + '</div>';

  document.body.appendChild(el);
  el.classList.add('open');
  lockScroll();

  el.querySelectorAll('.acc-tabs .nav-pill').forEach(function (tab) {
    tab.addEventListener('click', function () {
      el.querySelectorAll('.acc-tabs .nav-pill').forEach(function (t) { t.classList.remove('active'); });
      el.querySelectorAll('.acc-pane').forEach(function (p) { p.style.display = 'none'; });
      tab.classList.add('active');
      var pane = document.getElementById('acc-pane-' + tab.dataset.tab);
      if (pane) pane.style.display = 'flex';
    });
  });

  document.getElementById('acc-avatar-change-btn').addEventListener('click', function () {
    var grid = document.getElementById('account-avatar-grid');
    var collapsed = grid.classList.toggle('acc-avatar-collapsed');
    this.textContent = collapsed ? 'Change' : 'Hide';
  });

  function _renderAvatarCircle() {
    var d = document.getElementById('acc-avatar-display');
    if (!d) return;
    d.innerHTML = _userAvatar
      ? _userAvatar
      : _LOGO_SVG;
  }

  function renderTgStatus(connected) {
    var badge = document.getElementById('acc-tg-badge');
    var btnWrap = document.getElementById('acc-tg-btn-wrap');
    var linkArea = document.getElementById('acc-tg-link-area');
    if (!badge || !btnWrap) return;
    if (connected) {
      badge.innerHTML = '<span class="tg-connected">' + icon('check-circle', 14) + ' Connected</span>';
      btnWrap.innerHTML = '<button class="btn-cta danger" id="acc-tg-disconnect">Disconnect</button>';
      if (linkArea) linkArea.style.display = 'none';
      document.getElementById('acc-tg-disconnect').addEventListener('click', function () {
        var btn = this;
        btn.disabled = true; btn.classList.add('btn-loading');
        fetch(API_BASE + '/api/account', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ action: 'tg-disconnect' }),
        })
          .then(function () { renderTgStatus(false); })
          .catch(function () { btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = 'Disconnect'; });
      });
      return;
    }
    badge.innerHTML = '';
    btnWrap.innerHTML = '<button class="btn-cta" id="acc-tg-btn">Connect</button>';
    document.getElementById('acc-tg-btn').addEventListener('click', function () {
      var btn = document.getElementById('acc-tg-btn');
      btn.disabled = true; btn.classList.add('btn-loading');
      fetch(API_BASE + '/api/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'tg-link-start' }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.url) { btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = 'Connect'; return; }
          if (linkArea) {
            linkArea.style.display = 'block';
            linkArea.innerHTML =
              '<p class="tg-hint">Open the bot and click Start:</p>'
              + '<a class="btn-cta" href="' + d.url + '" target="_blank" rel="noopener">Open bot →</a>'
              + '<p class="tg-hint tg-waiting">Waiting for connection…</p>';
          }
          btnWrap.innerHTML = '';
          var polls = 0;
          var t = setInterval(function () {
            if (++polls > 150) { clearInterval(t); return; }
            fetch(API_BASE + '/api/account', { credentials: 'include' })
              .then(function (r) { return r.json(); })
              .then(function (d2) { if (d2.tgConnected) { clearInterval(t); renderTgStatus(true); } })
              .catch(function () {});
          }, 2000);
        })
        .catch(function () { btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = 'Connect'; });
    });
  }

  function bindBinanceSaveBtn(btnLabel, onSuccess) {
    var btn = document.getElementById('acc-bin-save');
    if (!btn) return;
    btn.onclick = function () {
      var key = (document.getElementById('acc-bin-key').value || '').trim();
      var sec = (document.getElementById('acc-bin-sec').value || '').trim();
      var err = document.getElementById('acc-bin-err');
      var errKey = document.getElementById('acc-bin-err-key');
      var errSec = document.getElementById('acc-bin-err-sec');
      err.textContent = '';
      if(errKey) errKey.textContent = '';
      if(errSec) errSec.textContent = '';
      document.getElementById('acc-bin-key').classList.remove('error');
      document.getElementById('acc-bin-sec').classList.remove('error');
      if (!key) {
        if(errKey) errKey.textContent = 'Enter API key';
        document.getElementById('acc-bin-key').classList.add('error');
        return;
      }
      if (!sec) {
        if(errSec) errSec.textContent = 'Enter Secret key';
        document.getElementById('acc-bin-sec').classList.add('error');
        return;
      }
      btn.disabled = true; btn.classList.add('btn-loading');
      fetch(API_BASE + '/api/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'save-binance', apiKey: key, apiSecret: sec }),
      })
        .then(function (r) {
          return r.json().then(function (d) {
            if (!r.ok) throw new Error(d.error || 'Server error');
            return d;
          });
        })
        .then(function () {
          btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = btnLabel;
          if (onSuccess) onSuccess();
        })
        .catch(function (e) {
          err.textContent = e.message || 'Network error';
          btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = btnLabel;
        });
    };
  }

  function renderBinanceStatus(connected, apiKey) {
    var val = document.getElementById('acc-bin-val');
    var btnWrap = document.getElementById('acc-bin-btn-wrap');
    var form = document.getElementById('acc-bin-form');
    if (!val || !btnWrap || !form) return;

    function _afterSave() {
      fetch(API_BASE + '/api/account', { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (d) { renderBinanceStatus(true, d.binanceKey || ''); })
        .catch(function () { renderBinanceStatus(true, apiKey || ''); });
    }

    if (connected) {
      val.textContent = '••••••' + (apiKey ? apiKey.slice(0, 4) + '...' + apiKey.slice(-4) : '');
      btnWrap.innerHTML = '<button class="acc-row-edit" id="acc-bin-upd">Change</button>';
      form.style.display = 'none';
      var delBtn = document.getElementById('acc-bin-del');
      if (delBtn) delBtn.style.display = 'none';

      document.getElementById('acc-bin-upd').addEventListener('click', function () {
        var upd = this;
        if (form.style.display === 'block') {
          form.style.display = 'none';
          upd.textContent = 'Change';
          if (delBtn) delBtn.style.display = 'none';
          document.getElementById('acc-bin-err').textContent = '';
        } else {
          document.getElementById('acc-bin-key').value = '';
          document.getElementById('acc-bin-sec').value = '';
          document.getElementById('acc-bin-err').textContent = '';
          form.style.display = 'block';
          upd.textContent = 'Cancel';
          if (delBtn) delBtn.style.display = 'inline-flex';
          bindBinanceSaveBtn('Save', _afterSave);
        }
      });

      if (delBtn) {
        delBtn.onclick = function () {
          if (!confirm('Disconnect Binance API?')) return;
          delBtn.disabled = true; delBtn.classList.add('btn-loading');
          fetch(API_BASE + '/api/account', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ action: 'delete-binance' }),
          })
            .then(function (r) { if (!r.ok) throw new Error('Server error'); renderBinanceStatus(false); })
            .catch(function () { delBtn.disabled = false; delBtn.classList.remove('btn-loading'); });
        };
      }

    } else {
      val.textContent = '';
      btnWrap.innerHTML = '';
      form.style.display = 'block';
      var cf3 = document.getElementById('acc-bin-del');
      if (cf3) cf3.style.display = 'none';
      bindBinanceSaveBtn('Save', _afterSave);
    }
  }

  // Email change section
  var _emailHasPassword = false;
  var _emailTgConnected = false;
  var _emailStep = 0; // 0=closed, 1=verify-identity, 2=new-email, 3=confirm-code
  var _emailNewPending = null;

  function _emailMsg(text, isSuccess) {
    var el = document.getElementById('acc-email-msg');
    el.textContent = text;
    el.style.color = isSuccess ? 'var(--bullish)' : 'var(--danger)';
  }

  function _emailErr(targetId, msg, inputId) {
    ['acc-email-step1-err','acc-email-err-1','acc-email-err-2','acc-email-step3-err'].forEach(function(id){
      var e=document.getElementById(id); if(e) e.textContent='';
    });
    ['acc-email-pass','acc-email-tg-code','acc-email-new1','acc-email-new2','acc-email-code'].forEach(function(id){
      var e=document.getElementById(id); if(e) e.classList.remove('error');
    });
    if(targetId){var e=document.getElementById(targetId); if(e) e.textContent=msg||'';}
    if(inputId){var e=document.getElementById(inputId); if(e) e.classList.add('error');}
  }

  function _emailShowStep(n) {
    [1, 2, 3].forEach(function (i) {
      var el = document.getElementById('acc-email-step' + i);
      if (el) el.style.display = (i === n) ? 'block' : 'none';
    });
    _emailErr(null, '');
    _emailStep = n;
    if (!n) {
      document.getElementById('acc-email-msg').textContent = '';
      document.getElementById('acc-email-change-btn').textContent = 'Change';
    }
  }

  function _emailBuildStep1() {
    var s1 = document.getElementById('acc-email-step1');
    if (_emailHasPassword) {
      s1.innerHTML = '<input type="password" id="acc-email-pass" placeholder="Current password" autocomplete="current-password" class="ds-input">'
        + '<div class="acc-field-err" id="acc-email-step1-err"></div>'
        + '<div class="acc-bin-actions"><button class="btn-cta" id="acc-email-s1-btn">Continue</button></div>';
    } else if (_emailTgConnected) {
      s1.innerHTML = '<button class="btn-cta" id="acc-email-send-tg-btn">Get code via Telegram</button>'
        + '<div id="acc-email-tg-code-wrap">'
          + '<input type="text" id="acc-email-tg-code" placeholder="Telegram code" inputmode="numeric" maxlength="6" class="ds-input" style="margin-top:var(--v-sm)">'
          + '<div class="acc-field-err" id="acc-email-step1-err"></div>'
          + '<div class="acc-bin-actions"><button class="btn-cta" id="acc-email-s1-btn">Continue</button></div>'
        + '</div>';
      document.getElementById('acc-email-send-tg-btn').addEventListener('click', function () {
        var btn = this; btn.disabled = true; btn.classList.add('btn-loading');
        fetch(API_BASE + '/api/account', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ action: 'email-change-send-tg-code' }),
        }).then(function (r) { return r.json(); }).then(function (d) {
          btn.disabled = false; btn.classList.remove('btn-loading');
          if (d.ok) {
            document.getElementById('acc-email-tg-code-wrap').style.display = 'block';
            btn.textContent = 'Send again';
            _emailErr(null, '');
          } else {
            _emailErr('acc-email-step1-err', d.error || 'Error');
          }
        }).catch(function () { btn.disabled = false; btn.classList.remove('btn-loading'); _emailErr('acc-email-step1-err', 'Network error'); });
      });
    } else {
      s1.innerHTML = '<div style="font-size:var(--text-sm);color:var(--graphite)">To change email, connect Telegram in the Integrations tab</div>';
    }
    // Delegate s1-btn click after DOM is built
    s1.addEventListener('click', function (e) {
      if (e.target.id !== 'acc-email-s1-btn') return;
      var btn = e.target;
      var password = (document.getElementById('acc-email-pass') || {}).value || '';
      var tgCode = ((document.getElementById('acc-email-tg-code') || {}).value || '').trim();
      if (!password && !tgCode) { _emailErr('acc-email-step1-err', 'Enter password or code', password ? 'acc-email-pass' : 'acc-email-tg-code'); return; }
      btn.disabled = true; btn.classList.add('btn-loading');
      var body = { action: 'email-change-verify-identity' };
      if (password) body.password = password;
      if (tgCode) body.tgCode = tgCode;
      fetch(API_BASE + '/api/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); }).then(function (d) {
        btn.disabled = false; btn.classList.remove('btn-loading');
        if (d.ok) {
          _emailErr(null, '');
          _emailShowStep(2);
          document.getElementById('acc-email-new1').focus();
        } else {
          _emailErr('acc-email-step1-err', d.error || 'Error');
        }
      }).catch(function () { btn.disabled = false; btn.classList.remove('btn-loading'); _emailErr('acc-email-step1-err', 'Network error'); });
    });
  }

  // Block paste on confirm-email field
  document.getElementById('acc-email-new2').addEventListener('paste', function (e) { e.preventDefault(); });

  document.getElementById('acc-email-change-btn').addEventListener('click', function () {
    if (_emailStep > 0) {
      _emailShowStep(0);
    } else {
      document.getElementById('acc-email-msg').textContent = '';
      this.textContent = 'Cancel';
      _emailBuildStep1();
      _emailShowStep(1);
    }
  });

  document.getElementById('acc-email-s2-btn').addEventListener('click', function () {
    var e1 = (document.getElementById('acc-email-new1').value || '').trim().toLowerCase();
    var e2 = (document.getElementById('acc-email-new2').value || '').trim().toLowerCase();
    if (!e1 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e1)) { _emailErr('acc-email-err-1', 'Enter a valid email', 'acc-email-new1'); return; }
    if (e1 !== e2) { _emailErr('acc-email-err-2', 'Emails do not match', 'acc-email-new2'); return; }
    if (e1 === (_userEmail || '').toLowerCase()) { _emailErr('acc-email-err-1', 'This is already your email', 'acc-email-new1'); return; }
    var btn = this; btn.disabled = true; btn.classList.add('btn-loading');
    fetch(API_BASE + '/api/account', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ action: 'email-change-request', newEmail: e1 }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      btn.disabled = false; btn.classList.remove('btn-loading');
      if (d.ok) {
        _emailNewPending = e1;
        document.getElementById('acc-email-s3-hint').textContent =
          'Code sent to ' + e1 + '. A cancellation link was sent to ' + (_userEmail || 'your old address') + '.';
        _emailErr(null, '');
        _emailShowStep(3);
        document.getElementById('acc-email-code').focus();
      } else {
        _emailErr('acc-email-err-2', d.error || 'Error');
      }
    }).catch(function () { btn.disabled = false; btn.classList.remove('btn-loading'); _emailErr('acc-email-err-2', 'Network error'); });
  });

  document.getElementById('acc-email-s3-btn').addEventListener('click', function () {
    var code = (document.getElementById('acc-email-code').value || '').trim();
    if (!code || code.length < 6) { _emailErr('acc-email-step3-err', 'Enter the 6-digit code', 'acc-email-code'); return; }
    var btn = this; btn.disabled = true; btn.classList.add('btn-loading');
    fetch(API_BASE + '/api/account', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ action: 'email-change-confirm', code: code }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      btn.disabled = false; btn.classList.remove('btn-loading');
      if (d.ok) {
        _userEmail = d.newEmail;
        document.getElementById('acc-email-display').textContent = d.newEmail;
        _emailShowStep(0);
        _emailMsg('Email changed successfully', true);
      } else {
        _emailErr('acc-email-step3-err', d.error || 'Error');
      }
    }).catch(function () { btn.disabled = false; btn.classList.remove('btn-loading'); _emailErr('acc-email-step3-err', 'Network error'); });
  });

  // Timezone section
  var _TZ_LIST = [
    ['Pacific/Honolulu',    'UTC−10  Hawaii'],
    ['America/Anchorage',   'UTC−9   Alaska'],
    ['America/Los_Angeles', 'UTC−8/−7  Los Angeles, Vancouver'],
    ['America/Denver',      'UTC−7/−6  Denver'],
    ['America/Chicago',     'UTC−6/−5  Chicago, Mexico City'],
    ['America/New_York',    'UTC−5/−4  New York, Toronto'],
    ['America/Sao_Paulo',   'UTC−3     São Paulo'],
    ['Atlantic/Reykjavik',  'UTC+0     Reykjavik'],
    ['Europe/London',       'UTC+0/+1  London'],
    ['Europe/Paris',        'UTC+1/+2  Berlin, Paris, Warsaw'],
    ['Europe/Athens',       'UTC+2/+3  Athens, Helsinki, Riga'],
    ['Europe/Moscow',       'UTC+3     Moscow, Minsk'],
    ['Asia/Dubai',          'UTC+4     Dubai, Tbilisi'],
    ['Asia/Karachi',        'UTC+5     Karachi, Tashkent'],
    ['Asia/Kolkata',        'UTC+5:30  Mumbai, Delhi'],
    ['Asia/Almaty',         'UTC+6     Almaty'],
    ['Asia/Bangkok',        'UTC+7     Bangkok, Jakarta'],
    ['Asia/Singapore',      'UTC+8     Singapore, Hong Kong, Beijing'],
    ['Asia/Seoul',          'UTC+9     Seoul, Tokyo'],
    ['Australia/Sydney',    'UTC+10/+11  Sydney'],
    ['Pacific/Auckland',    'UTC+12/+13  Auckland'],
  ];
  var _autoTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  var _tzEl = document.getElementById('acc-tz-select');
  var _tzDd = _tzEl.querySelector('.ds-select-dd');
  var _tzValEl = _tzEl.querySelector('.ds-select-val');
  var _tzSel = (function () {
    var _v = '';
    function _makeItem(opt) {
      var item = document.createElement('div');
      item.className = 'ds-select-item';
      item.dataset.value = opt.value;
      item.textContent = opt.textContent;
      item.addEventListener('click', function () {
        _v = opt.value;
        _tzValEl.textContent = opt.textContent;
        _tzDd.querySelectorAll('.ds-select-item').forEach(function (i) { i.classList.toggle('selected', i.dataset.value === _v); });
        _tzEl.classList.remove('open');
      });
      return item;
    }
    _tzEl.querySelector('.ds-select-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      _tzEl.classList.toggle('open');
    });
    document.addEventListener('click', function () { _tzEl.classList.remove('open'); });
    return {
      get value() { return _v; },
      set value(v) {
        _v = v;
        var found = _tzDd.querySelector('[data-value="' + v + '"]');
        _tzValEl.textContent = found ? found.textContent : v;
        _tzDd.querySelectorAll('.ds-select-item').forEach(function (i) { i.classList.toggle('selected', i.dataset.value === v); });
      },
      appendChild: function (opt) { _tzDd.appendChild(_makeItem(opt)); },
      insertBefore: function (opt) { _tzDd.insertBefore(_makeItem(opt), _tzDd.firstChild); }
    };
  })();
  var _tzCurrent = document.getElementById('acc-tz-current');
  var _tzRow = document.getElementById('acc-tz-row');
  var _tzEditor = document.getElementById('acc-tz-editor');

  function _tzSetDisplay(tz, source) {
    _tzCurrent.textContent = tz + ' · ' + source;
  }
  _tzSetDisplay(_autoTz, 'auto-detect');

  // Populate select
  _TZ_LIST.forEach(function (item) {
    var opt = document.createElement('option');
    opt.value = item[0]; opt.textContent = item[1];
    _tzSel.appendChild(opt);
  });
  // Add auto-detected zone if not in list
  if (_autoTz && !_TZ_LIST.some(function (item) { return item[0] === _autoTz; })) {
    var _autoOpt = document.createElement('option');
    _autoOpt.value = _autoTz; _autoOpt.textContent = _autoTz;
    _tzSel.insertBefore(_autoOpt, _tzSel.firstChild);
  }
  _tzSel.value = _autoTz || _TZ_LIST[0][0];

  document.getElementById('acc-tz-change-btn').addEventListener('click', function () {
    if (_tzEditor.style.display === 'block') {
      _tzEditor.style.display = 'none';
      document.getElementById('acc-tz-msg').textContent = '';
      this.textContent = 'Change';
    } else {
      _tzEditor.style.display = 'block';
      this.textContent = 'Cancel';
    }
  });

  document.getElementById('acc-tz-save').addEventListener('click', function () {
    var btn = document.getElementById('acc-tz-save');
    var msg = document.getElementById('acc-tz-msg');
    btn.disabled = true; btn.classList.add('btn-loading'); msg.textContent = '';
    fetch(API_BASE + '/api/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action: 'save-timezone', timezone: _tzSel.value }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        _tzSetDisplay(_tzSel.value, 'saved');
        _tzEditor.style.display = 'none';
        document.getElementById('acc-tz-change-btn').textContent = 'Change';
      } else {
        msg.style.color = 'var(--danger)'; msg.textContent = d.error || 'Error';
      }
      btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = 'Save';
    }).catch(function () {
      msg.style.color = 'var(--danger)'; msg.textContent = 'Network error';
      btn.disabled = false; btn.classList.remove('btn-loading'); btn.textContent = 'Save';
    });
  });

  // Load saved avatar + tg status from server
  fetch(API_BASE + '/api/account', { credentials: 'include' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.avatar) {
        _userAvatar = d.avatar;
        el.querySelectorAll('.avatar-preset').forEach(function (btn) {
          btn.classList.toggle('selected', btn.dataset.preset === d.avatar);
        });
        _renderAvatarCircle();
      }
      if (d.timezone) {
        _tzSel.value = d.timezone;
        _tzSetDisplay(d.timezone, 'saved');
      }
      _emailHasPassword = !!d.hasPassword;
      _emailTgConnected = !!d.tgConnected;
      _buildPassSection();
      renderTgStatus(!!d.tgConnected);
      if (d.pendingEmailChange) {
        _emailNewPending = d.pendingEmailChange;
        document.getElementById('acc-email-change-btn').textContent = 'Cancel';
        document.getElementById('acc-email-s3-hint').textContent =
          'Code sent to ' + d.pendingEmailChange + '. A cancellation link was sent to ' + (_userEmail || 'your old address') + '.';
        _emailShowStep(3);
      }
      renderBinanceStatus(!!d.binanceConnected, d.binanceKey || '');
    })
    .catch(function () { renderTgStatus(false); renderBinanceStatus(false); });

  document.getElementById('account-avatar-grid').addEventListener('click', function (e) {
    var btn = e.target.closest('.avatar-preset');
    if (!btn) return;
    var picked = btn.dataset.preset; // '' = reset to logo
    if ((picked || null) === _userAvatar) return;
    el.querySelectorAll('.avatar-preset').forEach(function (b) {
      b.classList.toggle('selected', b === btn);
    });
    setUserAvatar(picked);
    _renderAvatarCircle();
    fetch(API_BASE + '/api/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action: 'save-avatar', avatar: picked }),
    }).catch(function () {});
  });

  document.getElementById('account-close').addEventListener('click', function () { unlockScroll(); el.remove(); });

  document.getElementById('acc-logout-btn').addEventListener('click', function () {
    fetch(API_BASE + '/auth/sign-out', { method: 'POST', credentials: 'include' })
      .finally(function () { window.location.replace('/login'); });
  });

  document.getElementById('acc-delete-btn').addEventListener('click', function () {
    document.getElementById('acc-delete-confirm').style.display = 'block';
    this.style.display = 'none';
    document.getElementById('acc-delete-input').focus();
  });
  document.getElementById('acc-delete-input').addEventListener('input', function () {
    document.getElementById('acc-delete-yes').disabled = this.value.toLowerCase() !== 'delete account';
  });
  document.getElementById('acc-delete-no').addEventListener('click', function () {
    document.getElementById('acc-delete-confirm').style.display = 'none';
    document.getElementById('acc-delete-input').value = '';
    document.getElementById('acc-delete-yes').disabled = true;
    document.getElementById('acc-delete-btn').style.display = '';
  });
  document.getElementById('acc-delete-yes').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true; btn.classList.add('btn-loading');
    fetch(API_BASE + '/auth/delete-user', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) {
        if (r.ok) {
          window.location.replace('/login');
        } else {
          btn.disabled = false; btn.classList.remove('btn-loading');
        }
      })
      .catch(function () { btn.disabled = false; btn.classList.remove('btn-loading'); });
  });

  document.getElementById('acc-revoke-btn').addEventListener('click', function () {
    var btn = document.getElementById('acc-revoke-btn');
    var msg = document.getElementById('acc-revoke-msg');
    btn.disabled = true;
    btn.classList.add('btn-loading');
    fetch(API_BASE + '/auth/revoke-other-sessions', {
      method: 'POST',
      credentials: 'include',
    })
      .then(function (r) {
        if (r.ok) {
          msg.style.color = 'var(--bullish)';
          msg.textContent = 'Done — all other devices signed out';
          btn.classList.remove('btn-loading'); btn.textContent = 'Sign out other devices';
          btn.disabled = false;
        } else {
          throw new Error('fail');
        }
      })
      .catch(function () {
        msg.style.color = '';
        msg.textContent = 'Error, please try again';
        btn.classList.remove('btn-loading'); btn.textContent = 'Sign out other devices';
        btn.disabled = false;
      });
  });

  function _buildPassSection() {
    var section = document.getElementById('acc-pass-change-section');
    if (!section) return;
    if (_emailHasPassword) {
      section.innerHTML =
        '<div class="acc-row" id="acc-pass-row">'
          + '<div class="acc-row-left">'
            + '<div class="acc-row-label">Password</div>'
            + '<div class="acc-row-val">••••••••</div>'
          + '</div>'
          + '<button class="acc-row-edit" id="acc-pass-change-btn">Change</button>'
        + '</div>'
        + '<div id="acc-pass-editor">'
          + '<input type="password" id="acc-pass-current" placeholder="Current password" autocomplete="current-password" class="ds-input">'
          + '<div class="acc-field-err" id="acc-pass-err-cur"></div>'
          + '<input type="password" id="acc-pass-new" placeholder="New password (min. 8 characters)" autocomplete="new-password" class="ds-input" style="margin-top:var(--v-sm)">'
          + '<div class="acc-field-err" id="acc-pass-err-new"></div>'
          + '<input type="password" id="acc-pass-confirm" placeholder="Confirm new password" autocomplete="new-password" class="ds-input" style="margin-top:var(--v-sm)">'
          + '<div class="acc-field-err" id="acc-pass-err-cfm"></div>'
          + '<div class="acc-bin-actions">'
            + '<button class="btn-cta" id="acc-pass-submit">Save</button>'
          + '</div>'
        + '</div>'
        + '<div class="acc-field-err" id="acc-pass-msg"></div>';

      function _passErr(field, msg) {
        ['cur','new','cfm'].forEach(function(f){
          var el=document.getElementById('acc-pass-err-'+f); if(el) el.textContent='';
          var inputId={cur:'acc-pass-current',new:'acc-pass-new',cfm:'acc-pass-confirm'}[f];
          var inp=document.getElementById(inputId); if(inp) inp.classList.remove('error');
        });
        if(field){
          var el=document.getElementById('acc-pass-err-'+field); if(el) el.textContent=msg||'';
          var inputId={cur:'acc-pass-current',new:'acc-pass-new',cfm:'acc-pass-confirm'}[field];
          var inp=document.getElementById(inputId); if(inp) inp.classList.add('error');
        }
      }

      document.getElementById('acc-pass-change-btn').addEventListener('click', function () {
        var editor = document.getElementById('acc-pass-editor');
        var msg = document.getElementById('acc-pass-msg');
        if (editor.style.display === 'block') {
          editor.style.display = 'none';
          _passErr(null, '');
          msg.textContent = '';
          this.textContent = 'Change';
        } else {
          editor.style.display = 'block';
          msg.textContent = '';
          this.textContent = 'Cancel';
          document.getElementById('acc-pass-current').focus();
        }
      });

      document.getElementById('acc-pass-submit').addEventListener('click', function () {
        var cur = document.getElementById('acc-pass-current').value;
        var nw  = document.getElementById('acc-pass-new').value;
        var cfm = document.getElementById('acc-pass-confirm').value;
        var msg = document.getElementById('acc-pass-msg');
        _passErr(null, '');
        if (!cur) { _passErr('cur', 'Enter current password'); return; }
        if (nw.length < 8) { _passErr('new', 'New password must be at least 8 characters'); return; }
        if (nw !== cfm) { _passErr('cfm', 'Passwords do not match'); return; }
        var btn = this; btn.disabled = true; btn.classList.add('btn-loading');
        fetch(API_BASE + '/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ currentPassword: cur, newPassword: nw, revokeOtherSessions: false }),
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) {
            btn.disabled = false; btn.classList.remove('btn-loading');
            if (res.ok) {
              document.getElementById('acc-pass-editor').style.display = 'none';
              document.getElementById('acc-pass-change-btn').textContent = 'Change';
              msg.style.color = 'var(--bullish)';
              msg.textContent = 'Password changed';
            } else {
              _passErr('cur', (res.d && res.d.message) || 'Error');
            }
          })
          .catch(function () {
            btn.disabled = false; btn.classList.remove('btn-loading');
            _passErr('cur', 'Network error');
          });
      });

    } else {
      section.innerHTML =
        '<button class="btn-cta" id="acc-reset-pass-btn">Send password reset link</button>'
        + '<div class="acc-field-err" id="acc-reset-pass-msg"></div>';

      document.getElementById('acc-reset-pass-btn').addEventListener('click', function () {
        var btn = this;
        var msg = document.getElementById('acc-reset-pass-msg');
        btn.disabled = true; btn.classList.add('btn-loading');
        fetch(API_BASE + '/auth/request-password-reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email: _userEmail, redirectTo: 'https://questtick.com/reset-password' }),
        }).then(function (r) {
          btn.classList.remove('btn-loading');
          if (r.ok) {
            msg.style.color = 'var(--bullish)';
            msg.textContent = 'If this address is registered, we sent a link to ' + _userEmail;
          } else {
            msg.style.color = ''; msg.textContent = 'Error, please try again';
            btn.disabled = false; return;
          }
          // 60-second cooldown
          var secs = 60;
          btn.textContent = 'Resend in ' + secs + 's';
          var t = setInterval(function () {
            secs--;
            if (secs <= 0) {
              clearInterval(t);
              btn.disabled = false;
              btn.textContent = 'Send password reset link';
            } else {
              btn.textContent = 'Resend in ' + secs + 's';
            }
          }, 1000);
        }).catch(function () {
          btn.classList.remove('btn-loading');
          msg.style.color = ''; msg.textContent = 'Network error';
          btn.disabled = false;
        });
      });
    }
  }

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
    lvl.line = s.createPriceLine({ price: lvl.price, color: getCSSVar('--primary'), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' });
  }
  if (_fvSeries && _fvSym === sym) {
    if (lvl.fvLine) { try { _fvSeries.removePriceLine(lvl.fvLine); } catch (e) {} }
    lvl.fvLine = _fvSeries.createPriceLine({ price: lvl.price, color: getCSSVar('--primary'), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' });
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

function updateClearBtn(sym) {
  var lCount = (_levels[sym] || []).length;
  var aCount = (_alerts[sym] || []).length;
  var show = (lCount || aCount) ? 'inline-flex' : 'none';
  document.querySelectorAll('.btn-icon.clear[data-sym="' + sym + '"]').forEach(function (btn) {
    btn.style.display = show;
  });
}

function updateLevelsBtn(sym) { updateClearBtn(sym); }

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
  try { localStorage.setItem('pa_alerts', JSON.stringify(alertsData())); } catch (e) {}
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
    var local = JSON.parse(localStorage.getItem('pa_alerts') || '{}');
    Object.keys(local).forEach(function (sym) {
      _alerts[sym.toLowerCase()] = local[sym].map(function (a) {
        return { id: a.id || _aNewId(), price: a.price, triggered: a.triggered || false, createdAt: a.createdAt };
      });
    });
  } catch (e) {}
  if (_userId) fetchServerAlerts();
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

// Форматирует Unix timestamp (секунды) в локальное время устройства
function _localTimeFmt(ts) {
  var d = new Date(ts * 1000);
  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var hh = d.getHours().toString().padStart(2, '0');
  var mm = d.getMinutes().toString().padStart(2, '0');
  return days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()] + ', ' + hh + ':' + mm;
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
}

export function setChartTF(symbol, tf) {
  state.chartTF[symbol] = tf;
  clearRuler(symbol);
  var card = document.querySelector('.coin-card[data-sym="' + symbol + '"]');
  if (card) {
    var pill = card.querySelector('.pill');
    if (pill) pill.textContent = tf;
    card.querySelectorAll('.tf-dd button').forEach(function (btn) {
      btn.className = btn.dataset.tf === tf ? 'active' : '';
    });
  }
  fetchChart(symbol, tf);
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
  var ids = ['fv-overlay', 'bp-popup', 'search-popup', 'analysis-overlay'];
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
      durStr = d < 60 ? Math.round(d) + 'с' : d < 3600 ? Math.round(d / 60) + 'м' : d < 86400 ? Math.floor(d / 3600) + 'ч ' + Math.round((d % 3600) / 60) + 'м' : Math.floor(d / 86400) + 'д ' + Math.floor((d % 86400) / 3600) + 'ч';
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
  var label = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) +
              ' ' + d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
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
  var alerts = _alerts[sym] || [];
  var tagW = 16, tagH = 18;
  alerts.forEach(function (a) {
    // During drag use exact mouse Y so icon tracks cursor without lag
    var y = (_alertDragging && _alertDragging.sym === sym && _alertDragging.alert === a && _alertDragging.dragY != null)
      ? _alertDragging.dragY
      : s.priceToCoordinate(a.price);
    if (y == null || y < 0 || y > cssH) return;
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
  _charts[sym] = chart; _fullSeries[sym] = s; _volSeries[sym] = vs;
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
    }
    requestAnimationFrame(function () { alertIconLoop(s); });
  }(sym));
  _attachChartEvents(sym, el);
  fetchChart(sym, state.chartTF[sym] || '5m');
}

function _destroyChartForSym(sym) {
  if (!_charts[sym]) return;
  try { _charts[sym].remove(); } catch (e) {}
  if (_levels[sym]) _levels[sym].forEach(function (l) { l.line = null; });
  (_alerts[sym] || []).forEach(function (a) { if (_aLines[a.id]) _aLines[a.id].card = null; });
  if (_rulers[sym] && _rulers[sym].canvas) { try { _rulers[sym].canvas.remove(); } catch (e) {} }
  delete _charts[sym]; delete _fullSeries[sym]; delete _volSeries[sym]; delete _rulers[sym];
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

// ── Analysis Popup ─────────────────────────────────────────────────────────

function _popupFullscreen(popup) {
  popup.style.position = 'fixed';
  popup.style.top = '0';
  popup.style.left = '0';
  popup.style.right = '0';
  popup.style.bottom = '0';
  popup.style.width = '100%';
  popup.style.maxWidth = '100%';
  popup.style.maxHeight = '100%';
  popup.style.borderRadius = '0';
  popup.style.border = 'none';
  popup.style.overscrollBehavior = 'contain';
}

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
    el.className = 'analysis-overlay popup';
    el.innerHTML =
      '<div class="popup-header"><span class="popup-title">Analysis</span>' +
        '<button class="btn-topbar" data-action="close-analysis">' + icon('x', 16) + '</button>' +
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
  var card = btn.closest('.coin-card');

  var popup = document.getElementById('analysis-overlay');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'analysis-overlay';
    popup.className = 'analysis-overlay popup';
    popup.innerHTML =
      '<div class="popup-header"><span class="popup-title">Analysis</span>' +
        '<button class="btn-topbar" data-action="close-analysis">' + icon('x', 16) + '</button>' +
      '</div>' +
      '<div class="popup-body">' +
        '<div class="ao-spinner"><span class="spinner"></span></div>' +
        '<div class="ao-content"></div>' +
      '</div>';
  }
  if (popup.parentNode) popup.parentNode.removeChild(popup);

  popup._popupCard = card;

  if (_useFullscreenPopup()) {
    document.body.appendChild(popup);
    _popupFullscreen(popup);
    popup.style.height = '100%';
    popup.style.overflowY = 'auto';
    popup.style.zIndex = '99999';
    popup._lockedScroll = true;
    lockScroll();
  } else if (card) {
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
    var viewportH = document.documentElement.clientHeight;
    var popupW = Math.min(380, viewportW - 16);
    var leftIfRightAligned = btnRect2.right - popupW;
    popup.style.position = 'fixed';
    popup.style.width = popupW + 'px';
    popup.style.maxWidth = 'none';
    if (btnRect2.bottom > viewportH / 2) {
      popup.style.top = 'auto';
      popup.style.bottom = (viewportH - btnRect2.top + 6) + 'px';
    } else {
      popup.style.top = (btnRect2.bottom + 6) + 'px';
      popup.style.bottom = 'auto';
    }
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
    var ts = cache.timestamp ? new Date(cache.timestamp).toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    var extIcon = icon('external-link', 11, 'vertical-align:middle;margin-left:3px;margin-bottom:1px');
    var newsBlock = '';
    if (r.news_summary) {
      var hasRealNews = r.news_url && !r.news_summary.toLowerCase().includes('not found');
      if (hasRealNews) {
        newsBlock = '<div class="ao-row"><a href="' + escHtml(r.news_url) + '" target="_blank" rel="noopener" style="color:var(--primary);font-weight:var(--font-bold);text-decoration:none;">News' + extIcon + '</a><br>' + escHtml(r.news_summary) + '</div>';
      } else {
        newsBlock = '<div class="ao-row">' + escHtml(r.news_summary) + '</div>';
      }
    }
    content.innerHTML = '<div style="font-size:var(--text-base);font-weight:var(--font-bold);color:var(--ink-deep);letter-spacing:0.4px;margin-bottom:var(--space-5);">' + escHtml(sym.toUpperCase()) + '</div>' +
      '<div class="ao-row"><strong>Catalyst:</strong> ' + escHtml(r.catalyst) + '</div>' +
      newsBlock +
      (ts ? '<div style="margin-top:var(--space-6);font-size:var(--text-xs);color:var(--graphite);font-weight:var(--font-semi);">Analysis: ' + ts + '</div>' : '') +
      '<button class="btn-cta" style="width:100%;margin-top:var(--space-8)" data-action="reanalyze" data-sym="' + sym + '">Re-analyze</button>';
  } else {
    content.innerHTML = '<div class="ao-err">' + (cache.error || 'Error') + '</div>' +
      '<button class="btn-cta" style="width:100%;margin-top:var(--space-8)" data-action="reanalyze" data-sym="' + sym + '">Re-analyze</button>';
  }
}


export { openTVMode, closeTVMode } from './tv.js';

// ── Metric cards live update ────────────────────────────────────────────────

function updateMetricCards() {
  var coins = filteredCoins();
  var sortCount = document.querySelector('.sort-coin-count');
  if (sortCount) sortCount.textContent = coins.length + ' coins';
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

var _LOGO_SVG = '<svg width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.25519 4.37208C5.8536 5.29726 5.97716 6.4839 6.59499 7.69065C6.75974 8.01245 6.9245 8.38453 6.95539 8.52532C7.04806 8.84712 7.52173 9.34993 8.3249 10.0036C8.82945 10.4058 9.06629 10.5265 9.45757 10.5768C10.8374 10.7578 10.7447 10.7176 10.58 11.0293C10.374 11.4316 9.79738 11.8238 8.57203 12.407C7.9748 12.6886 7.39816 13.0205 7.29519 13.1411C7.18192 13.2518 6.99657 13.3523 6.87301 13.3523C6.73915 13.3523 6.27578 13.5333 5.82271 13.7546C4.88568 14.2071 3.91775 15.1122 3.50587 15.9167C3.16606 16.5603 2.87775 17.7771 3.0528 17.7771C3.21755 17.7771 3.70151 17.2441 4.19577 16.5402C4.70033 15.7859 5.48291 15.1122 6.47142 14.5591C7.03776 14.2473 7.35697 14.1267 7.6041 14.1367C7.94391 14.1669 8.73678 13.835 9.33401 13.4227L9.63262 13.2115L9.57084 13.4629C9.52965 13.5937 9.44728 13.9456 9.3752 14.2373C9.28252 14.6496 9.12807 14.911 8.72648 15.3535C7.5938 16.6005 6.82152 17.6866 6.82152 18.0486C6.82152 18.1693 6.65677 18.5313 6.46113 18.8531C5.46231 20.5023 5.1328 22.5639 5.62706 24.1628C5.71974 24.4444 5.8536 24.7561 5.92568 24.8567C6.06984 25.0478 6.08014 25.0478 6.18311 24.8567C6.23459 24.7561 6.31697 24.1427 6.35816 23.5092C6.44053 22.0912 6.62588 21.2767 7.15103 19.909C7.41875 19.2051 7.64529 18.7928 7.83064 18.6319C7.98509 18.5011 8.29401 18.0888 8.52054 17.7167L8.93242 17.0329L8.95302 17.4251C9.04569 18.9034 9.50906 20.442 10.1681 21.4476C11.2287 23.0667 12.8968 23.9315 14.9562 23.9215C16.717 23.9215 17.8909 23.4689 19.0339 22.3627C20.1871 21.2465 20.8255 19.7481 21.0109 17.7871L21.083 17.0329L21.5669 17.8475C21.8347 18.3 22.1436 18.6922 22.2465 18.7224C22.3701 18.7626 22.5554 19.1246 22.8232 19.8386C23.4204 21.4577 23.5131 21.8499 23.5955 23.3382C23.6675 24.3941 23.7293 24.7762 23.8426 24.8969C24.0279 25.0779 24.0588 25.0277 24.3986 23.9416C24.862 22.4231 24.4089 20.1303 23.3174 18.5011C23.2351 18.3704 23.1527 18.1391 23.1424 17.9883C23.1115 17.6363 22.5143 16.7715 21.5463 15.6753C20.877 14.9211 20.7638 14.7401 20.5578 14.0362C20.4343 13.6037 20.3519 13.2518 20.3725 13.2518C20.3828 13.2518 20.7123 13.4428 21.0933 13.6741C21.6287 14.006 21.8964 14.1065 22.298 14.1166C22.6996 14.1367 22.9776 14.2473 23.6263 14.6295C24.6561 15.2329 25.3871 15.9167 25.9947 16.8419C26.4374 17.5156 26.839 17.8776 26.9729 17.7369C27.0965 17.6262 26.7772 16.5603 26.4271 15.8765C26.1903 15.4038 25.8711 15.0016 25.4592 14.6295C24.8723 14.0965 23.5543 13.3523 23.2042 13.3523C23.1012 13.3523 22.8644 13.2317 22.6687 13.0909C22.4731 12.9501 21.8552 12.6082 21.2889 12.3366C20.0327 11.7333 19.5796 11.4215 19.4148 11.0394C19.2707 10.7176 19.2707 10.7075 20.4343 10.5869C20.8976 10.5366 21.1139 10.4461 21.4125 10.2047C22.1539 9.60134 22.9879 8.7365 22.9879 8.5756C22.9879 8.49515 23.1527 8.10296 23.3483 7.72082C24.0176 6.42356 24.1309 5.46821 23.7396 4.42236C23.4719 3.72848 23.2659 3.92961 23.1527 4.98551C23.0188 6.30289 22.4937 7.83144 22.123 8.00239C21.9891 8.06273 21.6905 8.38453 21.464 8.7365L21.0418 9.35999L20.3416 9.39016C19.9606 9.41027 19.5281 9.43038 19.384 9.44044C18.9927 9.46055 18.3645 9.18903 18.1792 8.91751C17.8703 8.46498 17.2731 7.90183 16.8921 7.71076C16.5523 7.53981 16.5008 7.46941 16.5008 7.16772C16.5008 6.42356 15.7182 5.00563 15.3063 5.00563C15.1313 5.00563 15.1107 5.62911 15.2754 5.9308C15.3681 6.10176 15.3475 6.17215 15.1827 6.33305C14.9768 6.53418 14.9768 6.53418 14.7812 6.34311C14.5958 6.1621 14.5855 6.11182 14.7091 5.90063C14.9047 5.55872 14.8944 5.00563 14.6988 5.00563C14.2766 5.00563 13.6176 6.14198 13.5352 6.97665C13.494 7.4493 13.4528 7.51969 13.113 7.71076C12.6291 7.99234 12.4128 8.17335 11.9289 8.74656C11.7126 9.01808 11.4861 9.22926 11.4346 9.22926C11.3728 9.22926 11.1772 9.29965 10.9815 9.39016C10.7035 9.52089 10.58 9.53095 10.2813 9.43038C10.0754 9.37005 9.69441 9.32982 9.42668 9.33988L8.94272 9.37005L8.43816 8.64599C8.17044 8.24374 7.88212 7.92194 7.79975 7.92194C7.54232 7.92194 6.82152 5.74979 6.82152 4.94529C6.82152 4.46259 6.67737 4 6.51261 4C6.46113 4 6.33756 4.17096 6.25519 4.37208Z" fill="currentColor"/></svg>';

function _topbarHTML() {
  var _av = _userAvatar || localStorage.getItem('pa_avatar') || '';
  return '<div class="topbar"><div class="filters">'
    + '<button class="topbar-logo' + (_av ? ' mob-has-avatar' : '') + '" id="topbar-logo-btn" data-action="refresh" title="Refresh">'
    + '<span class="logo-svg">' + _LOGO_SVG + '</span>'
    + '<span class="logo-mob-av">' + _av + '</span>'
    + '</button>'
    + '<button class="nav-pill' + (!_screenerMode ? ' active' : '') + '" data-action="go-main">Tear</button>'
    + '<button class="nav-pill' + (_screenerMode ? ' active' : '') + '" data-action="go-screener">Screener</button>'
    + '<a class="nav-pill nav-pill-beta desktop-nav-btn" href="/inplay-phase">Phase <span class="nav-beta-tag">beta</span></a>'
    + '<div class="topbar-actions">'
    + '<button class="btn-topbar" data-action="open-search" title="Search">' + icon('search', 16) + '</button>'
    + '<button class="btn-topbar" data-action="open-briefing" title="Watchlist">' + icon('bookmark', 16) + '</button>'
    + '<button class="btn-topbar desktop-nav-btn" data-action="tv" title="TV mode">' + icon('monitor', 16) + '</button>'
    + '<button class="btn-topbar desktop-nav-btn" data-action="toggle-theme" title="Toggle theme">' + (isDark() ? icon('sun', 16) : icon('moon', 16)) + '</button>'
    + '<div class="notif-wrap" id="notif-wrap">'
    + '<button class="btn-topbar" data-action="toggle-notif" id="notif-btn" title="Notifications">' + icon('bell', 16) + '<span class="notif-badge" id="notif-badge" style="display:none"></span></button>'
    + '<div class="notif-dd dropdown" id="notif-dd"></div>'
    + '</div>'
    + '<div class="avatar-wrap">'
    + (function() { var av = _userAvatar || localStorage.getItem('pa_avatar'); return '<button class="btn-avatar' + (av ? ' has-emoji' : '') + '" id="avatar-btn" data-action="toggle-avatar-dd" title="Profile"><span id="avatar-btn-icon">' + (av || icon('user-round', 16)) + '</span></button>'; })()
    + '<div class="avatar-dd dropdown" id="avatar-dd">'
    + '<button class="burger-dd-item" data-action="open-account">' + icon('user-round', 14) + 'Account</button>'
    + '<button class="burger-dd-item" data-action="logout">' + icon('log-out', 14) + 'Sign out</button>'
    + '</div>'
    + '</div>'
    + '<div class="burger-wrap">'
    + '<button class="btn-topbar" data-action="toggle-burger">' + icon('menu', 16) + '</button>'
    + '<div class="burger-dd dropdown" id="burger-dd">'
    + '<a class="burger-dd-item" href="/inplay-phase">' + icon('activity', 14) + 'Phase <span class="nav-beta-tag">beta</span></a>'
    + '<button class="burger-dd-item" data-action="tv">' + icon('monitor', 14) + 'TV mode</button>'
    + '<button class="burger-dd-item" data-action="toggle-theme">' + (isDark() ? icon('sun', 14) : icon('moon', 14)) + 'Toggle theme</button>'
    + '<button class="burger-dd-item" data-action="open-account">' + icon('user-round', 14) + 'Account</button>'
    + '<button class="burger-dd-item" data-action="logout">' + icon('log-out', 14) + 'Sign out</button>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '</div></div>';
}

// ── Sort Bar ───────────────────────────────────────────────────────────────

function _sortBarHTML(coins) {
  var ws = wsConnected;
  var wsTitle = ws ? 'WebSocket: connected' : 'WebSocket: disconnected';
  return '<div class="sort-bar">'
    + (_screenerMode ? '' :
        '<div class="tier-num-group">'
        + '<button class="pill' + (state.volTier === 'high' ? ' active' : '') + '" data-action="pick-tier" data-val="high" title=">100M USDT">&gt;100</button>'
        + '<button class="pill' + (state.volTier === 'mid'  ? ' active' : '') + '" data-action="pick-tier" data-val="mid"  title="50M – 100M USDT">&gt;50</button>'
        + '<button class="pill' + (state.volTier === 'low'  ? ' active' : '') + '" data-action="pick-tier" data-val="low"  title="12M – 50M USDT">&gt;12</button>'
        + '</div>')
    + '<span class="ws-indicator ' + (ws ? 'connected' : 'disconnected') + '" title="' + wsTitle + '"></span>'
    + '<span class="sort-coin-count">' + coins.length + ' coins</span>'
    + '<div class="sort-bar-btns">'
    + '<button class="btn-icon' + (state.sortCol === 'price_change_percentage_24h' ? ' active' : '') + '" data-action="sort" data-col="price_change_percentage_24h" title="Sort by change">' + icon('percent', 16) + '</button>'
    + '<button class="btn-icon' + (state.sortCol === 'total_volume' ? ' active' : '') + '" data-action="sort" data-col="total_volume" title="Sort by volume">' + icon('bar-chart-2', 16) + '</button>'
    + '</div>'
    + '</div>';
}

// ── Main Render ────────────────────────────────────────────────────────────

export function render() {
  var app = document.getElementById('app');
  if (state.loading) {
    destroyCharts();
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
    ? '<div class="cards-area' + (_screenerMode ? ' cards-area--scr' : '') + '">'
      + '<div class="cards-grid" id="cards-grid">'
      + coins.map(function (c) { return renderCard(c); }).join('')
      + '</div></div>'
    : emptyHtml;

  app.innerHTML =
    _topbarHTML()
    + (_screenerMode ? '' : _sortBarHTML(coins))
    + coinsHtml;
  initCharts();
  updateNotifBadge();
}


// ── Event listeners ────────────────────────────────────────────────────────

initTheme();
loadLevels();
on('render', render);
on('cards:sync', renderCards);
on('card:update', function (sym) { updateCardBadge(sym); updateAnalysisPopup(sym); });
on('metrics:update', updateMetricCards);
on('ws:status', function () {
  var els = document.querySelectorAll('.ws-indicator');
  for (var i = 0; i < els.length; i++) {
    els[i].className = 'ws-indicator ' + (wsConnected ? 'connected' : 'disconnected');
    els[i].title = wsConnected ? 'WebSocket connected' : 'WebSocket disconnected';
  }
});

// ── Full View ──────────────────────────────────────────────────────────────

var _fvRuler = null;
var _fvTradeMarkersData = [];

// ── Briefing ───────────────────────────────────────────────────────────────

var _briefingUserCode = null; // set by setUserId()
var _briefingServerLoaded = false; // true after first successful server GET
var _briefingSyncTimer = null;
var _expandedBpKey = null; // sym:date of currently expanded popup row
var _expandedFvKey = null; // sym:date of currently expanded FV drawer row

function todayDate() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fmtBriefingDate(iso) {
  var parts = iso.split('-');
  var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  return days[d.getDay()] + ', ' + parts[2] + '.' + parts[1] + '.' + parts[0];
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
  try { localStorage.setItem('pa_briefing', JSON.stringify(state.briefing)); } catch (e) {}
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
  var _today = new Date(); var _dow = _today.getDay();
  var _mon = new Date(_today.getFullYear(), _today.getMonth(), _today.getDate() - (_dow === 0 ? 6 : _dow - 1));
  var _mondayStr = _mon.getFullYear() + '-' + String(_mon.getMonth() + 1).padStart(2, '0') + '-' + String(_mon.getDate()).padStart(2, '0');
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
    try { localStorage.setItem('pa_briefing', JSON.stringify(state.briefing)); } catch (e) {} // no debounce sync — don't push server data back
    renderBriefingPanel();
    updateAllStarButtons();
    var _fvd = document.getElementById('fv-briefing-drawer');
    if (_fvd && _fvd.classList.contains('open')) renderFVBriefingDrawer();
  }).catch(function () {});
}

export function loadBriefing() {
  // Clear cached data if user switched to prevent cross-user data leakage
  try {
    var _storedUserId = localStorage.getItem('pa_user_id');
    if (_userId && _storedUserId !== _userId) {
      ['pa_briefing', 'pa_ai_summary', 'pa_ai_traded_keys', 'pa_ai_summary_date', 'pa_ai_trade_count'].forEach(function (k) {
        localStorage.removeItem(k);
      });
      localStorage.setItem('pa_user_id', _userId);
    }
  } catch (e) {}

  // Always filter to current week — old entries disappear automatically each Monday
  var _today = new Date();
  var _dow = _today.getDay();
  var _mon = new Date(_today.getFullYear(), _today.getMonth(), _today.getDate() - (_dow === 0 ? 6 : _dow - 1));
  var _mondayStr = _mon.getFullYear() + '-' + String(_mon.getMonth() + 1).padStart(2, '0') + '-' + String(_mon.getDate()).padStart(2, '0');

  try {
    var local = JSON.parse(localStorage.getItem('pa_briefing') || '[]');
    if (Array.isArray(local)) state.briefing = local.filter(function (e) { return e.date >= _mondayStr; });
  } catch (e) {}
  try {
    var savedAI = localStorage.getItem('pa_ai_summary');
    if (savedAI) state.aiSummary = savedAI;
    var savedKeys = localStorage.getItem('pa_ai_traded_keys');
    if (savedKeys) state.aiSummaryTradedKeys = JSON.parse(savedKeys);
    var savedDate = localStorage.getItem('pa_ai_summary_date');
    if (savedDate) state.aiSummaryDate = savedDate;
    var savedCount = localStorage.getItem('pa_ai_trade_count');
    if (savedCount !== null) state.aiSummaryTradeCount = parseInt(savedCount, 10) || 0;
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
    if (d && d.ai_summary) {
      state.aiSummary = d.ai_summary;
      state.aiSummaryTradedKeys = d.ai_traded_keys || [];
      state.aiSummaryDate = d.ai_summary_date || null;
      try {
        localStorage.setItem('pa_ai_summary', state.aiSummary);
        localStorage.setItem('pa_ai_traded_keys', JSON.stringify(state.aiSummaryTradedKeys));
        if (state.aiSummaryDate) localStorage.setItem('pa_ai_summary_date', state.aiSummaryDate);
      } catch (e) {}
      var _drawer = document.getElementById('fv-briefing-drawer');
      if (_drawer && _drawer.classList.contains('open') && state.briefingTab === 'ai') {
        renderFVBriefingDrawer();
      }
    } else if (d) {
      // Server returned no AI summary — clear any locally cached data (may belong to another user)
      state.aiSummary = null;
      state.aiSummaryTradedKeys = null;
      state.aiSummaryDate = null;
      state.aiSummaryTradeCount = null;
      try {
        localStorage.removeItem('pa_ai_summary');
        localStorage.removeItem('pa_ai_traded_keys');
        localStorage.removeItem('pa_ai_summary_date');
        localStorage.removeItem('pa_ai_trade_count');
      } catch (e) {}
      var _drawer2 = document.getElementById('fv-briefing-drawer');
      if (_drawer2 && _drawer2.classList.contains('open') && state.briefingTab === 'ai') {
        renderFVBriefingDrawer();
      }
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
    state.briefing.push({ sym: sym, date: today, addedAt: Date.now(), status: 'watching', note: '' });
  }
  saveBriefingLocal();
  syncBriefingNow();
  updateStarButton(sym);
  renderBriefingPanel();
  var _fvd = document.getElementById('fv-briefing-drawer');
  if (_fvd && _fvd.classList.contains('open')) renderFVBriefingDrawer();
}

function briefingStatusLabel(status) {
  if (status === 'traded')   return icon('check-check', 16);
  if (status === 'skip')     return icon('ban', 16);
  if (status === 'missed')   return icon('clock', 16);
  return icon('eye', 16);
}

function briefingStatusText(status) {
  if (status === 'traded')   return 'Traded';
  if (status === 'skip')     return 'Skipped';
  if (status === 'missed')   return 'Missed';
  return 'Watching';
}

function briefingStatusClass(status) {
  if (status === 'traded')   return 'bp-s-traded';
  if (status === 'skip')     return 'bp-s-skip';
  if (status === 'missed')   return 'bp-s-missed';
  return 'bp-s-watching';
}

function cycleBriefingStatus(sym, date) {
  var entry = (state.briefing || []).find(function (e) { return e.sym === sym && e.date === date; });
  if (!entry) return;
  var order = ['watching', 'traded', 'skip', 'missed'];
  var cur = order.indexOf(entry.status);
  entry.status = order[(cur + 1) % order.length];
  saveBriefingLocal();
  syncBriefingNow();
  var openNotes = Array.from(document.querySelectorAll('.bp-note-row'))
    .filter(function (el) { return el.style.display !== 'none'; })
    .map(function (el) { return el.id; });
  renderBriefingPanel();
  var _fvd = document.getElementById('fv-briefing-drawer');
  if (_fvd && _fvd.classList.contains('open')) renderFVBriefingDrawer();
  openNotes.forEach(function (id) {
    document.querySelectorAll('[id="' + id + '"]').forEach(function (el) {
      el.style.display = '';
      var ta = el.querySelector('textarea');
      if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
    });
  });
}

function updateStarButton(sym) {
  var active = isInBriefing(sym);
  document.querySelectorAll('.btn-icon.star[data-sym="' + sym + '"]').forEach(function (btn) {
    btn.classList.toggle('active', active);
    btn.title = active ? 'Remove from watchlist' : 'Add to watchlist';
  });
}

function updateAllStarButtons() {
  document.querySelectorAll('.btn-icon.star').forEach(function (btn) {
    var sym = btn.dataset.sym;
    var active = isInBriefing(sym);
    btn.classList.toggle('active', active);
    btn.title = active ? 'Remove from watchlist' : 'Add to watchlist';
  });
}

// ── Trade pill helper ──────────────────────────────────────────────────────

function _tradePillHTML(sym, date) {
  var t = state.trades[sym + ':' + date];
  if (!t) return '<span class="bp-trade-pill bp-trade-loading">···</span>';
  if (t.status === 'loading') return '<span class="bp-trade-pill bp-trade-loading">···</span>';
  if (t.status === 'error' || t.count === 0) return '<span class="bp-trade-pill bp-trade-none">—</span>';
  var sign = t.pnl >= 0 ? '+' : '';
  var cls = t.pnl >= 0 ? 'bp-trade-pos' : 'bp-trade-neg';
  var title = t.count + ' сд.';
  if (t.entries && t.entries.length) {
    var first = t.entries[0], last = t.entries[t.entries.length - 1];
    title += ' · entry $' + parseFloat(first.price).toFixed(2) + ' → $' + parseFloat(last.price).toFixed(2);
  }
  return '<span class="bp-trade-pill ' + cls + '" title="' + escHtml(title) + '">' + sign + '$' + Math.abs(t.pnl).toFixed(2) + '</span>';
}

// Inline trade result for popup compact row (no pill background, just colored text)
function _tradeInlineHTML(sym, date) {
  var t = state.trades[sym + ':' + date];
  if (!t || t.status === 'loading' || t.status === 'error' || t.count === 0) return null;
  var sign = t.pnl >= 0 ? '+' : '';
  var cls = t.pnl >= 0 ? 'up' : 'dn';
  return '<span class="bp-trade-inline stat-val ' + cls + '">' + sign + '$' + Math.abs(t.pnl).toFixed(2) + '</span>';
}

// ── Weekly summary block ───────────────────────────────────────────────────

function _weekStatsHTML() {
  var ws = state.weekSummary;
  var loadBtn = '<button class="btn-topbar bp-week-load-btn" data-action="bp-load-week" title="Refresh">' + icon('refresh-cw', 16) + '</button>';
  var statsHTML = ws
    ? (function () {
        var pnlSign = ws.pnl >= 0 ? '+' : '';
        var pnlCls = ws.pnl >= 0 ? 'up' : 'dn';
        return '<div class="bp-week-stats">'
          + '<div class="bp-stat-card"><div class="bp-stat-label">PnL</div><div class="bp-stat-val ' + pnlCls + '">' + pnlSign + '$' + ws.pnl.toFixed(2) + '</div></div>'
          + '<div class="bp-stat-card"><div class="bp-stat-label">Trades</div><div class="bp-stat-val">' + ws.tradeCount + '</div></div>'
          + '<div class="bp-stat-card"><div class="bp-stat-label">Win rate</div><div class="bp-stat-val">' + ws.winRate + '%</div></div>'
          + '<div class="bp-stat-card"><div class="bp-stat-label">Wins</div><div class="bp-stat-val">' + ws.winCount + '/' + ws.tradeCount + '</div></div>'
          + '</div>';
      })()
    : '<div class="fvbd-empty">Click refresh to load</div>';
  return '<div class="bp-week">'
    + '<div class="bp-week-header">' + loadBtn + '</div>'
    + statsHTML
    + '</div>';
}

function _weekAIHTML() {
  var ws = state.weekSummary;
  var aiText = state.aiSummary;
  var currentKeys = (state.briefing || [])
    .filter(function (e) { return e.status === 'traded'; })
    .map(function (e) { return e.sym + ':' + e.date; })
    .sort().join(',');
  var savedKeys = (state.aiSummaryTradedKeys || []).slice().sort().join(',');
  var hasNewTraded = currentKeys !== savedKeys;
  var savedTradeCount = typeof state.aiSummaryTradeCount === 'number' ? state.aiSummaryTradeCount : 0;
  var hasMoreTrades = ws && ws.tradeCount > savedTradeCount;
  var btnDisabled = !ws || (!!aiText && !hasNewTraded && !hasMoreTrades);
  var dateStr = '';
  if (aiText && state.aiSummaryDate) {
    var d = new Date(state.aiSummaryDate);
    dateStr = '<span class="bp-ai-date">'
      + d.toLocaleDateString('en-US', { month:'2-digit', day:'2-digit' })
      + ' ' + d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })
      + '</span>';
  }
  return '<div class="bp-week">'
    + '<div class="bp-ai-block">'
    + '<div class="bp-ai-header">'
    + dateStr
    + '<button class="acc-row-edit" data-action="bp-gen-ai"' + (btnDisabled ? ' disabled' : '') + '>Generate</button>'
    + '</div>'
    + (aiText ? '<div class="bp-ai-text">' + escHtml(aiText) + '</div>' : '')
    + '</div>'
    + '</div>';
}

var _refreshBriefingPctLast = 0;
function _refreshBriefingPct() {
  var now = Date.now();
  if (now - _refreshBriefingPctLast < 500) return;
  _refreshBriefingPctLast = now;
  var popup = document.getElementById('bp-popup');
  var drawer = document.getElementById('fv-briefing-drawer');
  if ((!popup || popup.style.display === 'none') && (!drawer || !drawer.classList.contains('open'))) return;
  var coinMap = {};
  state.coins.forEach(function (c) { coinMap[c.symbol] = c; });
  // Expose for mobile USB debugging: window._bpDiag()
  window._bpDiag = function () {
    var rows = document.querySelectorAll('.bp-row[data-sym]');
    return {
      rowCount: rows.length,
      syms: Array.from(rows).map(function (r) { return r.dataset.sym; }),
      coinMapSize: Object.keys(coinMap).length,
      matchCount: Array.from(rows).filter(function (r) { return !!(coinMap[r.dataset.sym] || coinMap[(r.dataset.sym || '').toLowerCase()]); }).length,
    };
  };
  document.querySelectorAll('.bp-row[data-sym]').forEach(function (row) {
    var coin = coinMap[row.dataset.sym] || coinMap[(row.dataset.sym || '').toLowerCase()];
    if (!coin) return;
    var ch = (coin.open_24h > 0 && coin.current_price > 0)
      ? (coin.current_price - coin.open_24h) / coin.open_24h * 100
      : (coin.price_change_percentage_24h || 0);
    var span = row.querySelector('.bp-chg');
    if (!span) return;
    var newChg = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
    span.textContent = newChg;
  });
}
setInterval(_refreshBriefingPct, 500);
on('metrics:update', _refreshBriefingPct); // also fires on every WS push (reliable on iOS)

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
    popup.className = 'bp-popup popup';
    document.body.appendChild(popup);
  } else if (!popup.parentNode || popup.parentNode !== document.body) {
    document.body.appendChild(popup);
  }
  popup.style.display = 'block';
  var _fvStar = document.querySelector('.btn-fv-star');
  if (_fvStar) _fvStar.style.display = 'none';
  renderBriefingPanel();
  refreshBriefingFromServer();
  popup._isFullscreenMode = _useFullscreenPopup();

  // Subscribe all briefing coins to kline stream so the server pushes per-trade
  // kline_update messages for them. Without this, only coins previously viewed in
  // FV (with loaded chart data) get per-trade price updates; the rest only update
  // on the slow bulk ticker, making them appear frozen in the popup.
  var _bpSyms = Array.from(new Set((state.briefing || []).map(function (e) { return e.sym; })));
  if (_bpSyms.length) sendWS({ type: 'subscribe_klines', symbols: _bpSyms, tf: '5m' });

  if (_useFullscreenPopup()) {
    _popupFullscreen(popup);
    popup.style.height = '100%';
    popup.style.overflowY = 'auto';
    lockScroll();
  } else if (btn) {
    var btnRect = btn.getBoundingClientRect();
    var inFixed = !!btn.closest('#fv-overlay');
    popup.style.position = inFixed ? 'fixed' : 'absolute';
    popup.style.top = (btnRect.bottom + (inFixed ? 0 : window.scrollY) + 6) + 'px';
    popup.style.right = (document.documentElement.clientWidth - btnRect.right) + 'px';
    popup.style.left = 'auto';
    popup.style.width = '360px';
  }
}

export function closeBriefingPanel() {
  var popup = document.getElementById('bp-popup');
  if (popup) popup.style.display = 'none';
  _expandedBpKey = null;
  unlockScroll();
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
    var change = coin ? ((coin.open_24h > 0 && coin.current_price > 0) ? (coin.current_price - coin.open_24h) / coin.open_24h * 100 : (coin.price_change_percentage_24h || 0)) : 0;
    var tradeInline = _tradeInlineHTML(e.sym, e.date);
    var tradeLocked = (function () { var t = state.trades[e.sym + ':' + e.date]; return t && t.count > 0; })();
    var isExpanded = _expandedBpKey === e.sym + ':' + e.date;
    var hasNote = !!e.note;
    return '<div class="bp-row' + (isExpanded ? ' bp-row-active' : '') + '" data-action="bp-expand" data-sym="' + e.sym + '" data-date="' + e.date + '">' +
      '<button class="bp-sym-btn" data-action="bp-open" data-sym="' + e.sym + '">' + e.sym.toUpperCase() + '</button>' +
      '<span class="bp-chg stat-val ' + (change >= 0 ? 'up' : 'dn') + '">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%</span>' +
      (tradeInline || '<span class="bp-row-status ' + briefingStatusClass(e.status) + '">' + briefingStatusLabel(e.status) + '</span>') +
      '<button class="btn-icon bp-note-btn' + (hasNote ? ' has-note' : '') + '" data-action="bp-expand" data-sym="' + e.sym + '" data-date="' + e.date + '">' + icon('sticky-note', 16) + '</button>' +
      '<button class="btn-icon bp-remove" data-action="bp-remove" data-sym="' + e.sym + '" data-date="' + e.date + '">' + icon('trash', 16) + '</button>' +
      '</div>' +
      '<div class="bp-note-row' + (isExpanded ? ' bp-row-active' : '') + '" id="bp-note-' + e.sym + '-' + e.date + '"' + (isExpanded ? '' : ' style="display:none"') + '>' +
        '<div class="bp-expand-bar">' +
          (tradeLocked
            ? '<span class="bp-status-btn bp-status bp-s-traded bp-status-locked">' + icon('check-check', 16) + '<span class="bp-status-text">Traded</span></span>'
            : '<button class="bp-status-btn bp-status ' + briefingStatusClass(e.status) + '" data-action="bp-cycle-status" data-sym="' + e.sym + '" data-date="' + e.date + '">' + briefingStatusLabel(e.status) + '<span class="bp-status-text">' + briefingStatusText(e.status) + '</span></button>') +
          '<button class="acc-delete-cancel" data-action="bp-note-action" data-sym="' + e.sym + '" data-date="' + e.date + '">' + (hasNote ? 'Delete note' : 'Add note') + '</button>' +
        '</div>' +
        '<div class="bp-note-wrap"' + (hasNote ? '' : ' style="display:none"') + '>' +
          '<textarea placeholder="Note..." data-sym="' + e.sym + '" data-date="' + e.date + '">' + escHtml(e.note || '') + '</textarea>' +
        '</div>' +
      '</div>';
  }).join('') : '<div class="bp-empty">No coins for today — star them on the dashboard</div>';

  popup.innerHTML =
    '<div class="popup-header">' +
      '<span class="popup-title">Watchlist</span>' +
      '<button class="btn-topbar" data-action="close-briefing">' + icon('x', 16) + '</button>' +
    '</div>' +
    '<div class="popup-body bp-list">' + rowsHTML + '</div>' +
    '<div class="popup-footer">' +
      (state.briefing && state.briefing.length ? '<button class="btn-cta" style="width:100%" data-action="go-briefing">Watchlist mode</button>' : '') +
    '</div>';

  _refreshBriefingPct();
  // Re-attach note textarea listeners
  popup.querySelectorAll('textarea[data-sym]').forEach(function (ta) {
    ta.addEventListener('input', function () {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      var sym = ta.dataset.sym, date = ta.dataset.date;
      var entry = (state.briefing || []).find(function (e) { return e.sym === sym && e.date === date; });
      if (entry) { entry.note = ta.value; entry.noteUpdatedAt = Date.now(); saveBriefingLocal(); }
      var noteBtn = popup.querySelector('.bp-note-btn[data-sym="' + sym + '"][data-date="' + date + '"]');
      if (noteBtn) noteBtn.classList.toggle('has-note', !!ta.value);
    });
    ta.addEventListener('blur', function () { syncBriefingNow(); });
  });
  // Restore textarea height for expanded row after re-render
  if (_expandedBpKey) {
    var _bpParts = _expandedBpKey.split(':');
    var _bpSym = _bpParts[0], _bpDate = _bpParts.slice(1).join(':');
    var _bpNoteRow = popup.querySelector('[id="bp-note-' + _bpSym + '-' + _bpDate + '"]');
    if (_bpNoteRow) {
      var _bpTa = _bpNoteRow.querySelector('textarea');
      if (_bpTa) { _bpTa.style.height = 'auto'; _bpTa.style.height = _bpTa.scrollHeight + 'px'; }
    }
  }
}

function _fvBottomBarHTML(sym, tf) {
  var cache = state.analysisCache[sym];
  var hasA = cache && cache.status === 'ok', isE = cache && cache.status === 'error';
  var signal = hasA ? cache.result.signal : null;
  var fvBadge = '';
  if (isE) fvBadge = '<button class="btn-retry" data-action="analyze" data-sym="' + sym + '">Retry</button>';
  else if (hasA) fvBadge = '<span class="signal-badge ' + signal + '" data-action="open-analysis" data-sym="' + sym + '">' + signalLabel(signal) + '</span>';
  else fvBadge = '<button class="btn-icon analyze" data-action="analyze" data-sym="' + sym + '">' + icon('zap', 16) + '</button>';
  var alertCount = (_alerts[sym] && _alerts[sym].length) || 0;
  var levelCount = (_levels[sym] && _levels[sym].length) || 0;
  return '<div class="fv-bottom-bar">'
    + '<div class="fv-bb-left">'
    + '<button class="btn-icon" data-action="close-fv" title="Back">' + icon('arrow-left', 16) + '</button>'
    + '<span class="fv-sym-label" data-action="copy-sym" data-sym="' + sym + '" title="Copy ticker">' + sym.toUpperCase() + '</span>'
    + '<div class="tf-picker"><button class="pill" data-action="fv-tf-pick">' + tf + '</button>'
    + '<div class="tf-dd fv-tf-dd dropdown">'
    + ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'].map(function (t) { return '<button class="' + (t === tf ? 'active' : '') + '" data-action="fv-tf-opt" data-tf="' + t + '">' + t + '</button>'; }).join('')
    + '</div></div>'
    + '</div>'
    + '<div class="fv-bb-right">'
    + '<button class="btn-icon star btn-fv-star' + (isInBriefing(sym) ? ' active' : '') + '" data-action="toggle-briefing" data-sym="' + sym + '">' + icon('star', 16) + '</button>'
    + '<button class="btn-icon clear" data-action="open-clear-popup" data-sym="' + sym + '" style="display:' + ((alertCount || levelCount) ? 'inline-flex' : 'none') + '" title="Delete">' + icon('trash', 16) + '</button>'
    + fvBadge
    + '</div>'
    + '</div>';
}

function _fvCoinInfoHTML(sym, tf) {
  var coin = state.coins.find(function (c) { return c.symbol === sym; });
  var change = coin ? ((coin.open_24h > 0 && coin.current_price > 0)
    ? (coin.current_price - coin.open_24h) / coin.open_24h * 100
    : (coin.price_change_percentage_24h || 0)) : 0;
  var nd = natrDisplay(sym);

  var cache = state.analysisCache[sym];
  var hasA = cache && cache.status === 'ok', isE = cache && cache.status === 'error';
  var signal = hasA ? cache.result.signal : null;
  var fvBadge = '';
  if (isE) fvBadge = '<button class="btn-retry" data-action="analyze" data-sym="' + sym + '">Retry</button>';
  else if (hasA) fvBadge = '<span class="signal-badge ' + signal + '" data-action="open-analysis" data-sym="' + sym + '">' + signalLabel(signal) + '</span>';
  else fvBadge = '<button class="btn-icon analyze" data-action="analyze" data-sym="' + sym + '">' + icon('zap', 16) + '</button>';

  var alertCount = (_alerts[sym] && _alerts[sym].length) || 0;
  var levelCount = (_levels[sym] && _levels[sym].length) || 0;

  return '<div class="fv-coin-info">'
    + '<div class="fv-info-top">'
    + '<button class="btn-icon" data-action="close-fv" title="Back">' + icon('arrow-left', 16) + '</button>'
    + '<span class="fv-sym-label fv-sym-gap" data-action="copy-sym" data-sym="' + sym + '" title="Copy ticker">' + sym.toUpperCase() + '</span>'
    + '<div class="tf-picker fv-tf-gap">'
    + '<button class="pill" data-action="fv-tf-pick">' + tf + '</button>'
    + '<div class="tf-dd fv-tf-dd dropdown">'
    + ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'].map(function (t) { return '<button class="' + (t === tf ? 'active' : '') + '" data-action="fv-tf-opt" data-tf="' + t + '">' + t + '</button>'; }).join('')
    + '</div>'
    + '</div>'
    + '<div class="fv-actions">'
    + '<button class="btn-icon star btn-fv-star' + (isInBriefing(sym) ? ' active' : '') + '" data-action="toggle-briefing" data-sym="' + sym + '" title="' + (isInBriefing(sym) ? 'Remove from watchlist' : 'Add to watchlist') + '">' + icon('star', 16) + '</button>'
    + '<button class="btn-icon clear" data-action="open-clear-popup" data-sym="' + sym + '" style="display:' + ((alertCount || levelCount) ? 'inline-flex' : 'none') + '" title="Delete">' + icon('trash', 16) + '</button>'
    + fvBadge
    + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="fv-info-stats">'
    + '<span class="stat-val ' + (change >= 0 ? 'up' : 'dn') + '">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%</span>'
    + '<span class="stat-val ' + nd.cls + '">' + nd.val + '</span>'
    + '<span class="stat-val">' + fmt(coin ? coin.total_volume : 0).replace('$', '') + '</span>'
    + '</div>';
}

// Draw alert bells + trade triangles on the FV canvas overlay.
// Called from both the rAF loop and the ruler mousemove handler so
// they always stay visible regardless of ruler state.
function _drawFVOverlays(ctx, rc, sym) {
  if (!_fvSeries) return;
  var dpr = window.devicePixelRatio || 1;
  var cssW = rc.width / dpr, cssH = rc.height / dpr;
  // Alert bell icons
  if (_bellImg && _bellImg.complete) {
    (_alerts[sym] || []).forEach(function (a) {
      var y = _fvSeries.priceToCoordinate(a.price);
      if (y == null || y < 0 || y > cssH) return;
      var tagW = 16, tagH = 18;
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
}

function _applyFVTradeMarkers(sym) {
  var _drawer = document.getElementById('fv-briefing-drawer');
  if (!sym || !_drawer || !_drawer.classList.contains('open')) { _fvTradeMarkersData = []; return; }
  var briefingEntries = (state.briefing || []).filter(function (e) { return e.sym === sym; });
  var markers = [];
  briefingEntries.forEach(function (e) {
    var t = state.trades[sym + ':' + e.date];
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

export function applyFVTradeMarkers() { _applyFVTradeMarkers(_fvSym); }

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
  var _fvVisibleCandles = window.innerWidth < 768 ? 120 : 240;
  _fvChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, cd.candles.length - _fvVisibleCandles), to: cd.candles.length + 4 });
  // Attach existing levels and alerts to fv series
  (_levels[sym] || []).forEach(function (l) {
    if (l.price && !l.fvLine) l.fvLine = _fvSeries.createPriceLine({ price: l.price, color: getCSSVar('--primary'), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: '' });
  });
  // Sync alert lines — _syncAlertLine handles create-or-update for both card and FV
  (_alerts[sym] || []).forEach(function (a) { _syncAlertLine(sym, a); });
  // Trade entry/exit markers from briefing history
  _applyFVTradeMarkers(sym);
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
    (_alerts[_fvSym] || []).forEach(function (a) { _detachFvLine(a); });
  }
  _fvSym = sym;

  var overlay = document.getElementById('fv-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'fv-overlay'; overlay.className = 'overlay'; document.body.appendChild(overlay); }

  var tf = state.chartTF[sym] || '5m';
  var switchingCoins = overlay.style.display === 'flex';
  if (!switchingCoins) {
    _pauseCardCharts();
    // First open — build full structure including drawer
    overlay.innerHTML = '<div class="fv-body">'
      + '<div class="fv-chart-wrap">'
      + _fvCoinInfoHTML(sym, tf)
      + '<div id="fv-chart"></div>'
      + '</div>'
      + '</div>'
      + _fvBottomBarHTML(sym, tf)
      + '<div id="fv-briefing-drawer"></div>';
  } else {
    // Switching coins — update chart-wrap only, leave drawer untouched
    var _chartWrap = overlay.querySelector('.fv-chart-wrap');
    if (_chartWrap) {
      _chartWrap.innerHTML = _fvCoinInfoHTML(sym, tf) + '<div id="fv-chart"></div>';
      var _bb = overlay.querySelector('.fv-bottom-bar');
      if (_bb) _bb.outerHTML = _fvBottomBarHTML(sym, tf);
      var _fvdEl = document.getElementById('fv-briefing-drawer');
      if (_fvdEl && _fvdEl.classList.contains('open')) renderFVBriefingDrawer();
    }
  }
  overlay.style.display = 'flex';
  lockScroll();

  // Init chart
  var el = document.getElementById('fv-chart');
  var c = getChartColors();
  _fvChart = window.LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: c.bg }, textColor: c.text, fontSize: 11, fontFamily: 'Manrope, Arial, sans-serif' },
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
  window.__fvSymbol = sym;
  window.__fvTF = tf;

  // Volume label overlay
  var wrap = document.querySelector('.fv-chart-wrap');
  var volLbl = document.createElement('div');
  volLbl.id = 'fv-vol-label';
  volLbl.className = 'fv-vol-label';
  wrap.appendChild(volLbl);

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
  function _onEscKey(e) { if (e.key === 'Escape') closeCoinFullView(); }
  document.addEventListener('keydown', _onEscKey);
  var fvLblEl = document.createElement('div');
  fvLblEl.className = 'ruler-lbl';
  wrap.appendChild(fvLblEl);
  _fvRuler = { start: null, canvas: rc, label: fvLblEl, _resizeHandler: _syncFVCanvas, _escHandler: _onEscKey };

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
    var y = e.clientY - rect.top;
    var price = _fvSeries.coordinateToPrice(y);
    if (price == null) return;
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
        durStr = d < 60 ? Math.round(d) + 'с' : d < 3600 ? Math.round(d / 60) + 'м' : d < 86400 ? Math.floor(d / 3600) + 'ч ' + Math.round((d % 3600) / 60) + 'м' : Math.floor(d / 86400) + 'д ' + Math.floor((d % 86400) / 3600) + 'ч';
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
    if (_fvDragging && e.button === 0) { saveLevels(); _fvDragging = null; el.style.cursor = ''; }
    if (_fvAlertDragging && e.button === _fvAlertDragBtn) { saveAlerts(); _fvAlertDragging = null; _fvAlertDragBtn = 2; el.style.cursor = ''; }
  });
  el.addEventListener('mouseleave', function () {
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


  function _fvTMShowMenu(y, price, delMode, delIdx) {
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
    } else {
      html = '<button class="fv-touch-menu-item" data-tm="level">' +
          '<span class="fv-tmi-icon">' + icon('minus', 16) + '</span><span>Price level · ' + p + '</span></button>' +
        '<button class="fv-touch-menu-item" data-tm="alert">' +
          '<span class="fv-tmi-icon">' + icon('bell', 16) + '</span><span>Add alert · ' + p + '</span></button>';
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

    // Empty area — 900ms long-press shows add menu directly (no "+" button)
    _fvTD.addTimer = setTimeout(function () {
      _fvTD.addTimer = null;
      var price = _fvSeries ? _fvSeries.coordinateToPrice(_fvTD.startY) : null;
      if (price != null) _fvTMShowMenu(_fvTD.startY, price, null, null);
    }, 900);

  }, { passive: false });

  el.addEventListener('touchmove', function (e) {
    if (e.touches.length !== 1) return;
    var t = e.touches[0], rect = el.getBoundingClientRect();
    var y = t.clientY - rect.top;
    var dx = t.clientX - rect.left - _fvTD.startX, dy = y - _fvTD.startY;
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
    clearTimeout(_fvTD.addTimer); _fvTD.addTimer = null;
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
  if (_fvChart) { try { _fvChart.remove(); } catch (e) {} _fvChart = null; }
  if (_fvRuler && _fvRuler._resizeHandler) window.removeEventListener('resize', _fvRuler._resizeHandler);
  if (_fvRuler && _fvRuler._escHandler) document.removeEventListener('keydown', _fvRuler._escHandler);
  _fvSeries = null; _fvVolSeries = null; _fvRuler = null; _fvTradeMarkersData = [];
  window.__fvSeries = null; window.__fvVolSeries = null; window.__fvSymbol = null; window.__fvTF = null;
  if (_fvSym) {
    (_levels[_fvSym] || []).forEach(function (l) { l.fvLine = null; });
    (_alerts[_fvSym] || []).forEach(function (a) { _detachFvLine(a); });
  }
  _fvSym = null;
  _expandedFvKey = null;
  var overlay = document.getElementById('fv-overlay');
  if (overlay) overlay.style.display = 'none';
  var ap = document.getElementById('analysis-overlay');
  if (ap) { ap.style.display = 'none'; if (ap._popupCard) { ap._popupCard.style.overflow = ''; ap._popupCard = null; } }
  forceUnlockScroll();
  initCharts();
}

export function setFVChartTF(tf) {
  if (!_fvSym || !_fvSeries) return;
  state.chartTF[_fvSym] = tf;
  window.__fvTF = tf;
  document.querySelectorAll('#fv-overlay .pill').forEach(function (pill) { pill.textContent = tf; });
  document.querySelectorAll('#fv-overlay .fv-tf-dd').forEach(function (dd) {
    dd.querySelectorAll('button').forEach(function (btn) { btn.className = btn.dataset.tf === tf ? 'active' : ''; });
  });
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

export function briefingClearNote(sym, date, noteRow) {
  var entry = (state.briefing || []).find(function (e) { return e.sym === sym && e.date === date; });
  if (!entry) return;
  entry.note = '';
  entry.noteUpdatedAt = Date.now();
  saveBriefingLocal();
  syncBriefingNow();
  if (noteRow) {
    var ta = noteRow.querySelector('textarea'); if (ta) ta.value = '';
    var clrBtn = noteRow.querySelector('.bp-note-clear'); if (clrBtn) clrBtn.style.display = 'none';
  }
  document.querySelectorAll('.bp-note-btn[data-sym="' + sym + '"][data-date="' + date + '"]')
    .forEach(function (btn) { btn.classList.remove('has-note'); });
}

// Handle "Add note" / "Delete note" button in popup expand bar
export function briefingNoteAction(sym, date, noteRow, actionBtn) {
  var entry = (state.briefing || []).find(function (e) { return e.sym === sym && e.date === date; });
  if (!entry || !noteRow) return;
  var noteWrap = noteRow.querySelector('.bp-note-wrap');
  var ta = noteRow.querySelector('textarea');
  var isShowing = noteWrap && noteWrap.style.display !== 'none';
  if (isShowing) {
    entry.note = '';
    entry.noteUpdatedAt = Date.now();
    saveBriefingLocal();
    syncBriefingNow();
    if (ta) ta.value = '';
    if (noteWrap) noteWrap.style.display = 'none';
    if (actionBtn) actionBtn.textContent = 'Add note';
    var compactRow = noteRow.previousElementSibling;
    if (compactRow) { var nb = compactRow.querySelector('.bp-note-btn'); if (nb) nb.classList.remove('has-note'); }
  } else {
    if (noteWrap) noteWrap.style.display = '';
    if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.focus(); }
    if (actionBtn) actionBtn.textContent = 'Delete note';
  }
}

export function toggleBpExpand(sym, date) {
  var key = sym + ':' + date;
  var popup = document.getElementById('bp-popup');
  if (!popup) return;
  var isExpanded = _expandedBpKey === key;
  // Collapse all
  popup.querySelectorAll('.bp-note-row').forEach(function (el) { el.style.display = 'none'; el.classList.remove('bp-row-active'); });
  popup.querySelectorAll('.bp-row.bp-row-active').forEach(function (el) { el.classList.remove('bp-row-active'); });
  popup.classList.remove('bp-has-expanded');
  _expandedBpKey = null;
  if (isExpanded) return;
  // Expand target
  var noteRow = document.getElementById('bp-note-' + sym + '-' + date);
  if (noteRow) {
    noteRow.style.display = '';
    noteRow.classList.add('bp-row-active');
    var ta = noteRow.querySelector('textarea');
    if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
    var compactRow = noteRow.previousElementSibling;
    if (compactRow) compactRow.classList.add('bp-row-active');
  }
  popup.classList.add('bp-has-expanded');
  _expandedBpKey = key;
}

export function toggleFvExpand(sym, date) {
  var key = sym + ':' + date;
  var drawer = document.getElementById('fv-briefing-drawer');
  if (!drawer) return;
  var isExpanded = _expandedFvKey === key;
  // Collapse all
  drawer.querySelectorAll('.bp-note-row').forEach(function (el) { el.style.display = 'none'; el.classList.remove('bp-row-active'); });
  drawer.querySelectorAll('.bp-row.bp-row-active').forEach(function (el) { el.classList.remove('bp-row-active'); });
  drawer.classList.remove('fvbd-has-expanded');
  _expandedFvKey = null;
  if (isExpanded) return;
  // Expand target
  var noteRow = drawer.querySelector('[id="bp-note-' + sym + '-' + date + '"]');
  if (noteRow) {
    noteRow.style.display = '';
    noteRow.classList.add('bp-row-active');
    var ta = noteRow.querySelector('textarea');
    if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
    var compactRow = noteRow.previousElementSibling;
    if (compactRow) compactRow.classList.add('bp-row-active');
  }
  drawer.classList.add('fvbd-has-expanded');
  _expandedFvKey = key;
}

export function briefingRemove(sym, date) {
  var idx = (state.briefing || []).findIndex(function (e) { return e.sym === sym && e.date === date; });
  if (idx >= 0) {
    var entry = state.briefing[idx];
    if (entry.note && entry.note.trim()) {
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

export function renderFVBriefingDrawer() {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (!drawer) return;
  var today = todayDate();
  var allEntries = state.briefing || [];
  if (!allEntries.length) {
    drawer.innerHTML = '<div class="fvbd-header"><span class="fvbd-title">Watchlist</span></div><div class="fvbd-empty">Watchlist is empty</div>';
    return;
  }
  // Group by date descending
  var dateMap = {};
  allEntries.forEach(function (e) { if (!dateMap[e.date]) dateMap[e.date] = []; dateMap[e.date].push(e); });
  var dates = Object.keys(dateMap).sort().reverse();
  var tab = state.briefingTab || 'coins';
  var tabs = '<div class="fvbd-tabs">'
    + '<button class="fvbd-tab pill' + (tab === 'coins' ? ' active' : '') + '" data-action="fvbd-tab" data-tab="coins">Coins</button>'
    + '<button class="fvbd-tab pill' + (tab === 'week' ? ' active' : '') + '" data-action="fvbd-tab" data-tab="week">Summary</button>'
    + '<button class="fvbd-tab pill' + (tab === 'ai' ? ' active' : '') + '" data-action="fvbd-tab" data-tab="ai">AI analysis</button>'
    + '</div>';
  var html = '<div class="fvbd-header"><span class="fvbd-title">Watchlist</span></div>' + tabs;
  if (tab === 'week') { drawer.innerHTML = html + _weekStatsHTML(); _refreshBriefingPct(); return; }
  if (tab === 'ai')   { drawer.innerHTML = html + _weekAIHTML();   _refreshBriefingPct(); return; }
  dates.forEach(function (date, idx) {
    var isToday = date === today;
    if (idx > 0 && dates[idx - 1] === today) html += '<div class="fvbd-divider"></div>';
    if (!isToday) html += '<div class="fvbd-date-label">' + fmtBriefingDate(date) + '</div>';
    dateMap[date].forEach(function (e) {
      var coin = state.coins.find(function (c) { return c.symbol === e.sym; });
      var change = coin ? ((coin.open_24h > 0 && coin.current_price > 0) ? (coin.current_price - coin.open_24h) / coin.open_24h * 100 : (coin.price_change_percentage_24h || 0)) : 0;
      var tradeInline = _tradeInlineHTML(e.sym, e.date);
      var tradeLocked = (function () { var t = state.trades[e.sym + ':' + e.date]; return t && t.count > 0; })();
      var isExpanded = _expandedFvKey === e.sym + ':' + e.date;
      var hasNote = !!e.note;
      var isCurrent = _fvSym === e.sym;
      html += '<div class="bp-row' + (isExpanded ? ' bp-row-active' : '') + (isCurrent ? ' fvbd-current' : '') + '" data-action="fvbd-expand" data-sym="' + e.sym + '" data-date="' + e.date + '">'
        + '<button class="bp-sym-btn" data-action="fvbd-open" data-sym="' + e.sym + '">' + e.sym.toUpperCase() + '</button>'
        + '<span class="bp-chg stat-val ' + (change >= 0 ? 'up' : 'dn') + '">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%</span>'
        + (tradeInline || '<span class="bp-row-status ' + briefingStatusClass(e.status) + '">' + briefingStatusLabel(e.status) + '</span>')
        + '<button class="btn-icon bp-note-btn' + (hasNote ? ' has-note' : '') + '" data-action="fvbd-expand" data-sym="' + e.sym + '" data-date="' + e.date + '">' + icon('sticky-note', 16) + '</button>'
        + (isToday
          ? '<button class="btn-icon bp-remove" data-action="bp-remove" data-sym="' + e.sym + '" data-date="' + e.date + '">' + icon('trash', 16) + '</button>'
          : '')
        + '</div>'
        + '<div class="bp-note-row' + (isExpanded ? ' bp-row-active' : '') + '" id="bp-note-' + e.sym + '-' + e.date + '"' + (isExpanded ? '' : ' style="display:none"') + '>'
        + '<div class="bp-expand-bar">'
        + (tradeLocked
          ? '<span class="bp-status-btn bp-status bp-s-traded bp-status-locked">' + icon('check-check', 16) + '<span class="bp-status-text">Traded</span></span>'
          : '<button class="bp-status-btn bp-status ' + briefingStatusClass(e.status) + '" data-action="bp-cycle-status" data-sym="' + e.sym + '" data-date="' + e.date + '">' + briefingStatusLabel(e.status) + '<span class="bp-status-text">' + briefingStatusText(e.status) + '</span></button>')
        + '<button class="acc-delete-cancel" data-action="bp-note-action" data-sym="' + e.sym + '" data-date="' + e.date + '">' + (hasNote ? 'Delete note' : 'Add note') + '</button>'
        + '</div>'
        + '<div class="bp-note-wrap"' + (hasNote ? '' : ' style="display:none"') + '>'
        + '<textarea placeholder="Note..." data-sym="' + e.sym + '" data-date="' + e.date + '">' + escHtml(e.note || '') + '</textarea>'
        + '</div>'
        + (isToday ? (function () {
          var _fullDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          var _hist = (state.briefing || []).filter(function (e2) { return e2.sym === e.sym && e2.date !== today && e2.note; });
          if (!_hist.length) return '';
          return '<div class="fvbd-history">' + _hist.map(function (e2) {
            var _p = e2.date.split('-'); var _d = new Date(+_p[0], +_p[1] - 1, +_p[2]);
            return '<div class="fvbd-history-item">'
              + '<span class="fvbd-history-date">' + _fullDays[_d.getDay()] + '</span>'
              + '<div class="fvbd-history-row">'
              + '<span class="fvbd-history-note">' + escHtml(e2.note) + '</span>'
              + '<span class="bp-row-status ' + briefingStatusClass(e2.status) + '">' + briefingStatusLabel(e2.status) + '</span>'
              + '</div>'
              + '</div>';
          }).join('') + '</div>';
        })() : '')
        + '</div>';
    });
  });
  drawer.innerHTML = html;
  _refreshBriefingPct();
  // Re-attach textarea listeners
  drawer.querySelectorAll('textarea[data-sym]').forEach(function (ta) {
    ta.addEventListener('input', function () {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      var sym = ta.dataset.sym, date = ta.dataset.date;
      var entry = (state.briefing || []).find(function (e) { return e.sym === sym && e.date === date; });
      if (entry) { entry.note = ta.value; entry.noteUpdatedAt = Date.now(); saveBriefingLocal(); }
      var noteBtn = drawer.querySelector('.bp-note-btn[data-sym="' + sym + '"][data-date="' + date + '"]');
      if (noteBtn) noteBtn.classList.toggle('has-note', !!ta.value);
    });
    ta.addEventListener('blur', function () { syncBriefingNow(); });
  });
  // Restore textarea height for expanded row after full re-render
  if (_expandedFvKey) {
    var _exParts = _expandedFvKey.split(':');
    var _exSym = _exParts[0], _exDate = _exParts.slice(1).join(':');
    var _exNoteRow = drawer.querySelector('[id="bp-note-' + _exSym + '-' + _exDate + '"]');
    if (_exNoteRow) {
      var _exTa = _exNoteRow.querySelector('textarea');
      if (_exTa) { _exTa.style.height = 'auto'; _exTa.style.height = _exTa.scrollHeight + 'px'; }
    }
  }
}

export function openFVBriefingDrawer() {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (!drawer) return;
  drawer.classList.add('open');
  renderFVBriefingDrawer();
  refreshBriefingFromServer();
}

export function closeFVBriefingDrawer() {
  var drawer = document.getElementById('fv-briefing-drawer');
  if (drawer) { drawer.classList.remove('open'); drawer.classList.remove('fvbd-has-expanded'); }
  _expandedFvKey = null;
  _applyFVTradeMarkers(null);
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
  var _qRaw = (query || '').trim().toLowerCase();
  var _qStripped = _qRaw.replace(/usdt$|usdc$|busd$|usd$|us$|u$/, '');
  var q = _qStripped || _qRaw;
  var coins = state.coins;
  var PINNED = ['btc', 'eth'];

  function rowHTML(c) {
    var change = c.price_change_percentage_24h || 0;
    var chgCls = change >= 0 ? 'up' : 'dn';
    var chgStr = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
    return '<button class="search-popup-row" data-action="search-pick" data-sym="' + c.symbol + '">' +
      '<span class="search-row-sym">' + c.symbol.toUpperCase() + '</span>' +
      '<span class="search-row-vol">' + fmt(c.total_volume || 0).replace('$', '') + '</span>' +
      '<span class="search-row-chg ' + chgCls + '">' + chgStr + '</span>' +
      '</button>';
  }

  if (q) {
    var filtered = coins.filter(function (c) {
      return c.symbol.toLowerCase().indexOf(q) !== -1 ||
             (c.name && c.name.toLowerCase().indexOf(q) !== -1);
    }).sort(function (a, b) {
      var aStarts = a.symbol.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      var bStarts = b.symbol.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0);
    });
    if (!filtered.length) {
      listEl.innerHTML = '<div class="search-popup-empty">Nothing found</div>';
      return;
    }
    listEl.innerHTML = filtered.map(rowHTML).join('');
  } else {
    var pinned = PINNED.map(function (sym) {
      return coins.find(function (c) { return c.symbol === sym; });
    }).filter(Boolean);
    var rest = coins.filter(function (c) { return PINNED.indexOf(c.symbol) === -1; })
      .slice().sort(function (a, b) {
        return (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0);
      });
    if (!pinned.length && !rest.length) {
      listEl.innerHTML = '<div class="search-popup-empty">Nothing found</div>';
      return;
    }
    var html = pinned.map(rowHTML).join('');
    if (pinned.length && rest.length) html += '<div class="search-divider"></div>';
    html += rest.map(rowHTML).join('');
    listEl.innerHTML = html;
  }
}

export function openSearchPopup() {
  var popup = document.getElementById('search-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'search-popup';
    popup.className = 'search-popup popup';
  }
  if (popup.parentNode) popup.parentNode.removeChild(popup);

  popup.innerHTML =
    '<div class="popup-header">' +
      '<span class="popup-title">Search coin</span>' +
      '<button class="btn-topbar" data-action="close-search">' + icon('x', 16) + '</button>' +
    '</div>' +
    '<div class="popup-body search-popup-input-wrap">' +
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
  popup._isFullscreenMode = _useFullscreenPopup();

  if (_useFullscreenPopup()) {
    _popupFullscreen(popup);
    var _list = popup.querySelector('.search-popup-list');
    if (_list) { _list.style.flex = '1'; _list.style.maxHeight = 'none'; _list.style.overflowY = 'auto'; _list.style.overscrollBehavior = 'contain'; }
    lockScroll();
  } else {
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
  unlockScroll();
}

// ── Clear popup ──────────────────────────────────────────────────────────────

export function closeClearPopup() {
  var o = document.getElementById('clear-popup-overlay');
  var p = document.getElementById('clear-popup');
  if (o) o.remove();
  if (p) p.remove();
}

export function openClearPopup(sym, btn) {
  closeClearPopup();

  var lCount = (_levels[sym] || []).length;
  var aCount = (_alerts[sym] || []).length;
  if (!lCount && !aCount) return;

  var overlay = document.createElement('div');
  overlay.id = 'clear-popup-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99998;';
  overlay.addEventListener('click', closeClearPopup);
  document.body.appendChild(overlay);

  var popup = document.createElement('div');
  popup.id = 'clear-popup';
  popup.className = 'clear-popup context-menu';
  popup.dataset.sym = sym;

  var html = '';
  if (lCount) html += '<button class="clear-popup-row" data-action="clear-levels" data-sym="' + sym + '">Price levels<span class="clear-count clear-count--level">' + lCount + '</span></button>';
  if (aCount) html += '<button class="clear-popup-row" data-action="clear-alerts" data-sym="' + sym + '">Alerts<span class="clear-count clear-count--alert">' + aCount + '</span></button>';
  popup.innerHTML = html;
  document.body.appendChild(popup);

  var btnRect = btn.getBoundingClientRect();
  var popupW = 220;
  var viewportH = window.innerHeight;
  var viewportW = window.innerWidth;
  var left = Math.min(btnRect.left, viewportW - popupW - 8);
  popup.style.left = Math.max(8, left) + 'px';
  if (btnRect.top > viewportH / 2) {
    popup.style.bottom = (viewportH - btnRect.top + 6) + 'px';
    popup.style.top = 'auto';
  } else {
    popup.style.top = (btnRect.bottom + 6) + 'px';
    popup.style.bottom = 'auto';
  }
}

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
  var t = document.createElement('div');
  t.className = 'notif-toast';
  t.textContent = entry.message;
  document.body.appendChild(t);
  setTimeout(function () { t.classList.add('notif-toast--visible'); }, 10);
  setTimeout(function () {
    t.classList.remove('notif-toast--visible');
    setTimeout(function () { t.remove(); }, 300);
  }, 4000);
}

export function updateNotifBadge() {
  var badge = document.getElementById('notif-badge');
  if (!badge) return;
  badge.style.display = state.notifUnread > 0 ? 'block' : 'none';
}

function _renderNotifDropdown() {
  var dd = document.getElementById('notif-dd');
  if (!dd) return;
  var items = state.notifications;
  var header = '<div class="popup-header"><span class="popup-title">Notifications</span><button class="btn-topbar" data-action="toggle-notif">' + icon('x', 16) + '</button></div>';
  var body = items.length
    ? '<div class="notif-scroll">'
      + items.map(function (n) {
          var ago = _timeAgo(n.createdAt);
          var ic = n.type === 'level' ? icon('trending-up', 14) : n.type === 'alert' ? icon('bell', 14) : icon('file-text', 14);
          return '<div class="notif-row">'
            + '<span class="notif-icon">' + ic + '</span>'
            + '<div class="notif-body">'
            + '<span class="notif-msg">' + escHtml(n.message) + '</span>'
            + '<span class="notif-time">' + ago + '</span>'
            + '</div>'
            + (n.sym ? '<button class="btn-icon" data-action="notif-open" data-sym="' + escHtml(n.sym) + '">' + icon('arrow-right', 14) + '</button>' : '')
            + '</div>';
        }).join('')
      + '</div>'
    : '<div class="notif-empty">No notifications yet</div>';
  var footer = '<div class="notif-footer">'
    + '<button class="notif-footer-btn" data-action="notif-clear">Clear all</button>'
    + '</div>';
  dd.innerHTML = header + body + footer;
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
  var dd = document.getElementById('notif-dd');
  if (!dd) return;
  var isOpen = dd.classList.contains('open');
  if (isOpen) {
    dd.classList.remove('open');
    if (dd._isFullscreenMode) {
      dd.style.cssText = '';
      unlockScroll();
      dd._isFullscreenMode = false;
    }
  } else {
    _renderNotifDropdown();
    dd.classList.add('open');
    dd._isFullscreenMode = _useFullscreenPopup();
    if (dd._isFullscreenMode) {
      _popupFullscreen(dd);
      lockScroll();
    }
    state.notifUnread = 0;
    updateNotifBadge();
    fetch(API_BASE + '/api/notifications', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark-read' }),
    }).catch(function () {});
  }
}

