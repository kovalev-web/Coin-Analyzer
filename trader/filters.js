'use strict';

// Symbol trading rules from /fapi/v1/exchangeInfo, and rounding of order
// prices/quantities to them. All math is done on scaled integers so that
// e.g. 0.1 + 0.2 never produces a quantity Binance rejects for precision.

function decimalsOf(step) {
  var s = String(step);
  if (s.indexOf('e-') !== -1) return parseInt(s.split('e-')[1], 10);
  var dot = s.indexOf('.');
  if (dot === -1) return 0;
  return s.slice(dot + 1).replace(/0+$/, '').length;
}

// mode: 'floor' | 'round' | 'ceil'
function toStep(value, step, mode) {
  var d = decimalsOf(step);
  var scale = Math.pow(10, d);
  var v = Math.round(Number(value) * scale * 1e6) / 1e6; // kill float noise before rounding
  var st = Math.round(Number(step) * scale);
  var units = v / st;
  var n = mode === 'floor' ? Math.floor(units + 1e-9)
        : mode === 'ceil' ? Math.ceil(units - 1e-9)
        : Math.round(units);
  return (n * st / scale).toFixed(d);
}

function parseExchangeInfo(info) {
  var out = {};
  (info.symbols || []).forEach(function (s) {
    var f = {};
    (s.filters || []).forEach(function (x) { f[x.filterType] = x; });
    var lot = f.LOT_SIZE || {};
    var mlot = f.MARKET_LOT_SIZE || lot;
    var price = f.PRICE_FILTER || {};
    out[s.symbol] = {
      symbol: s.symbol,
      status: s.status,
      contractType: s.contractType,
      tickSize: price.tickSize,
      minPrice: price.minPrice,
      maxPrice: price.maxPrice,
      stepSize: lot.stepSize,
      minQty: lot.minQty,
      maxQty: lot.maxQty,
      marketStepSize: mlot.stepSize,
      marketMinQty: mlot.minQty,
      marketMaxQty: mlot.maxQty,
      minNotional: f.MIN_NOTIONAL ? (f.MIN_NOTIONAL.notional || f.MIN_NOTIONAL.minNotional) : null,
    };
  });
  return out;
}

// Normalises price/quantity of an order to the symbol rules and checks limits.
// Returns { order } with adjusted string values, or { error } with a message.
function applyFilters(order, rules) {
  if (!rules) return { error: 'Unknown symbol ' + order.symbol };
  if (rules.status !== 'TRADING') return { error: order.symbol + ' is not trading (' + rules.status + ')' };

  var out = Object.assign({}, order);
  var isMarketQty = order.type === 'MARKET' || order.type === 'STOP_MARKET' || order.type === 'TAKE_PROFIT_MARKET';

  if (!order.closePosition) {
    var q = Number(order.quantity);
    if (!(q > 0)) return { error: 'Quantity must be greater than 0' };
    var step = isMarketQty ? rules.marketStepSize : rules.stepSize;
    var minQ = Number(isMarketQty ? rules.marketMinQty : rules.minQty);
    var maxQ = Number(isMarketQty ? rules.marketMaxQty : rules.maxQty);
    out.quantity = toStep(q, step, 'floor'); // never trade more than asked
    if (Number(out.quantity) < minQ) return { error: 'Quantity below minimum ' + minQ + ' for ' + order.symbol };
    if (maxQ && Number(out.quantity) > maxQ) return { error: 'Quantity above maximum ' + maxQ + ' for ' + order.symbol };
  }

  if (order.price != null) {
    var p = Number(order.price);
    if (!(p > 0)) return { error: 'Price must be greater than 0' };
    out.price = toStep(p, rules.tickSize, 'round');
  }
  if (order.triggerPrice != null) {
    var tp = Number(order.triggerPrice);
    if (!(tp > 0)) return { error: 'Trigger price must be greater than 0' };
    out.triggerPrice = toStep(tp, rules.tickSize, 'round');
  }

  // Notional check only when we know the price; for market orders Binance checks it.
  if (out.price && out.quantity && !order.reduceOnly && rules.minNotional) {
    var notional = Number(out.price) * Number(out.quantity);
    if (notional < Number(rules.minNotional)) {
      return { error: 'Order value ' + notional.toFixed(2) + ' USDT is below minimum ' + rules.minNotional + ' USDT' };
    }
  }
  return { order: out };
}

module.exports = { parseExchangeInfo, applyFilters, toStep, decimalsOf };
