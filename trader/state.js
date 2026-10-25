'use strict';

// In-memory account state: balances, positions, open orders and open algo
// (conditional) orders. Filled from a REST snapshot, then kept current by
// User Data Stream events. Every apply* function returns the changed item
// (or null if the update was stale/ignored) so the caller can broadcast it.

var OPEN_ORDER_STATUSES = { NEW: true, PARTIALLY_FILLED: true };
var OPEN_ALGO_STATUSES = { NEW: true, TRIGGERING: true };

function createState() {
  return { balances: {}, positions: {}, orders: {}, algoOrders: {} };
}

function posKey(symbol, positionSide) { return symbol + ':' + (positionSide || 'BOTH'); }

// Ignore updates older than what we already have (snapshot vs buffered events race).
function isStale(existing, updateTime) {
  return existing && existing.updateTime && updateTime && updateTime < existing.updateTime;
}

// ── Normalisers (REST and WS payloads → one shape) ──────────────────────

function orderFromRest(o) {
  return {
    orderId: o.orderId, clientOrderId: o.clientOrderId, symbol: o.symbol,
    side: o.side, type: o.type, status: o.status, timeInForce: o.timeInForce,
    price: o.price, avgPrice: o.avgPrice, origQty: o.origQty, executedQty: o.executedQty,
    reduceOnly: !!o.reduceOnly, positionSide: o.positionSide, updateTime: o.updateTime || o.time,
  };
}

function orderFromWs(o, eventTime) {
  return {
    orderId: o.i, clientOrderId: o.c, symbol: o.s,
    side: o.S, type: o.o, status: o.X, timeInForce: o.f,
    price: o.p, avgPrice: o.ap, origQty: o.q, executedQty: o.z,
    reduceOnly: !!o.R, positionSide: o.ps, updateTime: o.T || eventTime,
  };
}

function algoFromRest(a) {
  return {
    algoId: a.algoId, clientAlgoId: a.clientAlgoId, symbol: a.symbol,
    side: a.side, type: a.orderType, status: a.algoStatus,
    quantity: a.quantity, triggerPrice: a.triggerPrice, price: a.price,
    reduceOnly: !!a.reduceOnly, closePosition: !!a.closePosition,
    positionSide: a.positionSide, workingType: a.workingType,
    updateTime: a.updateTime || a.createTime,
  };
}

function algoFromWs(o, eventTime) {
  return {
    algoId: o.aid, clientAlgoId: o.caid, symbol: o.s,
    side: o.S, type: o.o, status: o.X,
    quantity: o.q, triggerPrice: o.tp, price: o.p,
    reduceOnly: !!o.R, closePosition: !!o.cp,
    positionSide: o.ps, workingType: o.wt, updateTime: eventTime,
  };
}

// ── Snapshot ────────────────────────────────────────────────────────────

function loadSnapshot(state, snap) {
  var t = snap.time || Date.now();
  state.balances = {};
  (snap.balances || []).forEach(function (b) {
    state.balances[b.asset] = {
      asset: b.asset, walletBalance: b.balance, crossWalletBalance: b.crossWalletBalance,
      availableBalance: b.availableBalance, updateTime: b.updateTime || t,
    };
  });
  state.positions = {};
  (snap.positions || []).forEach(function (p) {
    if (Number(p.positionAmt) === 0) return;
    state.positions[posKey(p.symbol, p.positionSide)] = {
      symbol: p.symbol, positionSide: p.positionSide, amount: p.positionAmt,
      entryPrice: p.entryPrice, unrealizedPnl: p.unRealizedProfit,
      leverage: p.leverage, marginType: p.marginType, liquidationPrice: p.liquidationPrice,
      updateTime: p.updateTime || t,
    };
  });
  state.orders = {};
  (snap.openOrders || []).forEach(function (o) {
    var n = orderFromRest(o);
    state.orders[n.orderId] = n;
  });
  state.algoOrders = {};
  (snap.openAlgoOrders || []).forEach(function (a) {
    var n = algoFromRest(a);
    state.algoOrders[n.algoId] = n;
  });
}

// ── Stream events ───────────────────────────────────────────────────────

function applyOrderUpdate(state, o, eventTime) {
  var n = orderFromWs(o, eventTime);
  var existing = state.orders[n.orderId];
  if (isStale(existing, n.updateTime)) return null;
  if (OPEN_ORDER_STATUSES[n.status]) state.orders[n.orderId] = n;
  else delete state.orders[n.orderId];
  return n;
}

function applyAlgoUpdate(state, o, eventTime) {
  var n = algoFromWs(o, eventTime);
  var existing = state.algoOrders[n.algoId];
  if (isStale(existing, n.updateTime)) return null;
  if (OPEN_ALGO_STATUSES[n.status]) state.algoOrders[n.algoId] = n;
  else delete state.algoOrders[n.algoId];
  return n;
}

// Returns { balances: [...], positions: [...] } with what changed.
function applyAccountUpdate(state, a, eventTime) {
  var changed = { balances: [], positions: [] };
  (a.B || []).forEach(function (b) {
    var existing = state.balances[b.a];
    if (isStale(existing, eventTime)) return;
    var n = Object.assign({}, existing, {
      asset: b.a, walletBalance: b.wb, crossWalletBalance: b.cw, updateTime: eventTime,
    });
    state.balances[b.a] = n;
    changed.balances.push(n);
  });
  (a.P || []).forEach(function (p) {
    var key = posKey(p.s, p.ps);
    var existing = state.positions[key];
    if (isStale(existing, eventTime)) return;
    var n = Object.assign({}, existing, {
      symbol: p.s, positionSide: p.ps, amount: p.pa, entryPrice: p.ep,
      unrealizedPnl: p.up, marginType: p.mt, updateTime: eventTime,
    });
    if (Number(p.pa) === 0) delete state.positions[key];
    else state.positions[key] = n;
    changed.positions.push(n);
  });
  return changed;
}

function toJSON(state) {
  return {
    balances: Object.values(state.balances),
    positions: Object.values(state.positions),
    orders: Object.values(state.orders),
    algoOrders: Object.values(state.algoOrders),
  };
}

module.exports = {
  createState, loadSnapshot, applyOrderUpdate, applyAlgoUpdate, applyAccountUpdate,
  toJSON, posKey, orderFromRest, algoFromRest,
};
