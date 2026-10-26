import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelPercentile, smoothScale } from './ladder-scale.js';

test('percentile ignores empty levels and one huge wall', () => {
  const levels = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 0, 5000];
  // 12 non-zero values → 90th percentile is the 11th: 100, not the 5000 wall
  assert.equal(levelPercentile(levels, 90), 100);
  assert.equal(levelPercentile([0, 0], 90), null);
});

test('smoothing: first value is taken as is, then moves ~63% per time constant', () => {
  assert.equal(smoothScale(null, 100, 0, 10000), 100);
  const v = smoothScale(100, 200, 10000, 10000);
  assert.ok(Math.abs(v - (100 + 100 * (1 - Math.exp(-1)))) < 1e-9);
  assert.equal(smoothScale(100, null, 500, 10000), 100); // nothing visible → keep
});

test('smoothing does not depend on how often it is called', () => {
  let a = 100;
  for (let i = 0; i < 10; i++) a = smoothScale(a, 200, 100, 10000);
  const b = smoothScale(100, 200, 1000, 10000);
  assert.ok(Math.abs(a - b) < 1e-9);
});
