import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyRu, keyLabel, DIMENSIONS } from './edge-insights.js';

test('group keys from the server read in Russian; unknown keys pass through', () => {
  assert.equal(keyRu('not tagged'), 'без пометки');
  assert.equal(keyLabel('Calm, by plan'), 'Спокойно, по плану');
  assert.equal(keyLabel('08–12'), '08–12');
  assert.equal(DIMENSIONS.hour, 'Время дня');
});

test('conclusions: compare groups in R per trade, biggest gap first, skip one-group and tiny groups', async () => {
  const { conclusions } = await import('./edge-insights.js');
  const g = (key, n, avgPnl) => ({ key, n, avgPnl });
  const groups = {
    hour: [g('08–12', 4, -0.24), g('04–08', 4, 0.21)],          // −0.48R vs +0.42R → gap 0.9R
    setup: [g('A setup', 4, 0.21), g('B setup', 3, 0.08), g('not tagged', 1, -1.19)], // not tagged has 1 trade → out; gap 0.26R → out
    sleep: [g('6–7.5 h', 8, -0.01)],                             // one group → nothing to compare
    flags: [g('clean', 6, -0.06), g('after stop-crane', 2, 0.34)], // execution panel covers breaks
  };
  const c = conclusions(groups, 0.5, 20);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].dim, c[0].best.key, c[0].best.avgR, c[0].worst.avgR, c[0].gapR, c[0].early], ['hour', '04–08', 0.42, -0.48, 0.9, true]);
  assert.equal(c[0].weight, 0.2); // 4 of 20 trades in the smaller group
  assert.deepEqual(conclusions(groups, null, 20), []);
});

test('conclusions: a solid finding on many trades outranks a big gap on a few', async () => {
  const { conclusions } = await import('./edge-insights.js');
  const g = (key, n, avgPnl) => ({ key, n, avgPnl });
  const groups = {
    energy: [g('high (4–5)', 2, 1.0), g('low (1–2)', 2, -1.0)],     // gap 4R, 2 trades each
    hour: [g('04–08', 60, 0.2), g('08–12', 50, -0.1)],               // gap 0.6R, 50+ trades
    focus: [g('high (4–5)', 12, 0.3), g('low (1–2)', 10, -0.2)],     // gap 1R, 10 trades: 1 × 0.5 = 0.5
  };
  const c = conclusions(groups, 0.5, 20);
  assert.deepEqual(c.map((x) => [x.dim, x.early]), [['hour', false], ['focus', true], ['energy', true]]);
});
