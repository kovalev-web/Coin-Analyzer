'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('./metrics');

const MIN = 60000;
const T0 = 1_700_000_000_000; // window start
const CFG = Object.assign({}, m.CFG, { normMin: 10, minNormBars: 5 });

// 10 usual minutes before T0 ($100K, 50 trades → $2K a trade), then the window
function bars(win, usual) {
  usual = Object.assign({ q: 100e3, n: 50, tb: 50e3 }, usual);
  const out = [];
  for (let i = 10; i >= 1; i--) out.push(Object.assign({ t: T0 - i * MIN, o: 10, h: 10, l: 10, c: 10 }, usual));
  win.forEach((w, i) => out.push(Object.assign({ t: T0 + i * MIN, o: 10, h: 10, l: 10, c: 10 }, w)));
  return out;
}

test('norm: median volume and trades, usual average trade', () => {
  const { hist } = m.splitBars(bars([]), T0, T0 + 5 * MIN, CFG);
  assert.deepEqual(m.normOf(hist, CFG), { q: 100e3, n: 50, avgTrade: 2000 });
  assert.equal(m.normOf(hist.slice(0, 3), CFG), null); // too little history
});

test('start: first of 3 minutes in a row averaging ≥ 3× the usual volume; a lone spike is not one', () => {
  const norm = { q: 100e3 };
  const spike = [{ t: 1, q: 600e3 }, { t: 2, q: 0 }, { t: 3, q: 0 }];           // averages 200K: no
  assert.equal(m.startTime(spike, norm, CFG), null);
  const run = spike.concat([{ t: 4, q: 300e3 }, { t: 5, q: 300e3 }, { t: 6, q: 400e3 }]);
  assert.equal(m.startTime(run, norm, CFG), 4);                                  // 4..6 average 333K
});

test('ratio, buy %, price change', () => {
  const norm = { q: 100e3, n: 50 };
  const win = [{ q: 400e3, n: 100, tb: 300e3, o: 10, c: 10.2 }, { q: 200e3, n: 100, tb: 100e3, o: 10.2, c: 10.5 }];
  assert.equal(m.ratio(win, norm, 'q'), 3);       // $300K a minute vs $100K
  assert.equal(m.ratio(win, norm, 'n'), 2);       // 100 trades vs 50
  assert.ok(Math.abs(m.buyPct(win) - 400 / 600 * 100) < 1e-9);
  assert.ok(Math.abs(m.priceChange(win) - 5) < 1e-9);
  assert.equal(m.buyPct([{ q: 1 }]), null);       // venue without taker split
});

test('size: big player vs crowd against the usual $2K trade', () => {
  const norm = { avgTrade: 2000 };
  assert.equal(m.sizeLabel([{ q: 500e3, n: 100 }], norm, CFG), 'крупный'); // $5K a trade
  assert.equal(m.sizeLabel([{ q: 100e3, n: 100 }], norm, CFG), 'толпа');   // $1K
  assert.equal(m.sizeLabel([{ q: 200e3, n: 100 }], norm, CFG), null);      // $2K, usual
  assert.equal(m.sizeLabel([{ q: 200e3 }], norm, CFG), null);              // no trade counts
});

test('shares now vs usual', () => {
  const rows = m.addShares([{ usdNow: 300, usdUsual: 100 }, { usdNow: 100, usdUsual: 300 }]);
  assert.deepEqual(rows.map((r) => [r.shareNow, r.shareUsual]), [[75, 25], [25, 75]]);
});

test('analyze: Upbit spot starts a minute before Binance futures → trigger Upbit, spot leads', () => {
  const none = { q: 100e3, n: undefined, tb: undefined };
  const venues = [
    { id: 'bnf', name: 'Binance F', kind: 'perp', bars: bars([100, 100, 500, 600, 600].map((k) => ({ q: k * 1e3, n: k / 2, tb: k * 600 }))) },
    { id: 'upbit', name: 'Upbit S', kind: 'spot', bars: bars([800, 900, 400, 300, 300].map((k) => ({ q: k * 1e3 })), none) },
    { id: 'okx', name: 'OKX P', kind: 'perp', bars: bars([100, 120, 110, 100, 100].map((k) => ({ q: k * 1e3 })), none) },
  ];
  const r = m.analyze(venues, T0, T0 + 5 * MIN, 'bnf', CFG);
  assert.equal(r.leader, 'upbit');
  const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  assert.equal(byId.bnf.start, T0 + MIN);
  assert.equal(byId.bnf.lag, MIN);
  assert.equal(byId.okx.start, null);
  assert.equal(Math.round(byId.bnf.buyPct), 60);
  assert.match(r.verdict, /^Триггер: Upbit S — объём ×5\.4\. Binance F позже на 1 мин · ведёт спот$/);
});

test('analyze: a venue with under 3% of the volume is never the trigger', () => {
  const none = { q: 100e3, n: undefined, tb: undefined };
  const venues = [
    { id: 'bnf', name: 'Binance F', kind: 'perp', bars: bars([1, 1, 1].map(() => ({ q: 100e6, n: 50, tb: 50e6 })), { q: 100e6, n: 50, tb: 50e6 }) },
    { id: 'thin', name: 'Thin S', kind: 'spot', bars: bars([900, 900, 900].map((k) => ({ q: k * 1e3 })), none) },
  ];
  const r = m.analyze(venues, T0, T0 + 3 * MIN, 'bnf', CFG);
  assert.equal(r.leader, null);
});

test('analyze: nobody left the norm', () => {
  const r = m.analyze([{ id: 'bnf', name: 'Binance F', kind: 'perp', bars: bars([{ q: 100e3, n: 50, tb: 50e3 }]) }], T0, T0 + MIN, 'bnf', CFG);
  assert.equal(r.leader, null);
  assert.match(r.verdict, /обычная активность/);
});

test('open interest change and liquidations over the window', () => {
  assert.equal(m.oiChange([{ t: T0, v: 100 }, { t: T0 + MIN, v: 105 }, { t: T0 + 9 * MIN, v: 110 }], T0, T0 + 5 * MIN), 5);
  const liq = m.liqSum([{ t: T0, side: 'SELL', usd: 10 }, { t: T0 + 1, side: 'BUY', usd: 4 }, { t: T0 - 1, side: 'BUY', usd: 99 }], T0, T0 + MIN);
  assert.deepEqual(liq, { longUsd: 10, shortUsd: 4 });
});
