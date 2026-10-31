'use strict';
// "In play" screener (/grid): what moves over the last 5m / 15m / 1h / 3h.
// Input — 1-minute bars of Binance USDT-M futures ({ t, o, h, l, c, q: USDT
// volume, n: trades }), oldest first; the last one may be the forming minute.
// The coin's norm is its last 24 h (ticker/24hr): USDT and trades per minute,
// and the day's high / low.
// Fed by inplay/feed.js; who goes on the grid — inplay/rank.js.
// Tests: npm run test:inplay

const CFG = {
  windows: { '5m': 5, '15m': 15, '1h': 60, '3h': 180 },
  minDayUsd: 10e6,    // liquidity: USDT volume over 24 h, below it the coin is not shown
  growth: ['15m', '3h'], // volume / trades growth: this window per minute against that one
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

// The norm from the 24 h ticker: USDT and trades per minute, the day's high / low
function dayNorm(t) {
  const usd = +t.quoteVolume, n = +t.count;
  return { dayUsd: usd, usdPerMin: usd / 1440, tradesPerMin: n / 1440, high: +t.highPrice, low: +t.lowPrice };
}

// Per minute over a short window against per minute over a long one: 1 = as
// usual lately, 3 = three times more active right now
function growth(short, long, field) {
  if (!short || !long || !(short.mins > 0) || !(long.mins > 0)) return null;
  const perLong = long[field] / long.mins;
  return perLong > 0 ? short[field] / short.mins / perLong : null;
}

// How close the price is to the day's high or low, % of the price; the ticker
// is a minute old, so the fresh bars can push the extremes further
function dayExtreme(bars, norm) {
  if (!bars.length || !norm || !(norm.high > 0) || !(norm.low > 0)) return null;
  let hi = norm.high, lo = norm.low;
  for (let i = Math.max(0, bars.length - 5); i < bars.length; i++) {
    if (bars[i].h > hi) hi = bars[i].h;
    if (bars[i].l < lo) lo = bars[i].l;
  }
  const last = bars[bars.length - 1].c;
  if (!(last > 0)) return null;
  const toHigh = (hi - last) / last * 100, toLow = (last - lo) / last * 100;
  return toHigh <= toLow ? { pct: toHigh, side: 'high' } : { pct: toLow, side: 'low' };
}

// One window of a coin; null while there are fewer bars than the window
function windowStats(bars, minutes, now, norm) {
  if (bars.length < minutes) return null;
  const win = bars.slice(-minutes);
  const mins = windowMinutes(win, now);
  let usd = 0, trades = 0;
  for (const b of win) { usd += b.q || 0; trades += b.n || 0; }
  return {
    mins,
    n: trades,
    chg: changePct(win),
    range: rangePct(win),
    usd,
    vol: vsNorm(usd, mins, norm && norm.usdPerMin),
    trades: vsNorm(trades, mins, norm && norm.tradesPerMin),
  };
}

// Every window of a coin, the growth of volume and trades, the day's extreme
// and whether it is liquid enough to show at all
function coinWindows(bars, now, norm, cfg) {
  cfg = cfg || CFG;
  const w = {};
  for (const key of Object.keys(cfg.windows)) w[key] = windowStats(bars, cfg.windows[key], now, norm);
  const s = w[cfg.growth[0]], l = w[cfg.growth[1]];
  return {
    w,
    gv: growth(s, l, 'usd'),
    gt: growth(s, l, 'n'),
    ext: dayExtreme(bars, norm),
    ok: !!norm && norm.dayUsd >= cfg.minDayUsd,
  };
}

module.exports = { CFG, windowMinutes, rangePct, changePct, vsNorm, dayNorm, growth, dayExtreme, windowStats, coinWindows };
