import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowTotals, isSpike, splitSymbol, ladderPrice } from './venues-stats.js';

test('window totals: buy, sell, delta and buy share inside the window only', () => {
  const now = 100000;
  const trades = [
    { t: 60000, usd: 999, buy: true },   // older than 30 s — out
    { t: 80000, usd: 300, buy: true },
    { t: 90000, usd: 100, buy: false },
    { t: 99000, usd: 100, buy: true },
  ];
  const w = windowTotals(trades, now, 30000);
  assert.deepEqual([w.vol, w.buy, w.sell, w.delta], [500, 400, 100, 300]);
  assert.equal(w.buyShare, 0.8);
  assert.equal(windowTotals([], now, 30000).buyShare, null);
});

test('spike: last 5 s at 3× the usual rate and above the minimum', () => {
  const now = 200000;
  // usual: 12 000 $ over the 2 minutes before → 0.1 $/ms; last 5 s: 6 000 $ → 1.2 $/ms
  const calm = [];
  for (let t = now - 125000; t < now - 5000; t += 10000) calm.push({ t, usd: 1000, buy: true });
  assert.equal(isSpike(calm.concat([{ t: now - 1000, usd: 6000, buy: true }]), now), true);
  assert.equal(isSpike(calm.concat([{ t: now - 1000, usd: 1000, buy: true }]), now), false); // under the minimum
  assert.equal(isSpike([{ t: now - 1000, usd: 6000, buy: false }], now), true);           // quiet before → any burst
});

test('1000-coins: symbol split and price on the futures ladder', () => {
  assert.deepEqual(splitSymbol('1000PEPEUSDT'), { coin: 'PEPE', mult: 1000 });
  assert.deepEqual(splitSymbol('BTCUSDT'), { coin: 'BTC', mult: 1 });
  assert.ok(Math.abs(ladderPrice('0.0000105', 1000) - 0.0105) < 1e-12);
});
