'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const d = require('./detect');

// Deterministic noise
function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }

test('trades of one side within 50 ms are one print (one market order through several levels)', () => {
  const p = d.toPrints([
    { t: 0, p: 10, usd: 100, buy: true }, { t: 20, p: 11, usd: 300, buy: true },
    { t: 30, p: 11, usd: 50, buy: false }, { t: 200, p: 12, usd: 10, buy: true },
  ]);
  assert.equal(p.length, 3);
  assert.equal(p[0].usd, 400);
  assert.equal(p[0].p, (10 * 100 + 11 * 300) / 400); // VWAP of the print
});

test('a buy of ~$82K every ~33 s, 11 times, is found among random prints', () => {
  const r = rng(7);
  const prints = [];
  for (let t = 0; t < 600000; t += 400 + r() * 2000) prints.push({ t: Math.round(t), p: 80, usd: 1000 + r() * 60000, buy: r() < 0.5 });
  for (let k = 0; k < 11; k++) prints.push({ t: 50000 + k * 33400 + Math.round((r() - 0.5) * 800), p: 80 + k * 0.1, usd: 82000 * (0.95 + r() * 0.1), buy: true });
  prints.sort((a, b) => a.t - b.t);
  const found = d.detectTimers(prints).filter((x) => x.count >= 8);
  assert.equal(found.length, 1);
  const f = found[0];
  assert.equal(f.buy, true);
  assert.equal(f.count, 11);
  assert.ok(Math.abs(f.periodSec - 33.4) < 0.5, String(f.periodSec));
  assert.ok(Math.abs(f.sizeUsd - 82000) < 4000);
  assert.equal(f.noticed, f.start + 4 * 33400 + (f.noticed - f.start - 4 * 33400)); // the 5th print
  assert.ok(f.change > 1 && f.change < 1.5);
});

test('a missed beat does not break the series; other sizes and sides are not mixed in', () => {
  const prints = [];
  [0, 1, 2, 4, 5, 6].forEach((k) => prints.push({ t: k * 30000, p: 1, usd: 5000, buy: false }));
  prints.push({ t: 90000, p: 1, usd: 20000, buy: false }); // other size at the missed beat
  prints.push({ t: 60000, p: 1, usd: 5000, buy: true });   // other side
  prints.sort((a, b) => a.t - b.t);
  const f = d.detectTimers(prints);
  assert.equal(f.length, 1);
  assert.equal(f[0].buy, false);
  assert.equal(f[0].count, 6);
  assert.equal(f[0].periodSec, 30);
});

test('no rhythm, no timer: same size at random times', () => {
  const r = rng(3);
  const prints = [];
  let t = 0;
  for (let k = 0; k < 40; k++) { t += 3000 + r() * 90000; prints.push({ t: Math.round(t), p: 1, usd: 5000, buy: true }); }
  assert.equal(d.detectTimers(prints).length, 0);
});

test('share of turnover over the series', () => {
  const prints = [];
  for (let k = 0; k < 5; k++) prints.push({ t: k * 10000, p: 1, usd: 2000, buy: true });
  prints.push({ t: 15000, p: 1, usd: 30000, buy: false });
  prints.sort((a, b) => a.t - b.t);
  const f = d.detectTimers(prints)[0];
  assert.equal(f.totalUsd, 10000);
  assert.equal(f.share, 25); // 10K of 40K
});
