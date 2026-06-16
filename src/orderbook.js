'use strict';

// Direct browser → Binance Futures WS for FV liquidity panel.
// depth20@100ms (spread + depth) via /stream?streams=.
// aggTrade (tape + aggression) via /market/ws + explicit SUBSCRIBE — the combined
// /stream?streams= and /ws/<symbol>@aggTrade endpoints return zero aggTrade messages
// for retail connections; /market/ws + SUBSCRIBE delivers real-time data (same
// endpoint server-vps.js uses for the phase detector's microstructure feed).

export var AGGRESSION_WINDOW_MS = 15000;
var RECONNECT_DELAY_MS = 3000;
var DEPTH_MEDIAN_WINDOW = 10; // ~1s at depth20@100ms — filters out brief wall spikes
var KEEP_ALIVE_MS = 12000;

var _depthWs = null;
var _tradeWs = null;
var _sym = null;
var _onUpdate = null;
var _depthReconnectTimer = null;
var _tradeReconnectTimer = null;
var _closed = true;
var _keepAliveTimer = null;
var _connectedAt = null;
var _symWarmCache = {}; // fullSym → { connectedAt, disconnectedAt }
var WARM_CACHE_TTL = 300000; // 5 min

var _bids = [];
var _asks = [];
var _trades = []; // [{ ts, qty, isBuy }]
var _depthBidBuf = [];
var _depthAskBuf = [];

function spreadBps(bids, asks) {
  if (!bids.length || !asks.length) return null;
  var bestBid = bids[0][0];
  var bestAsk = asks[0][0];
  var mid = (bestBid + bestAsk) / 2;
  if (mid === 0) return null;
  return (bestAsk - bestBid) / mid * 10000;
}

function depthUsdt50bps(levels, mid, side) {
  if (!levels.length || mid === 0) return 0;
  var threshold = mid * (side === 'bid' ? (1 - 0.005) : (1 + 0.005));
  var total = 0;
  for (var i = 0; i < levels.length; i++) {
    var price = levels[i][0];
    var qty = levels[i][1];
    if (side === 'bid' && price < threshold) break;
    if (side === 'ask' && price > threshold) break;
    total += price * qty;
  }
  return total;
}

function median(arr) {
  var sorted = arr.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function trimTrades(now) {
  while (_trades.length && now - _trades[0].ts > AGGRESSION_WINDOW_MS) _trades.shift();
}

function aggression(now) {
  trimTrades(now);
  var buyVol = 0, sellVol = 0;
  for (var i = 0; i < _trades.length; i++) {
    if (_trades[i].isBuy) buyVol += _trades[i].qty; else sellVol += _trades[i].qty;
  }
  var total = buyVol + sellVol;
  return {
    buyVol: buyVol,
    sellVol: sellVol,
    ratio: total > 0 ? buyVol / total : 0.5,
    tradesPerSec: _trades.length / (AGGRESSION_WINDOW_MS / 1000),
  };
}

function buildMetrics() {
  var metrics = { spread: null, depthBid: 0, depthAsk: 0, aggression: aggression(Date.now()) };
  if (_bids.length && _asks.length) {
    var mid = (_bids[0][0] + _asks[0][0]) / 2;
    metrics.spread = spreadBps(_bids, _asks);
    _depthBidBuf.push(depthUsdt50bps(_bids, mid, 'bid'));
    _depthAskBuf.push(depthUsdt50bps(_asks, mid, 'ask'));
    if (_depthBidBuf.length > DEPTH_MEDIAN_WINDOW) _depthBidBuf.shift();
    if (_depthAskBuf.length > DEPTH_MEDIAN_WINDOW) _depthAskBuf.shift();
    metrics.depthBid = median(_depthBidBuf);
    metrics.depthAsk = median(_depthAskBuf);
  }
  return metrics;
}

function _openDepthWs() {
  if (_closed) return;
  _depthWs = new WebSocket('wss://fstream.binance.com/stream?streams=' + _sym + '@depth20@100ms');

  _depthWs.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    var data = msg.data || msg;
    _bids = (data.b || []).map(function (l) { return [parseFloat(l[0]), parseFloat(l[1])]; });
    _asks = (data.a || []).map(function (l) { return [parseFloat(l[0]), parseFloat(l[1])]; });
    if (_onUpdate) _onUpdate({ type: 'depth', metrics: buildMetrics() });
  };

  _depthWs.onclose = function () {
    if (_closed) return;
    _depthReconnectTimer = setTimeout(_openDepthWs, RECONNECT_DELAY_MS);
  };

  _depthWs.onerror = function () {
    try { _depthWs.close(); } catch (e) {}
  };
}

function _openTradeWs() {
  if (_closed) return;
  _tradeWs = new WebSocket('wss://fstream.binance.com/market/ws');

  _tradeWs.onopen = function () {
    if (_closed) return;
    _tradeWs.send(JSON.stringify({ method: 'SUBSCRIBE', params: [_sym + '@aggTrade'], id: Date.now() }));
  };

  _tradeWs.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.e !== 'aggTrade') return;
    var trade = {
      ts: msg.T || Date.now(),
      price: parseFloat(msg.p),
      qty: parseFloat(msg.q),
      isBuy: msg.m === false,
    };
    _trades.push(trade);
    if (_onUpdate) _onUpdate({ type: 'trade', trade: trade, metrics: buildMetrics() });
  };

  _tradeWs.onclose = function () {
    if (_closed) return;
    _tradeReconnectTimer = setTimeout(_openTradeWs, RECONNECT_DELAY_MS);
  };

  _tradeWs.onerror = function () {
    try { _tradeWs.close(); } catch (e) {}
  };
}

function _hardDisconnect() {
  _closed = true;
  if (_sym && _connectedAt) _symWarmCache[_sym] = { connectedAt: _connectedAt, disconnectedAt: Date.now() };
  _connectedAt = null;
  if (_depthReconnectTimer) { clearTimeout(_depthReconnectTimer); _depthReconnectTimer = null; }
  if (_tradeReconnectTimer) { clearTimeout(_tradeReconnectTimer); _tradeReconnectTimer = null; }
  if (_depthWs) { try { _depthWs.close(); } catch (e) {} _depthWs = null; }
  if (_tradeWs) { try { _tradeWs.close(); } catch (e) {} _tradeWs = null; }
  _sym = null; _onUpdate = null;
  _bids = []; _asks = []; _trades = [];
  _depthBidBuf = []; _depthAskBuf = [];
}

export function connectOrderbook(sym, onUpdate) {
  var fullSym = sym.toLowerCase() + 'usdt';
  if (_keepAliveTimer !== null && _sym === fullSym && !_closed) {
    clearTimeout(_keepAliveTimer);
    _keepAliveTimer = null;
    _connectedAt = Math.min(_connectedAt || 0, Date.now() - AGGRESSION_WINDOW_MS);
    _onUpdate = onUpdate;
    return;
  }
  if (_keepAliveTimer) { clearTimeout(_keepAliveTimer); _keepAliveTimer = null; }
  _hardDisconnect();
  _closed = false;
  _sym = fullSym;
  var cached = _symWarmCache[fullSym];
  _connectedAt = (cached && cached.connectedAt && (Date.now() - cached.disconnectedAt < WARM_CACHE_TTL))
    ? cached.connectedAt
    : Date.now();
  _onUpdate = onUpdate;
  _openDepthWs();
  _openTradeWs();
}

// Milliseconds until aggression window is full; 0 if already warm or no active connection.
export function msUntilWarm() {
  if (_closed || _connectedAt === null) return AGGRESSION_WINDOW_MS;
  return Math.max(0, AGGRESSION_WINDOW_MS - (Date.now() - _connectedAt));
}

export function disconnectOrderbook() {
  if (_keepAliveTimer) { clearTimeout(_keepAliveTimer); _keepAliveTimer = null; }
  _hardDisconnect();
}

// Keeps WS alive for KEEP_ALIVE_MS so a quick FV reopen skips warmup.
export function softDisconnectOrderbook() {
  if (_closed) return;
  _onUpdate = null;
  if (_keepAliveTimer) return;
  _keepAliveTimer = setTimeout(function () {
    _keepAliveTimer = null;
    _hardDisconnect();
  }, KEEP_ALIVE_MS);
}
