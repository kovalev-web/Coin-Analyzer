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

test('typed amounts: suffixes, spaces, comma, Cyrillic', async () => {
  const { parseUsd, formatUsdShort } = await import('./ladder-scale.js');
  assert.equal(parseUsd('2M'), 2e6);
  assert.equal(parseUsd('500k'), 5e5);
  assert.equal(parseUsd('1.5m'), 1.5e6);
  assert.equal(parseUsd('2 000 000'), 2e6);
  assert.equal(parseUsd('2,5М'), 2.5e6);
  assert.equal(parseUsd('300к'), 3e5);
  assert.equal(parseUsd(''), 0);
  assert.equal(parseUsd('abc'), 0);
  assert.equal(formatUsdShort(2e6), '2M');
  assert.equal(formatUsdShort(1500), '1.5K');
  assert.equal(formatUsdShort(800), '800');
  assert.equal(formatUsdShort(0), '');
});

test('auto color: only levels well above the typical one', async () => {
  const { colorThreshold, levelPercentile } = await import('./ladder-scale.js');
  // flat book: levels 2–5K, median ~3K → threshold ~9K → none of them colored
  const flat = [2000, 2500, 3000, 3200, 3500, 4000, 4500, 5000, 2800, 3100];
  const thr = colorThreshold(levelPercentile(flat, 50), levelPercentile(flat, 90), 65);
  assert.ok(flat.every((v) => v < thr));
  // a real wall of 14K in that book is colored
  assert.ok(14000 >= colorThreshold(levelPercentile(flat.concat([14000]), 50), levelPercentile(flat.concat([14000]), 90), 65));
  // no median yet → falls back to the % of the full bar
  assert.equal(colorThreshold(0, 10000, 65), 6500);
});
