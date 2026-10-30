'use strict';
// Origin popover data: 1-minute bars of one coin on several venues (public REST,
// no keys), futures context (open interest, funding) and a liquidations buffer.
// Bars come out as origin/metrics.js expects: { t, o, h, l, c, q (USD), n?, tb? },
// oldest first, every minute of the range present (no-trade minutes → zero bars).

const WebSocket = require('ws');

const TIMEOUT_MS = 8000;
const MIN = 60000;

async function getJson(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({ signal: ctl.signal }, opts));
    if (!res.ok) throw new Error(url.split('?')[0] + ' → HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// SOLUSDT → SOL; 1000PEPEUSDT → PEPE (the "1000" contracts trade as the plain coin on spot)
function baseOf(symbol) {
  return symbol.replace(/USDT$/, '').replace(/^1000000|^1000/, '');
}

// Missing minutes (nobody traded) count as zero volume, so a thin venue's norm isn't inflated
function fillGaps(bars, from, to, fields) {
  const byT = new Map(bars.map((b) => [b.t, b]));
  const out = [];
  let prev = bars.length ? bars[0].o : 0;
  for (let t = Math.floor(from / MIN) * MIN; t < to; t += MIN) {
    const b = byT.get(t);
    if (b) { out.push(b); prev = b.c; continue; }
    const z = { t, o: prev, h: prev, l: prev, c: prev, q: 0 };
    if (fields.n) z.n = 0;
    if (fields.tb) z.tb = 0;
    out.push(z);
  }
  return out;
}

// ── Venues ───────────────────────────────────────────────────────────────────

function binanceKlines(host, path, symbol) {
  return async (from, to) => {
    const rows = await getJson(host + path + '?symbol=' + symbol + '&interval=1m&startTime=' + from + '&endTime=' + (to - 1) + '&limit=1000');
    return fillGaps(rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], q: +k[7], n: +k[8], tb: +k[10] })), from, to, { n: true, tb: true });
  };
}

function bybitKlines(category, symbol) {
  return async (from, to) => {
    const j = await getJson('https://api.bybit.com/v5/market/kline?category=' + category + '&symbol=' + symbol + '&interval=1&start=' + from + '&end=' + (to - 1) + '&limit=1000');
    if (j.retCode !== 0) throw new Error('Bybit ' + j.retMsg);
    return fillGaps(j.result.list.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], q: +k[6] })).reverse(), from, to, {});
  };
}

// OKX gives 100 bars a page, newest first: page back from `to`
function okxKlines(instId) {
  return async (from, to) => {
    const out = [];
    let after = to;
    for (let page = 0; page < 6 && after > from; page++) {
      const j = await getJson('https://www.okx.com/api/v5/market/history-candles?instId=' + instId + '&bar=1m&limit=100&after=' + after);
      if (j.code !== '0') throw new Error('OKX ' + j.msg);
      if (!j.data.length) break;
      j.data.forEach((k) => out.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], q: +k[7] }));
      after = +j.data[j.data.length - 1][0];
    }
    return fillGaps(out.filter((b) => b.t >= from).sort((a, b) => a.t - b.t), from, to, {});
  };
}

function hyperliquidKlines(coin) {
  return async (from, to) => {
    const rows = await getJson('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1m', startTime: from, endTime: to - 1 } }),
    });
    return fillGaps(rows.map((k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, q: +k.v * +k.c, n: +k.n })), from, to, { n: true });
  };
}

// Upbit: KRW, 200 bars a page, newest first; USD through Upbit's own KRW-USDT price
function upbitKlines(market) {
  return async (from, to) => {
    const usdt = await getJson('https://api.upbit.com/v1/ticker?markets=KRW-USDT');
    const krwPerUsd = usdt[0] && usdt[0].trade_price;
    if (!(krwPerUsd > 0)) throw new Error('Upbit KRW-USDT price');
    const out = [];
    let cursor = to;
    for (let page = 0; page < 3 && cursor > from; page++) {
      const rows = await getJson('https://api.upbit.com/v1/candles/minutes/1?market=' + market + '&count=200&to=' + new Date(cursor).toISOString().replace(/\.\d+Z$/, 'Z'));
      if (!rows.length) break;
      rows.forEach((k) => {
        const t = Date.parse(k.candle_date_time_utc + 'Z');
        out.push({ t, o: k.opening_price / krwPerUsd, h: k.high_price / krwPerUsd, l: k.low_price / krwPerUsd, c: k.trade_price / krwPerUsd, q: k.candle_acc_trade_price / krwPerUsd });
      });
      cursor = Date.parse(rows[rows.length - 1].candle_date_time_utc + 'Z');
    }
    return fillGaps(out.filter((b) => b.t >= from && b.t < to).sort((a, b) => a.t - b.t), from, to, {});
  };
}

// Venues of a Binance USDT-M symbol. `home` — the one the order book trades.
function venuesFor(symbol) {
  const base = baseOf(symbol);
  const thousand = /^1000/.test(symbol);
  return [
    { id: 'bnf', name: 'Binance F', kind: 'perp', home: true, load: binanceKlines('https://fapi.binance.com', '/fapi/v1/klines', symbol) },
    { id: 'bns', name: 'Binance S', kind: 'spot', load: binanceKlines('https://api.binance.com', '/api/v3/klines', base + 'USDT') },
    { id: 'byp', name: 'Bybit P', kind: 'perp', load: bybitKlines('linear', symbol) },
    { id: 'bys', name: 'Bybit S', kind: 'spot', load: bybitKlines('spot', base + 'USDT') },
    { id: 'okp', name: 'OKX P', kind: 'perp', load: okxKlines(base + '-USDT-SWAP') },
    { id: 'oks', name: 'OKX S', kind: 'spot', load: okxKlines(base + '-USDT') },
    { id: 'hlp', name: 'Hyperliquid P', kind: 'perp', load: hyperliquidKlines(thousand ? 'k' + base : base) },
    { id: 'upb', name: 'Upbit KRW', kind: 'spot', load: upbitKlines('KRW-' + base) },
  ];
}

// Every venue at once; one that doesn't list the coin (or fails) is left out with its reason
async function loadVenues(symbol, from, to) {
  const list = venuesFor(symbol);
  const res = await Promise.allSettled(list.map((v) => v.load(from, to)));
  const venues = [], missing = [];
  res.forEach((r, i) => {
    const v = list[i];
    if (r.status === 'fulfilled' && r.value.some((b) => b.q > 0)) venues.push({ id: v.id, name: v.name, kind: v.kind, bars: r.value });
    else missing.push({ id: v.id, name: v.name, reason: r.status === 'rejected' ? String(r.reason && r.reason.message || r.reason) : 'no trades' });
  });
  return { venues, missing };
}

// ── Futures context ─────────────────────────────────────────────────────────

// Open interest every 5 min, [{ t, v }] oldest first, per venue
async function loadOpenInterest(symbol, from, to) {
  const base = baseOf(symbol);
  const jobs = {
    'Binance F': getJson('https://fapi.binance.com/futures/data/openInterestHist?symbol=' + symbol + '&period=5m&limit=500&startTime=' + from + '&endTime=' + to)
      .then((rows) => rows.map((r) => ({ t: r.timestamp, v: +r.sumOpenInterestValue }))),
    'Bybit P': getJson('https://api.bybit.com/v5/market/open-interest?category=linear&symbol=' + symbol + '&intervalTime=5min&limit=200&startTime=' + from + '&endTime=' + to)
      .then((j) => j.result.list.map((r) => ({ t: +r.timestamp, v: +r.openInterest })).reverse()),
    'OKX P': getJson('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=' + base + '-USDT-SWAP&period=5m&begin=' + from + '&end=' + to)
      .then((j) => j.data.map((r) => ({ t: +r[0], v: +r[3] })).reverse()),
  };
  const names = Object.keys(jobs);
  const res = await Promise.allSettled(names.map((n) => jobs[n]));
  const out = {};
  res.forEach((r, i) => { if (r.status === 'fulfilled' && r.value.length) out[names[i]] = r.value; });
  return out;
}

// Current funding rate, % per period, per venue
async function loadFunding(symbol) {
  const base = baseOf(symbol);
  const jobs = {
    'Binance F': getJson('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=' + symbol).then((j) => +j.lastFundingRate * 100),
    'Bybit P': getJson('https://api.bybit.com/v5/market/tickers?category=linear&symbol=' + symbol).then((j) => +j.result.list[0].fundingRate * 100),
    'OKX P': getJson('https://www.okx.com/api/v5/public/funding-rate?instId=' + base + '-USDT-SWAP').then((j) => +j.data[0].fundingRate * 100),
  };
  const names = Object.keys(jobs);
  const res = await Promise.allSettled(names.map((n) => jobs[n]));
  const out = {};
  res.forEach((r, i) => { if (r.status === 'fulfilled' && Number.isFinite(r.value)) out[names[i]] = r.value; });
  return out;
}

// ── Liquidations ────────────────────────────────────────────────────────────
// Binance has no public history of liquidations, only the live stream: the
// server listens to all of them from start and keeps 3 h per symbol.

const LIQ_KEEP_MS = 3 * 3600 * 1000;

function createLiquidations() {
  const bySym = new Map(); // 'SOLUSDT' → [{ t, side, usd }]
  let ws = null, stopped = false, retry = 0, since = null;
  function add(sym, e) {
    let list = bySym.get(sym);
    if (!list) bySym.set(sym, list = []);
    list.push(e);
    while (list.length && e.t - list[0].t > LIQ_KEEP_MS) list.shift();
  }
  function connect() {
    if (stopped) return;
    ws = new WebSocket('wss://fstream.binance.com/market/ws/!forceOrder@arr');
    ws.on('open', () => { retry = 0; if (since == null) since = Date.now(); });
    ws.on('message', (d) => {
      try {
        const o = JSON.parse(d).o;
        if (o && o.s) add(o.s, { t: o.T, side: o.S, usd: +o.z * +o.ap });
      } catch (e) { /* not ours */ }
    });
    ws.on('close', () => { if (!stopped) setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, retry++))); });
    ws.on('error', () => {});
  }
  return {
    start() { stopped = false; connect(); },
    stop() { stopped = true; if (ws) ws.close(); },
    events(sym) { return bySym.get(sym) || []; },
    since() { return since; },
  };
}

module.exports = { baseOf, fillGaps, venuesFor, loadVenues, loadOpenInterest, loadFunding, createLiquidations };
