// ── Order book terminal (DOM ladder) inside the coin full view ───────────────
// Trading happens only by clicking the ladder:
//   left click  → buy,  right click → sell
//   below the market a buy rests as a limit order; at/through it fills now
//   (limit IOC at the clicked price, so a fast market can't fill worse)
//   Shift+click → stop-loss / take-profit for the open position (close-position)
//   click on "Mine" cell → cancel your orders on that level
//   hotkeys while the mouse is over the ladder: Space = close position, X = cancel all
// Ladder data comes from the trader's own environment (testnet or live), never
// from the main chart feed: testnet prices differ from the real market.

import { tradeRequest } from './api.js';
import { on } from './events.js';
import { icon } from './utils.js';
import { showToast, getCSSVar } from './ui.js';

var ROW_H = 16;
var SIZE_PRESETS = [50, 100, 250, 500, 1000];
var SCALES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
var OPEN_ORDER = { NEW: true, PARTIALLY_FILLED: true };
var OPEN_ALGO = { NEW: true, TRIGGERING: true };

var T = {
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
  closedIds: {},         // orderId/algoId seen closed by the stream (beats a late placement reply)        // orderId/algoId → true while a cancel is in flight
  bids: [], asks: [],    // [[price, qty], ...] best first
  scaleIdx: null, top: null, rows: 0,
  size: Number(_lsGet('qt_term_size')) || 100,
  hover: false,
  hoverRow: null,        // ladder row under the cursor (screen position), for the % ruler
  viewLive: _lsGet('qt_term_live') === '1', // testnet account, live-market book (view only)
  pinned: false,         // user scrolled the ladder: stop auto-centering until the mouse leaves
  renderQueued: false,
  lines: [], linesSeries: null, linesKey: '',
  zone: null, zoneSeries: null,
  lastClick: { key: '', at: 0 },
};

function _lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function _lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

// ── Access ─────────────────────────────────────────────────────────────────

function checkAccess() {
  if (T.access) return Promise.resolve(T.access);
  if (T.accessPromise) return T.accessPromise;
  T.accessPromise = tradeRequest('GET', 'status').then(function (s) {
    T.access = s;
    return tradeRequest('GET', 'account').then(function (a) { T.account = a; return s; });
  }).catch(function () {
    T.access = false;
    return false;
  }).finally(function () { T.accessPromise = null; });
  return T.accessPromise;
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
  if (T.sym !== sym) {
    T.sym = sym;
    T.rules = null; T.bids = []; T.asks = []; T.scaleIdx = null; T.top = null;
    tradeRequest('GET', 'rules?symbol=' + sym).then(function (r) {
      if (T.sym !== sym) return;
      T.rules = r;
      _queueRender();
    }).catch(function (e) { _setStatus('Rules: ' + e.message, true); });
    _connectDepth();
  }
  panel.innerHTML = _panelHTML();
  panel.classList.toggle('view-only', _viewOnly());
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
  T.sym = null;
  var panel = document.getElementById('fv-dom');
  if (panel) panel.remove();
  var body = document.querySelector('#fv-overlay .fv-body');
  if (body) body.classList.remove('has-dom');
}

function _isTestnet() { return !(T.access && T.access.env === 'mainnet'); }
function _viewOnly() { return _isTestnet() && T.viewLive; }

function _panelHTML() {
  var env = _isTestnet() ? 'Testnet' : 'Live';
  return '<div class="dom-head">'
    + '<span class="dom-env ' + (env === 'Live' ? 'live' : '') + '">' + env + '</span>'
    + (_isTestnet()
        ? '<button class="dom-book' + (T.viewLive ? ' active' : '') + '" data-live="1" title="Show the live Binance order book (view only)">'
          + (T.viewLive ? 'Live book' : 'Testnet book') + '</button>'
        : '')
    + '<div class="dom-sizes">'
    + SIZE_PRESETS.map(function (v) {
        return '<button class="dom-size' + (v === T.size ? ' active' : '') + '" data-size="' + v + '">' + v + '</button>';
      }).join('')
    + '<span class="dom-unit">USDT</span></div>'
    + '<div class="dom-scale"><button data-scale="-1" title="Finer">−</button><button data-scale="1" title="Coarser">+</button></div>'
    + '</div>'
    + (_viewOnly() ? '<div class="dom-viewonly">Live market · view only — trading is off</div>' : '')
    + '<div class="dom-cols"><span>Mine</span><span>Volume</span><span>Price</span></div>'
    + '<div class="dom-ladder" id="dom-ladder"></div>'
    + '<div class="dom-foot">'
    + '<div class="dom-pos" id="dom-pos"></div>'
    + '<div class="dom-status" id="dom-status"></div>'
    + '<div class="dom-hint">LMB buy · RMB sell · Shift+click SL/TP · click Mine to cancel · Space close · X cancel all</div>'
    + '</div>';
}

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

  var wt = new WebSocket(roots.ws + '/market/ws/' + s + '@aggTrade');
  T.wsTrades = wt;
  wt.onmessage = function (ev) {
    if (T.wsTrades !== wt) return;
    var d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.e !== 'aggTrade') return;
    T.lastTrade = { price: Number(d.p), buy: !d.m, at: Date.now() };
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
}

// ── Account events ──────────────────────────────────────────────────────────

on('trade:event', function (ev) {
  if (!ev || !T.access) return;
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
    acc.positions = acc.positions.filter(function (x) { return !(x.symbol === p.symbol && x.positionSide === p.positionSide); });
    if (Number(p.amount) !== 0) acc.positions.push(p);
  } else if (ev.type === 'balance') {
    acc.balances = acc.balances.filter(function (b) { return b.asset !== ev.balance.asset; });
    acc.balances.push(ev.balance);
  } else if (ev.type === 'status') {
    T.access = Object.assign({}, T.access, ev.status);
  } else if (ev.type === 'fill') {
    var f = ev.fill;
    if (T.sym === f.symbol || T.open) showToast('Filled ' + f.side + ' ' + f.quantity + ' ' + f.symbol.replace(/USDT$/, '') + ' @ ' + f.price);
  }
  _queueRender();
});

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
  // Fit roughly the 20 nearest levels per side into the window
  var span = (T.asks[Math.min(19, T.asks.length - 1)][0] - T.bids[Math.min(19, T.bids.length - 1)][0]) / _tick();
  var want = span / Math.max(10, T.rows * 0.8);
  var i = 0;
  while (i < SCALES.length - 1 && SCALES[i] < want) i++;
  T.scaleIdx = i;
}

function _fmtQty(q) {
  if (q >= 1e6) return (q / 1e6).toFixed(1) + 'M';
  if (q >= 1e3) return (q / 1e3).toFixed(1) + 'K';
  if (q >= 10) return q.toFixed(0);
  return q.toPrecision(2);
}

function _position() {
  return T.account.positions.find(function (p) { return p.symbol === T.sym && Number(p.amount) !== 0; }) || null;
}

// PnL marked to the price you could close at now: best bid for a long, best ask for a short.
function _pnlInfo() {
  if (_viewOnly()) return null; // testnet position vs live prices would be meaningless
  var pos = _position();
  if (!pos || !T.bids.length || !T.asks.length) return null;
  var amt = Number(pos.amount), entry = Number(pos.entryPrice);
  var exit = amt > 0 ? T.bids[0][0] : T.asks[0][0];
  var pnl = amt * (exit - entry);
  return {
    pos: pos, amt: amt, entry: entry, exit: exit, pnl: pnl,
    pct: entry ? (exit - entry) / entry * 100 * (amt > 0 ? 1 : -1) : 0,
    up: pnl >= 0,
  };
}

function _myOrdersByIdx(step) {
  var out = {};
  function add(idx, item) { (out[idx] = out[idx] || []).push(item); }
  T.account.orders.forEach(function (o) {
    if (o.symbol !== T.sym) return;
    add(Math.round(Number(o.price) / step), { kind: o.side === 'BUY' ? 'B' : 'S', qty: Number(o.origQty) - Number(o.executedQty || 0), order: o, cancelling: !!T.cancelling['o' + o.orderId] });
  });
  T.account.algoOrders.forEach(function (a) {
    if (a.symbol !== T.sym) return;
    add(Math.round(Number(a.triggerPrice) / step), { kind: a.type === 'TAKE_PROFIT_MARKET' ? 'TP' : 'SL', qty: null, algo: a, cancelling: !!T.cancelling['a' + a.algoId] });
  });
  Object.keys(T.pending).forEach(function (id) {
    var p = T.pending[id];
    add(Math.round(p.price / step), { kind: p.kind, qty: p.qty, pending: true });
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
    ladder.innerHTML = '<div class="dom-empty">' + (T.rules ? 'Waiting for order book…' : 'Loading…') + '</div>';
    return;
  }
  var empty = ladder.querySelector('.dom-empty');
  if (empty) empty.remove();
  T.rows = Math.max(10, Math.floor(ladder.clientHeight / ROW_H));
  _autoScale();
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

  var mine = _myOrdersByIdx(step);
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
    if (i === entryIdx) cls += ' entry';
    if (pnl && i >= pnlLo && i <= pnlHi) cls += pnlCls;
    if (tradeIdx === i) cls += tradeCls;
    if (row.className !== cls) row.className = cls;
    row.dataset.idx = i;
    var m = mine[i];
    var mineHtml = (i === entryIdx ? '<span class="dom-mine pos">ENTRY</span>' : '') + (m ? m.map(function (x) {
      return '<span class="dom-mine ' + x.kind.toLowerCase() + (x.pending ? ' pending' : '') + (x.cancelling ? ' cancelling' : '') + '">' + x.kind + (x.qty != null ? ' ' + _fmtQty(x.qty) : '') + '</span>';
    }).join('') : '');
    var c = row.children;
    if (c[0]._html !== mineHtml) { c[0].innerHTML = mineHtml; c[0]._html = mineHtml; c[0].classList.toggle('has', !!m); }
    // One volume column: asks above the spread, bids below, heat-filled by size
    _setVol(c[1], i >= askIdx ? askVol[i] : i <= bidIdx ? bidVol[i] : 0, maxVol);
    var pt = (i * step).toFixed(d);
    if (c[2].textContent !== pt) c[2].textContent = pt;
  }
  _drawRuler();
}

// ── % ruler: distance from the current price to the hovered level ──────────

function _drawRuler() {
  var panel = document.getElementById('fv-dom');
  var ladder = document.getElementById('dom-ladder');
  if (!panel || !ladder) return;
  var box = document.getElementById('dom-ruler');
  if (T.hoverRow == null || !T.rules || !T.bids.length || !T.asks.length || !ladder.children.length || ladder.querySelector('.dom-empty')) {
    if (box) box.style.display = 'none';
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
  var refIdx = Math.round(ref / step);
  // Row under the cursor, not a remembered price: the ladder may recenter under a still mouse
  var rHover = T.hoverRow, hoverIdx = T.top - rHover, rRef = T.top - refIdx;
  var last = ladder.children.length - 1;
  rRef = Math.max(0, Math.min(last, rRef));
  if (rHover < 0 || rHover > last) { box.style.display = 'none'; return; }
  // Just the number, on the hovered row
  var rect = ladder.children[rHover].getBoundingClientRect();
  var pct = (_priceOf(hoverIdx) - ref) / ref * 100;
  box.style.display = 'block';
  box.style.top = (rect.top - panel.getBoundingClientRect().top) + 'px';
  box.style.height = rect.height + 'px';
  var tag = box.firstChild;
  tag.textContent = (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct).toFixed(2) + '%';
}

function _makeRow() {
  var row = document.createElement('div');
  row.className = 'dom-row';
  row.innerHTML = '<span class="dom-c-mine"></span><span class="dom-c-vol"><i></i><b></b></span>'
    + '<span class="dom-c-price"></span>';
  return row;
}

// Bar length ∝ size (relative to the biggest level on screen); bigger also brighter
function _setVol(cell, v, maxVol) {
  var r = v && maxVol ? v / maxVol : 0;
  var w = v ? Math.max(2, Math.round(r * 100)) + '%' : '0%';
  var o = v ? (0.35 + 0.5 * r).toFixed(2) : '0';
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
  if (!pos) {
    el.innerHTML = '<div class="dom-pos-row"><span>Position</span><b>Flat</b></div>'
      + '<div class="dom-pos-row"><span>Available</span><b>' + avail + ' USDT</b></div>';
  } else {
    var amt = Number(pos.amount);
    var info = _pnlInfo();
    var pnlHtml = info
      ? '<b class="dom-pnl ' + (info.up ? 'up' : 'dn') + '">' + _fmtPnl(info) + '</b>'
      : '<b>—</b>';
    el.innerHTML = '<div class="dom-pos-row"><span>Position</span><b class="' + (amt > 0 ? 'up' : 'dn') + '">' + (amt > 0 ? 'Long ' : 'Short ') + Math.abs(amt) + '</b></div>'
      + '<div class="dom-pos-row"><span>Entry</span><b>' + pos.entryPrice + '</b></div>'
      + '<div class="dom-pos-row"><span>PnL</span>' + pnlHtml + '</div>'
      + '<div class="dom-pos-row"><span>Available</span><b>' + avail + ' USDT</b></div>';
  }
  var st = document.getElementById('dom-status');
  if (st && T.access && !T.access.tradingEnabled) {
    st.textContent = 'Trading is disabled by the kill switch';
    st.className = 'dom-status err';
  }
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
    ctx.save();
    ctx.fillStyle = g.color;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(g.x, g.top, w, g.h);
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = g.color;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(g.x, Math.round(g.yExit) + 0.5); ctx.lineTo(g.x + w, Math.round(g.yExit) + 0.5);
    ctx.moveTo(g.x + 0.5, g.top); ctx.lineTo(g.x + 0.5, g.top + g.h);
    ctx.stroke();
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
    ctx.font = '600 12px Manrope, Arial, sans-serif';
    var text = self.d.label;
    var tw = ctx.measureText(text).width, padX = 6, bh = 18;
    var bx = scope.mediaSize.width - tw - padX * 2 - 8;
    // Label on the current-price edge of the zone
    var by = g.yExit < g.yEntry ? g.yExit - bh - 2 : g.yExit + 2;
    by = Math.max(0, Math.min(scope.mediaSize.height - bh, by));
    ctx.fillStyle = self.d.color;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, tw + padX * 2, bh, 4); else ctx.rect(bx, by, tw + padX * 2, bh);
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
    // The label is the real PnL at the price you can close at now
    color: getCSSVar(info.up ? '--bullish' : '--danger'),
    label: _fmtPnl(info),
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
  if (pos) specs.push({ price: Number(pos.entryPrice), color: '--primary', title: (Number(pos.amount) > 0 ? 'Long ' : 'Short ') + Math.abs(Number(pos.amount)), style: 0 });
  T.account.orders.forEach(function (o) {
    if (o.symbol === T.sym) specs.push({ price: Number(o.price), color: o.side === 'BUY' ? '--bullish' : '--danger', title: (o.side === 'BUY' ? 'B ' : 'S ') + o.origQty, style: 2 });
  });
  T.account.algoOrders.forEach(function (a) {
    if (a.symbol === T.sym) specs.push({ price: Number(a.triggerPrice), color: a.type === 'TAKE_PROFIT_MARKET' ? '--bullish' : '--danger', title: a.type === 'TAKE_PROFIT_MARKET' ? 'TP' : 'SL', style: 1 });
  });
  var key = JSON.stringify(specs);
  if (series === T.linesSeries && key === T.linesKey) return;
  _clearLines();
  T.linesSeries = series;
  T.linesKey = key;
  specs.forEach(function (s) {
    var c = getCSSVar(s.color);
    try {
      T.lines.push(series.createPriceLine({ price: s.price, color: c, lineWidth: 1, lineStyle: s.style, axisLabelVisible: true, axisLabelColor: c, axisLabelTextColor: '#fff', title: s.title }));
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
    throw e;
  });
}

// Show the order on its level right away; it is replaced by the real order
// when the exchange confirms, or dropped on error.
function _placeOptimistic(body, price, kind, okMsg) {
  var id = body.clientOrderId;
  T.pending[id] = { price: price, kind: kind, qty: body.quantity != null ? Number(body.quantity) : null, at: Date.now() };
  _queueRender();
  return _send('order', body, okMsg).then(function (r) {
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

function _onLevelClick(idx, side, shift) {
  if (_viewOnlyBlocked()) return;
  if (!T.rules || !T.bids.length || !T.asks.length) return;
  // Ignore an accidental double click on the same level within 300ms
  var key = idx + ':' + side + ':' + shift;
  var now = Date.now();
  if (T.lastClick.key === key && now - T.lastClick.at < 300) return;
  T.lastClick = { key: key, at: now };

  var price = _priceOf(idx);
  var bestBid = T.bids[0][0], bestAsk = T.asks[0][0];

  if (shift) return _placeProtective(price, bestBid, bestAsk);

  var qty = T.size / price;
  var through = side === 'BUY' ? price >= bestAsk : price <= bestBid;
  _placeOptimistic({
    clientOrderId: _clientId(), symbol: T.sym, side: side, type: 'LIMIT',
    price: String(price), quantity: String(qty), timeInForce: through ? 'IOC' : 'GTC',
  }, price, side === 'BUY' ? 'B' : 'S', (side === 'BUY' ? 'Buy ' : 'Sell ') + (through ? 'now up to ' : 'limit at ') + price);
}

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
    triggerPrice: String(price), closePosition: true,
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

function _closePosition() {
  var pos = _position();
  if (!pos) { _setStatus('No position to close', true); return; }
  var amt = Number(pos.amount);
  _send('order', {
    clientOrderId: _clientId(), symbol: T.sym, side: amt > 0 ? 'SELL' : 'BUY', type: 'MARKET',
    quantity: String(Math.abs(amt)), reduceOnly: true,
  }, 'Closing position');
}

function _cancelAll() {
  _send('cancel-all', { symbol: T.sym }, 'All orders on ' + T.sym.replace(/USDT$/, '') + ' cancelled');
}

// ── Events ──────────────────────────────────────────────────────────────────

function _bindPanel(panel) {
  panel.addEventListener('mouseenter', function () { T.hover = true; });
  panel.addEventListener('mouseleave', function () { T.hover = false; T.pinned = false; T.hoverRow = null; _drawRuler(); _queueRender(); });
  panel.addEventListener('mousemove', function (e) {
    var row = e.target.closest('.dom-row');
    var r = row ? Array.prototype.indexOf.call(row.parentNode.children, row) : null;
    if (r !== T.hoverRow) { T.hoverRow = r; _drawRuler(); }
  });

  panel.addEventListener('click', function (e) {
    var size = e.target.closest('[data-size]');
    if (size) {
      T.size = Number(size.dataset.size);
      _lsSet('qt_term_size', String(T.size));
      panel.querySelectorAll('.dom-size').forEach(function (b) { b.classList.toggle('active', b === size); });
      return;
    }
    var lv = e.target.closest('[data-live]');
    if (lv) {
      T.viewLive = !T.viewLive;
      _lsSet('qt_term_live', T.viewLive ? '1' : '0');
      T.bids = []; T.asks = []; T.scaleIdx = null; T.top = null;
      panel.innerHTML = _panelHTML();
      panel.classList.toggle('view-only', _viewOnly());
      _connectDepth();
      _queueRender();
      return;
    }
    var sc = e.target.closest('[data-scale]');
    if (sc) {
      var i = (T.scaleIdx || 0) + Number(sc.dataset.scale);
      T.scaleIdx = Math.max(0, Math.min(SCALES.length - 1, i));
      T.top = null;
      _queueRender();
      return;
    }
  });

  // Orders go on mousedown (like trading terminals): instant, and immune to
  // the row updating between press and release.
  panel.addEventListener('mousedown', function (e) {
    if (e.button !== 0 && e.button !== 2) return;
    var row = e.target.closest('.dom-row');
    if (!row) return;
    e.preventDefault();
    var idx = Number(row.dataset.idx);
    if (e.target.closest('.dom-c-mine.has')) { if (e.button === 0) _cancelAtLevel(idx); return; }
    _onLevelClick(idx, e.button === 0 ? 'BUY' : 'SELL', e.shiftKey);
  });

  panel.addEventListener('contextmenu', function (e) {
    if (e.target.closest('.dom-ladder')) e.preventDefault();
  });

  // Scroll the ladder by wheel instead of letting it auto-center
  panel.addEventListener('wheel', function (e) {
    if (!e.target.closest('.dom-ladder') || T.top == null) return;
    e.preventDefault();
    T.pinned = true;
    T.top += e.deltaY > 0 ? -3 : 3;
    _render();
  }, { passive: false });
}

document.addEventListener('keydown', function (e) {
  if (!T.sym || !T.hover) return;
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
