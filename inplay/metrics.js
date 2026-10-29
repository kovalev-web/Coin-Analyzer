'use strict';
// "In play" screener (/grid): how active a coin is right now compared with
// its own norm. Input — 1-minute bars of Binance USDT-M futures
// ({ t, o, h, l, c, q: USDT volume, n: trades }), oldest first; the last one
// may be the forming minute. Fed by inplay/feed.js, the grid layout itself is
// src/inplay-grid.js. Tests: npm run test:inplay

const CFG = {
  windowMin: 5,       // "now" = the forming minute + the 4 closed before it
  normMin: 240,       // norm = median of the closed minutes over the 4 h before "now"
  minNormBars: 60,    // fewer closed minutes of history → no opinion yet
  minNormUsd: 15000,  // liquidity: median USDT per minute
  minNowUsd: 100000,  // and USDT per minute now
  minNatr: 0.25,      // and the average 1-minute range now, %
  ratioMin: 1 / 16,   // ratios are clamped so one dead minute or one spike can't run away
  ratioMax: 64,
  weights: { rv: 0.35, tr: 0.35, vr: 0.2, move: 0.1 },
  tauMs: 30000,       // score smoothing: ~63% of a change after 30 s
};

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// High − low of a bar, % of its close
function rangePct(bar) {
  return bar.c > 0 ? (bar.h - bar.l) / bar.c * 100 : 0;
}

// The last windowMin bars ("now") and the closed bars before them (the norm's history)
function splitWindow(bars, cfg) {
  cfg = cfg || CFG;
  const win = bars.slice(-cfg.windowMin);
  const hist = bars.slice(Math.max(0, bars.length - cfg.windowMin - cfg.normMin), bars.length - cfg.windowMin);
  return { win, hist };
}

// Per minute over the window; the forming minute counts for the part of it
// that has passed (at its very start the window is 4 full minutes long)
function ratePerMin(win, field, now) {
  if (!win.length) return null;
  const last = win[win.length - 1];
  const frac = last.closed ? 1 : Math.min(1, Math.max(0, (now - last.t) / 60000));
  const minutes = win.length - 1 + frac;
  if (!(minutes > 0)) return null;
  let sum = 0;
  for (const b of win) sum += b[field] || 0;
  return sum / minutes;
}

// a / b clamped to [ratioMin, ratioMax]; null without a norm
function ratio(a, b, cfg) {
  cfg = cfg || CFG;
  if (a == null || !(b > 0) || !(a >= 0)) return null;
  return Math.min(cfg.ratioMax, Math.max(cfg.ratioMin, a / b));
}

// Average 1-minute range over the window, %
function natrNow(win) {
  if (!win.length) return null;
  return win.reduce((s, b) => s + rangePct(b), 0) / win.length;
}

// Price move over the window in the coin's usual 1-minute ranges
function moveInRanges(win, medRangePct) {
  if (!win.length || !(medRangePct > 0)) return null;
  const first = win[0], last = win[win.length - 1];
  if (!(first.o > 0)) return null;
  return Math.abs(last.c - first.o) / first.o * 100 / medRangePct;
}

// Price change over the window, % (signed — for the card, not the score)
function changePct(win) {
  if (!win.length || !(win[0].o > 0)) return null;
  return (win[win.length - 1].c - win[0].o) / win[0].o * 100;
}

// Weighted sum of log2 ratios: 0 = as usual, 1 ≈ everything twice the norm
function score(m, cfg) {
  cfg = cfg || CFG;
  if (m.rv == null || m.tr == null || m.vr == null) return null;
  const w = cfg.weights;
  return w.rv * Math.log2(m.rv) + w.tr * Math.log2(m.tr) + w.vr * Math.log2(m.vr) + w.move * Math.log2(1 + (m.move || 0));
}

// Enough liquidity and movement to scalp at all
function passesGates(m, cfg) {
  cfg = cfg || CFG;
  return m.normUsd >= cfg.minNormUsd && m.usdPerMin >= cfg.minNowUsd && m.natr >= cfg.minNatr;
}

// Exponential smoothing that doesn't depend on how often it runs
function ema(prev, x, dtMs, tauMs) {
  if (x == null) return prev;
  if (prev == null || !(dtMs >= 0)) return x;
  return prev + (x - prev) * (1 - Math.exp(-dtMs / (tauMs || CFG.tauMs)));
}

// Everything for one coin; null until there's enough history
function coinMetrics(bars, now, cfg) {
  cfg = cfg || CFG;
  const { win, hist } = splitWindow(bars, cfg);
  if (hist.length < cfg.minNormBars || win.length < cfg.windowMin) return null;
  const normUsd = median(hist.map((b) => b.q));
  const normTrades = median(hist.map((b) => b.n));
  const normRange = median(hist.map(rangePct));
  const usdPerMin = ratePerMin(win, 'q', now);
  const tradesPerMin = ratePerMin(win, 'n', now);
  const natr = natrNow(win);
  const m = {
    usdPerMin, tradesPerMin, natr, normUsd,
    rv: ratio(usdPerMin, normUsd, cfg),
    tr: ratio(tradesPerMin, normTrades, cfg),
    vr: ratio(natr, normRange, cfg),
    move: moveInRanges(win, normRange),
    chg: changePct(win),
  };
  m.score = score(m, cfg);
  m.ok = m.score != null && passesGates(m, cfg);
  return m;
}

module.exports = {
  CFG, median, rangePct, splitWindow, ratePerMin, ratio, natrNow, moveInRanges,
  changePct, score, passesGates, ema, coinMetrics,
};
