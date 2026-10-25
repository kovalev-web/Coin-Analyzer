'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeEdge } = require('./edge');

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
