'use strict';
// "In play" screener (/grid): what moves over the last 5m / 15m / 1h / 3h.
// Input — 1-minute bars of Binance USDT-M futures ({ t, o, h, l, c, q: USDT
// volume, n: trades }), oldest first; the last one may be the forming minute.
// The coin's norm is its last 24 h (ticker/24hr): USDT and trades per minute,
// and the day's high / low. RVOL compares with the same time of day over the
// previous days instead — from a profile of 5-minute USDT volumes (rvolProfile).
// Fed by inplay/feed.js; who goes on the grid — inplay/rank.js.
// Tests: npm run test:inplay

const CFG = {
  windows: { '5m': 5, '15m': 15, '1h': 60, '3h': 180 },
  minDayUsd: 10e6,    // liquidity: USDT volume over 24 h, below it the coin is not shown
  growth: ['15m', '3h'], // volume / trades growth: this window per minute against that one
  natr: { tf: 5, period: 14 }, // NATR on 5-minute candles over 14 of them, like ScalpStation's "NATR 5м/14"
  // RVOL: the window's volume against the same clock time over the previous
  // `days` days (their average), from 5-minute buckets; a day counts when its
  // buckets cover ≥ `cover` of the span, and at least `minDays` must count
  rvol: { days: 5, minDays: 3, step: 5 * 60000, cover: 0.9 },
};
CFG.rvol.keep = (CFG.rvol.days + 1) * 288; // buckets in a profile: the days plus today
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
// 1-minute bars → candles of tfMin minutes on the clock (…:00, :05, …), oldest first
function candlesOf(bars, tfMin) {
  const ms = tfMin * 60000, out = [];
  for (const b of bars) {
    const t = Math.floor(b.t / ms) * ms;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      if (b.h > last.h) last.h = b.h;
      if (b.l < last.l) last.l = b.l;
      last.c = b.c;
    } else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  return out;
}

// Normalized ATR, %: the average true range of the last `period` candles of
// tfMin minutes (the forming one included) against the last price; null
// while there are fewer candles
function natr(bars, tfMin, period) {
  const candles = candlesOf(bars.slice(-(period + 2) * tfMin), tfMin).slice(-(period + 1));
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1].c;
    sum += Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
  }
  const last = candles[candles.length - 1].c;
  return last > 0 ? sum / period / last * 100 : null;
}

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

// Profile of a coin for RVOL: USDT volume in clock-aligned buckets of
// cfg.step, { t0: start of q[0], q: [usd | NaN = no data] }, at most cfg.keep
// buckets. Adds usd to the bucket of t (gaps between are NaN).
function profileAdd(prof, t, usd, cfg) {
  cfg = cfg || CFG.rvol;
  const b = Math.floor(t / cfg.step) * cfg.step;
  if (!prof.q.length) { prof.t0 = b; prof.q.push(usd); return prof; }
  let i = (b - prof.t0) / cfg.step;
  if (i < 0) return prof; // older than the profile
  while (prof.q.length <= i) prof.q.push(NaN);
  prof.q[i] = (Number.isNaN(prof.q[i]) ? 0 : prof.q[i]) + usd;
  const extra = prof.q.length - cfg.keep;
  if (extra > 0) { prof.q.splice(0, extra); prof.t0 += extra * cfg.step; }
  return prof;
}

// USDT in [from, to) from the profile; a bucket cut by the span counts for
// the part inside it. covered = ms of the span that had data
function spanUsd(prof, from, to, cfg) {
  cfg = cfg || CFG.rvol;
  let usd = 0, covered = 0;
  if (!prof || !prof.q.length || !(to > from)) return { usd, covered };
  const first = Math.max(0, Math.floor((from - prof.t0) / cfg.step));
  const last = Math.min(prof.q.length - 1, Math.floor((to - 1 - prof.t0) / cfg.step));
  for (let i = first; i <= last; i++) {
    const v = prof.q[i];
    if (Number.isNaN(v)) continue;
    const b0 = prof.t0 + i * cfg.step;
    const part = Math.min(to, b0 + cfg.step) - Math.max(from, b0);
    if (part <= 0) continue;
    usd += v * part / cfg.step;
    covered += part;
  }
  return { usd, covered };
}

// Relative volume: usd over [from, to) against the average of the same span
// on each of the previous days; 1 = as usual at this hour, 5 = five times.
// null while too few days have data
function rvol(prof, usd, from, to, cfg) {
  cfg = cfg || CFG.rvol;
  if (!prof || !(to > from)) return null;
  const DAY = 86400000;
  let sum = 0, days = 0;
  for (let k = 1; k <= cfg.days; k++) {
    const d = spanUsd(prof, from - k * DAY, to - k * DAY, cfg);
    if (d.covered < cfg.cover * (to - from)) continue;
    sum += d.usd; days++;
  }
  if (days < cfg.minDays || !(sum > 0)) return null;
  return usd / (sum / days);
}

// One window of a coin; null while there are fewer bars than the window
function windowStats(bars, minutes, now, norm, prof) {
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
    rvol: rvol(prof, usd, win[0].t, win[0].t + mins * 60000),
  };
}

// Every window of a coin, the growth of volume and trades, the day's extreme
// and whether it is liquid enough to show at all
function coinWindows(bars, now, norm, prof, cfg) {
  cfg = cfg || CFG;
  const w = {};
  for (const key of Object.keys(cfg.windows)) w[key] = windowStats(bars, cfg.windows[key], now, norm, prof);
  const s = w[cfg.growth[0]], l = w[cfg.growth[1]];
  return {
    w,
    gv: growth(s, l, 'usd'),
    gt: growth(s, l, 'n'),
    ext: dayExtreme(bars, norm),
    natr: natr(bars, cfg.natr.tf, cfg.natr.period),
    ok: !!norm && norm.dayUsd >= cfg.minDayUsd,
  };
}

module.exports = { CFG, windowMinutes, rangePct, changePct, vsNorm, dayNorm, growth, candlesOf, natr, dayExtreme, profileAdd, spanUsd, rvol, windowStats, coinWindows };
