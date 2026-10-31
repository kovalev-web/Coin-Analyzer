'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./rank');

const row = (s, range, vol, trades, ok = true) => ({ s, ok, w: { '5m': { range, vol, trades }, '1h': null } });
const ROWS = [row('A', 1, 5, 2), row('B', 3, 1, 4), row('C', 2, 3, 3), row('D', 9, 9, 9, false)];

test('rankCoins: by the chosen sort, strongest first, illiquid and empty windows out', () => {
  assert.deepEqual(R.rankCoins(ROWS, '5m', 'move'), ['B', 'C', 'A']);
  assert.deepEqual(R.rankCoins(ROWS, '5m', 'vol'), ['A', 'C', 'B']);
  assert.deepEqual(R.rankCoins(ROWS, '5m', 'trades'), ['B', 'C', 'A']);
  assert.deepEqual(R.rankCoins(ROWS, '1h', 'move'), []);
});

test('rankCoins: growth and the day\'s extreme ignore the window; closest to the extreme first', () => {
  const rows = [
    { s: 'A', ok: true, w: {}, gv: 3, gt: 1, ext: { pct: 2, side: 'high' } },
    { s: 'B', ok: true, w: {}, gv: 1, gt: 2, ext: { pct: 0.1, side: 'low' } },
    { s: 'C', ok: true, w: {}, gv: null, gt: null, ext: null },
  ];
  assert.deepEqual(R.rankCoins(rows, '5m', 'gvol'), ['A', 'B']);
  assert.deepEqual(R.rankCoins(rows, '1h', 'gtrades'), ['B', 'A']);
  assert.deepEqual(R.rankCoins(rows, '3h', 'ext'), ['B', 'A']);
});

test('parseView: known window and sort, cells 1…12, pins look like symbols and fit the cells', () => {
  assert.deepEqual(R.parseView({ win: '5m', sort: 'vol', n: 6, pins: ['SOLUSDT', 'bad', 3] }), { win: '5m', sort: 'vol', n: 6, pins: ['SOLUSDT'], freeze: false });
  assert.equal(R.parseView({ win: '5m', sort: 'rvol', n: 6, freeze: 1 }).freeze, true);
  assert.equal(R.parseView({ win: '2m', sort: 'vol', n: 6 }), null);
  assert.equal(R.parseView({ win: '5m', sort: 'score', n: 6 }), null);
  assert.equal(R.parseView({ win: '5m', sort: 'move', n: 99 }).n, 12);
  assert.deepEqual(R.parseView({ win: '5m', sort: 'move', n: 1, pins: ['AUSDT', 'BUSDT'] }).pins, ['AUSDT']);
});

test('nextShown: pins first, then the top; same order until HOLD_MS, at once on a new choice', () => {
  let v = { win: '5m', sort: 'move', n: 2, pins: ['A'], shown: [], at: 0 };
  v = R.nextShown(v, ROWS, 0);
  assert.deepEqual(v.shown, ['A', 'B']);
  const later = [row('A', 1, 5, 2), row('B', 1, 1, 4), row('C', 8, 3, 3)];
  assert.deepEqual(R.nextShown(v, later, R.HOLD_MS - 1).shown, ['A', 'B']); // held
  assert.deepEqual(R.nextShown(v, later, R.HOLD_MS).shown, ['A', 'C']);     // refreshed
  assert.deepEqual(R.nextShown(Object.assign({}, v, { pins: [] }), later, 1).shown, ['C', 'A']); // choice changed
});

test('nextShown: freeze holds the order past HOLD_MS, a new choice still refreshes', () => {
  let v = R.nextShown({ win: '5m', sort: 'move', n: 2, pins: ['A'], shown: [], at: 0, freeze: true }, ROWS, 0);
  const later = [row('A', 1, 5, 2), row('B', 1, 1, 4), row('C', 8, 3, 3)];
  assert.deepEqual(R.nextShown(v, later, 10 * R.HOLD_MS).shown, ['A', 'B']);
  assert.deepEqual(R.nextShown(Object.assign({}, v, { freeze: false }), later, 10 * R.HOLD_MS).shown, ['A', 'C']);
  assert.deepEqual(R.nextShown(Object.assign({}, v, { pins: [] }), later, 1).shown, ['C', 'A']);
});
