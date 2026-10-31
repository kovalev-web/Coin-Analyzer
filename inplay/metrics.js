'use strict';
// "In play" screener (/grid): what moves over the last 5m / 15m / 1h / 3h.
// Input — 1-minute bars of Binance USDT-M futures ({ t, o, h, l, c, q: USDT
// volume, n: trades }), oldest first; the last one may be the forming minute.
// The coin's norm is its last 24 h (ticker/24hr): USDT and trades per minute.
// Fed by inplay/feed.js; who goes on the grid — inplay/rank.js.
// Tests: npm run test:inplay

const CFG = {
  windows: { '5m': 5, '15m': 15, '1h': 60, '3h': 180 },
  minDayUsd: 10e6,    // liquidity: USDT volume over 24 h, below it the coin is not shown
};
CFG.keepBars = CFG.windows['3h'] + 5;

// Minutes the window covers; the forming minute counts for the part that has passed
function windowMinutes(win, now) {
  if (!win.length) return 0;
  const last = win[win.length - 1];
  const frac = last.closed ? 1 : Math.min(1, Math.max(0, (now - last.t) / 60000));
  return win.length - 1 + frac;
}

// High − low of the whole window, % of its open
function rangePct(win) {
  if (!win.length || !(win[0].o > 0)) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of win) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
  return (hi - lo) / win[0].o * 100;
}

// Price change over the window, % (signed)
function changePct(win) {
  if (!win.length || !(win[0].o > 0)) return null;
  return (win[win.length - 1].c - win[0].o) / win[0].o * 100;
}

// Sum per minute against the norm per minute: 1 = as usual, 3 = three times
function vsNorm(sum, minutes, normPerMin) {
  if (!(minutes > 0) || !(normPerMin > 0)) return null;
  return sum / minutes / normPerMin;
}

// The norm from the 24 h ticker: USDT and trades per minute
function dayNorm(t) {
  const usd = +t.quoteVolume, n = +t.count;
  return { dayUsd: usd, usdPerMin: usd / 1440, tradesPerMin: n / 1440 };
}

// One window of a coin; null while there are fewer bars than the window
function windowStats(bars, minutes, now, norm) {
  if (bars.length < minutes) return null;
  const win = bars.slice(-minutes);
  const mins = windowMinutes(win, now);
  let usd = 0, trades = 0;
  for (const b of win) { usd += b.q || 0; trades += b.n || 0; }
  return {
    chg: changePct(win),
    range: rangePct(win),
    usd,
    vol: vsNorm(usd, mins, norm && norm.usdPerMin),
    trades: vsNorm(trades, mins, norm && norm.tradesPerMin),
  };
}

// Every window of a coin + whether it is liquid enough to show at all
function coinWindows(bars, now, norm, cfg) {
  cfg = cfg || CFG;
  const w = {};
  for (const key of Object.keys(cfg.windows)) w[key] = windowStats(bars, cfg.windows[key], now, norm);
  return { w, ok: !!norm && norm.dayUsd >= cfg.minDayUsd };
}

module.exports = { CFG, windowMinutes, rangePct, changePct, vsNorm, dayNorm, windowStats, coinWindows };
