'use strict';

// Local stops: the trader watches every trade on symbols where you have a
// protective SL / TP on the exchange, and the moment a trade prints at or
// through its trigger it closes the position itself with a reduce-only MARKET
// order — without waiting for Binance's conditional-order engine. The exchange
// SL / TP stays as the backup (if this process is down, Binance still fires it).
// Both firing is safe: reduce-only / closePosition never flip or grow a position.
// Like Tiger's "local stop", but it lives on the Tokyo server, not in a browser.
// Tests: npm run test:trader (localstops.test.js)

var STALE_TRADE_MS = 5000;     // ignore trades older than this (reconnect backlog)
var SYMBOL_LOCK_MS = 3000;     // one local close per symbol at a time
var BACKOFF_MS = [1000, 2000, 5000, 10000];

// ── Formulas ────────────────────────────────────────────────────────────────

// A protective order closes a position: SL / TP with closePosition or reduceOnly
function isProtective(algo) {
  return !!algo && (algo.type === 'STOP_MARKET' || algo.type === 'TAKE_PROFIT_MARKET')
    && !!(algo.closePosition || algo.reduceOnly);
}

// Does a trade at `price` reach the trigger? A BUY stop / SELL take-profit
// fires on the way up (price ≥ trigger), a SELL stop / BUY take-profit on the
// way down (price ≤ trigger) — same rule as Binance.
function fires(algo, price) {
  var trigger = Number(algo.triggerPrice), p = Number(price);
  if (!(trigger > 0) || !(p > 0)) return false;
  var up = (algo.type === 'STOP_MARKET') === (algo.side === 'BUY');
  return up ? p >= trigger : p <= trigger;
}

// The market order that does what the protective order would: close the
// position (closePosition) or reduce it by the order's quantity (reduceOnly).
// null when there's nothing to close on that side.
function closeOrderFor(algo, position) {
  var amt = position ? Number(position.amount) : 0;
  if (!amt) return null;
  // A SELL closes a long, a BUY closes a short
  if ((algo.side === 'SELL') !== (amt > 0)) return null;
  var qty = Math.abs(amt);
  if (!algo.closePosition && Number(algo.quantity) > 0) qty = Math.min(qty, Number(algo.quantity));
  return {
    symbol: algo.symbol, side: algo.side, type: 'MARKET',
    quantity: String(qty), reduceOnly: 'true',
    newClientOrderId: 'ls-' + algo.algoId, newOrderRespType: 'RESULT',
  };
}

// Symbols that need watching: those with an open protective order
function watchedSymbols(state) {
  var out = {};
  Object.values(state.algoOrders).forEach(function (a) { if (isProtective(a)) out[a.symbol] = true; });
  return Object.keys(out).sort();
}

// ── Watcher ─────────────────────────────────────────────────────────────────

// opts: trader (state, client, audit, emit), url (market WS root, e.g.
// wss://fstream.binance.com/market/ws), WebSocket (for tests), log, now
function createLocalStops(opts) {
  var trader = opts.trader;
  var WebSocketImpl = opts.WebSocket || require('ws');
  var log = opts.log || console;
  var now = opts.now || Date.now;
  var url = opts.url;

  var ws = null, open = false, stopped = false, attempt = 0, reconnectTimer = null, reqId = 0;
  var subscribed = {};           // SYMBOL → true (what the socket has)
  var fired = {};                // algoId → true (fired once, don't again)
  var locked = {};               // SYMBOL → until (ms)

  function streamName(sym) { return sym.toLowerCase() + '@aggTrade'; }

  function send(method, syms) {
    if (!syms.length || !ws || !open) return;
    ws.send(JSON.stringify({ method: method, params: syms.map(streamName), id: ++reqId }));
  }

  // Keep the socket subscribed to exactly the symbols with protective orders
  function sync() {
    var want = watchedSymbols(trader.state);
    Object.keys(fired).forEach(function (id) { if (!trader.state.algoOrders[id]) delete fired[id]; });
    if (!want.length) { if (ws) ws.close(); return; }
    if (!ws) { connect(); return; }
    if (!open) return; // subscribes on open
    var add = want.filter(function (s) { return !subscribed[s]; });
    var drop = Object.keys(subscribed).filter(function (s) { return want.indexOf(s) === -1; });
    send('SUBSCRIBE', add);
    send('UNSUBSCRIBE', drop);
    add.forEach(function (s) { subscribed[s] = true; });
    drop.forEach(function (s) { delete subscribed[s]; });
  }

  function connect() {
    if (stopped || ws) return;
    ws = new WebSocketImpl(url);
    open = false;
    subscribed = {};
    ws.on('open', function () {
      open = true;
      attempt = 0;
      sync();
    });
    ws.on('message', function (raw) {
      var m;
      try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m && m.data) m = m.data;
      if (m && m.e === 'aggTrade') onTrade(m.s, m.p, m.T);
    });
    ws.on('close', function () {
      ws = null; open = false; subscribed = {};
      if (stopped) return;
      if (!watchedSymbols(trader.state).length) return;
      var delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt++;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, delay);
    });
    ws.on('error', function (e) { log.error('[LocalStops] socket error:', e.message); });
  }

  function onTrade(symbol, price, tradeTime) {
    var t = now();
    if (tradeTime && t - tradeTime > STALE_TRADE_MS) return;
    if (locked[symbol] && locked[symbol] > t) return;
    var algos = Object.values(trader.state.algoOrders).filter(function (a) {
      return a.symbol === symbol && isProtective(a) && !fired[a.algoId];
    });
    for (var i = 0; i < algos.length; i++) {
      if (!fires(algos[i], price)) continue;
      fire(algos[i], price, tradeTime, t);
      return; // one close per trade; the position is gone or reduced after it
    }
  }

  function fire(algo, price, tradeTime, seenAt) {
    var pos = Object.values(trader.state.positions).find(function (p) { return p.symbol === algo.symbol; });
    var order = closeOrderFor(algo, pos);
    if (!order || !trader.client) return; // nothing to close (yet): look again on the next trade
    fired[algo.algoId] = true;
    locked[algo.symbol] = seenAt + SYMBOL_LOCK_MS;
    var info = { symbol: algo.symbol, algoId: algo.algoId, kind: algo.type === 'STOP_MARKET' ? 'SL' : 'TP', trigger: algo.triggerPrice, tradePrice: String(price), tradeTime: tradeTime || null };
    trader.client.request('POST', '/fapi/v1/order', order).then(function (res) {
      var doneAt = now();
      info.fillPrice = res && res.avgPrice;
      info.ms = { seen: tradeTime ? seenAt - tradeTime : null, order: doneAt - seenAt };
      trader.audit('local-stop', order, { result: res, info: info });
      log.log('[LocalStops] ' + info.kind + ' ' + algo.symbol + ' at ' + price + ' (trigger ' + algo.triggerPrice + ') closed in ' + info.ms.order + ' ms');
      trader.emit('event', { type: 'local-stop', stop: info });
      // The exchange order did its job through us — remove it (it may have fired too: ignore)
      return trader.client.request('DELETE', '/fapi/v1/algoOrder', { algoId: algo.algoId }).catch(function () {});
    }).catch(function (e) {
      // Not closed by us: the exchange SL / TP is still there and will fire
      delete locked[algo.symbol];
      trader.audit('local-stop', order, { error: { message: e.message, code: e.code, status: e.status }, info: info });
      log.error('[LocalStops] ' + algo.symbol + ' close failed:', e.message, '— the exchange order stays');
    });
  }

  return {
    sync: sync,
    stop: function () { stopped = true; clearTimeout(reconnectTimer); if (ws) ws.close(); },
    // for tests
    _onTrade: onTrade,
  };
}

// Market-data root for trades: aggTrade lives on the /market path
function marketTradesUrl(marketWs) {
  return String(marketWs || '').replace(/\/public\/ws$/, '/market/ws');
}

module.exports = { isProtective, fires, closeOrderFor, watchedSymbols, createLocalStops, marketTradesUrl };
