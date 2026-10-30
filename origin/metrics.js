'use strict';
// "Where did the move come from" (full-view chart → Origin popover): the same
// coin on several venues over one window, each against its own norm — who left
// the norm first, whose volume it is, who is the aggressor, crowd or big player.
// Input per venue — 1-minute bars, oldest first: { t (open ms), o, h, l, c,
// q: USD volume, n?: trades, tb?: USD taker-buy volume } (n / tb only where the
// venue's klines carry them). Fetchers: origin/venues.js. Tests: npm run test:origin

const CFG = {
  normMin: 120,       // norm = median of the 2 h of minutes before the window
  minNormBars: 30,    // fewer → no opinion on that venue
  startRatio: 3,      // "left the norm": 3 minutes in a row averaging ≥ 3× its median volume
  startBars: 3,       //   (one stray spike minute is noise on a quiet venue)
  minLeadX: 1.5,      // and the whole window ≥ 1.5× its usual, else it didn't really move
  minShare: 3,        // and ≥ 3% of all the coin's volume now: a venue that thin can't drive the move
  bigTrade: 2,        // average trade ≥ 2× its usual → "крупный"
  crowdTrade: 0.7,    // ≤ 0.7× its usual (trades grew faster than volume) → "толпа"
};

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function sum(bars, key) {
  let s = 0;
  for (const b of bars) s += Number(b[key]) || 0;
  return s;
}

// Bars inside [from, to) and the norm's history (normMin minutes before from)
function splitBars(bars, from, to, cfg) {
  cfg = cfg || CFG;
  return {
    win: bars.filter((b) => b.t >= from && b.t < to),
    hist: bars.filter((b) => b.t < from && b.t >= from - cfg.normMin * 60000),
  };
}

// Usual minute: median USD volume, median trades, usual average trade (USD)
function normOf(hist, cfg) {
  cfg = cfg || CFG;
  if (hist.length < cfg.minNormBars) return null;
  const q = median(hist.map((b) => b.q));
  const hasN = hist.every((b) => b.n != null);
  const n = hasN ? median(hist.map((b) => b.n)) : null;
  const tradesSum = hasN ? sum(hist, 'n') : 0;
  return { q, n, avgTrade: tradesSum > 0 ? sum(hist, 'q') / tradesSum : null };
}

// First minute of the window that starts startBars minutes averaging
// ≥ startRatio × the norm; null if none
function startTime(win, norm, cfg) {
  cfg = cfg || CFG;
  if (!norm || !(norm.q > 0)) return null;
  for (let i = 0; i + cfg.startBars <= win.length; i++) {
    let q = 0;
    for (let j = i; j < i + cfg.startBars; j++) q += win[j].q;
    if (q / cfg.startBars >= cfg.startRatio * norm.q) return win[i].t;
  }
  return null;
}

// Average minute of the window against the usual minute (volume or trades)
function ratio(win, norm, key) {
  if (!win.length || !norm || !(norm[key] > 0)) return null;
  return sum(win, key) / win.length / norm[key];
}

// Share of taker buys in the window's volume, %; null when the venue doesn't say
function buyPct(win) {
  if (!win.length || win.some((b) => b.tb == null)) return null;
  const q = sum(win, 'q');
  return q > 0 ? sum(win, 'tb') / q * 100 : null;
}

// Average trade now against its usual: "крупный" / "толпа" / null
function sizeLabel(win, norm, cfg) {
  cfg = cfg || CFG;
  if (!norm || !(norm.avgTrade > 0) || win.some((b) => b.n == null)) return null;
  const n = sum(win, 'n');
  if (!(n > 0)) return null;
  const r = sum(win, 'q') / n / norm.avgTrade;
  return r >= cfg.bigTrade ? 'крупный' : r <= cfg.crowdTrade ? 'толпа' : null;
}

// Price change over the window, % (first open → last close)
function priceChange(win) {
  if (!win.length || !(win[0].o > 0)) return null;
  return (win[win.length - 1].c - win[0].o) / win[0].o * 100;
}

// Per-venue row. venues: [{ id, name, kind: 'spot'|'perp', bars }]
function venueRow(v, from, to, cfg) {
  const { win, hist } = splitBars(v.bars, from, to, cfg);
  const norm = normOf(hist, cfg);
  const volX = ratio(win, norm, 'q');
  return {
    id: v.id, name: v.name, kind: v.kind,
    start: volX != null && volX >= (cfg || CFG).minLeadX ? startTime(win, norm, cfg) : null,
    volX,
    tradesX: ratio(win, norm, 'n'),
    buyPct: buyPct(win),
    size: sizeLabel(win, norm, cfg),
    change: priceChange(win),
    usdNow: sum(win, 'q'),
    usdUsual: norm ? norm.q * win.length : 0,
  };
}

// Share of each venue in the window's volume and in the usual volume, %
function addShares(rows) {
  const now = rows.reduce((s, r) => s + r.usdNow, 0);
  const usual = rows.reduce((s, r) => s + r.usdUsual, 0);
  return rows.map((r) => Object.assign({}, r, {
    shareNow: now > 0 ? r.usdNow / now * 100 : null,
    shareUsual: usual > 0 ? r.usdUsual / usual * 100 : null,
  }));
}

// Who left the norm first (earliest start; same minute → bigger volume ×),
// and each one's lag behind it, ms. Rows without a start keep lag null.
function rankStarts(rows) {
  const started = rows.filter((r) => r.start != null)
    .sort((a, b) => a.start - b.start || (b.volX || 0) - (a.volX || 0));
  const first = started[0] || null;
  return {
    leader: first ? first.id : null,
    rows: rows.map((r) => Object.assign({}, r, { lag: first && r.start != null ? r.start - first.start : null })),
  };
}

// One line: the trigger and how Binance futures followed
function verdict(ranked, homeId) {
  const rows = ranked.rows;
  const lead = rows.find((r) => r.id === ranked.leader);
  if (!lead) return 'Ни одна площадка не вышла из нормы: обычная активность';
  const home = rows.find((r) => r.id === homeId);
  let s = 'Триггер: ' + lead.name + ' — объём ×' + (lead.volX || 0).toFixed(1)
    + (lead.buyPct != null ? ', покупки ' + Math.round(lead.buyPct) + '%' : '');
  if (lead.id === homeId) s += '. Ход начался здесь';
  else if (home && home.lag != null) s += '. ' + home.name + (home.lag === 0 ? ' в ту же минуту' : ' позже на ' + Math.round(home.lag / 60000) + ' мин');
  else if (home) s += '. ' + home.name + ' из нормы не вышел';
  const spot = rows.filter((r) => r.kind === 'spot' && r.start != null).map((r) => r.start);
  const perp = rows.filter((r) => r.kind === 'perp' && r.start != null).map((r) => r.start);
  if (spot.length && perp.length) {
    const sp = Math.min(...spot), pe = Math.min(...perp);
    s += sp < pe ? ' · ведёт спот' : pe < sp ? ' · ведут фьючерсы' : '';
  }
  return s;
}

// Open interest change over the window, %: series [{ t, v }] oldest first
function oiChange(series, from, to) {
  const inWin = series.filter((p) => p.t >= from && p.t <= to);
  if (inWin.length < 2 || !(inWin[0].v > 0)) return null;
  return (inWin[inWin.length - 1].v - inWin[0].v) / inWin[0].v * 100;
}

// Liquidations in the window: { longUsd, shortUsd } (a SELL order liquidates a long)
function liqSum(events, from, to) {
  let longUsd = 0, shortUsd = 0;
  for (const e of events) {
    if (e.t < from || e.t > to) continue;
    if (e.side === 'SELL') longUsd += e.usd; else shortUsd += e.usd;
  }
  return { longUsd, shortUsd };
}

function analyze(venues, from, to, homeId, cfg) {
  const minShare = (cfg || CFG).minShare;
  const rows = addShares(venues.map((v) => venueRow(v, from, to, cfg)))
    .map((r) => (r.start != null && !(r.shareNow >= minShare) ? Object.assign({}, r, { start: null }) : r));
  const ranked = rankStarts(rows);
  return { leader: ranked.leader, rows: ranked.rows, verdict: verdict(ranked, homeId) };
}

module.exports = {
  CFG, median, splitBars, normOf, startTime, ratio, buyPct, sizeLabel, priceChange,
  venueRow, addShares, rankStarts, verdict, oiChange, liqSum, analyze,
};
