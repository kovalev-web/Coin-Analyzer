'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toStep, decimalsOf, parseExchangeInfo, applyFilters } = require('./filters');

const INFO = {
  symbols: [{
    symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL',
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.10', minPrice: '556.80', maxPrice: '4529764' },
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '120' },
      { filterType: 'MIN_NOTIONAL', notional: '100' },
    ],
  }, {
    symbol: 'OLDUSDT', status: 'SETTLING', filters: [],
  }],
};
const RULES = parseExchangeInfo(INFO);

test('decimalsOf handles trailing zeros and exponents', () => {
  assert.equal(decimalsOf('0.00100000'), 3);
  assert.equal(decimalsOf('1'), 0);
  assert.equal(decimalsOf('0.10'), 1);
  assert.equal(decimalsOf(1e-7), 7);
});

test('toStep floors, rounds and ceils without float noise', () => {
  assert.equal(toStep(0.1 + 0.2, '0.1', 'floor'), '0.3');
  assert.equal(toStep(0.0129, '0.001', 'floor'), '0.012');
  assert.equal(toStep(1.23, '0.05', 'round'), '1.25');
  assert.equal(toStep(1.21, '0.05', 'ceil'), '1.25');
  assert.equal(toStep(64000.04, '0.10', 'round'), '64000.0');
  assert.equal(toStep(37, '10', 'floor'), '30');
});

test('parseExchangeInfo reads lot, market lot, tick and notional', () => {
  const r = RULES.BTCUSDT;
  assert.equal(r.tickSize, '0.10');
  assert.equal(r.stepSize, '0.001');
  assert.equal(r.marketMaxQty, '120');
  assert.equal(r.minNotional, '100');
});

test('applyFilters floors quantity and rounds price to tick', () => {
  const { order, error } = applyFilters(
    { symbol: 'BTCUSDT', type: 'LIMIT', quantity: '0.0129', price: '64000.04' }, RULES.BTCUSDT);
  assert.equal(error, undefined);
  assert.equal(order.quantity, '0.012');
  assert.equal(order.price, '64000.0');
});

test('applyFilters rejects quantity below minimum', () => {
  const r = applyFilters({ symbol: 'BTCUSDT', type: 'MARKET', quantity: '0.0004' }, RULES.BTCUSDT);
  assert.match(r.error, /below minimum/);
});

test('applyFilters uses MARKET_LOT_SIZE max for market orders', () => {
  const r = applyFilters({ symbol: 'BTCUSDT', type: 'MARKET', quantity: '200' }, RULES.BTCUSDT);
  assert.match(r.error, /above maximum 120/);
  const ok = applyFilters({ symbol: 'BTCUSDT', type: 'LIMIT', quantity: '200', price: '60000' }, RULES.BTCUSDT);
  assert.equal(ok.error, undefined);
});

test('applyFilters checks notional for limit orders, skips for reduce-only', () => {
  const small = { symbol: 'BTCUSDT', type: 'LIMIT', quantity: '0.001', price: '60000' };
  assert.match(applyFilters(small, RULES.BTCUSDT).error, /below minimum 100 USDT/);
  assert.equal(applyFilters(Object.assign({}, small, { reduceOnly: true }), RULES.BTCUSDT).error, undefined);
});

test('applyFilters: closePosition stop needs no quantity, trigger is rounded', () => {
  const r = applyFilters(
    { symbol: 'BTCUSDT', type: 'STOP_MARKET', closePosition: true, triggerPrice: '59999.97' }, RULES.BTCUSDT);
  assert.equal(r.error, undefined);
  assert.equal(r.order.quantity, undefined);
  assert.equal(r.order.triggerPrice, '60000.0');
});

test('applyFilters rejects unknown and non-trading symbols', () => {
  assert.match(applyFilters({ symbol: 'NOPEUSDT' }, RULES.NOPEUSDT).error, /Unknown symbol/);
  assert.match(applyFilters({ symbol: 'OLDUSDT' }, RULES.OLDUSDT).error, /not trading/);
});
