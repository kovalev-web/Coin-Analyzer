import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoThreshold, hitStrength, MIN_SAMPLE } from './hit-stats.js';

test('auto threshold follows the coin: small trades → small bar, big → big', () => {
  const thin = Array.from({ length: 50 }, (_, i) => 10 + i);      // 10…59 $
  const busy = Array.from({ length: 50 }, (_, i) => 1000 * (i + 1)); // 1K…50K $
  assert.equal(autoThreshold(thin, 90), 54);
  assert.equal(autoThreshold(busy, 90), 45000);
  assert.equal(autoThreshold(thin.slice(0, MIN_SAMPLE - 1), 90), null); // not enough history
});

test('hit strength: by size against the threshold', () => {
  assert.equal(hitStrength(400, 500, 1e9), 0);   // smaller than usual, level huge → nothing
  assert.equal(hitStrength(500, 500, 1e9), 1);
  assert.equal(hitStrength(1000, 500, 1e9), 2);
  assert.equal(hitStrength(2500, 500, 1e9), 3);
});

test('hit strength: a hit that ate a fifth of a real level counts, a thin price does not', () => {
  // level of 5 000 $ (≥ the 1 000 $ bar), 1 000 $ eaten → 20% → counts
  assert.equal(hitStrength(1000, 1000, 5000), 1);
  // 300 $ hit (under the bar) on a 1 200 $ level → 25% eaten → counts
  assert.equal(hitStrength(300, 1000, 1200), 1);
  // 300 $ at a price that held only 300 $ (thinner than the bar) → not a level, no frame
  assert.equal(hitStrength(300, 1000, 300), 0);
  // a big hit that cleared a real level → strongest
  assert.equal(hitStrength(5000, 1000, 5000), 3);
  assert.equal(hitStrength(0, 100, 0), 0);
});

test('tape intensity: minimum is palest, the biggest on screen brightest, log steps', async () => {
  const { tapeIntensity } = await import('./hit-stats.js');
  assert.equal(tapeIntensity(1000, 1000, 100000), 0);
  assert.equal(tapeIntensity(100000, 1000, 100000), 1);
  assert.ok(Math.abs(tapeIntensity(10000, 1000, 100000) - 0.5) < 1e-9); // 10K halfway between 1K and 100K
  assert.equal(tapeIntensity(2000, 1000, 1000), 0.5);                     // nothing bigger on screen
  assert.equal(tapeIntensity(500, 1000, 100000), 0);                      // under the minimum → palest
});
