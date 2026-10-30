'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const B = require('./briefing');

const D = '2026-10-30';
const e = (sym, addedAt, extra) => Object.assign({ sym, date: D, addedAt, status: 'watching', note: '' }, extra);

test('dayCoins: only the date, no auto entries, keyed as futures symbols', () => {
  const c = B.dayCoins([e('sol', 1), e('pepe', 2, { auto: true }), e('eth', 3, { date: '2026-10-29' })], D);
  assert.deepEqual(Object.keys(c), ['SOLUSDT']);
});

test('updateBriefingLog: add opens a span from addedAt, removal closes it at now', () => {
  let log = B.updateBriefingLog({}, [], [e('sol', 100)], 150);
  assert.deepEqual(log[D].SOLUSDT, [[100, null]]);
  log = B.updateBriefingLog(log, [e('sol', 100)], [], 500);
  assert.deepEqual(log[D].SOLUSDT, [[100, 500]]);
  log = B.updateBriefingLog(log, [], [e('sol', 50)], 900);     // re-added (an old addedAt can't reach back before the removal)
  assert.deepEqual(log[D].SOLUSDT, [[100, 500], [500, null]]);
});

test('updateBriefingLog: addedAt in the future is capped at now; a saved-again coin keeps its span', () => {
  let log = B.updateBriefingLog({}, [], [e('sol', 9999)], 200);
  assert.deepEqual(log[D].SOLUSDT, [[200, null]]);
  log = B.updateBriefingLog(log, [e('sol', 9999)], [e('sol', 9999, { note: 'x' })], 300);
  assert.deepEqual(log[D].SOLUSDT, [[200, null]]);
});

test('updateBriefingLog: removing a coin saved before the log existed records its span', () => {
  const log = B.updateBriefingLog({}, [e('sol', 100)], [], 400);
  assert.deepEqual(log[D].SOLUSDT, [[100, 400]]);
});

test('pruneLog keeps the last 60 days', () => {
  const log = { '2026-08-30': {}, '2026-08-31': { X: [] }, [D]: {} };
  assert.deepEqual(Object.keys(B.pruneLog(log, D)), ['2026-08-31', D]);
});

test('briefingSpans: the log plus coins present now that it does not know', () => {
  const log = { [D]: { SOLUSDT: [[100, 500]] } };
  const spans = B.briefingSpans(log, [e('eth', 300)], D);
  assert.deepEqual(spans, { SOLUSDT: [[100, 500]], ETHUSDT: [[300, null]] });
});

test('inBriefingAt: inside a span, not before it, not after the removal', () => {
  const spans = { SOLUSDT: [[100, 500], [800, null]] };
  assert.equal(B.inBriefingAt(spans, 'SOLUSDT', 99), false);
  assert.equal(B.inBriefingAt(spans, 'SOLUSDT', 100), true);
  assert.equal(B.inBriefingAt(spans, 'SOLUSDT', 500), false);
  assert.equal(B.inBriefingAt(spans, 'SOLUSDT', 900), true);
  assert.equal(B.inBriefingAt(spans, 'ETHUSDT', 900), false);
});
