// ── Order book terminal (DOM ladder) inside the coin full view ───────────────
// Trading happens only by clicking the ladder:
//   left click  → buy,  right click → sell
//   below the market a buy rests as a limit order; at/through it fills now
//   (limit IOC at the clicked price, so a fast market can't fill worse)
//   Shift+click → stop-loss / take-profit for the open position (close-position)
//   Option(Alt)+click → stop entry (STOP_MARKET with quantity): above the ask a
//   buy stop, below the bid a sell stop — direction by price, like Tiger
//   click on "Mine" cell → cancel your orders on that level; drag it → move them
//   hotkeys while the mouse is over the ladder: Space = close position, X = cancel all
// Ladder data comes from the trader's own environment (testnet or live), never
// from the main chart feed: testnet prices differ from the real market.

import { tradeRequest, refreshTradesAfterFill, saveTradeTag, setTradeEnv, wsConnected } from './api.js';
import { ensureSetups, setupButtons, diagramAttr } from './setups.js';
import { state } from './state.js';
import { on, emit } from './events.js';
import { icon } from './utils.js';
import { showToast, getCSSVar, chartMarks } from './ui.js';
import { startLatency, stopLatency, noteBookEvent, noteOrder, grade } from './latency.js';
import { levelPercentile, smoothScale, AUTO_PERCENTILE, parseUsd, formatUsdShort, colorThreshold, barRatio, trackMax } from './ladder-scale.js';
import { venuesStart, venuesStop, VENUES } from './venues.js';
import { booksStart, booksStop, bookRows, bookListed, bookAt, BOOK_VENUES } from './venue-books.js';
import { autoThreshold, hitStrength, tapeIntensity, HIT_WINDOW_MS, SIZE_HISTORY_MS, FRAME_PERCENTILE, TAPE_PERCENTILE } from './hit-stats.js';

var ROW_H = 16;
var SIZE_DEFAULTS = [10, 25, 50, 100, 250, 500]; // USDT per click
var SIZE_MIN = 5, SIZE_MAX = 500;
// Shown in the settings modal; mouse keys work over the ladder, keys while the mouse is over it
var HOTKEYS = [
  ['Left click', 'Buy at the level'],
  ['Right click', 'Sell at the level'],
  ['Shift + click', 'Stop-loss / take-profit'],
  ['Option + click', 'Stop order: buy above the market, sell below'],
  ['Click on Mine', 'Cancel your orders there'],
  ['Drag on Mine', 'Move your orders to another price'],
  ['Space', 'Close the position and cancel all orders on the coin'],
  ['X', 'Cancel all orders on the coin'],
  ['+ / −', 'Coarser / finer price scale'],
  ['1 … 6', 'Order size slot 1 … 6'],
  ['Esc', 'Close this window'],
];
var HIGHLIGHT_DEFAULT = 65;
// Clusters (Tiger-style): traded volume per price for each period, columns left of the ladder
var CLUSTER_TFS = { off: 0, '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 };
var CLUSTER_TF_DEFAULT = '5m';
var CLUSTER_COLS = 2;          // newest on the right, next to Mine
var TAPE_KEEP = 300;           // prints kept for the tape
var VENUE_SHORT = {};          // tape letter per venue (Binance futures unlabeled)
VENUES.forEach(function (v) { VENUE_SHORT[v.id] = v.short; });
var TAPE_MIN_FLOOR = 10;       // USD: never show prints smaller than this, whatever the auto threshold says
var TAPE_AUTO = -1;            // tapeMin value meaning "automatic" (hit-stats.js TAPE_PERCENTILE)
var TAPE_BIG_USD = 500;        // USD: from here a print is a square with its size written in it
var CLUSTER_BACKFILL_PAGES = 8; // ≤ 8 000 recent trades from REST when opening; older periods may be partial // with a full scale set, levels under this % of it are grey // Binance minimum notional … the agreed per-click cap
// Price step multipliers (Tiger "price scale"): one ladder row = tick × multiplier
var SCALES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
var OPEN_ORDER = { NEW: true, PARTIALLY_FILLED: true };
var OPEN_ALGO = { NEW: true, TRIGGERING: true };

// Ladder settings (gear in the panel head): per coin, kept in this browser.
// Reloaded when the ladder switches to another coin.
var S = _loadSettings(null);

var T = {
  mode: _lsGet('qt_term_mode') === 'test' ? 'test' : 'live', // Live / Test switch in the panel head
  vHits: {}, vSizes: {}, vThr: {}, vAuto: {}, vAutoAt: {}, // other venues: recent hits, trade sizes, thresholds, book scales
  access: null,          // null = unknown, false = no access, object = /status
  accessPromise: null,
  account: { balances: [], positions: [], orders: [], algoOrders: [] },
  open: _lsGet('qt_term_open') === '1',
  sym: null,             // 'JCTUSDT'
  rules: null,
  ws: null, wsTrades: null, wsTimer: null,
  bbo: null,             // latest bookTicker {b, B, a, A, u}: top of book, real-time
  lastTrade: null,       // {price, buy, at} from aggTrade
  pending: {},           // clientOrderId → {idx, kind, qty, at}: shown before the exchange confirms
  cancelling: {},
  closedIds: {},
  lastFillAt: {},         // symbol → exchange time of its latest fill
  tagQueue: [],           // closed trades waiting for a tag: {symbol, closeTime, setup, emotion}         // orderId/algoId seen closed by the stream (beats a late placement reply)        // orderId/algoId → true while a cancel is in flight
  bids: [], asks: [],    // [[price, qty], ...] best first
  scaleIdx: null, top: null, rows: 0,
  size: S.sizes[2],
  hover: false,
  hoverRow: null,        // ladder row under the cursor (screen position), for the % ruler
  // Live-market book on the testnet account (view only). The Testnet/Live book
  // button is gone since the Live/Test switch; kept off so old saved state can't lock trading.
  viewLive: false,
  pinned: false,         // user scrolled the ladder: stop auto-centering until the mouse leaves
  renderQueued: false,
  lines: [], linesSeries: null, linesKey: '',
  zone: null, zoneSeries: null,
  lastClick: { key: '', at: 0 },
};

// A remembered size that is no longer a slot falls back to the middle one
function _savedSize() {
  var v = Number(_lsGet('qt_term_size_' + T.sym));
  return S.sizes.indexOf(v) !== -1 ? v : S.sizes[Math.min(2, S.sizes.length - 1)];
}

// sizes: USDT per click; fullScale: USD at which a volume bar is full (0 = biggest level on screen);
// highlight: % of the full scale from which a bar is colored
// A coin without its own settings starts from the defaults
function _loadSettings(sym) {
  var s = null;
  try { s = sym ? JSON.parse(_lsGet('qt_term_settings_' + sym) || 'null') : null; } catch (e) {}
  s = s || {};
  var sizes = Array.isArray(s.sizes) ? s.sizes.map(Number).filter(_validSize) : [];
  return {
    sizes: sizes.length ? sizes.slice(0, SIZE_DEFAULTS.length) : SIZE_DEFAULTS.slice(),
    fullScale: Number(s.fullScale) > 0 ? Number(s.fullScale) : 0,
    highlight: Number(s.highlight) > 0 && Number(s.highlight) <= 100 ? Number(s.highlight) : HIGHLIGHT_DEFAULT,
    clusterTf: CLUSTER_TFS[s.clusterTf] != null ? s.clusterTf : CLUSTER_TF_DEFAULT,
    tape: s.tape !== false,                                   // trades tape left of the clusters
    venues: s.venues !== false,                               // other venues: books next to the ladder + their trades on the tape
    venueFull: s.venueFull !== false,                         // those books as full ladders (bars) or compact numbers
    // USD; smaller prints are dropped. Automatic by default (the old default 10 counts as automatic)
    tapeMin: s.tapeMin != null && Number(s.tapeMin) >= 0 && Number(s.tapeMin) !== 10 ? Number(s.tapeMin) : TAPE_AUTO,
    hitMin: Number(s.hitMin) > 0 ? Number(s.hitMin) : 0,      // frames on other venues' books: USD, 0 = automatic
  };
}

function _validSize(v) { return v >= SIZE_MIN && v <= SIZE_MAX; }
function _saveSettings() { _lsSet('qt_term_settings_' + T.sym, JSON.stringify(S)); }

function _lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function _lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

// ── Access ─────────────────────────────────────────────────────────────────

setTradeEnv(T.mode);

export function checkAccess() {
  if (T.access) return Promise.resolve(T.access);
  if (T.accessPromise) return T.accessPromise;
  T.accessPromise = tradeRequest('GET', 'status').then(function (s) {
    T.access = s;
    return tradeRequest('GET', 'account').then(function (a) { T.account = a; emit('terminal:account'); return s; });
  }).catch(function () {
    // Test trader down or no testnet key: fall back to Live so the terminal stays reachable
    if (T.mode === 'test') {
      _setMode('live');
      T.accessPromise = null;
      showToast('Test mode is unavailable — switched to Live');
      return checkAccess();
    }
    T.access = false;
    return false;
  }).finally(function () { T.accessPromise = null; });
  return T.accessPromise;
}

// Account data can miss a load (the server restarting, a dropped socket) and
// then the panel would show no balance until a page reload: reload it after
// every reconnect (a failed access check is retried here too), and every 15 s
// while the panel is open without a USDT balance
var _wsWasUp = false;
on('ws:status', function () {
  if (wsConnected && !_wsWasUp) _reloadAccount();
  _wsWasUp = wsConnected;
});
setInterval(function () {
  var hasUsdt = T.account.balances.some(function (b) { return b.asset === 'USDT'; });
  if (T.open && T.sym && T.access && !hasUsdt) _reloadAccount();
}, 15000);

function _reloadAccount() {
  if (!T.open || !T.sym) return;
  if (T.access === false) {
    // The first check failed: ask again and rebuild the panel when it works
    T.access = null;
    checkAccess().then(function (s) {
      if (!s || !T.open) return;
      var sym = T.sym;
      T.sym = null;
      _openPanel(sym);
    });
    return;
  }
  if (!T.access) return;
  tradeRequest('GET', 'account').then(function (a) {
    if (!a || !a.balances) return;
    T.account = a;
    emit('terminal:account');
    _queueRender();
  }).catch(function () {});
}

function _setMode(m) {
  T.mode = m;
  _lsSet('qt_term_mode', m);
  setTradeEnv(m);
  _markMode();
}

// Test mode is marked on the whole panel (top bar + watermark), so a demo
// ladder can't be mistaken for the live one
function _markMode() {
  var panel = document.getElementById('fv-dom');
  if (panel) panel.classList.toggle('mode-test', T.mode === 'test');
}

// Live ↔ Test: different trader, account, book and orders — rebuild the panel from scratch
function _switchMode(m) {
  if (m === T.mode) return;
  var sym = T.sym;
  _setMode(m);
  _disconnectDepth();
  _clearLines();
  _clearBand();
  T.access = null;
  T.account = { balances: [], positions: [], orders: [], algoOrders: [] };
  T.pending = {}; T.cancelling = {}; T.closedIds = {}; T.tagQueue = [];
  T.sym = null;
  checkAccess().then(function (s) {
    if (s && sym) _openPanel(sym);
  });
}

// ── Full view hooks (called from ui.js) ─────────────────────────────────────

export function terminalOnFVOpen(shortSym) {
  var sym = shortSym.toUpperCase() + 'USDT';
  if (window.innerWidth < 900) return; // desktop only for now
  checkAccess().then(function (s) {
    if (!s) return;
    var btn = document.getElementById('fv-dom-btn');
    if (btn) { btn.style.display = 'inline-flex'; btn.classList.toggle('active', T.open); }
    if (T.open) _openPanel(sym);
  });
}

export function terminalOnFVClose() {
  _closePanel(false);
}

export function toggleTerminal() {
  if (T.open) { _closePanel(true); return; }
  var sym = window.__fvSymbol ? String(window.__fvSymbol).toUpperCase() + 'USDT' : null;
  if (!sym) return;
  T.open = true;
  _lsSet('qt_term_open', '1');
  var btn = document.getElementById('fv-dom-btn');
  if (btn) btn.classList.add('active');
  _openPanel(sym);
}

// ── Panel lifecycle ─────────────────────────────────────────────────────────

function _openPanel(sym) {
  var body = document.querySelector('#fv-overlay .fv-body');
  if (!body) return;
  var panel = document.getElementById('fv-dom');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'fv-dom';
    panel.className = 'fv-dom';
    body.appendChild(panel);
    _bindPanel(panel);
  }
  body.classList.add('has-dom');
  _markMode();
  if (T.sym !== sym) {
    T.sym = sym;
    S = _loadSettings(sym);
    T.size = _savedSize();
    T.rules = null; T.rulesError = null; T.bids = []; T.asks = []; T.scaleIdx = null; T.top = null; T.autoFull = null; T.autoMed = null; T.autoMax = null;
    tradeRequest('GET', 'rules?symbol=' + sym).then(function (r) {
      if (T.sym !== sym) return;
      T.rules = r;
      _queueRender();
    }).catch(function (e) {
      if (T.sym !== sym) return;
      T.rulesError = e.message;
      _queueRender();
    });
    _connectDepth();
    venuesStart(sym, function (venue, price, usd, buy, time) {
      if (venue !== 'BF' && !S.venues) return;
      _tapeAdd(price, usd, buy, time, venue);
      // A venue trading at a price flashes its column cell there (who is eating the level)
      var now = Date.now();
      var hits = T.vHits[venue] || (T.vHits[venue] = []);
      // What stood on that price when the trade came (buyers take asks, sellers bids)
      hits.push({ p: price, buy: buy, at: now, usd: usd, before: bookAt(venue, price, buy ? 'ask' : 'bid') });
      if (hits.length > 200) hits.splice(0, hits.length - 200);
      // The venue's recent trade sizes → its automatic thresholds
      var sz = T.vSizes[venue] || (T.vSizes[venue] = []);
      sz.push({ t: now, usd: usd });
      if (sz.length > 4000 || (sz.length > 50 && now - sz[0].t > SIZE_HISTORY_MS + 30000)) {
        var cut = 0;
        while (cut < sz.length && (now - sz[cut].t > SIZE_HISTORY_MS || sz.length - cut > 3000)) cut++;
        sz.splice(0, cut);
      }
    });
    booksStart(sym, function () { _syncVenueCols(); window.dispatchEvent(new Event('resize')); });
  }
  panel.innerHTML = _panelHTML();
  panel.classList.toggle('view-only', _viewOnly());
  T.lockKey = null;
  _renderLock();
  _renderTag();
  _refreshDay();
  clearInterval(T.dayTimer);
  T.dayTimer = setInterval(_refreshDay, 30000);
  startLatency(_renderPing);
  _renderPing();
  _syncVenueCols();
  _queueRender();
}

function _closePanel(userAction) {
  if (userAction) {
    T.open = false;
    _lsSet('qt_term_open', '0');
    var btn = document.getElementById('fv-dom-btn');
    if (btn) btn.classList.remove('active');
  }
  _disconnectDepth();
  _clearLines();
  _clearBand();
  stopLatency();
  venuesStop();
  booksStop();
  clearInterval(T.dayTimer);
  T.sym = null;
  var panel = document.getElementById('fv-dom');
  if (panel) panel.remove();
  var body = document.querySelector('#fv-overlay .fv-body');
  if (body) body.classList.remove('has-dom');
}

function _isTestnet() { return !(T.access && T.access.env === 'mainnet'); }
function _viewOnly() { return _isTestnet() && T.viewLive; }

function _panelHTML() {
  return '<div class="dom-head">'
    + '<span class="dom-mode" title="Live: real account · Test: Binance Demo, practice money">'
    + '<button data-mode="live" class="' + (T.mode === 'live' ? 'active live' : '') + '">Live</button>'
    + '<button data-mode="test" class="' + (T.mode === 'test' ? 'active test' : '') + '">Test</button></span>'
    + '<span class="dom-ping" id="dom-ping" tabindex="0"><i></i><b>— ms</b><span class="dom-ping-pop" id="dom-ping-pop"></span></span>'
    + '<div class="dom-scale" title="Price scale: one row = exchange tick × multiplier">'
    + '<button data-scale="-1" title="Finer">−</button><span class="dom-scale-val" id="dom-scale-val"></span>'
    + '<button data-scale="1" title="Coarser">+</button></div>'
    + '<button class="dom-gear" data-settings="1" title="Order book settings">' + icon('settings', 14) + '</button>'
    + '</div>'
    + (_viewOnly() ? '<div class="dom-viewonly">Live market · view only — trading is off</div>' : '')
    + '<div class="dom-lock" id="dom-lock"></div>'
    + '<div class="dom-tag" id="dom-tag"></div>'
    + '<div class="dom-cols"><span>Mine</span><span>Volume, $</span><span>Price</span>'
    + '<span class="dom-cols-cl" id="dom-cols-cl" data-cl-tf="1" title="Clusters: traded volume per price for each period. Click to change the period">'
    + new Array(CLUSTER_COLS + 1).join('<b></b>') + '</span><span class="dom-cols-tape">Tape</span>'
    + '<span class="dom-cols-ven">' + BOOK_VENUES.map(function (v) {
        return '<b data-vcol="' + v.id + '" title="' + v.title + ' order book — click to fold / unfold">' + v.name + '</b>';
      }).join('') + '</span></div>'
    + '<div class="dom-ladder" id="dom-ladder"></div>'
    + '<div class="dom-sizes" id="dom-sizes">' + _sizesHTML() + '</div>'
    + '<div class="dom-foot">'
    + '<div class="dom-pos" id="dom-pos"></div>'
    + '<div class="dom-status" id="dom-status"></div>'
    + '</div>';
}

function _sizesHTML() {
  return S.sizes.map(function (v) {
    return '<button class="dom-size' + (v === T.size ? ' active' : '') + '" data-size="' + v + '">' + v + '</button>';
  }).join('') + '<span class="dom-unit">USDT</span>';
}

// Settings modal: changes apply as you type (on change), Done just closes it
function _openSettings() {
  if (document.getElementById('dom-settings-modal')) return;
  var ov = document.createElement('div');
  ov.id = 'dom-settings-modal';
  ov.className = 'overlay dom-settings-overlay';
  ov.innerHTML = '<div class="popup dom-settings-popup" role="dialog" aria-label="Order book settings">'
    + '<div class="popup-header"><span class="popup-title">Order book settings · ' + T.sym.replace(/USDT$/, '') + '</span><button class="btn-topbar" data-set-close="1">' + icon('x', 14) + '</button></div>'
    + '<div class="popup-body">' + _settingsHTML() + '</div>'
    + '<div class="popup-footer"><button class="btn-cta" data-set-close="1">Done</button></div>'
    + '</div>';
  document.body.appendChild(ov);
  ov.addEventListener('change', function (e) { if (e.target.closest('#dom-settings')) _applySettingInput(e.target); });
  ov.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-chip]');
    if (chip) { _applyChip(chip); return; }
    if (e.target === ov || e.target.closest('[data-set-close]')) _closeSettings();
  });
  document.addEventListener('keydown', _settingsKey);
  var first = ov.querySelector('input');
  if (first) first.focus();
}

function _closeSettings() {
  var ov = document.getElementById('dom-settings-modal');
  if (!ov) return;
  // Apply a value typed but not yet committed (no blur before Done/Esc)
  var a = document.activeElement;
  if (a && ov.contains(a) && a.tagName === 'INPUT') _applySettingInput(a);
  ov.remove();
  document.removeEventListener('keydown', _settingsKey);
}

function _settingsKey(e) {
  // Esc is handled globally in main.js (topmost modal first)
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); _closeSettings(); }
}

// Quick values under a field; the active one is highlighted
function _chipsHTML(kind, current, list) {
  return '<div class="dom-chips">' + list.map(function (c) {
    return '<button type="button" class="dom-chip' + (Number(current) === c[0] ? ' active' : '') + '" data-chip="' + kind + '" data-value="' + c[0] + '">' + c[1] + '</button>';
  }).join('') + '</div>';
}

function _switchHTML(key, label, on) {
  return '<label class="dom-set-switch"><span>' + label + '</span>'
    + '<span class="ds-switch"><input type="checkbox" data-set-' + key + '="1"' + (on ? ' checked' : '') + '><i></i></span></label>';
}

function _settingsHTML() {
  return '<div class="dom-settings" id="dom-settings">'
    + '<div class="dom-set-row"><span>Order sizes, USDT</span><div class="dom-set-sizes">'
    + SIZE_DEFAULTS.map(function (_, i) {
        return '<input class="ds-input" type="number" inputmode="decimal" min="' + SIZE_MIN + '" max="' + SIZE_MAX + '" data-set-size="' + i + '" value="' + (S.sizes[i] != null ? S.sizes[i] : '') + '">';
      }).join('')
    + '</div></div>'
    + '<div class="dom-set-row"><span>Volume bar is full at, $</span>'
    + '<input class="ds-input" type="text" inputmode="text" autocomplete="off" data-set-full="1" placeholder="Auto' + (T.autoFull ? ' · now ≈ ' + formatUsdShort(T.autoFull) : '') + '" value="' + formatUsdShort(S.fullScale) + '">'
    + _chipsHTML('full', S.fullScale, [[0, 'Auto'], [250e3, '250K'], [500e3, '500K'], [1e6, '1M'], [2e6, '2M'], [5e6, '5M']])
    + '<span class="dom-set-note">Type 2M, 500K or 1.5M. Empty or Auto — set from the levels on screen.</span></div>'
    + '<div class="dom-set-row"><span>Colored from, % of a full bar</span>'
    + _chipsHTML('hl', S.highlight, [[50, '50%'], [60, '60%'], [65, '65%'], [70, '70%'], [80, '80%'], [90, '90%']])
    + '<span class="dom-set-note">Smaller levels stay grey. In Auto a level is also colored only if it\'s ≥ 3× the typical one — a flat book stays grey.</span></div>'
    + _switchHTML('tape', 'Trades tape', S.tape)
    + '<div class="dom-set-row"><span>Tape: hide trades under, $</span>'
    + '<input class="ds-input" type="text" inputmode="text" autocomplete="off" data-set-tape-min="1" placeholder="'
      + (S.tapeMin === TAPE_AUTO ? 'Auto · now ≈ ' + (formatUsdShort(_tapeMinFor('BF')) || '10') : 'Show all') + '" value="' + (S.tapeMin > 0 ? formatUsdShort(S.tapeMin) : '') + '">'
    + _chipsHTML('tmin', S.tapeMin, [[TAPE_AUTO, 'Auto'], [0, 'All'], [100, '100'], [500, '500'], [1e3, '1K'], [5e3, '5K']])
    + '<span class="dom-set-note">Auto — bigger than most trades on that venue lately.</span></div>'
    + _switchHTML('venues', 'Other venues: books and their trades on the tape', S.venues)
    + _switchHTML('venue-full', 'Other venues as full books (bars like ours)', S.venueFull)
    + '<div class="dom-set-row"><span>Frames on other venues from, $</span>'
    + _chipsHTML('hitmin', S.hitMin, [[0, 'Auto'], [1e3, '1K'], [5e3, '5K'], [1e4, '10K'], [5e4, '50K']])
    + '<span class="dom-set-note">Auto — a hit bigger than 90% of that venue\'s recent trades, or one that ate 20%+ of the level.</span></div>'
    + '<div class="dom-set-row"><span>Clusters period</span><select class="ds-input" data-set-cluster="1">'
    + Object.keys(CLUSTER_TFS).map(function (k) { return '<option value="' + k + '"' + (k === S.clusterTf ? ' selected' : '') + '>' + (k === 'off' ? 'Off' : k) + '</option>'; }).join('')
    + '</select></div>'
    + '<div class="dom-set-hint">Order sizes ' + SIZE_MIN + '–' + SIZE_MAX + ' USDT, an empty slot hides it.</div>'
    + '<div class="dom-set-row"><span>Hotkeys · all coins</span><div class="dom-keys">'
    + HOTKEYS.map(function (k) { return '<kbd>' + k[0] + '</kbd><span>' + k[1] + '</span>'; }).join('')
    + '</div></div>'
    + '</div>';
}

// Re-draw the modal body (chips' active state) keeping the focused field
function _refreshSettings() {
  var box = document.getElementById('dom-settings');
  if (box) box.outerHTML = _settingsHTML();
}

function _applyChip(btn) {
  var v = Number(btn.dataset.value);
  if (btn.dataset.chip === 'full') S.fullScale = v;
  else if (btn.dataset.chip === 'hl') S.highlight = v;
  else if (btn.dataset.chip === 'tmin') S.tapeMin = v;
  else if (btn.dataset.chip === 'hitmin') S.hitMin = v;
  _saveSettings();
  _refreshSettings();
  _queueRender();
}

function _applySettingInput(inp) {
  if (inp.dataset.setCluster) {
    _setClusterTf(inp.value);
    return;
  } else if (inp.dataset.setVenueFull) {
    S.venueFull = inp.checked;
    _syncVenueCols();
    window.dispatchEvent(new Event('resize'));
  } else if (inp.dataset.setVenues) {
    S.venues = inp.checked;
    _syncVenueCols();
    window.dispatchEvent(new Event('resize'));
  } else if (inp.dataset.setTape) {
    S.tape = inp.checked;
    _syncClusterLayout();
    window.dispatchEvent(new Event('resize'));
  } else if (inp.dataset.setTapeMin) {
    S.tapeMin = parseUsd(inp.value);
    inp.value = formatUsdShort(S.tapeMin);
    _refreshSettings();
  } else if (inp.dataset.setFull) {
    S.fullScale = parseUsd(inp.value); // "2M", "500K" or plain dollars; empty = auto
    inp.value = formatUsdShort(S.fullScale);
    _refreshSettings();
  } else {
    var vals = [];
    document.querySelectorAll('#dom-settings [data-set-size]').forEach(function (el) {
      if (el.value === '') return;
      var v = Number(el.value);
      if (!_validSize(v)) { el.value = ''; showToast('Order size must be ' + SIZE_MIN + '–' + SIZE_MAX + ' USDT'); return; }
      if (vals.indexOf(v) === -1) vals.push(v);
    });
    S.sizes = vals.length ? vals.sort(function (a, b) { return a - b; }) : SIZE_DEFAULTS.slice();
    if (S.sizes.indexOf(T.size) === -1) { T.size = _savedSize(); _lsSet('qt_term_size_' + T.sym, String(T.size)); }
    var box = document.getElementById('dom-sizes');
    if (box) box.innerHTML = _sizesHTML();
  }
  _saveSettings();
  _queueRender();
}

// Binance Demo lists fewer coins than the real exchange (≈560 of ≈750)
function _rulesErrorText(err) {
  var coin = (T.sym || '').replace(/USDT$/, '');
  if (/unknown symbol/i.test(err) && T.mode === 'test') {
    return coin + ' is not listed on Binance Demo, so it can\'t be traded in Test mode.<br>Open another coin or switch to Live.';
  }
  return 'Could not load ' + coin + ' trading rules: ' + err;
}

// ── Clusters ────────────────────────────────────────────────────────────────
// Every market trade (aggTrade) adds price × qty (USDT) to its price in the
// column of its period. On open, recent trades come from REST (newest first,
// up to CLUSTER_BACKFILL_PAGES × 1000); a column the backfill didn't fully
// cover is marked partial. Live trades that arrive meanwhile wait in a buffer
// and are added after it, skipping ids the backfill already counted.

function _clusterTfSec() { return CLUSTER_TFS[S.clusterTf] || 0; }

function _clusterStart(rest, sym) {
  var tf = _clusterTfSec();
  var cl = T.cl = { tf: tf, sym: sym, cols: {}, ready: false, buffer: [], topId: 0, coveredFrom: null, ver: 0, cache: {} };
  _syncClusterLayout();
  if (!tf) return;
  var oldest = (Math.floor(Date.now() / 1000 / tf) - CLUSTER_COLS + 1) * tf * 1000;
  var pages = 0;
  function page(endId) {
    var url = rest + '/fapi/v1/aggTrades?symbol=' + sym + '&limit=1000' + (endId != null ? '&fromId=' + Math.max(0, endId - 999) : '');
    return fetch(url).then(function (r) { return r.json(); }).then(function (list) {
      if (T.cl !== cl || !Array.isArray(list) || !list.length) return;
      if (endId == null && !T.tape.length) {
        list.slice(-TAPE_KEEP).forEach(function (t) { _tapeAdd(Number(t.p), Number(t.p) * Number(t.q), !t.m, t.T, 'BF'); });
      }
      list.forEach(function (t) {
        if (endId != null && t.a > endId) return;
        if (t.a > cl.topId) cl.topId = t.a;
        _clusterAdd(cl, t.p, Number(t.q), t.T);
      });
      cl.coveredFrom = list[0].T;
      pages++;
      if (list[0].T > oldest && pages < CLUSTER_BACKFILL_PAGES && list[0].a > 0) return page(list[0].a - 1);
    });
  }
  page(null).catch(function () {}).then(function () {
    if (T.cl !== cl) return;
    cl.ready = true;
    cl.buffer.forEach(function (t) { if (t.a > cl.topId) _clusterAdd(cl, t.p, t.q, t.T); });
    cl.buffer = [];
    _queueRender();
  });
}

function _clusterTrade(a, p, q, time) {
  var cl = T.cl;
  if (!cl || !cl.tf) return;
  if (!cl.ready) { cl.buffer.push({ a: a, p: p, q: q, T: time }); return; }
  _clusterAdd(cl, p, q, time);
}

function _clusterAdd(cl, p, q, time) {
  var start = Math.floor(time / 1000 / cl.tf) * cl.tf;
  var col = cl.cols[start];
  if (!col) {
    col = cl.cols[start] = {};
    var keys = Object.keys(cl.cols).map(Number).sort(function (x, y) { return x - y; });
    while (keys.length > CLUSTER_COLS) delete cl.cols[keys.shift()];
  }
  col[p] = (col[p] || 0) + Number(p) * q;
  cl.ver++;
}

// Columns for the current step, newest last: [{ start, partial, byIdx: {rowIdx: usd}, max }]
function _clusterView(step) {
  var cl = T.cl;
  if (!cl || !cl.tf) return null;
  var nowStart = Math.floor(Date.now() / 1000 / cl.tf) * cl.tf;
  var key = cl.ver + ':' + step + ':' + nowStart; // a new period shifts the columns even before its first trade
  if (cl.cache.key === key) return cl.cache.view;
  var view = [];
  for (var k = CLUSTER_COLS - 1; k >= 0; k--) {
    var start = nowStart - k * cl.tf;
    var col = cl.cols[start] || {};
    var byIdx = {}, max = 0;
    Object.keys(col).forEach(function (p) {
      var i = Math.round(Number(p) / step);
      byIdx[i] = (byIdx[i] || 0) + col[p];
      if (byIdx[i] > max) max = byIdx[i];
    });
    view.push({ start: start, partial: cl.coveredFrom != null && cl.coveredFrom > start * 1000, byIdx: byIdx, max: max });
  }
  cl.cache = { key: key, view: view };
  _renderClusterHead(view);
  return view;
}

// Brighter cell = more traded at that price in that period (relative to the column's max)
function _setClusterCells(box, i, view) {
  for (var k = 0; k < view.length; k++) {
    var cell = box.children[k], v = view[k].byIdx[i] || 0;
    var t = v ? _fmtQty(v) : '';
    var a = v && view[k].max ? Math.round(8 + 42 * v / view[k].max) : 0;
    if (cell._t !== t) { cell.textContent = t; cell._t = t; }
    if (cell._a !== a) {
      cell.style.background = a ? 'color-mix(in srgb, var(--primary) ' + a + '%, transparent)' : '';
      cell._a = a;
      cell.classList.toggle('top', !!v && v === view[k].max);
    }
  }
}

function _renderClusterHead(view) {
  var head = document.getElementById('dom-cols-cl');
  if (!head) return;
  view.forEach(function (c, k) {
    var d = new Date(c.start * 1000);
    var t = (k === 0 ? S.clusterTf + ' ' : '') + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + (c.partial ? '*' : '');
    var cell = head.children[k];
    if (cell && cell.textContent !== t) cell.textContent = t;
    if (cell) cell.title = c.partial ? 'Partial: older trades of this period were not loaded' : '';
  });
}

function _syncClusterLayout() {
  var panel = document.getElementById('fv-dom');
  if (!panel) return;
  panel.classList.toggle('has-cl', !!_clusterTfSec());
  panel.classList.toggle('has-tape', !!S.tape);
}

function _setClusterTf(tf) {
  if (CLUSTER_TFS[tf] == null) return;
  S.clusterTf = tf;
  _saveSettings();
  if (T.book && T.sym) _clusterStart(T.book.rest, T.sym); else _syncClusterLayout();
  window.dispatchEvent(new Event('resize')); // the chart takes back / gives up the width
  _queueRender();
}

// ── Trades tape (Tiger-style) ───────────────────────────────────────────────
// Each market trade is a circle on the row of its price, newest at the right
// edge (next to the clusters), older ones step left; blue = buy, red = sell,
// size ∝ √USDT relative to the biggest print shown. Trades at the same
// millisecond and side merge into one print (one aggressive order). Prints
// under the tape minimum (automatic per venue by default) are dropped; size and
// brightness are relative: the minimum is palest, the biggest print on screen
// solid (hit-stats.js tapeIntensity); from TAPE_BIG_USD a print is a square
// with its size in it.
// A thin line joins the prints.

// Smallest print the tape shows for a venue: the coin's own setting, or
// automatic — the venue's usual trade size (TAPE_PERCENTILE), never under 10 $
function _tapeMinFor(venue) {
  if (S.tapeMin !== TAPE_AUTO) return S.tapeMin;
  return Math.max(TAPE_MIN_FLOOR, _venueThreshold(venue || 'BF', TAPE_PERCENTILE) || 0);
}

function _tapeAdd(p, usd, buy, time, venue) {
  if (!T.tape) T.tape = [];
  var last = T.tape[T.tape.length - 1];
  if (last && last.t === time && last.buy === buy && last.v === venue) { last.usd += usd; last.p = p; return; }
  T.tape.push({ p: p, usd: usd, buy: buy, t: time, v: venue || 'BF' });
  if (T.tape.length > TAPE_KEEP) T.tape.shift();
}

function _drawTape(step) {
  var ladder = document.getElementById('dom-ladder');
  var panel = document.getElementById('fv-dom');
  if (!ladder || !panel) return;
  var cv = document.getElementById('dom-tape');
  if (!S.tape) { if (cv) cv.style.display = 'none'; return; }
  if (!cv) {
    // On the panel, not inside the ladder: the ladder's children are its rows
    cv = document.createElement('canvas');
    cv.id = 'dom-tape';
    cv.className = 'dom-tape';
    panel.appendChild(cv);
  }
  var w = cv.offsetWidth, h = ladder.clientHeight, dpr = window.devicePixelRatio || 1;
  cv.style.display = '';
  cv.style.top = ladder.offsetTop + 'px';
  cv.style.height = h + 'px';
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  var ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  var tape = T.tape || [];
  if (!tape.length || T.top == null) return;
  ctx.font = getCSSVar('--font-bold') + ' 10px ' + getCSSVar('--font-family');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Lay out from the newest (right edge) back in time: each print takes its own
  // width, so squares sit side by side with readable numbers instead of piling up
  var recent = tape.slice(-200).filter(function (x) { return x.usd >= _tapeMinFor(x.v); });
  // Relative hierarchy: the tape's minimum is the palest and smallest, the
  // biggest print on screen the brightest and largest (log steps in between),
  // so a jump in hit size stands out whatever the minimum is set to
  var minUsd = Infinity, maxUsd = 0;
  recent.forEach(function (x) { var m = _tapeMinFor(x.v); if (m < minUsd) minUsd = m; if (x.usd > maxUsd) maxUsd = x.usd; });
  if (!isFinite(minUsd)) minUsd = TAPE_MIN_FLOOR;
  var items = [], right = w - 2;
  for (var j = recent.length - 1; j >= 0 && right > 0; j--) {
    var x = recent[j];
    var t = tapeIntensity(x.usd, minUsd, maxUsd);
    var r = 5 + 11 * t;
    var it = { x: x, t: t, y: (T.top - Math.round(x.p / step)) * ROW_H + ROW_H / 2, kind: 'bubble', r: r, bw: 2 * r, bh: 2 * r };
    it.venue = VENUE_SHORT[x.v] || '';
    if (x.usd >= TAPE_BIG_USD) {
      it.kind = 'square';
      it.label = (it.venue ? it.venue + ' ' : '') + _fmtQty(x.usd);
      it.bw = Math.max(2 * r, ctx.measureText(it.label).width + 8);
      it.bh = Math.max(2 * r, 16);
    }
    it.cx = right - it.bw / 2;
    right -= it.bw - Math.min(4, it.bw / 4); // slight overlap, like Tiger
    items.push(it);
  }
  items.reverse(); // oldest first: newer prints are drawn on top
  ctx.strokeStyle = getCSSVar('--graphite');
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1;
  ctx.beginPath();
  items.forEach(function (it, k) { if (k) ctx.lineTo(it.cx, it.y); else ctx.moveTo(it.cx, it.y); });
  ctx.stroke();
  var buyC = getCSSVar('--primary'), sellC = getCSSVar('--danger'), inkC = getCSSVar('--ink-deep');
  items.forEach(function (it) {
    if (it.y < -20 || it.y > h + 20) return;
    ctx.fillStyle = it.x.buy ? buyC : sellC;
    var alpha = 0.22 + 0.78 * it.t;            // pale at the minimum → solid for the biggest
    var ink = it.t < 0.45 ? inkC : '#fff';     // dark text on pale fills, white on strong ones
    if (it.kind === 'bubble') {
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(it.cx, it.y, it.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = getCSSVar('--paper'); // thin rim keeps overlapping bubbles apart
      ctx.stroke();
      if (it.venue && it.r >= 6) { ctx.fillStyle = ink; ctx.fillText(it.venue, it.cx, it.y + 0.5); } // other venue: its letter
      return;
    }
    ctx.globalAlpha = alpha;
    ctx.fillRect(it.cx - it.bw / 2, it.y - it.bh / 2, it.bw, it.bh);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = getCSSVar('--paper');
    ctx.strokeRect(it.cx - it.bw / 2, it.y - it.bh / 2, it.bw, it.bh);
    ctx.fillStyle = ink; // white on strong blue / red (as the chart labels), dark on pale ones
    ctx.fillText(it.label, it.cx, it.y + 0.5);
  });
  ctx.globalAlpha = 1;
}

// ── Other venues' books: columns right of Price ─────────────────────────────
// Spot, Bybit, OKX in that order, each a column of USDT resting at the row's
// price (bids blue, asks red), on the same dollar scale as our ladder. A cell flashes when that venue trades there.
// Click a header to fold / unfold one column (remembered in this browser).

// Compact: a number per row; full: a bar ladder like our Volume column
var VEN_W = 46, VEN_FULL_W = 112, VEN_FOLDED_W = 18;

function _venueFolded() {
  try { return JSON.parse(_lsGet('qt_term_vcols') || '{}') || {}; } catch (e) { return {}; }
}

function _syncVenueCols() {
  var panel = document.getElementById('fv-dom');
  if (!panel) return;
  var folded = _venueFolded();
  // Not listed on that venue → always folded to its (red) letter
  var widths = BOOK_VENUES.map(function (v) { return !S.venues ? 0 : folded[v.id] || bookListed(v.id) === false ? VEN_FOLDED_W : S.venueFull ? VEN_FULL_W : VEN_W; });
  var total = widths.reduce(function (a, b) { return a + b; }, 0);
  panel.style.setProperty('--ven-w', total + 'px');
  panel.style.setProperty('--ven-cols', widths.map(function (w) { return w + 'px'; }).join(' '));
  panel.classList.toggle('has-ven', !!S.venues);
  panel.classList.toggle('ven-full', !!S.venueFull);
  panel.querySelectorAll('[data-vcol]').forEach(function (b) {
    var v = BOOK_VENUES.find(function (x) { return x.id === b.dataset.vcol; });
    var na = bookListed(v.id) === false;
    var f = na || !!folded[v.id];
    b.classList.toggle('folded', f);
    b.classList.toggle('na', na);
    b.textContent = f ? v.name.charAt(0) : v.name;
    b.title = na ? (T.sym || '').replace(/USDT$/, '') + ' is not listed on ' + v.title : v.title + ' order book — click to fold / unfold';
  });
}

function _toggleVenueCol(id) {
  var folded = _venueFolded();
  folded[id] = !folded[id];
  _lsSet('qt_term_vcols', JSON.stringify(folded));
  _syncVenueCols();
  window.dispatchEvent(new Event('resize'));
  _queueRender();
}

// A venue's automatic size bar (percentile of its last 3 minutes of trades),
// recomputed at most every 2 s
function _venueThreshold(id, pct) {
  var key = id + ':' + pct, now = Date.now(), c = T.vThr[key];
  if (c && now - c.at < 2000) return c.v;
  var sizes = (T.vSizes[id] || []).filter(function (x) { return now - x.t <= SIZE_HISTORY_MS; }).map(function (x) { return x.usd; });
  var v = autoThreshold(sizes, pct);
  T.vThr[key] = { v: v, at: now };
  return v;
}

function _venueView(step, lo, hi, mainFull, mainColorThr, mainBarOf) {
  if (!S.venues) return null;
  var folded = _venueFolded(), now = Date.now();
  return BOOK_VENUES.map(function (v) {
    if (folded[v.id] || bookListed(v.id) === false) return { folded: true };
    var rows = bookRows(v.id, step, lo, hi);
    // Trades on one row within HIT_WINDOW_MS add up; a frame only for a hit that's
    // big for this venue right now, or that ate a good part of the level
    var sums = {};
    (T.vHits[v.id] || []).forEach(function (h) {
      if (now - h.at >= HIT_WINDOW_MS) return;
      var i = Math.round(h.p / step), g = sums[i] || (sums[i] = { buy: 0, sell: 0, buyBefore: 0, sellBefore: 0 });
      g[h.buy ? 'buy' : 'sell'] += h.usd;
      var bk = h.buy ? 'buyBefore' : 'sellBefore';
      if (h.before > g[bk]) g[bk] = h.before;
    });
    var thr = S.hitMin || _venueThreshold(v.id, FRAME_PERCENTILE);
    var hits = {};
    Object.keys(sums).forEach(function (k) {
      var g = sums[k], buy = g.buy >= g.sell, usd = buy ? g.buy : g.sell;
      // The level before the hit: as captured with the trade, or what's left now plus what was eaten
      var now_ = rows ? (buy ? rows.ask[k] : rows.bid[k]) || 0 : 0;
      var before = Math.max(buy ? g.buyBefore : g.sellBefore, now_ + usd);
      var st = thr ? hitStrength(usd, thr, before) : 0;
      if (st) hits[k] = (buy ? 'hit-buy' : 'hit-sell') + ' s' + st;
    });
    if (!rows) return { rows: null, hits: hits };
    var vals = Object.values(rows.bid).concat(Object.values(rows.ask));
    T.vAuto[v.id] = smoothScale(T.vAuto[v.id], levelPercentile(vals, AUTO_PERCENTILE), now - (T.vAutoAt[v.id] || now));
    T.vAutoAt[v.id] = now;
    // One scale with our ladder: a wall is colored when it's big in dollars next to
    // Binance's levels, not just big for a thin venue; own scale only until ours is known
    var vf = mainFull || T.vAuto[v.id];
    return { rows: rows, hits: hits, full: vf, colorThr: mainColorThr || (vf ? vf * S.highlight / 100 : 0),
      barOf: mainBarOf || (vf ? function (u) { return Math.min(1, u / vf); } : null) };
  });
}

// Which side of THIS venue's book a row is on: its own top of book, not
// Binance's — a venue trading above or below us shows its levels at its prices
function _venueSide(rows, i) {
  if (!rows) return null;
  if (rows.bestAsk != null && i >= rows.bestAsk) return 'ask';
  if (rows.bestBid != null && i <= rows.bestBid) return 'bid';
  return null;
}

// The venue's own spread edge: a line under its best ask (as on our ladder)
function _venueEdge(rows, i) {
  return rows && rows.bestAsk != null && i === rows.bestAsk ? ' best-ask' : '';
}

function _setVenueCells(box, i, view) {
  if (S.venueFull) return _setVenueBars(box, i, view);
  for (var k = 0; k < view.length; k++) {
    var cell = box.children[k], col = view[k];
    var side = _venueSide(col.rows, i);
    var usd = col.rows && side ? (col.rows[side][i] || 0) : 0;
    var t = col.folded || !usd ? '' : _fmtQty(usd);
    var a = usd && col.full ? Math.round(6 + 44 * Math.min(1, usd / col.full)) : 0;
    var cls = (side || '') + _venueEdge(col.rows, i) + (col.hits && col.hits[i] ? ' ' + col.hits[i] : '');
    if (cell.firstChild && cell.firstChild.nodeType === 1) { cell.textContent = ''; cell._t = null; }
    if (cell._t !== t) { cell.textContent = t; cell._t = t; }
    if (cell._a !== a || cell._side !== side) {
      cell.style.background = a ? 'color-mix(in srgb, var(' + (side === 'ask' ? '--danger' : '--primary') + ') ' + a + '%, transparent)' : '';
      cell._a = a; cell._side = side;
    }
    if (cell._cls !== cls) { cell.className = cls; cell._cls = cls; }
  }
}

// Full books: the same bar as our Volume column — length by size against our
// ladder's full scale (same dollars as Binance), grey under the color threshold
function _setVenueBars(box, i, view) {
  for (var k = 0; k < view.length; k++) {
    var cell = box.children[k], col = view[k];
    var side = _venueSide(col.rows, i);
    if (!cell.firstChild || cell.firstChild.nodeType !== 1) { cell.innerHTML = '<i></i><em></em>'; cell._t = null; cell._w = null; cell.style.background = ''; cell._a = null; }
    var usd = col.rows && side ? (col.rows[side][i] || 0) : 0;
    var ratio = usd && col.barOf ? col.barOf(usd) : 0;
    var dim = usd && col.colorThr && usd < col.colorThr;
    var t = col.folded || !usd ? '' : _fmtQty(usd);
    var w = usd ? Math.max(2, Math.round(ratio * 100)) + '%' : '0%';
    var o = !usd ? '0' : dim ? '0.3' : (0.35 + 0.5 * ratio).toFixed(2);
    // Past the feed's depth limit: unknown, not empty
    var nodata = col.rows && ((side === 'ask' && col.rows.askEdge != null && i > col.rows.askEdge) || (side === 'bid' && col.rows.bidEdge != null && i < col.rows.bidEdge));
    var cls = (side || '') + _venueEdge(col.rows, i) + (dim ? ' dim' : '') + (nodata ? ' nodata' : '') + (col.hits && col.hits[i] ? ' ' + col.hits[i] : '');
    var bar = cell.firstChild, txt = cell.lastChild;
    if (cell._w !== w) { bar.style.width = w; cell._w = w; }
    if (bar.style.opacity !== o) bar.style.opacity = o;
    if (cell._t !== t) { txt.textContent = t; cell._t = t; }
    if (cell._cls !== cls) { cell.className = cls; cell._cls = cls; }
  }
}

// ── Connection indicator (next to the env badge) ────────────────────────────

function _ms(v) { return v == null ? '—' : Math.round(v) + ' ms'; }

function _renderPing(s) {
  var el = document.getElementById('dom-ping');
  if (!el) return;
  s = s || null;
  var g = s ? grade(s) : 'unknown';
  if (el.dataset.grade !== g) { el.dataset.grade = g; }
  var main = !s ? '— ms' : s.down ? 'offline' : _ms(s.last) + (s.edgeCity ? ' · ' + s.edgeCity : '');
  var b = el.querySelector('b');
  if (b.textContent !== main) b.textContent = main;
  var pop = document.getElementById('dom-ping-pop');
  if (!pop || !s) return;
  var ago = s.order ? Math.round((Date.now() - s.order.at) / 1000) : null;
  pop.innerHTML = '<span class="dom-ping-title">Connection</span>'
    + _pingRow('Entry point', s.route === 'direct' ? 'Tokyo server, direct'
        : s.edgeCity ? s.edgeCity + ' (Cloudflare ' + s.edge + ')' : '—')
    + _pingRow('Your traffic exits in', s.country || '—')
    + _pingRow('You ↔ server', _ms(s.last) + ' · p50 ' + _ms(s.p50) + ' · p95 ' + _ms(s.p95))
    + _pingRow('Jitter', _ms(s.jitter))
    + _pingRow('Lost pings', s.samples || s.loss ? Math.round(s.loss * 100) + '%' : '—')
    + _pingRow('Server ↔ Binance', s.binance == null ? '—' : s.binance.toFixed(1) + ' ms')
    + _pingRow('Order book delay', _ms(s.book) + (s.bookP95 != null ? ' · p95 ' + _ms(s.bookP95) : ''))
    + _pingRow('Last order, click → accepted', s.order ? _ms(s.order.ms) + ' · ' + (ago < 60 ? ago + ' s' : Math.round(ago / 60) + ' min') + ' ago' : '—')
    + _pingRow('Reconnects', String(s.reconnects))
    + '<span class="dom-ping-note">Last 2 min, ping every 2 s over the order socket.</span>';
}

function _pingRow(k, v) { return '<span class="dom-ping-row"><span>' + k + '</span><b>' + v + '</b></span>'; }

// ── Order book (trader's environment) ───────────────────────────────────────
// Full local book, maintained the way Binance documents it: a REST snapshot
// (up to 1000 levels per side) plus the @depth@100ms diff stream, checked for
// gaps with pu → u. bookTicker (unthrottled) keeps the top of book exact
// between diffs; aggTrade marks the last traded price.

function _marketRoots() {
  if (_viewOnly() || (T.access && T.access.env === 'mainnet')) {
    return { ws: 'wss://fstream.binance.com', rest: 'https://fapi.binance.com' };
  }
  return {
    ws: T.access.marketWs.replace(/\/public\/ws$/, ''),
    rest: T.access.marketRest || 'https://demo-fapi.binance.com',
  };
}

function _connectDepth() {
  _disconnectDepth();
  if (!T.access || !T.access.marketWs || !T.sym) return;
  var sym = T.sym, s = sym.toLowerCase();
  var roots = _marketRoots();
  var book = { bids: new Map(), asks: new Map(), lastU: 0, synced: false, started: false, syncing: false, buffer: [], rest: roots.rest, sym: sym };
  T.book = book;
  var ws = new WebSocket(roots.ws + '/public/stream?streams=' + s + '@depth@100ms/' + s + '@bookTicker');
  T.ws = ws;
  ws.onopen = function () { _snapshot(book); };
  ws.onmessage = function (ev) {
    if (T.ws !== ws) return;
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    var d = m.data || m;
    if (d.E) noteBookEvent(d.E);
    if (d.e === 'bookTicker') {
      T.bbo = { b: Number(d.b), B: Number(d.B), a: Number(d.a), A: Number(d.A), u: d.u };
    } else if (d.e === 'depthUpdate') {
      if (!book.synced) { book.buffer.push(d); return; }
      if (!_applyEvent(book, d)) { _resync(book); return; }
    } else {
      return;
    }
    _queueRender();
  };
  ws.onclose = function () {
    if (T.ws !== ws) return;
    T.ws = null;
    if (T.sym === sym) T.wsTimer = setTimeout(_connectDepth, 1000);
  };

  _clusterStart(roots.rest, sym);
  var wt = new WebSocket(roots.ws + '/market/ws/' + s + '@aggTrade');
  T.wsTrades = wt;
  wt.onmessage = function (ev) {
    if (T.wsTrades !== wt) return;
    var d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.e !== 'aggTrade') return;
    T.lastTrade = { price: Number(d.p), buy: !d.m, at: Date.now() };
    _clusterTrade(d.a, d.p, Number(d.q), d.T);
    _queueRender();
  };
}

// Returns false on a sequence gap (caller resyncs).
function _applyEvent(book, d) {
  if (!book.started) {
    if (d.u < book.lastU) return true;          // older than the snapshot
    if (d.U > book.lastU) return false;         // missed events between snapshot and stream
    book.started = true;
  } else if (d.pu !== book.lastU) {
    return false;
  }
  d.b.forEach(function (l) { if (Number(l[1]) === 0) book.bids.delete(l[0]); else book.bids.set(l[0], Number(l[1])); });
  d.a.forEach(function (l) { if (Number(l[1]) === 0) book.asks.delete(l[0]); else book.asks.set(l[0], Number(l[1])); });
  book.lastU = d.u;
  T.bookDirty = true;
  return true;
}

function _resync(book) {
  book.synced = false; book.started = false; book.buffer = [];
  _snapshot(book);
}

function _snapshot(book) {
  if (book.syncing || T.book !== book) return;
  book.syncing = true;
  var wait = Math.max(0, (T.lastSnapAt || 0) + 2000 - Date.now()); // at most one snapshot per 2s
  setTimeout(function () {
    if (T.book !== book) return;
    T.lastSnapAt = Date.now();
    fetch(book.rest + '/fapi/v1/depth?symbol=' + book.sym + '&limit=1000').then(function (r) { return r.json(); }).then(function (snap) {
      if (T.book !== book) return;
      book.bids = new Map(snap.bids.map(function (l) { return [l[0], Number(l[1])]; }));
      book.asks = new Map(snap.asks.map(function (l) { return [l[0], Number(l[1])]; }));
      book.lastU = snap.lastUpdateId;
      book.started = false;
      var buf = book.buffer;
      book.buffer = [];
      book.syncing = false;
      for (var k = 0; k < buf.length; k++) {
        if (!_applyEvent(book, buf[k])) { _resync(book); return; }
      }
      book.synced = true;
      T.bookDirty = true;
      _queueRender();
    }).catch(function () {
      book.syncing = false;
      setTimeout(function () { _snapshot(book); }, 2000);
    });
  }, wait);
}

// Sorted arrays for the ladder: rebuilt from the local book when it changed,
// then the newer bookTicker trims anything now inside the spread.
function _refreshLevels() {
  var book = T.book;
  if (!book || !book.synced) return;
  if (T.bookDirty) {
    T.baseBids = Array.from(book.bids, function (e) { return [Number(e[0]), e[1]]; }).sort(function (a, b) { return b[0] - a[0]; });
    T.baseAsks = Array.from(book.asks, function (e) { return [Number(e[0]), e[1]]; }).sort(function (a, b) { return a[0] - b[0]; });
    T.bookDirty = false;
  }
  var bids = T.baseBids || [], asks = T.baseAsks || [];
  var t = T.bbo;
  if (t && t.u > book.lastU && bids.length && asks.length) {
    bids = bids.filter(function (l) { return l[0] < t.b; }); bids.unshift([t.b, t.B]);
    asks = asks.filter(function (l) { return l[0] > t.a; }); asks.unshift([t.a, t.A]);
  }
  T.bids = bids; T.asks = asks;
}

function _disconnectDepth() {
  clearTimeout(T.wsTimer);
  if (T.ws) { var w = T.ws; T.ws = null; try { w.close(); } catch (e) {} }
  if (T.wsTrades) { var t = T.wsTrades; T.wsTrades = null; try { t.close(); } catch (e) {} }
  T.book = null; T.baseBids = null; T.baseAsks = null; T.bookDirty = false;
  T.bbo = null; T.lastTrade = null;
  T.cl = null;
  T.tape = [];
  T.vHits = {}; T.vAuto = {}; T.vAutoAt = {}; T.vSizes = {}; T.vThr = {};
}

// ── Account events ──────────────────────────────────────────────────────────

on('setups:updated', function () { _renderTag(); });

on('trade:event', function (ev) {
  if (!ev || !T.access) return;
  if ((ev.env || 'live') !== T.mode) return; // the other trader's events
  var acc = T.account;
  if (ev.type === 'snapshot') {
    T.account = ev.account;
  } else if (ev.type === 'order') {
    acc.orders = acc.orders.filter(function (o) { return o.orderId !== ev.order.orderId; });
    if (OPEN_ORDER[ev.order.status]) acc.orders.push(ev.order);
    else T.closedIds['o' + ev.order.orderId] = Date.now();
  } else if (ev.type === 'algo') {
    acc.algoOrders = acc.algoOrders.filter(function (o) { return o.algoId !== ev.algo.algoId; });
    if (OPEN_ALGO[ev.algo.status]) acc.algoOrders.push(ev.algo);
    else T.closedIds['a' + ev.algo.algoId] = Date.now();
  } else if (ev.type === 'position') {
    var p = ev.position;
    var was = acc.positions.find(function (x) { return x.symbol === p.symbol && x.positionSide === p.positionSide; });
    if (was && Number(was.amount) !== 0 && Number(p.amount) === 0) _queueTag(p.symbol, p.updateTime);
    acc.positions = acc.positions.filter(function (x) { return !(x.symbol === p.symbol && x.positionSide === p.positionSide); });
    if (Number(p.amount) !== 0) acc.positions.push(p);
  } else if (ev.type === 'balance') {
    acc.balances = acc.balances.filter(function (b) { return b.asset !== ev.balance.asset; });
    acc.balances.push(ev.balance);
  } else if (ev.type === 'status') {
    T.access = Object.assign({}, T.access, ev.status);
    _renderLock(true);
  } else if (ev.type === 'local-stop') {
    // The trader closed the position itself the moment a trade hit your SL / TP
    var ls = ev.stop;
    showToast(ls.kind + ' ' + ls.symbol.replace(/USDT$/, '') + ' closed locally at ' + ls.tradePrice + ' (trigger ' + ls.trigger + (ls.ms ? ', ' + ls.ms.order + ' ms' : '') + ')');
  } else if (ev.type === 'fill') {
    var f = ev.fill;
    if (T.sym === f.symbol || T.open) showToast('Filled ' + f.side + ' ' + f.symbol.replace(/USDT$/, '') + ' ' + _fmtUsd(Number(f.quantity) * Number(f.price)) + ' USDT @ ' + f.price);
    T.lastFillAt[f.symbol] = f.time;
    if (T.mode === 'live' && /USDT$/.test(f.symbol)) refreshTradesAfterFill(f.symbol.replace(/USDT$/, '').toLowerCase());
  }
  _queueRender();
  emit('terminal:account');
});

// ── For the main screen widget (summary.js) ─────────────────────────────────

// null when this account can't trade; else the live trader state for the current mode
export function tradingSnapshot() {
  if (!T.access) return null;
  return { mode: T.mode, account: T.account };
}

// Like Space on every coin with a position, all at once: cancel the coin's
// orders (limits, stop entries, SL/TP) and market-close the position
// (reduce-only). Allowed even when the day or 2FA is locked: it only reduces risk.
export function closeAllPositions() {
  var list = T.account.positions.filter(function (p) { return Number(p.amount) !== 0; });
  return Promise.all(list.map(function (p) {
    var amt = Number(p.amount);
    var hasOrders = T.account.orders.some(function (o) { return o.symbol === p.symbol; })
      || T.account.algoOrders.some(function (a) { return a.symbol === p.symbol; });
    var cancel = hasOrders
      ? tradeRequest('POST', 'cancel-all', { symbol: p.symbol }).then(function () { return null; }, function (e) { return 'orders not cancelled: ' + e.message; })
      : Promise.resolve(null);
    var close = tradeRequest('POST', 'order', {
      clientOrderId: _clientId(), symbol: p.symbol, side: amt > 0 ? 'SELL' : 'BUY', type: 'MARKET',
      quantity: String(Math.abs(amt)), reduceOnly: true,
    }).then(function () { return null; }, function (e) { return e.message; });
    return Promise.all([close, cancel]).then(function (errs) {
      var err = errs.filter(Boolean).join('; ');
      return err ? { symbol: p.symbol, ok: false, error: err } : { symbol: p.symbol, ok: true };
    });
  }));
}

// ── Ladder model ────────────────────────────────────────────────────────────

function _decimals(step) {
  var s = String(step);
  var dot = s.indexOf('.');
  return dot === -1 ? 0 : s.slice(dot + 1).replace(/0+$/, '').length;
}

function _tick() { return T.rules ? Number(T.rules.tickSize) : null; }
function _step() { return _tick() * SCALES[T.scaleIdx || 0]; }
function _priceOf(idx) {
  return Number((idx * _step()).toFixed(_decimals(T.rules.tickSize)));
}

function _autoScale() {
  if (T.scaleIdx != null || !T.bids.length || !T.asks.length) return;
  // The multiplier you picked for this coin last time wins over the auto fit
  var saved = SCALES.indexOf(Number(_lsGet('qt_term_scale_' + T.sym)));
  if (saved !== -1) { T.scaleIdx = saved; return; }
  // Fit roughly the 20 nearest levels per side into the window
  var span = (T.asks[Math.min(19, T.asks.length - 1)][0] - T.bids[Math.min(19, T.bids.length - 1)][0]) / _tick();
  var want = span / Math.max(10, T.rows * 0.8);
  var i = 0;
  while (i < SCALES.length - 1 && SCALES[i] < want) i++;
  T.scaleIdx = i;
}

function _renderScale() {
  var el = document.getElementById('dom-scale-val');
  if (!el || !T.rules || T.scaleIdx == null) return;
  var t = '×' + SCALES[T.scaleIdx];
  if (el.textContent !== t) el.textContent = t;
}

// Compact number for the ladder: sizes are in USDT everywhere (volume, orders)
function _fmtQty(q) {
  if (q >= 1e6) return (q / 1e6).toFixed(1) + 'M';
  if (q >= 1e3) return (q / 1e3).toFixed(1) + 'K';
  if (q >= 10) return q.toFixed(0);
  return q.toPrecision(2);
}

function _position() {
  return T.account.positions.find(function (p) { return p.symbol === T.sym && Number(p.amount) !== 0; }) || null;
}

// PnL of the whole trade marked to the price you could close at now (best bid
// for a long, best ask for a short). Measured from the breakeven, not the
// entry: after a partial close the realized part (net of fees, from the trader)
// moves the zero, and the zone stretches like Tiger's. Falls back to the entry
// until the trader has counted it.
function _pnlInfo() {
  if (_viewOnly()) return null; // testnet position vs live prices would be meaningless
  var pos = _position();
  if (!pos || !T.bids.length || !T.asks.length) return null;
  var amt = Number(pos.amount), avg = Number(pos.entryPrice);
  var be = pos.breakEven != null && isFinite(pos.breakEven) ? Number(pos.breakEven) : avg;
  var exit = amt > 0 ? T.bids[0][0] : T.asks[0][0];
  var pnl = amt * (exit - be);
  return {
    pos: pos, amt: amt, entry: be, avgEntry: avg, exit: exit, pnl: pnl,
    pct: be ? (exit - be) / be * 100 * (amt > 0 ? 1 : -1) : 0,
    up: pnl >= 0,
  };
}

function _myOrdersByIdx(step) {
  var out = {};
  function add(idx, item) { (out[idx] = out[idx] || []).push(item); }
  T.account.orders.forEach(function (o) {
    if (o.symbol !== T.sym) return;
    add(Math.round(Number(o.price) / step), { kind: o.side === 'BUY' ? 'B' : 'S', usd: (Number(o.origQty) - Number(o.executedQty || 0)) * Number(o.price), order: o, cancelling: !!T.cancelling['o' + o.orderId] });
  });
  T.account.algoOrders.forEach(function (a) {
    if (a.symbol !== T.sym) return;
    var entry = _isStopEntry(a);
    add(Math.round(Number(a.triggerPrice) / step), {
      kind: entry ? (a.side === 'BUY' ? 'BS' : 'SS') : a.type === 'TAKE_PROFIT_MARKET' ? 'TP' : 'SL',
      usd: entry ? Number(a.quantity) * Number(a.triggerPrice) : null, algo: a, cancelling: !!T.cancelling['a' + a.algoId],
    });
  });
  Object.keys(T.pending).forEach(function (id) {
    var p = T.pending[id];
    add(Math.round(p.price / step), { kind: p.kind, usd: p.qty != null ? p.qty * p.price : null, pending: true });
  });
  return out;
}

// Levels, rays and alerts from the chart, on the row their price falls in.
// Shown in Test too: Binance Demo follows the real market within a tick or two.
function _chartMarksByIdx(step) {
  var out = {};
  chartMarks(T.sym.replace(/USDT$/, '')).forEach(function (m) {
    if (!(m.price > 0)) return;
    var i = Math.round(m.price / step);
    if ((out[i] || '').indexOf(' mk-' + m.kind) === -1) out[i] = (out[i] || '') + ' mk-' + m.kind;
  });
  return out;
}

// Several clicks on one level are separate exchange orders (each keeps its
// queue place); the Mine column shows them as one sum per kind. A click on
// it cancels them all (_cancelAtLevel).
function _sumByKind(items) {
  var out = [], byKind = {};
  items.forEach(function (x) {
    var g = byKind[x.kind];
    if (!g) {
      g = byKind[x.kind] = { kind: x.kind, usd: null, pending: true, cancelling: true };
      out.push(g);
    }
    if (x.usd != null) g.usd = (g.usd || 0) + x.usd;
    g.pending = g.pending && !!x.pending;          // dim only while nothing is confirmed yet
    g.cancelling = g.cancelling && !!x.cancelling; // struck through when all are being cancelled
  });
  return out;
}

// ── Render ──────────────────────────────────────────────────────────────────

function _queueRender() {
  if (T.renderQueued) return;
  T.renderQueued = true;
  var done = false;
  function run() { if (done) return; done = true; T.renderQueued = false; _render(); }
  // Next frame normally; the timer covers hidden/occluded windows where rAF stalls
  requestAnimationFrame(run);
  setTimeout(run, 100);
}

function _render() {
  var ladder = document.getElementById('dom-ladder');
  if (!ladder) return;
  _refreshLevels();
  _renderFoot();
  _syncLines();
  _syncBand();
  if (!T.rules || !T.bids.length || !T.asks.length) {
    var msg = T.rules ? 'Waiting for order book…' : T.rulesError ? _rulesErrorText(T.rulesError) : 'Loading…';
    if (ladder.firstChild && ladder.firstChild._msg === msg) return;
    ladder.innerHTML = '<div class="dom-empty">' + msg + '</div>';
    ladder.firstChild._msg = msg;
    return;
  }
  var empty = ladder.querySelector('.dom-empty');
  if (empty) empty.remove();
  T.rows = Math.max(10, Math.floor(ladder.clientHeight / ROW_H));
  _autoScale();
  _renderScale();
  var step = _step();
  var bestBid = T.bids[0][0], bestAsk = T.asks[0][0];
  var bidIdx = Math.floor(bestBid / step + 1e-9), askIdx = Math.ceil(bestAsk / step - 1e-9);
  var midIdx = Math.round((bidIdx + askIdx) / 2);

  // Recenter when the market leaves the middle 60% of the window
  if (T.top == null || (!T.pinned && (midIdx > T.top - T.rows * 0.2 || midIdx < T.top - T.rows * 0.8))) {
    T.top = midIdx + Math.floor(T.rows / 2);
  }

  var bidVol = {}, askVol = {}, maxVol = 0;
  var lo = T.top - T.rows + 1, hi = T.top;
  T.bids.forEach(function (l) { var i = Math.floor(l[0] / step + 1e-9); if (i >= lo && i <= hi) bidVol[i] = (bidVol[i] || 0) + l[1]; });
  T.asks.forEach(function (l) { var i = Math.ceil(l[0] / step - 1e-9); if (i >= lo && i <= hi) askVol[i] = (askVol[i] || 0) + l[1]; });
  // Bar lengths are relative to the biggest level currently on screen
  Object.keys(bidVol).forEach(function (k) { maxVol = Math.max(maxVol, bidVol[k]); });
  Object.keys(askVol).forEach(function (k) { maxVol = Math.max(maxVol, askVol[k]); });
  // Full scale: the coin's own setting, else automatic — a "typical big" level
  // on screen (ladder-scale.js), smoothed so the colors don't flicker
  var usdLevels = [];
  Object.keys(bidVol).forEach(function (k) { usdLevels.push(bidVol[k] * Number(k) * step); });
  Object.keys(askVol).forEach(function (k) { usdLevels.push(askVol[k] * Number(k) * step); });
  var nowMs = Date.now();
  T.autoFull = smoothScale(T.autoFull, levelPercentile(usdLevels, AUTO_PERCENTILE), nowMs - (T.autoAt || nowMs));
  T.autoMed = smoothScale(T.autoMed, levelPercentile(usdLevels, 50), nowMs - (T.autoAt || nowMs));
  T.autoMax = trackMax(T.autoMax, usdLevels.length ? Math.max.apply(null, usdLevels) : null, nowMs - (T.autoAt || nowMs));
  T.autoAt = nowMs;
  // Bar length: manual full scale → linear to it; auto → log from a quarter of the
  // typical level to the biggest on screen, so a 615K wall is far longer than a 14K one
  var barOf = S.fullScale
    ? function (u) { return Math.min(1, u / S.fullScale); }
    : function (u) { return barRatio(u, T.autoMed, T.autoMax); };
  var full = S.fullScale || T.autoFull || 0;
  // Colored = a density. Manual full scale: the % of it; auto: also ≥ 3× the typical
  // level on screen, so a flat book stays grey (ladder-scale.js colorThreshold)
  var colorThr = S.fullScale ? S.fullScale * S.highlight / 100 : colorThreshold(T.autoMed, full, S.highlight);

  var mine = _myOrdersByIdx(step);
  var marks = _chartMarksByIdx(step);
  var cl = _clusterView(step);
  var ven = _venueView(step, T.top - T.rows + 1, T.top, full, colorThr, full ? barOf : null);
  var pnl = _pnlInfo();
  var entryIdx = pnl ? Math.round(pnl.entry / step) : null;
  var exitIdx = pnl ? Math.round(pnl.exit / step) : null;
  var pnlLo = pnl ? Math.min(entryIdx, exitIdx) : null, pnlHi = pnl ? Math.max(entryIdx, exitIdx) : null;
  var pnlCls = pnl ? (pnl.up ? ' pnl-up' : ' pnl-dn') : '';
  var lt = T.lastTrade;
  var tradeIdx = lt ? Math.round(lt.price / step) : null;
  var tradeCls = lt ? (lt.buy ? ' last-buy' : ' last-sell') + (Date.now() - lt.at < 300 ? ' flash' : '') : '';
  if (lt && Date.now() - lt.at < 300) setTimeout(_queueRender, 320); // let the flash fade
  var d = _decimals(T.rules.tickSize);

  // Rows are created once and updated in place: replacing them 10×/s would
  // swallow clicks that land between two renders.
  while (ladder.children.length < T.rows) ladder.appendChild(_makeRow());
  while (ladder.children.length > T.rows) ladder.lastChild.remove();

  for (var r = 0; r < T.rows; r++) {
    var i = T.top - r;
    var row = ladder.children[r];
    var cls = 'dom-row';
    if (i >= askIdx) cls += ' ask'; else if (i <= bidIdx) cls += ' bid'; else cls += ' spread';
    if (i === askIdx) cls += ' best-ask'; else if (i === bidIdx) cls += ' best-bid';
    if (pnl && i >= pnlLo && i <= pnlHi) cls += pnlCls;
    if (tradeIdx === i) cls += tradeCls;
    if (T.drag && T.drag.moved && T.drag.toIdx === i) cls += ' drop-target';
    if (marks[i]) cls += marks[i];
    // Faint row tint where your orders rest: green for buy-colored kinds, red for sell
    if (mine[i]) {
      var green = mine[i].some(function (x) { return /^(B|BS|TP)$/.test(x.kind); });
      var red = mine[i].some(function (x) { return /^(S|SS|SL)$/.test(x.kind); });
      cls += green && red ? ' has-order' : green ? ' has-order buy' : ' has-order sell';
    }
    if (row.className !== cls) row.className = cls;
    row.dataset.idx = i;
    var m = mine[i];
    var mineHtml = (m ? _sumByKind(m).map(function (x) {
      return '<span class="dom-mine ' + x.kind.toLowerCase() + (x.pending ? ' pending' : '') + (x.cancelling ? ' cancelling' : '') + '" data-kind="' + x.kind + '">' + x.kind + (x.usd != null ? ' ' + _fmtQty(x.usd) : '') + '</span>';
    }).join('') : '');
    var c = row.children;
    if (cl) _setClusterCells(c[3], i, cl);
    if (ven) _setVenueCells(c[4], i, ven);
    if (c[0]._html !== mineHtml) { c[0].innerHTML = mineHtml; c[0]._html = mineHtml; c[0].classList.toggle('has', !!m); }
    // One volume column: asks above the spread, bids below, heat-filled by size
    var v = i >= askIdx ? askVol[i] : i <= bidIdx ? bidVol[i] : 0;
    var usd = v * i * step;
    var ratio = !v ? 0 : full ? barOf(usd) : v / maxVol;
    _setVol(c[1], usd, ratio, colorThr > 0 && usd < colorThr, T.autoMed > 0 && usd < T.autoMed);
    var pt = (i * step).toFixed(d);
    if (c[2].textContent !== pt) c[2].textContent = pt;
  }
  _drawRuler();
  _drawTape(step);
  _renderOffscreen(step, mine);
}

// ── % ruler: distance from the current price to the hovered level ──────────

function _drawRuler() {
  var panel = document.getElementById('fv-dom');
  var ladder = document.getElementById('dom-ladder');
  if (!panel || !ladder) return;
  var box = document.getElementById('dom-ruler');
  var ghost = document.getElementById('dom-ghost');
  // The hovered row's volume number gives its place to the % (restored when the mouse moves on)
  if (T.rulerCell && T.rulerCell.lastChild) { T.rulerCell.lastChild.style.visibility = ''; T.rulerCell = null; }
  if (T.hoverRow == null || !T.rules || !T.bids.length || !T.asks.length || !ladder.children.length || ladder.querySelector('.dom-empty')) {
    if (box) box.style.display = 'none';
    if (ghost) ghost.style.display = 'none';
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.id = 'dom-ruler';
    box.className = 'dom-ruler';
    box.innerHTML = '<span class="dom-ruler-tag"></span>';
    panel.appendChild(box);
  }
  var step = _step();
  var ref = T.lastTrade ? T.lastTrade.price : (T.bids[0][0] + T.asks[0][0]) / 2;
  // Row under the cursor, not a remembered price: the ladder may recenter under a still mouse
  var rHover = T.hoverRow, hoverIdx = T.top - rHover;
  var last = ladder.children.length - 1;
  if (rHover < 0 || rHover > last) { box.style.display = 'none'; if (ghost) ghost.style.display = 'none'; return; }
  var row = ladder.children[rHover], pRect = panel.getBoundingClientRect();
  // The % from the current price, in the Volume cell of the hovered row
  var vol = row.children[1], vRect = vol.getBoundingClientRect();
  var pct = (_priceOf(hoverIdx) - ref) / ref * 100;
  box.style.display = 'block';
  box.style.top = (vRect.top - pRect.top) + 'px';
  box.style.left = (vRect.left - pRect.left) + 'px';
  box.style.width = vRect.width + 'px';
  box.style.height = vRect.height + 'px';
  box.firstChild.textContent = (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct).toFixed(2) + '%';
  if (vol.lastChild) { vol.lastChild.style.visibility = 'hidden'; T.rulerCell = vol; }
  _drawGhost(panel, row, hoverIdx, pRect);
}

// Option / Shift held over the ladder: the order a click would place shows in
// the Mine column of the hovered row — stop entry (BS / SS with the chosen
// size) or SL / TP — so you see the key is down before you click.
function _drawGhost(panel, row, idx, pRect) {
  var ghost = document.getElementById('dom-ghost');
  var g = T.mods && (T.mods.alt || T.mods.shift) ? _ghostOrder(idx, T.mods.alt) : null;
  if (!g) { if (ghost) ghost.style.display = 'none'; return; }
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'dom-ghost';
    ghost.className = 'dom-ghost';
    panel.appendChild(ghost);
  }
  var mine = row.children[0], mRect = mine.getBoundingClientRect();
  ghost.style.display = 'flex';
  ghost.style.top = (mRect.top - pRect.top) + 'px';
  ghost.style.left = (mRect.left - pRect.left) + 'px';
  ghost.style.width = mRect.width + 'px';
  ghost.style.height = mRect.height + 'px';
  ghost.innerHTML = '<span class="dom-mine ' + (g.kind ? g.kind.toLowerCase() : 'none') + '">' + g.label + '</span>';
}

// What Option (stop entry) / Shift (SL / TP) + click would place at this level
function _ghostOrder(idx, stopEntry) {
  var price = _priceOf(idx), bid = T.bids[0][0], ask = T.asks[0][0];
  if (stopEntry) {
    var side = price > ask ? 'BUY' : price < bid ? 'SELL' : null;
    if (!side) return { kind: null, label: 'за спредом' };
    var k = side === 'BUY' ? 'BS' : 'SS';
    return { kind: k, label: k + ' ' + _fmtQty(T.size) };
  }
  var pos = _position();
  if (!pos) return { kind: null, label: 'нет позиции' };
  var long = Number(pos.amount) > 0;
  var type = long ? (price < bid ? 'SL' : price > ask ? 'TP' : null) : (price > ask ? 'SL' : price < bid ? 'TP' : null);
  return type ? { kind: type, label: type } : { kind: null, label: 'за спредом' };
}

function _makeRow() {
  var row = document.createElement('div');
  row.className = 'dom-row';
  row.innerHTML = '<span class="dom-c-mine"></span><span class="dom-c-vol"><i></i><b></b></span>'
    + '<span class="dom-c-price"></span><span class="dom-c-cl">' + new Array(CLUSTER_COLS + 1).join('<b></b>') + '</span>'
    + '<span class="dom-c-ven">' + new Array(BOOK_VENUES.length + 1).join('<b></b>') + '</span>';
  return row;
}

// Bar length ∝ size: r = share of the full scale (set in USD, or the biggest
// level on screen); bigger also brighter. v is the level's size in USD.
// dim: under the highlight threshold — grey, to cut color noise.
// tiny: smaller than the typical level on screen — its number is muted too.
function _setVol(cell, v, r, dim, tiny) {
  if (cell.classList.contains('tiny') !== !!tiny) cell.classList.toggle('tiny', !!tiny);
  var w = v ? Math.max(2, Math.round(r * 100)) + '%' : '0%';
  var o = !v ? '0' : dim ? '0.3' : (0.35 + 0.5 * r).toFixed(2);
  if (cell.classList.contains('dim') !== !!dim) cell.classList.toggle('dim', !!dim);
  var t = v ? _fmtQty(v) : '';
  if (cell.firstChild.style.width !== w) cell.firstChild.style.width = w;
  if (cell.firstChild.style.opacity !== o) cell.firstChild.style.opacity = o;
  if (cell.lastChild.textContent !== t) cell.lastChild.textContent = t;
}

function _renderFoot() {
  var el = document.getElementById('dom-pos');
  if (!el) return;
  var pos = _position();
  var usdt = T.account.balances.find(function (b) { return b.asset === 'USDT'; });
  var avail = usdt && usdt.availableBalance != null ? Number(usdt.availableBalance).toFixed(2) : '—';
  var html;
  if (!pos) {
    html = '<div class="dom-pos-row"><span>Position</span><b>Flat</b></div>'
      + '<div class="dom-pos-row"><span>Available</span><b>' + avail + ' USDT</b></div>';
  } else {
    var amt = Number(pos.amount);
    var info = _pnlInfo();
    var pnlHtml = info
      ? '<b class="dom-pnl ' + (info.up ? 'up' : 'dn') + '">' + _fmtPnl(info) + '</b>'
      : '<b>—</b>';
    html = '<div class="dom-pos-row"><span>Position</span><b class="' + (amt > 0 ? 'up' : 'dn') + '">' + (amt > 0 ? 'Long ' : 'Short ') + _fmtUsd(Math.abs(amt) * Number(pos.entryPrice)) + ' USDT</b></div>'
      + '<div class="dom-pos-row"><span>Entry</span><b>' + pos.entryPrice + '</b></div>'
      + (info && Math.abs(info.entry - info.avgEntry) > 1e-12
          ? '<div class="dom-pos-row" title="Where the whole trade, closed part and fees included, comes out at zero"><span>Breakeven</span><b>'
            + Number(info.entry.toFixed(_decimals(T.rules ? T.rules.tickSize : 0.0001) + 1)) + '</b></div>'
          : '')
      + '<div class="dom-pos-row"><span>PnL</span>' + pnlHtml + '</div>'
      + '<div class="dom-pos-row"><span>Available</span><b>' + avail + ' USDT</b></div>';
  }
  // Rebuilt only on change: the order rows are clickable and must not be replaced under the mouse
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
  var st = document.getElementById('dom-status');
  if (st && T.access && !T.access.tradingEnabled) {
    st.textContent = 'Trading is disabled by the kill switch';
    st.className = 'dom-status err';
  }
}

// Your orders outside the visible ladder: a small badge at the top / bottom of
// the Mine column ("↑ S 50 · TP"), summed per kind; a click scrolls to the
// nearest one. Hidden while every order is on screen.
function _renderOffscreen(step, mine) {
  var panel = document.getElementById('fv-dom'), ladder = document.getElementById('dom-ladder');
  if (!panel || !ladder || !ladder.firstChild || !ladder.firstChild.children) return;
  var hi = T.top, lo = T.top - T.rows + 1;
  var up = [], down = [], nearUp = null, nearDown = null;
  Object.keys(mine).forEach(function (k) {
    var i = Number(k);
    if (i > hi) { up = up.concat(mine[k]); if (nearUp == null || i < nearUp) nearUp = i; }
    else if (i < lo) { down = down.concat(mine[k]); if (nearDown == null || i > nearDown) nearDown = i; }
  });
  var cell = ladder.firstChild.children[0];
  var left = ladder.offsetLeft + cell.offsetLeft;
  [['up', up, nearUp, '↑', ladder.offsetTop + 2], ['down', down, nearDown, '↓', null]].forEach(function (d) {
    var id = 'dom-off-' + d[0], el = document.getElementById(id);
    if (!d[1].length) { if (el) el.style.display = 'none'; return; }
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'dom-off';
      el.title = 'Your orders off screen — click to show';
      panel.appendChild(el);
    }
    var html = '<span class="dom-off-arrow">' + d[3] + '</span>' + _sumByKind(d[1]).map(function (x) {
      return '<span class="dom-mine ' + x.kind.toLowerCase() + '">' + x.kind + (x.usd != null ? ' ' + _fmtQty(x.usd) : '') + '</span>';
    }).join('');
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.dataset.jump = _priceOf(d[2]);
    el.style.display = '';
    el.style.left = left + 'px';
    if (d[4] != null) { el.style.top = d[4] + 'px'; el.style.bottom = ''; }
    else { el.style.top = (ladder.offsetTop + ladder.clientHeight - el.offsetHeight - 2) + 'px'; }
  });
}

function _jumpTo(price) {
  if (!T.rules || !T.rows) return;
  T.top = Math.round(price / _step()) + Math.floor(T.rows / 2);
  T.pinned = true; // stay there until the mouse leaves the panel
  _queueRender();
}

function _fmtUsd(n) { return n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2); }

// Price move from the entry in the position's favour, % (+ = in profit direction)
function _moveFromEntry(info) {
  return info.avgEntry ? (info.exit - info.avgEntry) / info.avgEntry * 100 * (info.amt > 0 ? 1 : -1) : 0;
}

function _movePct(info) {
  var m = _moveFromEntry(info);
  return (m >= 0 ? '+' : '−') + Math.abs(m).toFixed(2) + '%';
}

function _fmtPnl(info) {
  return (info.pnl >= 0 ? '+' : '') + info.pnl.toFixed(2) + ' USDT (' + (info.pct >= 0 ? '+' : '') + info.pct.toFixed(2) + '%)';
}

// ── PnL zone on the chart ───────────────────────────────────────────────────
// Drawn by the chart itself (series primitive), so it moves with candles while
// panning/zooming. Spans from the candle where the position was opened to the
// right edge, between the entry price and the current close price.

var TF_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

function PnlZone() {
  var self = this;
  this.d = null;
  this._chart = null; this._series = null; this._req = null;
  this._views = [
    { zOrder: function () { return 'bottom'; }, renderer: function () { return { draw: function (t) { self._drawZone(t); } }; } },
    { zOrder: function () { return 'top'; }, renderer: function () { return { draw: function (t) { self._drawLabel(t); } }; } },
  ];
}
PnlZone.prototype.attached = function (p) { this._chart = p.chart; this._series = p.series; this._req = p.requestUpdate; };
PnlZone.prototype.detached = function () { this._chart = null; this._series = null; this._req = null; };
PnlZone.prototype.updateAllViews = function () {};
PnlZone.prototype.paneViews = function () { return this._views; };
PnlZone.prototype.setData = function (d) { this.d = d; if (this._req) this._req(); };

PnlZone.prototype._geom = function (width) {
  var d = this.d, s = this._series, c = this._chart;
  if (!d || !s || !c) return null;
  // Edge follows the last candle's close, read in the same frame the chart
  // draws it, so the zone never trails the candle you see.
  var exit = d.exit;
  try {
    var last = s.dataByIndex ? s.dataByIndex(1e9, -1) : null;
    if (last && last.close != null) exit = last.close;
  } catch (e) {}
  var y1 = s.priceToCoordinate(d.entry), y2 = s.priceToCoordinate(exit);
  if (y1 == null || y2 == null) return null;
  var x = d.time != null ? c.timeScale().timeToCoordinate(d.time) : null;
  if (x == null || x < 0) x = 0; // entry candle not loaded / scrolled off to the left
  if (x > width) return null;
  var up = d.long ? exit >= d.entry : exit <= d.entry;
  return { x: x, yEntry: y1, yExit: y2, top: Math.min(y1, y2), h: Math.max(1, Math.abs(y2 - y1)), color: up ? d.upColor : d.dnColor };
};

PnlZone.prototype._drawZone = function (target) {
  var self = this;
  target.useMediaCoordinateSpace(function (scope) {
    var g = self._geom(scope.mediaSize.width);
    if (!g) return;
    var ctx = scope.context, w = scope.mediaSize.width - g.x;
    // Fill only, no edges of its own. It stops ZONE_GAP px short of the current
    // price so the chart's dashed price line lies on the plain background
    // instead of mixing with the tint.
    var ZONE_GAP = 2;
    var yExit = Math.round(g.yExit), yEntry = Math.round(g.yEntry);
    var a = yEntry < yExit ? yEntry : yExit + ZONE_GAP + 1;
    var b = yEntry < yExit ? yExit - ZONE_GAP : yEntry;
    if (b <= a) return;
    ctx.save();
    ctx.fillStyle = g.color;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(g.x, a, w, b - a);
    ctx.restore();
  });
};

PnlZone.prototype._drawLabel = function (target) {
  var self = this;
  target.useMediaCoordinateSpace(function (scope) {
    var g = self._geom(scope.mediaSize.width);
    if (!g) return;
    var ctx = scope.context;
    ctx.save();
    // Glued to the price-axis label of the current price: same height
    // (lightweight-charts: font 11 + 2 × 2.5/12 × 11 padding), centred on it,
    // no gap; rounded on the left only, the right edge meets the axis label
    var fs = 11;
    ctx.font = fs + 'px Manrope, Arial, sans-serif';
    var text = self.d.label;
    var tw = ctx.measureText(text).width, padX = 6, bh = Math.round(fs + 2 * (2.5 / 12) * fs);
    var bx = scope.mediaSize.width - tw - padX * 2;
    var by = Math.round(g.yExit - bh / 2);
    by = Math.max(0, Math.min(scope.mediaSize.height - bh, by));
    ctx.fillStyle = self.d.color;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, tw + padX * 2, bh, [2, 0, 0, 2]); else ctx.rect(bx, by, tw + padX * 2, bh);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + padX, by + bh / 2 + 0.5);
    ctx.restore();
  });
};

function _clearBand() {
  if (T.zone && T.zoneSeries) { try { T.zoneSeries.detachPrimitive(T.zone); } catch (e) {} }
  T.zone = null; T.zoneSeries = null;
}

function _syncBand() {
  var series = window.__fvSeries;
  var info = _pnlInfo();
  if (!series || !series.attachPrimitive) { _clearBand(); return; }
  if (T.zoneSeries !== series) {
    _clearBand();
    T.zone = new PnlZone();
    T.zoneSeries = series;
    series.attachPrimitive(T.zone);
  }
  if (!info) { T.zone.setData(null); return; }
  var iv = TF_SEC[window.__fvTF] || 300;
  var openSec = info.pos.openTime ? Math.floor(info.pos.openTime / 1000 / iv) * iv : null;
  T.zone.setData({
    entry: info.entry, exit: info.exit, time: openSec, long: info.amt > 0,
    upColor: getCSSVar('--bullish'), dnColor: getCSSVar('--danger'),
    // The label is only how far the price went from the entry (at the price you
    // can close at now); the dollars are in the ladder footer
    color: getCSSVar(_moveFromEntry(info) >= 0 ? '--bullish' : '--danger'),
    label: _movePct(info),
  });
}

function _setStatus(msg, isErr) {
  var st = document.getElementById('dom-status');
  if (!st) return;
  st.textContent = msg;
  st.className = 'dom-status' + (isErr ? ' err' : '');
  clearTimeout(st._t);
  st._t = setTimeout(function () { if (st.isConnected) { st.textContent = ''; st.className = 'dom-status'; _renderFoot(); } }, 5000);
}

// ── Chart lines (orders and position on the full view chart) ───────────────

function _clearLines() {
  if (T.linesSeries) T.lines.forEach(function (l) { try { T.linesSeries.removePriceLine(l); } catch (e) {} });
  T.lines = []; T.linesSeries = null; T.linesKey = '';
}

function _syncLines() {
  var series = window.__fvSeries;
  if (!series || !T.sym) { _clearLines(); return; }
  var specs = [];
  var pos = _position();
  // Entry: a plain dashed line in the text color (white on dark), dashed like the
  // alert lines, only its price on the axis — sizes and PnL are in the ladder
  if (pos) specs.push({ price: Number(pos.entryPrice), color: '--ink-deep', text: '--paper', title: '', style: 2 });
  // One line per price and side, with the summed USDT of all orders there
  var sums = {};
  T.account.orders.forEach(function (o) {
    if (o.symbol !== T.sym) return;
    var k = o.side + '@' + o.price;
    sums[k] = sums[k] || { side: o.side, price: Number(o.price), usd: 0 };
    sums[k].usd += (Number(o.origQty) - Number(o.executedQty || 0)) * Number(o.price);
  });
  Object.keys(sums).forEach(function (k) {
    var g = sums[k];
    specs.push({ price: g.price, color: g.side === 'BUY' ? '--bullish' : '--danger', title: (g.side === 'BUY' ? 'B ' : 'S ') + _fmtQty(g.usd) + ' $', style: 2 });
  });
  T.account.algoOrders.forEach(function (a) {
    if (a.symbol !== T.sym) return;
    if (_isStopEntry(a)) specs.push({ price: Number(a.triggerPrice), color: a.side === 'BUY' ? '--bullish' : '--danger', title: (a.side === 'BUY' ? 'Buy stop ' : 'Sell stop ') + _fmtQty(Number(a.quantity) * Number(a.triggerPrice)) + ' $', style: 2 });
    else specs.push({ price: Number(a.triggerPrice), color: a.type === 'TAKE_PROFIT_MARKET' ? '--bullish' : '--danger', title: a.type === 'TAKE_PROFIT_MARKET' ? 'TP' : 'SL', style: 1 });
  });
  var key = JSON.stringify(specs);
  if (series === T.linesSeries && key === T.linesKey) return;
  _clearLines();
  T.linesSeries = series;
  T.linesKey = key;
  specs.forEach(function (s) {
    var c = getCSSVar(s.color);
    try {
      T.lines.push(series.createPriceLine({ price: s.price, color: c, lineWidth: 1, lineStyle: s.style, axisLabelVisible: true, axisLabelColor: c, axisLabelTextColor: s.text ? getCSSVar(s.text) : '#fff', title: s.title }));
    } catch (e) {}
  });
}

// ── Actions ─────────────────────────────────────────────────────────────────

function _clientId() {
  return 'qt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function _send(action, body, okMsg) {
  return tradeRequest('POST', action, body).then(function (r) {
    if (okMsg) _setStatus(okMsg, false);
    return r;
  }).catch(function (e) {
    _setStatus(e.message, true);
    showToast(e.message);
    if (e.status === 423) _refreshDay();
    throw e;
  });
}

// Show the order on its level right away; it is replaced by the real order
// when the exchange confirms, or dropped on error.
function _placeOptimistic(body, price, kind, okMsg) {
  var id = body.clientOrderId;
  T.pending[id] = { price: price, kind: kind, qty: body.quantity != null ? Number(body.quantity) : null, at: Date.now() };
  var t0 = performance.now(); // ~ the click: orders go out on mousedown
  _queueRender();
  return _send('order', body, okMsg).then(function (r) {
    if (r && (r.order || r.algo)) noteOrder(performance.now() - t0);
    if (r && r.order && OPEN_ORDER[r.order.status] && !T.closedIds['o' + r.order.orderId] && !T.account.orders.some(function (o) { return o.orderId === r.order.orderId; })) {
      T.account.orders.push(r.order);
    }
    if (r && r.algo && OPEN_ALGO[r.algo.status] && !T.closedIds['a' + r.algo.algoId] && !T.account.algoOrders.some(function (a) { return a.algoId === r.algo.algoId; })) {
      T.account.algoOrders.push(r.algo);
    }
  }).catch(function () {}).finally(function () {
    delete T.pending[id];
    _queueRender();
  });
}

function _viewOnlyBlocked() {
  if (!_viewOnly()) return false;
  _setStatus('Live book is view only — switch to Testnet book to trade', true);
  return true;
}

// ── Trade tag bar (journal stage 3, docs/TRADER_EDGE.md) ───────────────────
// Right after a position goes flat: setup quality and what drove the entry,
// one tap each, skippable. Keyed by the exchange close time so the edge
// report can join it to the computed trade.

var TAG_SETUPS = ['A', 'B', 'C'];
var TAG_EMOTIONS = [['plan', 'By plan'], ['fomo', 'FOMO'], ['revenge', 'Revenge'], ['boredom', 'Boredom'], ['fear', 'Fear']];

function _queueTag(symbol, eventTime) {
  if (T.mode === 'test') return; // practice trades stay out of the journal
  // The fill time is what the facts use; the position event may arrive first,
  // so fall back to its own time when the last known fill is stale.
  var lf = T.lastFillAt[symbol];
  var closeTime = lf && (!eventTime || Math.abs(eventTime - lf) < 3000) ? lf : (eventTime || Date.now());
  if (T.tagQueue.some(function (q) { return q.symbol === symbol && q.closeTime === closeTime; })) return;
  T.tagQueue.push({ symbol: symbol, closeTime: closeTime, setup: null, emotion: null });
  if (T.tagQueue.length > 5) T.tagQueue.shift();
  _renderTag();
}

function _renderTag() {
  var el = document.getElementById('dom-tag');
  if (!el) return;
  var q = T.tagQueue[T.tagQueue.length - 1];
  if (!q) { el.innerHTML = ''; return; }
  if (!state.setups) { ensureSetups().then(_renderTag); }
  el.innerHTML = '<span class="dom-tag-sym">' + q.symbol.replace(/USDT$/, '') + (q.pattern ? ' — сетап сохранён, остальное по желанию' : ' closed — какой сетап?') + '</span>'
    + '<span class="dom-tag-group">' + setupButtons().map(function (x) {
        return '<button data-tag-pattern="' + x[0] + '"' + diagramAttr(x[0]) + ' class="' + (q.pattern === x[0] ? 'on' : '') + '">' + x[1] + '</button>';
      }).join('') + '</span>'
    + '<span class="dom-tag-group">' + TAG_SETUPS.map(function (x) {
        return '<button data-tag-setup="' + x + '" class="' + (q.setup === x ? 'on' : '') + '">' + x + '</button>';
      }).join('') + '</span>'
    + '<span class="dom-tag-group">' + TAG_EMOTIONS.map(function (x) {
        return '<button data-tag-emotion="' + x[0] + '" class="' + (q.emotion === x[0] ? 'on' : '') + '">' + x[1] + '</button>';
      }).join('') + '</span>'
    + '<button class="dom-tag-skip" data-tag-skip="1" title="Skip">×</button>';
}

function _tagClick(kind, value) {
  var q = T.tagQueue[T.tagQueue.length - 1];
  if (!q) return;
  q[kind] = value;
  var body = { symbol: q.symbol, closeTime: q.closeTime };
  body[kind] = value;
  saveTradeTag(body).catch(function (e) { _setStatus(e.message, true); });
  // Only the setup is required (it's what My edge needs). Once it's chosen the
  // row stays a few seconds for the optional quality / emotion, then goes.
  if (q.pattern && q.setup && q.emotion) _dropTag(q);
  else if (q.pattern && !q.dropTimer) q.dropTimer = setTimeout(function () { _dropTag(q); }, TAG_OPTIONAL_MS);
  _renderTag();
}

var TAG_OPTIONAL_MS = 6000;
function _dropTag(q) {
  clearTimeout(q.dropTimer);
  var i = T.tagQueue.indexOf(q);
  if (i !== -1) T.tagQueue.splice(i, 1);
  _renderTag();
}

// ── 2FA lock bar ─────────────────────────────────────────────────────────────
// Opening risk needs an unlock when 2FA is on (the trader enforces it; this
// just tells you before you click). Reduce-only / close / cancel always work.

// Day gate (morning briefing filled, evening not yet) comes first; the server
// enforces it too. Polled while the ladder is open so the morning card unlocks
// the terminal without a reload.
function _refreshDay() {
  tradeRequest('GET', 'day').then(function (d) {
    var changed = !T.day || T.day.open !== d.open || T.day.reason !== d.reason;
    T.day = d;
    if (changed) _renderLock(true);
  }).catch(function () {});
}

function _lockState() {
  if (T.day && !T.day.open) return 'day';
  var f = T.access && T.access.twoFactor;
  if (!f) return 'none';
  if (!f.enabled) return f.required ? 'setup' : 'none';
  return f.unlockedUntil > Date.now() ? 'open' : 'locked';
}

function _renderLock(force) {
  var el = document.getElementById('dom-lock');
  if (!el) return;
  var st = _lockState();
  var f = (T.access && T.access.twoFactor) || {};
  var key = st + ':' + (f.unlockedUntil || 0);
  if (!force && key === T.lockKey) return; // keep a half-typed code intact
  T.lockKey = key;
  clearTimeout(T.lockTimer);
  if (st === 'none') { el.innerHTML = ''; el.className = 'dom-lock'; return; }
  if (st === 'day') {
    el.className = 'dom-lock warn';
    el.textContent = T.day.reason;
    return;
  }
  if (st === 'setup') {
    el.className = 'dom-lock warn';
    el.innerHTML = 'Set up 2FA in Account → Integrations to trade live';
    return;
  }
  if (st === 'open') {
    var t = new Date(f.unlockedUntil);
    el.className = 'dom-lock open';
    el.innerHTML = 'Unlocked until ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
      + ' <button data-lock="1">Lock</button>';
    T.lockTimer = setTimeout(function () { _renderLock(true); }, Math.max(1000, f.unlockedUntil - Date.now() + 500));
    return;
  }
  el.className = 'dom-lock locked';
  el.innerHTML = 'Locked · <input id="dom-unlock-code" inputmode="numeric" maxlength="6" placeholder="2FA code" autocomplete="one-time-code">'
    + ' <button data-unlock="1">Unlock</button>';
}

function _unlock() {
  var input = document.getElementById('dom-unlock-code');
  var code = input ? input.value.trim() : '';
  if (!/^\d{6}$/.test(code)) { _setStatus('Enter the 6-digit code from your authenticator', true); return; }
  tradeRequest('POST', 'unlock', { code: code }).then(function (f) {
    T.access = Object.assign({}, T.access, { twoFactor: f });
    _renderLock(true);
    _setStatus('Trading unlocked', false);
  }).catch(function (e) {
    if (input) input.value = '';
    _setStatus(e.message, true);
  });
}

function _lock() {
  tradeRequest('POST', 'lock', {}).then(function (f) {
    T.access = Object.assign({}, T.access, { twoFactor: f });
    _renderLock(true);
  }).catch(function (e) { _setStatus(e.message, true); });
}

function _lockedBlocked() {
  var st = _lockState();
  if (st === 'day') { _setStatus(T.day.reason, true); return true; }
  if (st === 'locked') {
    _setStatus('Trading is locked — enter your 2FA code above', true);
    var i = document.getElementById('dom-unlock-code');
    if (i) i.focus();
    return true;
  }
  if (st === 'setup') { _setStatus('Set up 2FA in your account before live trading', true); return true; }
  return false;
}

function _onLevelClick(idx, side, shift, alt) {
  if (_viewOnlyBlocked()) return;
  if (!shift && _lockedBlocked()) return; // Shift = close-position SL/TP, always allowed
  if (!T.rules || !T.bids.length || !T.asks.length) return;
  // Repeated clicks on a level add up (one order each); only a bounce within 120 ms is dropped
  var key = idx + ':' + side + ':' + shift + ':' + alt;
  var now = Date.now();
  if (T.lastClick.key === key && now - T.lastClick.at < 120) return; // mouse bounce, not a deliberate repeat
  T.lastClick = { key: key, at: now };

  var price = _priceOf(idx);
  var bestBid = T.bids[0][0], bestAsk = T.asks[0][0];

  if (shift) return _placeProtective(price, bestBid, bestAsk);
  if (alt) return _placeStopEntry(price, bestBid, bestAsk);

  var qty = T.size / price;
  var through = side === 'BUY' ? price >= bestAsk : price <= bestBid;
  _placeOptimistic({
    clientOrderId: _clientId(), symbol: T.sym, side: side, type: 'LIMIT',
    price: String(price), quantity: String(qty), timeInForce: through ? 'IOC' : 'GTC',
  }, price, side === 'BUY' ? 'B' : 'S', (side === 'BUY' ? 'Buy ' : 'Sell ') + (through ? 'now up to ' : 'limit at ') + price);
}

// Stops (SL / TP / stop entries) trigger on the LAST traded price, the one the
// ladder and the tape show. Binance's default is the mark price — an index
// average that updates about once a second and lags a fast move, so a stop on
// mark fires late after the price already traded through it.
var STOP_TRIGGER = 'CONTRACT_PRICE';

// Pending entry: buy when the price rises to the level, sell when it falls to it.
// Market on trigger (fills even in a fast move; may slip by the spread).
function _placeStopEntry(price, bestBid, bestAsk) {
  var side = price > bestAsk ? 'BUY' : price < bestBid ? 'SELL' : null;
  if (!side) { _setStatus('Stop orders go above the ask (buy) or below the bid (sell)', true); return; }
  _placeOptimistic({
    clientOrderId: _clientId(), symbol: T.sym, side: side, type: 'STOP_MARKET',
    triggerPrice: String(price), quantity: String(T.size / price), workingType: STOP_TRIGGER,
  }, price, side === 'BUY' ? 'BS' : 'SS', (side === 'BUY' ? 'Buy stop at ' : 'Sell stop at ') + price);
}

function _isStopEntry(a) { return a.type === 'STOP_MARKET' && !a.closePosition && !a.reduceOnly; }

function _placeProtective(price, bestBid, bestAsk) {
  var pos = _position();
  if (!pos) { _setStatus('Open a position first, then Shift+click for SL/TP', true); return; }
  var long = Number(pos.amount) > 0;
  var type;
  if (long) type = price < bestBid ? 'STOP_MARKET' : price > bestAsk ? 'TAKE_PROFIT_MARKET' : null;
  else type = price > bestAsk ? 'STOP_MARKET' : price < bestBid ? 'TAKE_PROFIT_MARKET' : null;
  if (!type) { _setStatus('SL/TP must be outside the spread', true); return; }
  _placeOptimistic({
    clientOrderId: _clientId(), symbol: T.sym, side: long ? 'SELL' : 'BUY', type: type,
    triggerPrice: String(price), closePosition: true, workingType: STOP_TRIGGER,
  }, price, type === 'STOP_MARKET' ? 'SL' : 'TP', (type === 'STOP_MARKET' ? 'Stop-loss at ' : 'Take-profit at ') + price);
}

function _cancelAtLevel(idx) {
  if (_viewOnlyBlocked()) return;
  var step = _step();
  var items = _myOrdersByIdx(step)[idx] || [];
  items.forEach(function (x) {
    var key = x.order ? 'o' + x.order.orderId : x.algo ? 'a' + x.algo.algoId : null;
    if (!key || T.cancelling[key]) return;
    T.cancelling[key] = true; // struck through until the exchange confirms
    var req = x.order ? _send('cancel', { symbol: T.sym, orderId: x.order.orderId }, 'Cancelled')
                      : _send('cancel', { algoId: x.algo.algoId }, 'Cancelled');
    req.then(function () {
      if (x.order) T.account.orders = T.account.orders.filter(function (o) { return o.orderId !== x.order.orderId; });
      else T.account.algoOrders = T.account.algoOrders.filter(function (a) { return a.algoId !== x.algo.algoId; });
    }).catch(function () {}).finally(function () { delete T.cancelling[key]; _queueRender(); });
  });
  _queueRender();
}

// Space: flat on this coin — cancel every resting order (limits, stop entries,
// SL/TP) and market-close the position, both at once
function _closePosition() {
  var pos = _position();
  var hasOrders = T.account.orders.some(function (o) { return o.symbol === T.sym; })
    || T.account.algoOrders.some(function (a) { return a.symbol === T.sym; });
  if (!pos && !hasOrders) { _setStatus('No position or orders to close', true); return; }
  var coin = T.sym.replace(/USDT$/, '');
  if (hasOrders) _send('cancel-all', { symbol: T.sym }, pos ? null : 'All orders on ' + coin + ' cancelled').catch(function () {});
  if (!pos) return;
  var amt = Number(pos.amount);
  _send('order', {
    clientOrderId: _clientId(), symbol: T.sym, side: amt > 0 ? 'SELL' : 'BUY', type: 'MARKET',
    quantity: String(Math.abs(amt)), reduceOnly: true,
  }, hasOrders ? 'Closing position, orders cancelled' : 'Closing position').catch(function () {});
}

function _cancelAll() {
  _send('cancel-all', { symbol: T.sym }, 'All orders on ' + T.sym.replace(/USDT$/, '') + ' cancelled');
}

// ── Events ──────────────────────────────────────────────────────────────────

// Option / Shift state (for the ghost order in Mine). true when it changed.
function _modsChanged(e) {
  var m = { alt: !!e.altKey, shift: !!e.shiftKey };
  var was = T.mods || {};
  T.mods = m;
  return m.alt !== !!was.alt || m.shift !== !!was.shift;
}
['keydown', 'keyup'].forEach(function (type) {
  document.addEventListener(type, function (e) {
    if (e.key !== 'Alt' && e.key !== 'Shift') return;
    if (_modsChanged(e) && T.hover) _drawRuler();
  });
});
window.addEventListener('blur', function () { T.mods = null; _drawRuler(); });

function _bindPanel(panel) {
  panel.addEventListener('mouseenter', function () { T.hover = true; });
  panel.addEventListener('mouseleave', function () { T.hover = false; T.pinned = false; T.hoverRow = null; _drawRuler(); _queueRender(); });
  panel.addEventListener('mousemove', function (e) {
    var row = e.target.closest('.dom-row');
    var r = row ? Array.prototype.indexOf.call(row.parentNode.children, row) : null;
    var mods = _modsChanged(e);
    if (r !== T.hoverRow || mods) { T.hoverRow = r; _drawRuler(); }
  });

  panel.addEventListener('click', function (e) {
    var vc = e.target.closest('[data-vcol]');
    if (vc) { if (!vc.classList.contains('na')) _toggleVenueCol(vc.dataset.vcol); return; }
    if (e.target.closest('[data-cl-tf]')) {
      var tfs = Object.keys(CLUSTER_TFS).filter(function (k) { return k !== 'off'; });
      _setClusterTf(tfs[(tfs.indexOf(S.clusterTf) + 1) % tfs.length]);
      return;
    }
    var jump = e.target.closest('[data-jump]');
    if (jump) { _jumpTo(Number(jump.dataset.jump)); return; }
    var md = e.target.closest('[data-mode]');
    if (md) { _switchMode(md.dataset.mode); return; }
    if (e.target.closest('[data-settings]')) { _openSettings(); return; }
    var size = e.target.closest('[data-size]');
    if (size) { _pickSize(Number(size.dataset.size)); return; }
    var ts = e.target.closest('[data-tag-setup]');
    if (ts) { _tagClick('setup', ts.dataset.tagSetup); return; }
    var tp = e.target.closest('[data-tag-pattern]');
    if (tp) { _tagClick('pattern', tp.dataset.tagPattern); return; }
    var te = e.target.closest('[data-tag-emotion]');
    if (te) { _tagClick('emotion', te.dataset.tagEmotion); return; }
    if (e.target.closest('[data-tag-skip]')) { T.tagQueue.pop(); _renderTag(); return; }
    if (e.target.closest('[data-unlock]')) { _unlock(); return; }
    if (e.target.closest('[data-lock]')) { _lock(); return; }
    var sc = e.target.closest('[data-scale]');
    if (sc) { _changeScale(Number(sc.dataset.scale)); return; }
  });

  // Orders go on mousedown (like trading terminals): instant, and immune to
  // the row updating between press and release.
  panel.addEventListener('mousedown', function (e) {
    if (e.button !== 0 && e.button !== 2) return;
    var row = e.target.closest('.dom-row');
    if (!row) return;
    e.preventDefault();
    var idx = Number(row.dataset.idx);
    if (e.target.closest('.dom-c-mine.has')) {
      // Press on your order: a click cancels it, a drag moves it (see _dragMove / _dragEnd)
      if (e.button !== 0) return;
      var label = e.target.closest('.dom-mine[data-kind]');
      T.drag = { fromIdx: idx, toIdx: idx, kind: label ? label.dataset.kind : null, moved: false };
      return;
    }
    // Orders only from the Volume and Price columns; the Mine column and the gaps do nothing
    if (!e.target.closest('.dom-c-vol, .dom-c-price')) return;
    _onLevelClick(idx, e.button === 0 ? 'BUY' : 'SELL', e.shiftKey, e.altKey);
  });

  panel.addEventListener('keydown', function (e) {
    if (e.target.id === 'dom-unlock-code' && e.key === 'Enter') { e.preventDefault(); _unlock(); }
  });

  panel.addEventListener('contextmenu', function (e) {
    if (e.target.closest('.dom-ladder')) e.preventDefault();
  });

  // Scroll the ladder by wheel instead of letting it auto-center
  // Scroll by the real distance: a trackpad sends dozens of small events per
  // second (plus momentum), a mouse wheel a few big ones. Pixels add up and
  // every ROW_H of them moves the ladder one row; the remainder carries over.
  var wheelAcc = 0;
  panel.addEventListener('wheel', function (e) {
    if (!e.target.closest('.dom-ladder') || T.top == null) return;
    e.preventDefault();
    T.pinned = true;
    var px = e.deltaMode === 1 ? e.deltaY * ROW_H : e.deltaMode === 2 ? e.deltaY * T.rows * ROW_H : e.deltaY;
    wheelAcc += px;
    var rows = wheelAcc > 0 ? Math.floor(wheelAcc / ROW_H) : Math.ceil(wheelAcc / ROW_H);
    if (!rows) return;
    wheelAcc -= rows * ROW_H;
    T.top -= rows;
    _render();
  }, { passive: false });
}

// Order size slot (button or digit key); remembered per coin
function _pickSize(v) {
  T.size = v;
  _lsSet('qt_term_size_' + T.sym, String(v));
  document.querySelectorAll('#dom-sizes .dom-size').forEach(function (b) { b.classList.toggle('active', Number(b.dataset.size) === v); });
}

// −1 finer, +1 coarser; remembered per coin
function _changeScale(dir) {
  var i = (T.scaleIdx || 0) + dir;
  T.scaleIdx = Math.max(0, Math.min(SCALES.length - 1, i));
  T.autoFull = null; T.autoMed = null; T.autoMax = null; // a row now holds more (or less): measure the scale afresh
  _lsSet('qt_term_scale_' + T.sym, String(SCALES[T.scaleIdx]));
  T.top = null;
  _queueRender();
}

// ── Drag your order to another level ────────────────────────────────────────
// A press on a Mine label starts it; moving to another row turns it into a drag
// (the target row is outlined), releasing there moves the orders of that kind;
// releasing on the same row is a click and cancels them. Esc aborts the drag.

document.addEventListener('mousemove', function (e) {
  if (!T.drag) return;
  var row = document.elementFromPoint(e.clientX, e.clientY);
  row = row && row.closest('#dom-ladder .dom-row');
  if (!row) return;
  var to = Number(row.dataset.idx);
  if (to === T.drag.toIdx) return;
  T.drag.toIdx = to;
  if (to !== T.drag.fromIdx && T.drag.kind) {
    T.drag.moved = true;
    document.body.classList.add('dom-dragging');
  }
  _queueRender();
});

document.addEventListener('mouseup', function (e) {
  var d = T.drag;
  if (!d || e.button !== 0) return;
  T.drag = null;
  document.body.classList.remove('dom-dragging');
  if (!d.moved) { _cancelAtLevel(d.fromIdx); return; }
  if (d.toIdx !== d.fromIdx) _moveLevel(d.fromIdx, d.kind, d.toIdx);
  _queueRender();
});

function _moveLevel(fromIdx, kind, toIdx) {
  if (_viewOnlyBlocked()) return;
  var step = _step();
  var items = (_myOrdersByIdx(step)[fromIdx] || []).filter(function (x) { return x.kind === kind && (x.order || x.algo) && !x.cancelling; });
  if (!items.length) return;
  var price = _priceOf(toIdx);
  var bestBid = T.bids[0][0], bestAsk = T.asks[0][0];
  // The exchange is the judge; this only stops the obvious mistakes early
  var bad = kind === 'B' && price >= bestAsk ? 'A buy limit must stay below the ask'
    : kind === 'S' && price <= bestBid ? 'A sell limit must stay above the bid'
    : null;
  if (!bad && items[0].algo) {
    var a = items[0].algo;
    var firesUp = (a.type === 'STOP_MARKET') === (a.side === 'BUY');
    if (firesUp ? price <= bestAsk : price >= bestBid) bad = 'At ' + price + ' the ' + kind + ' would trigger at once';
  }
  if (bad) { _setStatus(bad, true); return; }
  // Moving an entry is like placing one (2FA unlock, day open); SL / TP / reduce-only always move
  var opening = items.some(function (x) { return x.order ? !x.order.reduceOnly : !(x.algo.closePosition || x.algo.reduceOnly); });
  if (opening && _lockedBlocked()) return;

  items.forEach(function (x) {
    var key = x.order ? 'o' + x.order.orderId : 'a' + x.algo.algoId;
    if (T.cancelling[key]) return;
    T.cancelling[key] = true; // old place struck through until the exchange answers
    var ghost = 'mv' + key;
    var qty = x.order ? Number(x.order.origQty) - Number(x.order.executedQty || 0) : x.algo.closePosition ? null : Number(x.algo.quantity);
    T.pending[ghost] = { price: price, kind: kind, qty: qty, at: Date.now() };
    var reducing = x.order ? !!x.order.reduceOnly : !!(x.algo.closePosition || x.algo.reduceOnly);
    var body = { symbol: T.sym, price: String(price), reducing: reducing };
    if (x.order) body.orderId = x.order.orderId; else body.algoId = x.algo.algoId;
    _send('move', body, kind + ' moved to ' + price).then(function (r) {
      if (r && r.order) {
        T.account.orders = T.account.orders.filter(function (o) { return o.orderId !== r.order.orderId; });
        T.account.orders.push(r.order);
      } else if (r && r.algo) {
        T.closedIds[key] = Date.now();
        T.account.algoOrders = T.account.algoOrders.filter(function (o) { return o.algoId !== x.algo.algoId && o.algoId !== r.algo.algoId; });
        T.account.algoOrders.push(r.algo);
      }
    }).catch(function (e) {
      if (/GONE/.test(e.message)) showToast(kind + ' at ' + x.algo.triggerPrice + ' is gone — place it again');
    }).finally(function () {
      delete T.cancelling[key];
      delete T.pending[ghost];
      _queueRender();
    });
  });
  _queueRender();
}

document.addEventListener('keydown', function (e) {
  if (T.drag && e.key === 'Escape') {
    // Abort the drag only; don't let Esc close the coin view
    e.preventDefault();
    e.stopImmediatePropagation();
    T.drag = null;
    document.body.classList.remove('dom-dragging');
    _queueRender();
    return;
  }
  if (!T.sym) return;
  // + / − change the price scale whenever the terminal is open (same as the buttons).
  // By physical key, so it works on any layout; Cmd/Ctrl +/− stays browser zoom.
  if (!e.metaKey && !e.ctrlKey && !e.altKey && !document.getElementById('dom-settings-modal')) {
    var dir = e.code === 'Equal' || e.code === 'NumpadAdd' ? 1 : e.code === 'Minus' || e.code === 'NumpadSubtract' ? -1 : 0;
    var t = (e.target && e.target.tagName) || '';
    var typing = t === 'INPUT' || t === 'TEXTAREA' || e.target.isContentEditable;
    if (dir && !typing) { e.preventDefault(); _changeScale(dir); return; }
    // 1…6 pick the order size slot (top row or numpad)
    var digit = /^(Digit|Numpad)([1-6])$/.exec(e.code);
    if (digit && !typing && S.sizes[digit[2] - 1] != null) { e.preventDefault(); _pickSize(S.sizes[digit[2] - 1]); return; }
  }
  if (!T.hover) return;
  if ((e.code === 'Space' || /^[xXчЧ]$/.test(e.key)) && _viewOnly()) { e.preventDefault(); _viewOnlyBlocked(); return; }
  var tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.code === 'Space') { e.preventDefault(); _closePosition(); }
  else if (e.key === 'x' || e.key === 'X' || e.key === 'ч' || e.key === 'Ч') { e.preventDefault(); _cancelAll(); }
});

window.addEventListener('resize', function () { if (T.sym) { T.top = null; _queueRender(); } });

export function terminalButtonHTML() {
  return '<button class="btn-icon" id="fv-dom-btn" data-action="toggle-terminal" style="display:none" title="Order book">' + icon('list-ordered', 16) + '</button>';
}
