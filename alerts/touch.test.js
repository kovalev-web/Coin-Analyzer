'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { candleTouch, snapshotRange, touches } = require('./touch');

const T = 1761900000000;

test('first event: nothing touched yet', () => {
  const r = candleTouch(null, { t: T, h: 105, l: 95, c: 100 });
  assert.equal(r.range, null);
  assert.deepEqual(r.state, { t: T, h: 105, l: 95, c: 100 });
});

test('a wick up between two events touches the level', () => {
  // last price 100 → 100 again, but the candle high rose to 103: someone traded at 103
  const s = { t: T, h: 101, l: 99, c: 100 };
  const r = candleTouch(s, { t: T, h: 103, l: 99, c: 100 });
  assert.deepEqual(r.range, [100, 103]);
  assert.ok(touches(r.range, 103));
  assert.ok(touches(r.range, 102.5));
  assert.ok(!touches(r.range, 103.01));
});

test('a wick down between two events touches the level', () => {
  const s = { t: T, h: 101, l: 99, c: 100 };
  const r = candleTouch(s, { t: T, h: 101, l: 96, c: 99.5 });
  assert.deepEqual(r.range, [96, 100]);
  assert.ok(touches(r.range, 96));
});

test('old extremes of the candle (before the alert was watched) do not count', () => {
  // the candle already had a high of 110 at the previous event; price now moves 100 → 101
  const s = { t: T, h: 110, l: 90, c: 100 };
  const r = candleTouch(s, { t: T, h: 110, l: 90, c: 101 });
  assert.deepEqual(r.range, [100, 101]);
  assert.ok(!touches(r.range, 108));
  assert.ok(!touches(r.range, 92));
});

test('a new candle: its whole range plus the move from the last close', () => {
  const s = { t: T, h: 101, l: 99, c: 100 };
  const r = candleTouch(s, { t: T + 60000, h: 102, l: 100.5, c: 101 });
  assert.deepEqual(r.range, [100, 102]);
  assert.deepEqual(r.state, { t: T + 60000, h: 102, l: 100.5, c: 101 });
});

test('ticker snapshots: the range between two last prices, either direction', () => {
  assert.deepEqual(snapshotRange(100, 102), [100, 102]);
  assert.deepEqual(snapshotRange(102, 100), [100, 102]);
  assert.equal(snapshotRange(null, 100), null);
  assert.ok(touches(snapshotRange(100, 100), 100)); // sitting exactly on the level
  assert.ok(!touches(null, 100));
});
