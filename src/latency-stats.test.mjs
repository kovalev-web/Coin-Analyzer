import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, jitter, clockOffset, grade } from './latency-stats.js';

test('percentile picks the nearest-rank value', () => {
  const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(v, 50), 50);
  assert.equal(percentile(v, 95), 100);
  assert.equal(percentile([], 50), null);
});

test('jitter is the mean change between consecutive pings', () => {
  assert.equal(jitter([100, 110, 100, 130]), (10 + 10 + 30) / 3);
  assert.equal(jitter([100]), null);
});

test('clock offset assumes the reply was stamped mid-way', () => {
  // sent at local 1000, 100 ms round trip, server said 1550 → server is 500 ms ahead
  assert.equal(clockOffset(1000, 100, 1550), 500);
});

test('grade: green, yellow, red', () => {
  assert.equal(grade({ p50: 90, p95: 140, loss: 0 }), 'ok');
  assert.equal(grade({ p50: 120, p95: 300, loss: 0 }), 'warn');
  assert.equal(grade({ p50: 300, p95: 500, loss: 0 }), 'bad');
  assert.equal(grade({ p50: 90, p95: 140, loss: 0.1 }), 'bad');
  assert.equal(grade({ down: true }), 'bad');
});
