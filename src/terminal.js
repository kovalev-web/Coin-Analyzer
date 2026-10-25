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

var ROW_H = 18;
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
  ws: null, wsTimer: null,
  bids: [], asks: [],    // [[price, qty], ...] best first
  scaleIdx: null, top: null, rows: 0,
  size: Number(_lsGet('qt_term_size')) || 100,
  hover: false,
  pinned: false,         // user scrolled the ladder: stop auto-centering until the mouse leaves
  renderQueued: false,
  lines: [], linesSeries: null, linesKey: '',
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

function _panelHTML() {
  var env = T.access && T.access.env === 'mainnet' ? 'Live' : 'Testnet';
  return '<div class="dom-head">'
    + '<span class="dom-env ' + (env === 'Live' ? 'live' : '') + '">' + env + '</span>'
    + '<div class="dom-sizes">'
    + SIZE_PRESETS.map(function (v) {
        return '<button class="dom-size' + (v === T.size ? ' active' : '') + '" data-size="' + v + '">' + v + '</button>';
      }).join('')
    + '<span class="dom-unit">USDT</span></div>'
    + '<div class="dom-scale"><button data-scale="-1" title="Finer">−</button><button data-scale="1" title="Coarser">+</button></div>'
    + '</div>'
    + '<div class="dom-cols"><span>Mine</span><span>Bid</span><span>Price</span><span>Ask</span></div>'
    + '<div class="dom-ladder" id="dom-ladder"></div>'
    + '<div class="dom-foot">'
    + '<div class="dom-pos" id="dom-pos"></div>'
    + '<div class="dom-status" id="dom-status"></div>'
    + '<div class="dom-hint">LMB buy · RMB sell · Shift+click SL/TP · click Mine to cancel · Space close · X cancel all</div>'
    + '</div>';
}

// ── Depth stream (trader's environment) ─────────────────────────────────────

function _connectDepth() {
  _disconnectDepth();
  if (!T.access || !T.access.marketWs || !T.sym) return;
  var sym = T.sym;
  var ws = new WebSocket(T.access.marketWs + '/' + sym.toLowerCase() + '@depth20@100ms');
  T.ws = ws;
  ws.onmessage = function (ev) {
    if (T.ws !== ws) return;
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    var b = m.b || m.bids, a = m.a || m.asks;
    if (!b || !a) return;
    T.bids = b.map(function (l) { return [Number(l[0]), Number(l[1])]; }).filter(function (l) { return l[1] > 0; });
    T.asks = a.map(function (l) { return [Number(l[0]), Number(l[1])]; }).filter(function (l) { return l[1] > 0; });
    _queueRender();
  };
  ws.onclose = function () {
    if (T.ws !== ws) return;
    T.ws = null;
    if (T.sym === sym) T.wsTimer = setTimeout(_connectDepth, 2000);
  };
}

function _disconnectDepth() {
  clearTimeout(T.wsTimer);
  if (T.ws) { var w = T.ws; T.ws = null; try { w.close(); } catch (e) {} }
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
  } else if (ev.type === 'algo') {
    acc.algoOrders = acc.algoOrders.filter(function (o) { return o.algoId !== ev.algo.algoId; });
    if (OPEN_ALGO[ev.algo.status]) acc.algoOrders.push(ev.algo);
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
  var span = (T.asks[T.asks.length - 1][0] - T.bids[T.bids.length - 1][0]) / _tick();
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
    add(Math.round(Number(o.price) / step), { kind: o.side === 'BUY' ? 'B' : 'S', qty: Number(o.origQty) - Number(o.executedQty || 0), order: o });
  });
  T.account.algoOrders.forEach(function (a) {
    if (a.symbol !== T.sym) return;
    add(Math.round(Number(a.triggerPrice) / step), { kind: a.type === 'TAKE_PROFIT_MARKET' ? 'TP' : 'SL', qty: null, algo: a });
  });
  return out;
}

// ── Render ──────────────────────────────────────────────────────────────────

function _queueRender() {
  if (T.renderQueued) return;
  T.renderQueued = true;
  // Timer, not rAF: rAF stops in background tabs and the ladder would freeze stale
  setTimeout(function () { T.renderQueued = false; _render(); }, 66);
}

function _render() {
  var ladder = document.getElementById('dom-ladder');
  if (!ladder) return;
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
  T.bids.forEach(function (l) { var i = Math.floor(l[0] / step + 1e-9); bidVol[i] = (bidVol[i] || 0) + l[1]; });
  T.asks.forEach(function (l) { var i = Math.ceil(l[0] / step - 1e-9); askVol[i] = (askVol[i] || 0) + l[1]; });
  Object.keys(bidVol).forEach(function (k) { maxVol = Math.max(maxVol, bidVol[k]); });
  Object.keys(askVol).forEach(function (k) { maxVol = Math.max(maxVol, askVol[k]); });

  var mine = _myOrdersByIdx(step);
  var pnl = _pnlInfo();
  var entryIdx = pnl ? Math.round(pnl.entry / step) : null;
  var exitIdx = pnl ? Math.round(pnl.exit / step) : null;
  var pnlLo = pnl ? Math.min(entryIdx, exitIdx) : null, pnlHi = pnl ? Math.max(entryIdx, exitIdx) : null;
  var pnlCls = pnl ? (pnl.up ? ' pnl-up' : ' pnl-dn') : '';
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
    if (row.className !== cls) row.className = cls;
    row.dataset.idx = i;
    var m = mine[i];
    var mineHtml = (i === entryIdx ? '<span class="dom-mine pos">ENTRY</span>' : '') + (m ? m.map(function (x) {
      return '<span class="dom-mine ' + x.kind.toLowerCase() + '">' + x.kind + (x.qty != null ? ' ' + _fmtQty(x.qty) : '') + '</span>';
    }).join('') : '');
    var c = row.children;
    if (c[0]._html !== mineHtml) { c[0].innerHTML = mineHtml; c[0]._html = mineHtml; c[0].classList.toggle('has', !!m); }
    _setVol(c[1], bidVol[i], maxVol);
    var pt = (i * step).toFixed(d);
    if (c[2].textContent !== pt) c[2].textContent = pt;
    _setVol(c[3], askVol[i], maxVol);
  }
}

function _makeRow() {
  var row = document.createElement('div');
  row.className = 'dom-row';
  row.innerHTML = '<span class="dom-c-mine"></span><span class="dom-c-bid"><i></i><b></b></span>'
    + '<span class="dom-c-price"></span><span class="dom-c-ask"><i></i><b></b></span>';
  return row;
}

function _setVol(cell, v, maxVol) {
  var w = v ? Math.round(v / maxVol * 100) + '%' : '0%';
  var t = v ? _fmtQty(v) : '';
  if (cell.firstChild.style.width !== w) cell.firstChild.style.width = w;
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

// ── PnL band on the chart: entry → current exit price, green/red ───────────

function _clearBand() {
  var b = document.getElementById('fv-pnl-band');
  if (b) b.remove();
}

function _syncBand() {
  var series = window.__fvSeries;
  var wrap = document.querySelector('#fv-overlay .fv-chart-wrap');
  var info = _pnlInfo();
  if (!series || !wrap || !info) { _clearBand(); return; }
  var yEntry = series.priceToCoordinate(info.entry);
  var yExit = series.priceToCoordinate(info.exit);
  if (yEntry == null || yExit == null) { _clearBand(); return; }
  var band = document.getElementById('fv-pnl-band');
  if (!band) {
    band = document.createElement('div');
    band.id = 'fv-pnl-band';
    band.className = 'fv-pnl-band';
    band.innerHTML = '<span class="fv-pnl-label"></span>';
    wrap.appendChild(band);
  }
  var h = wrap.clientHeight;
  var top = Math.max(0, Math.min(yEntry, yExit)), bottom = Math.min(h, Math.max(yEntry, yExit));
  var scaleW = 0;
  try { scaleW = series.priceScale().width(); } catch (e) {}
  band.className = 'fv-pnl-band ' + (info.up ? 'up' : 'dn');
  band.style.top = top + 'px';
  band.style.height = Math.max(2, bottom - top) + 'px';
  band.style.right = scaleW + 'px';
  var label = band.firstChild;
  label.textContent = _fmtPnl(info);
  // Label sits at the current-price edge of the band
  label.style.top = (yExit < yEntry ? 0 : Math.max(0, bottom - top - 18)) + 'px';
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

function _onLevelClick(idx, side, shift) {
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
  _send('order', {
    clientOrderId: _clientId(), symbol: T.sym, side: side, type: 'LIMIT',
    price: String(price), quantity: String(qty), timeInForce: through ? 'IOC' : 'GTC',
  }, (side === 'BUY' ? 'Buy ' : 'Sell ') + (through ? 'now up to ' : 'limit at ') + price);
}

function _placeProtective(price, bestBid, bestAsk) {
  var pos = _position();
  if (!pos) { _setStatus('Open a position first, then Shift+click for SL/TP', true); return; }
  var long = Number(pos.amount) > 0;
  var type;
  if (long) type = price < bestBid ? 'STOP_MARKET' : price > bestAsk ? 'TAKE_PROFIT_MARKET' : null;
  else type = price > bestAsk ? 'STOP_MARKET' : price < bestBid ? 'TAKE_PROFIT_MARKET' : null;
  if (!type) { _setStatus('SL/TP must be outside the spread', true); return; }
  _send('order', {
    clientOrderId: _clientId(), symbol: T.sym, side: long ? 'SELL' : 'BUY', type: type,
    triggerPrice: String(price), closePosition: true,
  }, (type === 'STOP_MARKET' ? 'Stop-loss at ' : 'Take-profit at ') + price);
}

function _cancelAtLevel(idx) {
  var step = _step();
  var items = _myOrdersByIdx(step)[idx] || [];
  items.forEach(function (x) {
    if (x.order) _send('cancel', { symbol: T.sym, orderId: x.order.orderId }, 'Cancelled');
    else if (x.algo) _send('cancel', { algoId: x.algo.algoId }, 'Cancelled');
  });
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
  panel.addEventListener('mouseleave', function () { T.hover = false; T.pinned = false; _queueRender(); });

  panel.addEventListener('click', function (e) {
    var size = e.target.closest('[data-size]');
    if (size) {
      T.size = Number(size.dataset.size);
      _lsSet('qt_term_size', String(T.size));
      panel.querySelectorAll('.dom-size').forEach(function (b) { b.classList.toggle('active', b === size); });
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
  var tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.code === 'Space') { e.preventDefault(); _closePosition(); }
  else if (e.key === 'x' || e.key === 'X' || e.key === 'ч' || e.key === 'Ч') { e.preventDefault(); _cancelAll(); }
});

window.addEventListener('resize', function () { if (T.sym) { T.top = null; _queueRender(); } });

export function terminalButtonHTML() {
  return '<button class="btn-icon" id="fv-dom-btn" data-action="toggle-terminal" style="display:none" title="Order book">' + icon('list-ordered', 16) + '</button>';
}
