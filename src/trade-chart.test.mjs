import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartWindow, avgPrices } from './trade-chart.js';

test('window: 1m for a scalp, with 20 candles of margin', () => {
  const open = Date.UTC(2026, 9, 28, 10, 0, 30), close = open + 3 * 60000;
  const w = chartWindow(open, close);
  assert.equal(w.interval, '1m');
  assert.equal(w.from, Date.UTC(2026, 9, 28, 9, 40, 0));
  assert.equal(w.to, Date.UTC(2026, 9, 28, 10, 24, 0));
});

test('window: 5m for a few hours, 15m beyond 8 h; margin grows with the hold', () => {
  const open = Date.UTC(2026, 9, 28, 10);
  assert.equal(chartWindow(open, open + 3 * 3600000).interval, '5m');
  const w = chartWindow(open, open + 10 * 3600000);
  assert.equal(w.interval, '15m');
  assert.equal(w.from, open - 5 * 3600000); // half of a 10 h hold
});

test('average entry / exit by quantity, long and short', () => {
  const execs = [{ s: 'BUY', p: 1, q: 10 }, { s: 'BUY', p: 1.1, q: 10 }, { s: 'SELL', p: 1.2, q: 20 }];
  const a = avgPrices(execs, 'long');
  assert.ok(Math.abs(a.entry - 1.05) < 1e-12);
  assert.equal(a.exit, 1.2);
  assert.deepEqual(avgPrices([{ s: 'SELL', p: 2, q: 1 }, { s: 'BUY', p: 1.9, q: 1 }], 'short'), { entry: 2, exit: 1.9 });
  assert.deepEqual(avgPrices([], 'long'), { entry: null, exit: null });
});
