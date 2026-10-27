'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeEdge, tradeR, riskUsd, brokenRules, setupStats, weekOf } = require('./edge');

function trade(symbol, closeTime, pnl, extra) {
  return Object.assign({ symbol, closeTime, pnlNet: pnl, result: pnl > 0 ? 'win' : 'loss', planned: true, atLevel: null, hour: 9 }, extra);
}

const days = [
  { date: '2026-10-24', morning: { sleepHours: 5, sleepQuality: 2, energy: 2, carryover: 4, focus: 3 },
    facts: { trades: [trade('AUSDT', 1000, -2, { revenge: true }), trade('BUSDT', 2000, 1, { planned: false }), Object.assign(trade('CUSDT', 3000, 0), { result: 'open' })] } },
  { date: '2026-10-25', morning: { sleepHours: 8, sleepQuality: 5, energy: 4, carryover: 1, focus: 5 },
    facts: { trades: [trade('AUSDT', 5000, 3, { atLevel: true, hour: 14 }), trade('AUSDT', 6000, 2, { afterCrane: true })] } },
  { date: '2026-10-23', morning: {}, facts: null },
];
const tags = [
  { symbol: 'AUSDT', close_time: 1003, setup: 'C', emotion: 'revenge' },
  { symbol: 'AUSDT', close_time: 5001, setup: 'A', emotion: 'plan' },
  { symbol: 'BUSDT', close_time: 9000, setup: 'A', emotion: 'plan' }, // too far from 2000 → not matched
];

test('only closed trades count; totals and tag matching', () => {
  const e = computeEdge(days, tags);
  assert.equal(e.total.n, 4);
  assert.equal(e.total.pnl, 4);
  assert.equal(e.tagged, 2);
});

test('groups by setup, emotion, plan, flags with win rate and pnl', () => {
  const g = computeEdge(days, tags).groups;
  const row = (list, key) => list.find((r) => r.key === key);
  assert.deepEqual([row(g.setup, 'A setup').n, row(g.setup, 'A setup').pnl], [1, 3]);
  assert.equal(row(g.setup, 'not tagged').n, 2);
  assert.equal(row(g.emotion, 'Revenge').pnl, -2);
  assert.equal(row(g.plan, 'outside briefing').n, 1);
  assert.equal(row(g.flags, 'clean').n, 2);
  assert.equal(row(g.flags, 'after stop-crane').n, 1);
  assert.equal(row(g.level, 'at a signal level').winRate, 100);
});

test('morning state buckets and enough-data flag', () => {
  const g = computeEdge(days, tags).groups;
  assert.equal(g.sleep.find((r) => r.key === '< 6 h').n, 2);
  assert.equal(g.carryover.find((r) => r.key === 'high (4–5)').n, 2);
  assert.equal(g.focus.find((r) => r.key === 'high (4–5)').winRate, 100);
  assert.equal(g.sleep[0].enough, false);
  assert.deepEqual(g.hour.map((r) => r.key).sort(), ['08–12', '12–16']);
});

test('1R: 0.5% of the 100 USDT working volume = 0.50 USDT, whatever size you entered with', () => {
  assert.equal(riskUsd(0.5, 100, 25), 0.5);
  assert.equal(riskUsd(0.5, null, 200), 1);   // no working volume → the trade's size
  assert.equal(riskUsd(null, 100, 25), null);
});

test('R: PnL in units of 1R', () => {
  assert.equal(tradeR(1, 0.5), 2);
  assert.equal(tradeR(-0.5, 0.5), -1);
  assert.equal(tradeR(0.525, 0.5), 1.05);    // +0.525 USDT on a 25 USDT entry is ~1R, not 4.2R
  assert.equal(tradeR(1, null), null);
});

test('rules: each break is named; unknown R does not count as a stop overrun', () => {
  const ok = { t: { planned: true }, tag: null, r: -1 }; // no setup type is not a trading rule
  assert.deepEqual(brokenRules(ok), []);
  assert.deepEqual(brokenRules({ ...ok, r: -1.5 }), ['stopHeld']);
  assert.deepEqual(brokenRules({ ...ok, r: null }), []);
  assert.deepEqual(brokenRules({ t: { planned: false, revenge: true, oversize: true }, tag: null, r: 0.5 }), ['planned', 'size', 'noRevenge']);
});

test('setup stats: expectancy is the average R per trade', () => {
  // 3 wins of +2R, 2 losses of −1R → (6 − 2) / 5 = +0.8R per trade
  assert.deepEqual(setupStats([2, 2, 2, -1, -1]), { n: 5, winRate: 60, avgWinR: 2, avgLossR: -1, expectancyR: 0.8, totalR: 4 });
  assert.deepEqual(setupStats([]), { n: 0, winRate: 0, avgWinR: null, avgLossR: null, expectancyR: null, totalR: 0 });
});

test('week starts on Monday', () => {
  assert.equal(weekOf('2026-10-27'), '2026-10-26'); // Tuesday
  assert.equal(weekOf('2026-10-26'), '2026-10-26');
  assert.equal(weekOf('2026-11-01'), '2026-10-26'); // Sunday
});

test('execution and setups: by-the-rules share and setups in R on clean trades only', () => {
  const d = [{ date: '2026-10-26', morning: {}, facts: { trades: [
    { symbol: 'XUSDT', closeTime: 100, pnlNet: 1, result: 'win', planned: true, maxNotional: 100 },
    { symbol: 'XUSDT', closeTime: 200, pnlNet: -0.5, result: 'loss', planned: true, maxNotional: 100 },
    { symbol: 'XUSDT', closeTime: 300, pnlNet: -1, result: 'loss', planned: true, maxNotional: 100, revenge: true },
    { symbol: 'YUSDT', closeTime: 400, pnlNet: 0.5, result: 'win', planned: false, maxNotional: 100 },
  ] } }];
  const tg = [
    { symbol: 'XUSDT', close_time: 100, pattern: 'breakout' },
    { symbol: 'XUSDT', close_time: 200, pattern: 'breakout' },
    { symbol: 'XUSDT', close_time: 300, pattern: 'breakout' },
  ];
  const e = computeEdge(d, tg, { riskPct: 0.5, workingVolume: 100 });
  // revenge and off-briefing break rules; the untagged Y trade is still by the rules
  assert.deepEqual([e.execution.n, e.execution.clean, e.execution.rate], [4, 2, 50]);
  assert.equal(e.execution.rules.find((r) => r.key === 'noRevenge').broken, 1);
  assert.deepEqual(e.execution.weeks, [{ week: '2026-10-26', n: 4, clean: 2, rate: 50 }]);
  // breakout by the rules: +2R and −1R (the revenge trade is out) → +0.5R per trade
  const b = e.setups.find((x) => x.key === 'breakout');
  assert.deepEqual([b.n, b.expectancyR, b.totalR], [2, 0.5, 1]);
  assert.equal(e.noPattern, 1);
  assert.deepEqual(e.untagged.map((u) => [u.symbol, u.closeTime, u.r]), [['YUSDT', 400, 1]]);
  // everything traded: +2 −1 −2 +1 = 0R; the revenge (−2R) and off-briefing (+1R) trades cost −1R
  assert.deepEqual([e.allTrades.n, e.allTrades.totalR], [4, 0]);
  assert.equal(e.breaksCostR, -1);
  assert.deepEqual(e.dates, ['2026-10-26']);
});

test('your own setups: named rows, excluded setup (misclicks) leaves the report, hidden setup shows only with trades', () => {
  const d = [{ date: '2026-10-26', morning: {}, facts: { trades: [
    { symbol: 'XUSDT', closeTime: 100, pnlNet: 1, result: 'win', planned: true, maxNotional: 100 },
    { symbol: 'XUSDT', closeTime: 200, pnlNet: -5, result: 'loss', planned: false, maxNotional: 100 },
    { symbol: 'XUSDT', closeTime: 300, pnlNet: 0.5, result: 'win', planned: true, maxNotional: 100 },
  ] } }];
  const tg = [
    { symbol: 'XUSDT', close_time: 100, pattern: 's1' },
    { symbol: 'XUSDT', close_time: 200, pattern: 'miss' },
    { symbol: 'XUSDT', close_time: 300, pattern: 'old' },
  ];
  const setups = [
    { key: 's1', name: 'Ложный пробой' },
    { key: 'miss', name: 'Мисклик', exclude: true },
    { key: 'old', name: 'Старый', archived: true },
    { key: 'gone', name: 'Скрытый пустой', archived: true },
  ];
  const e = computeEdge(d, tg, { riskPct: 0.5, workingVolume: 100, setups });
  assert.equal(e.excluded, 1);
  assert.deepEqual([e.execution.n, e.execution.clean], [2, 2]); // the misclick broke a rule but is not counted
  assert.deepEqual(e.setups.map((x) => [x.key, x.name, x.n]), [['s1', 'Ложный пробой', 1], ['old', 'Старый', 1]]);
});
