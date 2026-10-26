import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSymbol, ladderPrice } from './venues-stats.js';

test('1000-coins: symbol split and price on the futures ladder', () => {
  assert.deepEqual(splitSymbol('1000PEPEUSDT'), { coin: 'PEPE', mult: 1000 });
  assert.deepEqual(splitSymbol('BTCUSDT'), { coin: 'BTC', mult: 1 });
  assert.ok(Math.abs(ladderPrice('0.0000105', 1000) - 0.0105) < 1e-12);
});
