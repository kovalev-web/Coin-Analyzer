'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseOf, fillGaps } = require('./venues');

test('base coin of a Binance futures symbol', () => {
  assert.equal(baseOf('SOLUSDT'), 'SOL');
  assert.equal(baseOf('1000PEPEUSDT'), 'PEPE');
  assert.equal(baseOf('1000000MOGUSDT'), 'MOG');
});

test('missing minutes become zero-volume bars at the last close', () => {
  const M = 60000;
  const out = fillGaps([{ t: 0, o: 1, h: 2, l: 1, c: 2, q: 5, n: 3 }, { t: 3 * M, o: 4, h: 4, l: 4, c: 4, q: 7, n: 1 }], 0, 4 * M, { n: true });
  assert.deepEqual(out.map((b) => [b.t / M, b.q, b.n, b.c]), [[0, 5, 3, 2], [1, 0, 0, 2], [2, 0, 0, 2], [3, 7, 1, 4]]);
});
