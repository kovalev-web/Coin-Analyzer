'use strict';

// Trading core: symbol rules, account state, order placement with
// idempotency, cancels, leverage and the kill switch. Transport-agnostic —
// server.js exposes it over HTTP, userstream.js feeds it live events.

var EventEmitter = require('events');
var fs = require('fs');
var path = require('path');
var st = require('./state');
var { parseExchangeInfo, applyFilters, toStep } = require('./filters');
var { isProtective } = require('./localstops');

var IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
var BALANCE_REFRESH_DEBOUNCE_MS = 1000;
var REALIZED_REFRESH_DEBOUNCE_MS = 400; // after a fill, recount the position's realized PnL (breakeven)
var STOP_FIRED = { TRIGGERING: true, TRIGGERED: true, FINISHED: true }; // algo statuses once an SL / TP fired
var STOP_CLEANUP_WINDOW_MS = 15000; // SL / TP fired and the position went flat within this → cancel the coin's orders
var MISSING_RETRY_MS = [200, 400]; // waits before retrying "Order does not exist" on a just-placed algo order

// Binance answers "Order does not exist" (-2013) for an algo order placed a moment
// ago; it shows up shortly. Retry a couple of times before giving up.
function retryMissing(fn) {
  var i = 0;
  function attempt() {
    return fn().catch(function (e) {
      var missing = e && (e.code === -2013 || /does not exist/i.test(e.message || ''));
      if (!missing || i >= MISSING_RETRY_MS.length) throw e;
      return new Promise(function (r) { setTimeout(r, MISSING_RETRY_MS[i++]); }).then(attempt);
    });
  }
  return attempt();
}
var CLIENT_ID_RE = /^[\.A-Za-z0-9:\/_-]{1,36}$/; // Binance's allowed newClientOrderId charset
var SYMBOL_RE = /^[A-Z0-9]{2,30}$/;
var MOVABLE_ORDER = { NEW: true, PARTIALLY_FILLED: true };
var REGULAR_TYPES = { MARKET: true, LIMIT: true };
var ALGO_TYPES = { STOP_MARKET: true, TAKE_PROFIT_MARKET: true };
var TIME_IN_FORCE = { GTC: true, IOC: true, FOK: true, GTX: true };

class TraderError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'TraderError';
    this.status = status;
  }
}

function bool(v) { return v === true || v === 'true'; }

class Trader extends EventEmitter {
  constructor(opts) {
    super();
    this.client = opts.client;
    this.audit = opts.audit || function () {};
    this.dataDir = opts.dataDir;
    this.state = st.createState();
    this.rules = {};
    this.positionMode = null;     // 'oneway' | 'hedge'
    this.streamConnected = false;
    this.lastSyncAt = null;
    this._syncing = false;
    this._buffered = [];
    this._recent = new Map();     // clientOrderId → Promise of the placement result
    this.tradingEnabled = this._readTradingFlag();
  }

  // ── Startup / sync ─────────────────────────────────────────────────────

  async init() {
    await this.client.syncTime();
    await this.loadRules();
    var mode = await this.client.request('GET', '/fapi/v1/positionSide/dual');
    this.positionMode = mode.dualSidePosition ? 'hedge' : 'oneway';
    await this.resync();
  }

  async loadRules() {
    var info = await this.client.request('GET', '/fapi/v1/exchangeInfo', {}, false);
    this.rules = parseExchangeInfo(info);
  }

  // Full REST snapshot. Stream events that arrive meanwhile are buffered and
  // replayed on top, so nothing between "snapshot taken" and "now" is lost.
  async resync() {
    this._syncing = true;
    this._buffered = [];
    try {
      var c = this.client;
      var res = await Promise.all([
        c.request('GET', '/fapi/v2/balance'),
        c.request('GET', '/fapi/v2/positionRisk'),
        c.request('GET', '/fapi/v1/openOrders'),
        c.request('GET', '/fapi/v1/openAlgoOrders'),
      ]);
      st.loadSnapshot(this.state, {
        balances: res[0], positions: res[1], openOrders: res[2],
        openAlgoOrders: Array.isArray(res[3]) ? res[3] : (res[3] && res[3].orders) || [],
      });
    } finally {
      this._syncing = false;
    }
    await this._fillOpenTimes();
    var buffered = this._buffered;
    this._buffered = [];
    buffered.forEach(this.handleStreamEvent, this);
    this.lastSyncAt = Date.now();
    this.emit('event', { type: 'snapshot', account: this.getAccount() });
  }

  // Positions found in a snapshot (e.g. after restart) don't know when they
  // were opened or what they already realized — recover both from recent
  // fills. Best effort.
  async _fillOpenTimes() {
    for (var p of Object.values(this.state.positions)) {
      try { await this._loadRealized(p); } catch (e) {}
    }
  }

  // Realized PnL since the position opened (net of USDT fees) → breakeven
  async _loadRealized(p) {
    var trades = await this.client.request('GET', '/fapi/v1/userTrades', { symbol: p.symbol, limit: 200 });
    var r = st.realizedFromTrades(trades, p.amount);
    if (!p.openTime) p.openTime = r.openTime;
    p.realizedPnl = Math.round(r.realized * 1e6) / 1e6;
    p.breakEven = st.breakEven(p.entryPrice, p.amount, p.realizedPnl);
  }

  // After fills: recount the symbol's position, debounced so a burst costs one request
  _scheduleRealized(symbol) {
    this._realizedTimers = this._realizedTimers || {};
    if (this._realizedTimers[symbol]) return;
    var self = this;
    var t = this._realizedTimers[symbol] = setTimeout(function () {
      delete self._realizedTimers[symbol];
      var p = Object.values(self.state.positions).find(function (x) { return x.symbol === symbol; });
      if (!p) return;
      self._loadRealized(p).then(function () {
        self.emit('event', { type: 'position', position: p });
      }).catch(function (e) { console.error('[Trader] realized PnL refresh failed:', e.message); });
    }, REALIZED_REFRESH_DEBOUNCE_MS);
    if (t.unref) t.unref();
  }

  setStreamStatus(connected) {
    this.streamConnected = connected;
    this.emit('event', { type: 'status', status: this.getStatus() });
  }

  handleStreamEvent(msg) {
    if (this._syncing) { this._buffered.push(msg); return; }
    var self = this;
    if (msg.e === 'ORDER_TRADE_UPDATE') {
      var o = st.applyOrderUpdate(this.state, msg.o, msg.E);
      if (o) this.emit('event', { type: 'order', order: o });
      // A placed / cancelled / amended order reserves or frees margin, and no
      // ACCOUNT_UPDATE comes for it — available balance must be fetched
      this._scheduleBalanceRefresh();
      if (msg.o.x === 'TRADE') {
        var fill = {
          symbol: msg.o.s, side: msg.o.S, orderId: msg.o.i, clientOrderId: msg.o.c,
          price: msg.o.L, quantity: msg.o.l, realizedPnl: msg.o.rp,
          commission: msg.o.n, commissionAsset: msg.o.N, time: msg.o.T,
        };
        // Breakeven moves with the fill; the recount below makes it exact
        var moved = st.applyFill(this.state, fill);
        if (moved) this.emit('event', { type: 'position', position: moved });
        this._scheduleRealized(msg.o.s);
        this.emit('event', { type: 'fill', fill: fill });
        if (/^ls-/.test(fill.clientOrderId || '')) this._stopHit(fill.symbol); // our local stop closed it
      }
    } else if (msg.e === 'ALGO_UPDATE') {
      var a = st.applyAlgoUpdate(this.state, msg.o, msg.E);
      if (a) this.emit('event', { type: 'algo', algo: a });
      // The exchange fired an SL / TP
      if (a && isProtective(a) && STOP_FIRED[a.status]) this._stopHit(a.symbol);
    } else if (msg.e === 'ACCOUNT_UPDATE') {
      var ch = st.applyAccountUpdate(this.state, msg.a, msg.E);
      ch.positions.forEach(function (p) {
        self.emit('event', { type: 'position', position: p });
        if (Number(p.amount) === 0) self._flatAt(p.symbol);
      });
      ch.balances.forEach(function (b) { self.emit('event', { type: 'balance', balance: b }); });
      if (ch.balances.length) this._scheduleBalanceRefresh();
    }
  }

  // After an SL / TP closes the position, nothing of the trade should stay on the
  // book: every order of the coin (limits, stop entries, the other SL / TP) is
  // cancelled. Needs both: a stop fired (exchange or local) and the position flat,
  // in either order, within STOP_CLEANUP_WINDOW_MS. A partial TP leaves a position
  // and cancels nothing.
  _stopHit(symbol) {
    this._stopHits = this._stopHits || {};
    this._stopHits[symbol] = Date.now();
    var flat = !Object.values(this.state.positions).some(function (p) { return p.symbol === symbol && Number(p.amount) !== 0; });
    if (flat && this._flats && Date.now() - (this._flats[symbol] || 0) < STOP_CLEANUP_WINDOW_MS) this._cleanupAfterStop(symbol);
  }

  _flatAt(symbol) {
    this._flats = this._flats || {};
    this._flats[symbol] = Date.now();
    if (this._stopHits && Date.now() - (this._stopHits[symbol] || 0) < STOP_CLEANUP_WINDOW_MS) this._cleanupAfterStop(symbol);
  }

  _cleanupAfterStop(symbol) {
    delete this._stopHits[symbol];
    delete this._flats[symbol];
    var req = { symbol: symbol }, c = this.client;
    this._audited('cancel-after-stop', req, Promise.all([
      c.request('DELETE', '/fapi/v1/allOpenOrders', req),
      c.request('DELETE', '/fapi/v1/algoOpenOrders', req),
    ])).catch(function (e) { console.error('[Trader] cancel after stop failed for ' + symbol + ':', e.message); });
  }

  // Neither ACCOUNT_UPDATE nor order updates carry the available balance — fetch
  // it, debounced so a burst of fills or clicks costs one request.
  _scheduleBalanceRefresh() {
    if (this._balanceTimer) return;
    var self = this;
    this._balanceTimer = setTimeout(function () {
      self._balanceTimer = null;
      self.refreshBalances().catch(function (e) { console.error('[Trader] balance refresh failed:', e.message); });
    }, BALANCE_REFRESH_DEBOUNCE_MS);
    if (this._balanceTimer.unref) this._balanceTimer.unref();
  }

  async refreshBalances() {
    var list = await this.client.request('GET', '/fapi/v2/balance');
    var self = this;
    list.forEach(function (b) {
      var existing = self.state.balances[b.asset];
      var n = Object.assign({}, existing, {
        asset: b.asset, walletBalance: b.balance, crossWalletBalance: b.crossWalletBalance,
        availableBalance: b.availableBalance, updateTime: b.updateTime || Date.now(),
      });
      var changed = !existing || existing.availableBalance !== n.availableBalance || existing.walletBalance !== n.walletBalance;
      self.state.balances[b.asset] = n;
      if (changed) self.emit('event', { type: 'balance', balance: n });
    });
  }

  getAccount() { return st.toJSON(this.state); }

  getRules(symbol) {
    var r = this.rules[String(symbol || '').toUpperCase()];
    if (!r) throw new TraderError(404, 'Unknown symbol');
    return {
      symbol: r.symbol, status: r.status, tickSize: r.tickSize, stepSize: r.stepSize,
      minQty: r.minQty, marketMinQty: r.marketMinQty, minNotional: r.minNotional,
    };
  }

  getStatus() {
    return {
      tradingEnabled: this.tradingEnabled,
      positionMode: this.positionMode,
      streamConnected: this.streamConnected,
      lastSyncAt: this.lastSyncAt,
    };
  }

  // ── Orders ─────────────────────────────────────────────────────────────

  // Same clientOrderId within 10 minutes → same result, no second order.
  placeOrder(input) {
    var id = input && input.clientOrderId;
    if (!id || !CLIENT_ID_RE.test(id)) {
      return Promise.reject(new TraderError(400, 'clientOrderId is required (1-36 chars: letters, digits, . : / _ -)'));
    }
    if (this._recent.has(id)) return this._recent.get(id);
    var p = this._placeOrder(input);
    this._recent.set(id, p);
    var recent = this._recent;
    var timer = setTimeout(function () { recent.delete(id); }, IDEMPOTENCY_TTL_MS);
    if (timer.unref) timer.unref();
    return p;
  }

  async _placeOrder(input) {
    this._requireTrading();
    var order = this._validateOrder(input);
    var filtered = applyFilters(order, this.rules[order.symbol]);
    if (filtered.error) throw new TraderError(400, filtered.error);
    order = filtered.order;

    var isAlgo = !!ALGO_TYPES[order.type];
    try {
      var res = isAlgo
        ? await this.client.request('POST', '/fapi/v1/algoOrder', {
            algoType: 'CONDITIONAL', symbol: order.symbol, side: order.side, type: order.type,
            quantity: order.closePosition ? undefined : order.quantity,
            closePosition: order.closePosition ? 'true' : undefined,
            reduceOnly: order.reduceOnly && !order.closePosition ? 'true' : undefined,
            triggerPrice: order.triggerPrice, workingType: order.workingType,
            clientAlgoId: order.clientOrderId, newOrderRespType: 'RESULT',
          })
        : await this.client.request('POST', '/fapi/v1/order', {
            symbol: order.symbol, side: order.side, type: order.type, quantity: order.quantity,
            price: order.type === 'LIMIT' ? order.price : undefined,
            timeInForce: order.type === 'LIMIT' ? order.timeInForce : undefined,
            reduceOnly: order.reduceOnly ? 'true' : undefined,
            newClientOrderId: order.clientOrderId, newOrderRespType: 'RESULT',
          });
      var result = isAlgo ? { algo: st.algoFromRest(res) } : { order: st.orderFromRest(res) };
      this.audit('place', order, { result: result });
      return result;
    } catch (e) {
      if (e.noResponse) {
        // We don't know if Binance accepted it — ask by our own id.
        var found = await this._findByClientId(order, isAlgo);
        if (found) {
          this.audit('place', order, { result: found, reconciled: true });
          return Object.assign({ reconciled: true }, found);
        }
      }
      this.audit('place', order, { error: { message: e.message, code: e.code, status: e.status } });
      throw e;
    }
  }

  async _findByClientId(order, isAlgo) {
    try {
      if (isAlgo) {
        var a = await this.client.request('GET', '/fapi/v1/algoOrder', { clientAlgoId: order.clientOrderId });
        return { algo: st.algoFromRest(a) };
      }
      var o = await this.client.request('GET', '/fapi/v1/order', { symbol: order.symbol, origClientOrderId: order.clientOrderId });
      return { order: st.orderFromRest(o) };
    } catch (e) {
      return null;
    }
  }

  _validateOrder(input) {
    var symbol = String(input.symbol || '').toUpperCase();
    if (!SYMBOL_RE.test(symbol)) throw new TraderError(400, 'Invalid symbol');
    var side = String(input.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') throw new TraderError(400, 'side must be BUY or SELL');
    var type = String(input.type || '').toUpperCase();
    if (!REGULAR_TYPES[type] && !ALGO_TYPES[type]) {
      throw new TraderError(400, 'type must be one of MARKET, LIMIT, STOP_MARKET, TAKE_PROFIT_MARKET');
    }
    var order = {
      clientOrderId: input.clientOrderId, symbol: symbol, side: side, type: type,
      quantity: input.quantity, reduceOnly: bool(input.reduceOnly),
    };
    if (type === 'LIMIT') {
      if (input.price == null) throw new TraderError(400, 'price is required for LIMIT');
      order.price = input.price;
      order.timeInForce = String(input.timeInForce || 'GTC').toUpperCase();
      if (!TIME_IN_FORCE[order.timeInForce]) throw new TraderError(400, 'timeInForce must be GTC, IOC, FOK or GTX');
    }
    if (ALGO_TYPES[type]) {
      if (input.triggerPrice == null) throw new TraderError(400, 'triggerPrice is required for ' + type);
      order.triggerPrice = input.triggerPrice;
      order.closePosition = bool(input.closePosition);
      order.workingType = input.workingType === 'CONTRACT_PRICE' ? 'CONTRACT_PRICE' : 'MARK_PRICE';
      if (order.closePosition) delete order.quantity;
    } else if (bool(input.closePosition)) {
      throw new TraderError(400, 'closePosition is only for STOP_MARKET / TAKE_PROFIT_MARKET');
    }
    return order;
  }

  // ── Move (drag in the ladder) ──────────────────────────────────────────
  // LIMIT: modified in place (same id and quantity, new price).
  // Algo (stop entry, SL/TP): Binance can't modify them, so after checking the
  // new trigger won't fire at once, it is cancelled and placed again with the
  // same parameters; if that fails, the old one is put back.
  // opts.requireUnlocked() is called when the order opens risk (not reduce-only).
  async move(input, opts) {
    var symbol = String(input.symbol || '').toUpperCase();
    if (!SYMBOL_RE.test(symbol)) throw new TraderError(400, 'Invalid symbol');
    var rules = this.rules[symbol];
    if (!rules) throw new TraderError(400, 'Unknown symbol ' + symbol);
    var price = Number(input.price);
    if (!(price > 0)) throw new TraderError(400, 'price must be greater than 0');
    var to = toStep(price, rules.tickSize, 'round');
    var c = this.client;
    var guard = (opts && opts.requireUnlocked) || function () {};

    if (input.orderId) {
      var o = await c.request('GET', '/fapi/v1/order', { symbol: symbol, orderId: input.orderId });
      if (o.type !== 'LIMIT' || !MOVABLE_ORDER[o.status]) throw new TraderError(400, 'Only open limit orders can be moved');
      if (!o.reduceOnly) { this._requireTrading(); guard(); }
      var bt = await c.request('GET', '/fapi/v1/ticker/bookTicker', { symbol: symbol }, false);
      if (o.side === 'BUY' ? Number(to) >= Number(bt.askPrice) : Number(to) <= Number(bt.bidPrice)) {
        // Through the market it fills at once. Fine for a limit that closes the
        // position (taking the profit now); an entry is refused — a slip of the drag.
        if (!this._closesPosition(symbol, o)) {
          throw new TraderError(400, 'At ' + to + ' the ' + (o.side === 'BUY' ? 'buy' : 'sell') + ' limit would fill at once ('
            + (o.side === 'BUY' ? 'ask ' + bt.askPrice : 'bid ' + bt.bidPrice) + ')');
        }
        return this._replaceLimit(o, to, rules);
      }
      var req = { symbol: symbol, orderId: o.orderId, side: o.side, quantity: o.origQty, price: to };
      var res = await this._audited('move', req, c.request('PUT', '/fapi/v1/order', req));
      return { order: st.orderFromRest(res) };
    }

    if (!input.algoId) throw new TraderError(400, 'orderId or algoId is required');
    // A stop placed a moment ago (the previous move) may not be visible to Binance's
    // algo service yet: "Order does not exist" for a few hundred ms — retry
    var a = st.algoFromRest(await retryMissing(function () { return c.request('GET', '/fapi/v1/algoOrder', { algoId: input.algoId }); }));
    if (a.symbol !== symbol || a.status !== 'NEW') throw new TraderError(400, 'Only waiting stop orders can be moved');
    if (!a.closePosition && !a.reduceOnly) { this._requireTrading(); guard(); }
    var ref = await this._refPrice(symbol, a.workingType);
    // Fires when the price rises to it: buy stop, sell take-profit; else when it falls
    var firesUp = (a.type === 'STOP_MARKET') === (a.side === 'BUY');
    if (firesUp ? !(Number(to) > ref) : !(Number(to) < ref)) {
      throw new TraderError(400, 'At ' + to + ' the order would trigger at once (' + (a.workingType === 'CONTRACT_PRICE' ? 'last' : 'mark') + ' price ' + ref + ')');
    }
    await this._audited('cancel-algo', { algoId: a.algoId }, retryMissing(function () { return c.request('DELETE', '/fapi/v1/algoOrder', { algoId: a.algoId }); }));
    var self = this;
    function place(trigger, tag) {
      var p = {
        algoType: 'CONDITIONAL', symbol: symbol, side: a.side, type: a.type,
        quantity: a.closePosition ? undefined : a.quantity,
        closePosition: a.closePosition ? 'true' : undefined,
        reduceOnly: a.reduceOnly && !a.closePosition ? 'true' : undefined,
        triggerPrice: trigger, workingType: a.workingType || 'MARK_PRICE',
        clientAlgoId: tag + '-' + Date.now(), newOrderRespType: 'RESULT',
      };
      return self._audited('move-algo', p, c.request('POST', '/fapi/v1/algoOrder', p)).then(function (r) { return { algo: st.algoFromRest(r) }; });
    }
    try {
      return await place(to, 'mv');
    } catch (e) {
      try {
        await place(a.triggerPrice, 'rb');
        e.message += ' — the order is back at ' + a.triggerPrice;
      } catch (e2) {
        e.message += ' — and it could not be put back: the order is GONE, place it again';
        e.lost = true;
      }
      throw e;
    }
  }

  // The limit only closes (part of) the position: reduce-only, or the opposite
  // side of it and not bigger than what is left of it
  _closesPosition(symbol, o) {
    if (o.reduceOnly) return true;
    var p = Object.values(this.state.positions).find(function (x) { return x.symbol === symbol; });
    var amt = p ? Number(p.amount) : 0;
    var left = Number(o.origQty) - Number(o.executedQty || 0);
    return amt !== 0 && (amt > 0) !== (o.side === 'BUY') && left <= Math.abs(amt) + 1e-12;
  }

  // A closing limit moved through the market: cancel it and place a reduce-only
  // limit at the new price — it fills at once as far as the book allows, the rest
  // waits there. Cancelled first so the two never close more than the position;
  // if the new one is rejected the old one is put back.
  async _replaceLimit(o, price, rules) {
    var c = this.client, symbol = o.symbol;
    var qty = toStep(Number(o.origQty) - Number(o.executedQty || 0), rules.stepSize, 'floor');
    var cancel = { symbol: symbol, orderId: o.orderId };
    await this._audited('cancel', cancel, c.request('DELETE', '/fapi/v1/order', cancel));
    var self = this;
    function place(at, tag) {
      var p = {
        symbol: symbol, side: o.side, type: 'LIMIT', timeInForce: 'GTC', quantity: qty, price: at,
        reduceOnly: 'true', newClientOrderId: tag + '-' + Date.now(), newOrderRespType: 'RESULT',
      };
      return self._audited('move-cross', p, c.request('POST', '/fapi/v1/order', p));
    }
    try {
      return { order: st.orderFromRest(await place(price, 'mv')), replaced: o.orderId };
    } catch (e) {
      try {
        await place(o.price, 'rb');
        e.message += ' — the order is back at ' + o.price;
      } catch (e2) {
        e.message += ' — and it could not be put back: the order is GONE, place it again';
        e.lost = true;
      }
      throw e;
    }
  }

  // Price the trigger is compared with on Binance
  async _refPrice(symbol, workingType) {
    if (workingType === 'CONTRACT_PRICE') {
      return Number((await this.client.request('GET', '/fapi/v1/ticker/price', { symbol: symbol }, false)).price);
    }
    return Number((await this.client.request('GET', '/fapi/v1/premiumIndex', { symbol: symbol }, false)).markPrice);
  }

  // Cancels are always allowed, even with trading disabled.
  async cancel(input) {
    var symbol = String(input.symbol || '').toUpperCase();
    var req, res;
    if (input.algoId || input.clientAlgoId) {
      req = { algoId: input.algoId, clientAlgoId: input.clientAlgoId };
      res = await this._audited('cancel-algo', req, this.client.request('DELETE', '/fapi/v1/algoOrder', req));
      return { algo: res };
    }
    if (!SYMBOL_RE.test(symbol)) throw new TraderError(400, 'Invalid symbol');
    if (!input.orderId && !input.clientOrderId) throw new TraderError(400, 'orderId or clientOrderId is required');
    req = { symbol: symbol, orderId: input.orderId, origClientOrderId: input.clientOrderId };
    res = await this._audited('cancel', req, this.client.request('DELETE', '/fapi/v1/order', req));
    return { order: st.orderFromRest(res) };
  }

  async cancelAll(input) {
    var symbol = String(input.symbol || '').toUpperCase();
    if (!SYMBOL_RE.test(symbol)) throw new TraderError(400, 'Invalid symbol');
    var req = { symbol: symbol };
    var c = this.client;
    await this._audited('cancel-all', req, Promise.all([
      c.request('DELETE', '/fapi/v1/allOpenOrders', req),
      c.request('DELETE', '/fapi/v1/algoOpenOrders', req),
    ]));
    return { symbol: symbol };
  }

  async setLeverage(input) {
    this._requireTrading();
    var symbol = String(input.symbol || '').toUpperCase();
    if (!SYMBOL_RE.test(symbol)) throw new TraderError(400, 'Invalid symbol');
    var lev = parseInt(input.leverage, 10);
    if (!(lev >= 1 && lev <= 125)) throw new TraderError(400, 'leverage must be 1-125');
    var req = { symbol: symbol, leverage: lev };
    var res = await this._audited('leverage', req, this.client.request('POST', '/fapi/v1/leverage', req));
    var pos = this.state.positions[st.posKey(symbol, 'BOTH')];
    if (pos) pos.leverage = String(res.leverage);
    return res;
  }

  // ── Kill switch ────────────────────────────────────────────────────────

  // Disables trading first, then cancels every open order (fresh from REST,
  // not from local state). closePositions also market-closes every position.
  async kill(input) {
    this._writeTradingFlag(false);
    var c = this.client;
    var summary = { cancelledSymbols: [], closed: [], errors: [] };
    var lists = await Promise.all([
      c.request('GET', '/fapi/v1/openOrders'),
      c.request('GET', '/fapi/v1/openAlgoOrders'),
    ]);
    var algos = Array.isArray(lists[1]) ? lists[1] : (lists[1] && lists[1].orders) || [];
    var symbols = {};
    lists[0].forEach(function (o) { symbols[o.symbol] = true; });
    algos.forEach(function (a) { symbols[a.symbol] = true; });
    for (var sym of Object.keys(symbols)) {
      try {
        await Promise.all([
          c.request('DELETE', '/fapi/v1/allOpenOrders', { symbol: sym }),
          c.request('DELETE', '/fapi/v1/algoOpenOrders', { symbol: sym }),
        ]);
        summary.cancelledSymbols.push(sym);
      } catch (e) {
        summary.errors.push({ symbol: sym, step: 'cancel', message: e.message });
      }
    }
    if (input && bool(input.closePositions)) {
      var positions = await c.request('GET', '/fapi/v2/positionRisk');
      var stamp = Date.now();
      for (var i = 0; i < positions.length; i++) {
        var p = positions[i];
        var amt = Number(p.positionAmt);
        if (!amt) continue;
        try {
          await c.request('POST', '/fapi/v1/order', {
            symbol: p.symbol, side: amt > 0 ? 'SELL' : 'BUY', type: 'MARKET',
            quantity: String(p.positionAmt).replace('-', ''), reduceOnly: 'true',
            newClientOrderId: 'kill-' + stamp + '-' + i, newOrderRespType: 'RESULT',
          });
          summary.closed.push(p.symbol);
        } catch (e) {
          summary.errors.push({ symbol: p.symbol, step: 'close', message: e.message });
        }
      }
    }
    this.audit('kill', input || {}, { result: summary });
    return summary;
  }

  resume() {
    this._writeTradingFlag(true);
    this.audit('resume', {}, { result: { tradingEnabled: true } });
    return this.getStatus();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _requireTrading() {
    if (!this.tradingEnabled) throw new TraderError(423, 'Trading is disabled by the kill switch — resume to trade');
    if (this.positionMode === 'hedge') throw new TraderError(409, 'Hedge mode is not supported — switch the account to one-way mode');
  }

  async _audited(action, req, promise) {
    try {
      var res = await promise;
      this.audit(action, req, { result: res });
      return res;
    } catch (e) {
      this.audit(action, req, { error: { message: e.message, code: e.code, status: e.status } });
      throw e;
    }
  }

  _flagFile() { return path.join(this.dataDir, 'trading.json'); }

  _readTradingFlag() {
    try { return JSON.parse(fs.readFileSync(this._flagFile(), 'utf8')).enabled !== false; }
    catch (e) { return true; }
  }

  _writeTradingFlag(enabled) {
    this.tradingEnabled = enabled;
    fs.writeFileSync(this._flagFile(), JSON.stringify({ enabled: enabled, changedAt: new Date().toISOString() }), { mode: 0o600 });
    this.emit('event', { type: 'status', status: this.getStatus() });
  }
}

module.exports = { Trader, TraderError };
