import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impact, comparable, insights, advice } from './edge-insights.js';

// The report from the screenshot: 8 trades, −0.10 total
const r = (key, n, winRate, pnl) => ({ key, n, winRate, pnl, avgPnl: Math.round(pnl / n * 10000) / 10000 });
const EDGE = {
  minN: 20,
  total: r('all trades', 8, 63, -0.10),
  groups: {
    setup: [r('A setup', 4, 100, 0.85), r('B setup', 3, 33, 0.23), r('not tagged', 1, 0, -1.19)],
    emotion: [r('Calm, by plan', 7, 71, 1.08), r('not tagged', 1, 0, -1.19)],
    flags: [r('clean', 6, 67, -0.34), r('revenge (≤5 min after a loss)', 1, 0, -0.10), r('after stop-crane', 1, 100, 0.34)],
    plan: [r('in briefing', 8, 63, -0.10)],
    level: [r('away from levels', 8, 63, -0.10)],
    sleep: [r('6–7.5 h', 8, 63, -0.10)],
    hour: [r('08–12', 4, 25, -0.95), r('04–08', 4, 100, 0.85)],
  },
};

test('impact: money beyond your average trade, times the trades', () => {
  // A setups: avg +0.2125 vs overall −0.0125 → +0.225 × 4 = +0.9
  assert.ok(Math.abs(impact(EDGE.groups.setup[0], EDGE.total.avgPnl) - 0.9) < 1e-9);
  assert.equal(impact(null, 0), 0);
});

test('comparable: needs two known groups', () => {
  assert.equal(comparable(EDGE.groups.plan), false);
  assert.equal(comparable(EDGE.groups.hour), true);
  assert.equal(comparable([r('6–7.5 h', 5, 60, 1), r('not recorded', 3, 0, -1)]), false);
});

test('insights from the screenshot: what works, what costs, what has nothing to compare', () => {
  const x = insights(EDGE);
  // Calm by plan: +1.08 over 7 trades = +1.17 beyond average; A setups +0.90; 04–08 +0.90
  assert.deepEqual(x.works.map((f) => f.key), ['Calm, by plan', 'A setup', '04–08']);
  // the untagged trade shows once, not for setup and again for emotion
  assert.deepEqual(x.costs.map((f) => f.key), ['not tagged', '08–12', 'clean']);
  assert.deepEqual(x.flat, ['План брифинга', 'Уровень', 'Сон']);
  assert.deepEqual(x.sample, { n: 8, minN: 20, ratio: 0.4, early: true });
  assert.match(x.costs[1].advice, /08–12/);
});

test('a group that earns but less than average is neither works nor costs', () => {
  const x = insights(EDGE);
  assert.equal(x.works.some((f) => f.key === 'B setup'), false); // +0.23 total, but below what A does
  assert.equal(x.works.some((f) => f.key === 'clean'), false);
});

test('advice has a line for every kind of finding', () => {
  assert.match(advice('setup', 'C setup', false), /C-сетап/);
  assert.match(advice('flags', 'revenge (≤5 min after a loss)', false), /5 минут/);
  assert.match(advice('energy', 'low (1–2)', false), /меньше объём/);
});
