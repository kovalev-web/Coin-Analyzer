'use strict';
// Algorithms in the trade tape, shown as marks on the full-view chart with a
// card (src/react/host/AlgoCard.jsx):
//  - "Таймер" (P): one side, about the same size, at about the same interval
//    (a TWAP-like bot: ~$82K every ~33 s);
//  - "Давление" (C, below): minutes where nearly all market orders are one side
//    and there are many times more of them and of volume than usual — a bot
//    slicing a big order into thousands of small ones.
// Timer input: prints of one venue + symbol, oldest first — { t (ms), p, usd, buy }
// where a print is one market order (trades of one side within mergeMs merged).
// Collector: algos/collector.js. Tests: npm run test:algos

const CFG = {
  mergeMs: 50,          // trades of one side this close = one market order
  minUsd: 1000,         // smaller prints are noise for this
  sizeTol: 0.2,         // "same size": within ±20%
  minPeriodMs: 5000,    // a bot with a period under 5 s or over 5 min isn't a timer we can see
  maxPeriodMs: 300000,
  beatTolRel: 0.05,     // the next print lands within ±5% of the period…
  beatTolMs: 600,       // …or ±0.6 s, whichever is wider
  maxSkip: 1,           // one missed beat: expect at +1 or +2 periods
  minRepeats: 5,        // prints in the series before it counts
  maxSkipShare: 0.25,   // missed beats ≤ 25% of the series
  maxJitter: 0.03,      // median |beat − period| ≤ 3% of the period: a clock, not chance
  minPurity: 0.5,       // ≥ half of the same-side same-size prints over its span are the series itself
  maxChance: 1e-4,      // odds that background prints of that size line up this long by chance
};

// Odds that prints of that size, at their background rate, fall into the
// expected windows L−2 times in a row (the first two only set the period)
function chanceOf(len, period, alikeOthers, span, cfg) {
  const tol = Math.max(cfg.beatTolMs, period * cfg.beatTolRel);
  const rate = span > 0 ? alikeOthers / span : 0; // per ms
  const hit = 1 - Math.exp(-rate * 2 * tol * (cfg.maxSkip + 1));
  return Math.pow(hit, len - 2);
}

// Is this chain a clock, or prints that happened to line up? (skips, jitter, purity)
function isRegular(prints, chain, period, cfg) {
  let skips = 0;
  const dev = [];
  for (let c = 1; c < chain.length; c++) {
    const dt = prints[chain[c]].t - prints[chain[c - 1]].t;
    const k = Math.max(1, Math.round(dt / period));
    skips += k - 1;
    dev.push(Math.abs(dt / k - period) / period);
  }
  if (skips > cfg.maxSkipShare * (chain.length - 1)) return false;
  if (median(dev) > cfg.maxJitter) return false;
  const a = prints[chain[0]].t, b = prints[chain[chain.length - 1]].t;
  const size = median(chain.map((c) => prints[c].usd));
  let alike = 0;
  for (const x of prints) if (x.t >= a && x.t <= b && sameSize(x.usd, size, cfg.sizeTol)) alike++;
  if (chain.length / alike < cfg.minPurity) return false;
  return chanceOf(chain.length, period, alike - chain.length, b - a, cfg) <= cfg.maxChance;
}

// Trades → prints: same side within mergeMs of the print's first trade
function toPrints(trades, cfg) {
  cfg = cfg || CFG;
  const out = [];
  let cur = null;
  for (const tr of trades) {
    if (cur && cur.buy === tr.buy && tr.t - cur.t <= cfg.mergeMs) {
      cur.usd += tr.usd;
      cur.pq += tr.p * tr.usd;
      continue;
    }
    cur = { t: tr.t, buy: tr.buy, usd: tr.usd, pq: tr.p * tr.usd };
    out.push(cur);
  }
  return out.map((x) => ({ t: x.t, buy: x.buy, usd: x.usd, p: x.usd > 0 ? x.pq / x.usd : 0 }));
}

function median(v) {
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const sameSize = (a, b, tol) => Math.abs(a / b - 1) <= tol;

// First print at index ≥ from whose time is within tol of `at` and size close to `size`
function findBeat(prints, from, at, tol, size, cfg) {
  let best = -1, bestErr = Infinity;
  for (let k = from; k < prints.length && prints[k].t <= at + tol; k++) {
    const err = Math.abs(prints[k].t - at);
    if (err <= tol && sameSize(prints[k].usd, size, cfg.sizeTol) && err < bestErr) { best = k; bestErr = err; }
  }
  return best;
}

// The longest series starting at prints[i] (indices into prints, one side only)
function seriesFrom(prints, i, cfg) {
  let best = null;
  const a = prints[i];
  for (let j = i + 1; j < prints.length && prints[j].t - a.t <= cfg.maxPeriodMs; j++) {
    const dt = prints[j].t - a.t;
    if (dt < cfg.minPeriodMs || !sameSize(prints[j].usd, a.usd, cfg.sizeTol)) continue;
    const chain = [i, j];
    let period = dt;
    for (;;) {
      const last = prints[chain[chain.length - 1]];
      const size = median(chain.map((c) => prints[c].usd));
      let next = -1;
      for (let skip = 1; skip <= cfg.maxSkip + 1 && next < 0; skip++) {
        const tol = Math.max(cfg.beatTolMs, period * cfg.beatTolRel);
        next = findBeat(prints, chain[chain.length - 1] + 1, last.t + skip * period, tol, size, cfg);
        if (next >= 0) {
          chain.push(next);
          const beats = [];
          for (let c = 1; c < chain.length; c++) {
            const d = prints[chain[c]].t - prints[chain[c - 1]].t;
            beats.push(d / Math.max(1, Math.round(d / period)));
          }
          period = median(beats);
        }
      }
      if (next < 0) break;
    }
    if (chain.length >= cfg.minRepeats && isRegular(prints, chain, period, cfg) && (!best || chain.length > best.chain.length)) best = { chain, period };
  }
  return best;
}

// All timers among the prints of one side: every start's best series, then
// claimed longest first, so a chance chain can't steal a print of a real one
function timersOfSide(prints, cfg) {
  const cands = [];
  for (let i = 0; i < prints.length; i++) {
    const s = seriesFrom(prints, i, cfg);
    if (s) cands.push(s);
  }
  cands.sort((a, b) => b.chain.length - a.chain.length);
  const used = new Uint8Array(prints.length);
  const found = [];
  for (const s of cands) {
    if (s.chain.some((c) => used[c])) continue;
    s.chain.forEach((c) => { used[c] = 1; });
    found.push(s);
  }
  return found;
}

// Turnover of the venue (all prints, both sides) over [from, to]
function turnover(prints, from, to) {
  let s = 0;
  for (const x of prints) if (x.t >= from && x.t <= to) s += x.usd;
  return s;
}

// Timers in the prints of one venue + symbol. Each: side, size, period, count,
// total, VWAP, price change over the series, share of the venue's turnover,
// start, noticed (the minRepeats-th print — when it could first be seen), end.
// turnoverOf(from, to) — the venue's USD turnover; by default summed from the
// prints themselves (the collector keeps only big prints, so it passes its own)
function detectTimers(allPrints, cfg, turnoverOf) {
  cfg = cfg || CFG;
  turnoverOf = turnoverOf || ((from, to) => turnover(allPrints, from, to));
  const big = allPrints.filter((x) => x.usd >= cfg.minUsd);
  const out = [];
  [true, false].forEach((buy) => {
    const side = big.filter((x) => x.buy === buy);
    timersOfSide(side, cfg).forEach((s) => {
      const pr = s.chain.map((c) => side[c]);
      const total = pr.reduce((a, x) => a + x.usd, 0);
      const start = pr[0].t, end = pr[pr.length - 1].t;
      const all = turnoverOf(start, end);
      out.push({
        kind: 'timer', buy,
        sizeUsd: median(pr.map((x) => x.usd)),
        periodSec: s.period / 1000,
        count: pr.length,
        totalUsd: total,
        avgPrice: pr.reduce((a, x) => a + x.p * x.usd, 0) / total,
        change: pr[0].p > 0 ? (pr[pr.length - 1].p - pr[0].p) / pr[0].p * 100 : 0,
        share: all > 0 ? total / all * 100 : null,
        start, end,
        noticed: pr[cfg.minRepeats - 1].t,
        firstPrice: pr[0].p,
        noticedPrice: pr[cfg.minRepeats - 1].p,
      });
    });
  });
  return out.sort((a, b) => a.start - b.start);
}

// ── Давление ────────────────────────────────────────────────────────────────
// Input: the venue's minutes, oldest first — { t (minute start), usd, buyUsd,
// n (market orders), o, c (first / last price) }; every minute present.

const PCFG = {
  normMin: 120,      // usual minute = median over the 2 h before the minute
  minNormBars: 20,
  side: 0.7,         // ≥ 70% of the volume one side
  volX: 5,           // volume ≥ 5× the usual minute
  tradesX: 3,        // market orders ≥ 3× the usual minute
  minUsd: 20000,     // and ≥ $20K in the minute (dead coins aside)
  gap: 1,            // one weaker minute inside an episode is allowed
  minMinutes: 3,     // pressing minutes before it counts ("замечено" = after the 3rd)
};

// The usual minute before index i: median volume and market orders
function minuteNorm(mins, i, cfg) {
  const hist = mins.slice(Math.max(0, i - cfg.normMin), i);
  if (hist.length < cfg.minNormBars) return null;
  return { usd: median(hist.map((m) => m.usd)), n: median(hist.map((m) => m.n)) };
}

// Is the minute pressing, and which side: true buy / false sell / null no
function pressing(m, norm, cfg) {
  if (!norm || !(m.usd >= cfg.minUsd) || !(m.usd >= cfg.volX * norm.usd) || !(m.n >= cfg.tradesX * Math.max(1, norm.n))) return null;
  const share = m.buyUsd / m.usd;
  return share >= cfg.side ? true : share <= 1 - cfg.side ? false : null;
}

function detectPressure(mins, cfg) {
  cfg = cfg || PCFG;
  const out = [];
  let ep = null;
  const close = () => {
    if (ep && ep.hits >= cfg.minMinutes) {
      const ms = mins.slice(ep.i0, ep.i1 + 1);
      const usd = ms.reduce((a, m) => a + m.usd, 0);
      const buyUsd = ms.reduce((a, m) => a + m.buyUsd, 0);
      out.push({
        kind: 'pressure', buy: ep.buy,
        count: ms.reduce((a, m) => a + m.n, 0),
        totalUsd: usd,
        sidePct: (ep.buy ? buyUsd / usd : 1 - buyUsd / usd) * 100,
        volX: usd / ms.length / ep.norm.usd,
        change: ms[0].o > 0 ? (ms[ms.length - 1].c - ms[0].o) / ms[0].o * 100 : 0,
        start: ms[0].t, end: ms[ms.length - 1].t + 60000,
        noticed: mins[ep.noticedIdx].t + 60000,
        firstPrice: ms[0].o, noticedPrice: mins[ep.noticedIdx].c,
      });
    }
    ep = null;
  };
  for (let i = 0; i < mins.length; i++) {
    const norm = ep ? ep.norm : minuteNorm(mins, i, cfg); // inside an episode: the norm from before it
    const side = pressing(mins[i], norm, cfg);
    if (ep && side === ep.buy) {
      ep.i1 = i; ep.hits++; ep.miss = 0;
      if (ep.hits === cfg.minMinutes) ep.noticedIdx = i;
    } else if (ep && side === null && ++ep.miss <= cfg.gap) {
      continue;
    } else {
      close();
      if (side !== null) ep = { buy: side, i0: i, i1: i, hits: 1, miss: 0, norm, noticedIdx: i };
    }
  }
  close();
  return out;
}

module.exports = { CFG, PCFG, toPrints, median, chanceOf, findBeat, seriesFrom, detectTimers, minuteNorm, pressing, detectPressure };
