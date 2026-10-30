'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTape, hlCoin } = require('./collector');

test('tape: minutes count market orders (merged trades), volume, buys, first / last price; quiet minutes are zero', () => {
  const t = createTape();
  const M = 60000, T = 1_700_000_000_000 - (1_700_000_000_000 % M);
  t.add(T + 1000, 10, 600, true); t.add(T + 1010, 11, 600, true); // one order, $1200 → a big print
  t.add(T + 5000, 10, 100, false);
  t.add(T + 2 * M + 10, 12, 50, true);
  const m = t.minutes();
  assert.deepEqual(m.map((x) => [x.usd, x.buyUsd, x.n, x.o, x.c]), [[1300, 1200, 2, 10, 10], [0, 0, 0, 10, 10], [50, 50, 1, 12, 12]]);
  assert.equal(t.prints().length, 1);
  assert.equal(t.prints()[0].usd, 1200);
  assert.equal(t.turnover(T, T + M - 1), 1300);
});

test('tape: history goes in front of the live trades, the shared minute adds up', () => {
  const t = createTape();
  const M = 60000, T = 1_700_000_000_000 - (1_700_000_000_000 % M);
  t.add(T + 30000, 2, 5000, true);
  t.addHistory([{ t: T - M + 1, p: 1, usd: 2000, buy: false }, { t: T + 1, p: 1.5, usd: 3000, buy: true }]);
  assert.deepEqual(t.prints().map((x) => x.t), [T - M + 1, T + 1, T + 30000]);
  const m = t.minutes();
  assert.equal(m.length, 2);
  assert.deepEqual([m[1].usd, m[1].n, m[1].o, m[1].c], [8000, 2, 1.5, 2]);
  assert.equal(t.since(), T - M + 1);
});

test('Hyperliquid coin names', () => {
  assert.equal(hlCoin('SOLUSDT'), 'SOL');
  assert.equal(hlCoin('1000PEPEUSDT'), 'kPEPE');
});
