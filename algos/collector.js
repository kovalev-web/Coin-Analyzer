'use strict';
// Trade tape of the watched coins, for the algorithm detector (algos/detect.js):
// Binance futures + spot, Bybit perp + spot, OKX swap + spot, Hyperliquid perps,
// Upbit KRW spot — live by WS. Watched = the trader's coins in today's briefing,
// only while the day is open (morning card filled, evening not yet). Keeps 6 h: big prints (≥ detector's
// minUsd, for timers) and every minute's volume, buys, market orders and first /
// last price (for pressure and "share of turnover"). A coin seen for the first
// time gets up to the last hour of Binance trades from REST (paced, newest first).

const WebSocket = require('ws');
const { CFG } = require('./detect');

const KEEP_MS = 6 * 3600 * 1000;
const MIN = 60000;
const BACKFILL_MS = 3600 * 1000;  // history for a coin seen the first time
const BACKFILL_PAGES = 20;        // × 1000 trades; aggTrades weighs 20 of Binance's 2400 a minute (pressure uses klines instead)
const BACKFILL_GAP_MS = 2000;     // between pages: ~600 weight a minute at most
const MAX_PRINTS = 200000; // per venue + coin, a guard against a runaway coin

function baseOf(symbol) { return symbol.replace(/USDT$/, '').replace(/^1000000|^1000/, ''); }
function hlCoin(symbol) { return /^1000/.test(symbol) ? 'k' + baseOf(symbol) : baseOf(symbol); }

// One venue + coin: prints merged from trades, minute stats
function createTape() {
  const prints = [];
  const minutes = new Map(); // minute start → { usd, buyUsd, n, o, c }
  let last = null, since = Date.now();
  function minuteOf(t, p) {
    const k = Math.floor(t / MIN) * MIN;
    let m = minutes.get(k);
    if (!m) minutes.set(k, m = { t: k, usd: 0, buyUsd: 0, n: 0, o: p, c: p });
    return m;
  }
  function add(t, p, usd, buy) {
    const m = minuteOf(t, p);
    m.usd += usd; if (buy) m.buyUsd += usd; m.c = p;
    if (last && last.buy === buy && t - last.t <= CFG.mergeMs) {
      last.pq += p * usd; last.usd += usd; last.p = last.pq / last.usd;
      if (!last.kept && last.usd >= CFG.minUsd) { last.kept = true; prints.push(last); }
      return;
    }
    m.n++;
    last = { t, p, usd, buy, pq: p * usd, kept: usd >= CFG.minUsd };
    if (last.kept) prints.push(last);
    if (prints.length > MAX_PRINTS) prints.splice(0, prints.length - MAX_PRINTS);
  }
  return {
    add,
    // Older trades (oldest first, all before `since`) put in front of the live ones
    addHistory(trades) {
      const h = createTape();
      trades.forEach((tr) => h.add(tr.t, tr.p, tr.usd, tr.buy));
      prints.unshift(...h._prints());
      h._minutes().forEach((hm, k) => {
        const m = minutes.get(k);
        if (!m) { minutes.set(k, hm); return; }
        m.usd += hm.usd; m.buyUsd += hm.buyUsd; m.n += hm.n; m.o = hm.o; // the older part opened that minute
      });
      if (trades.length) since = Math.min(since, trades[0].t);
    },
    prune(now) {
      let cut = 0;
      while (cut < prints.length && now - prints[cut].t > KEEP_MS) cut++;
      if (cut) prints.splice(0, cut);
      for (const k of minutes.keys()) if (now - k > KEEP_MS) minutes.delete(k);
      if (now - since > KEEP_MS) since = now - KEEP_MS;
    },
    prints() { return prints.map((x) => ({ t: x.t, p: x.p, usd: x.usd, buy: x.buy })); },
    // Every minute from the first one on (quiet minutes as zero), oldest first
    minutes() {
      const keys = [...minutes.keys()].sort((a, b) => a - b);
      if (!keys.length) return [];
      const out = [];
      let prev = minutes.get(keys[0]);
      for (let k = keys[0]; k <= keys[keys.length - 1]; k += MIN) {
        const m = minutes.get(k) || { t: k, usd: 0, buyUsd: 0, n: 0, o: prev.c, c: prev.c };
        out.push(Object.assign({}, m));
        prev = m;
      }
      return out;
    },
    turnover(from, to) {
      let s = 0;
      for (const [k, m] of minutes) if (k + MIN > from && k <= to) s += m.usd;
      return s;
    },
    since() { return since; },
    _prints() { return prints; },
    _minutes() { return minutes; },
  };
}

// Up to the last hour of Binance futures trades before `to`, newest pages first
async function binanceHistory(symbol, to, log) {
  const get = async (q) => {
    const r = await fetch('https://fapi.binance.com/fapi/v1/aggTrades?symbol=' + symbol + '&limit=1000&' + q);
    if (!r.ok) throw new Error('aggTrades HTTP ' + r.status);
    return r.json();
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let page = await get('startTime=' + (to - MIN) + '&endTime=' + to);
  if (!page.length) page = await get('endTime=' + to);
  if (!page.length) return [];
  const pages = [page];
  let firstId = page[0].a;
  for (let k = 1; k < BACKFILL_PAGES && page[0].T > to - BACKFILL_MS && firstId > 0; k++) {
    await sleep(BACKFILL_GAP_MS);
    page = await get('fromId=' + Math.max(0, firstId - 1000));
    page = page.filter((t) => t.a < firstId);
    if (!page.length) break;
    pages.unshift(page);
    firstId = page[0].a;
  }
  const out = [];
  pages.forEach((pg) => pg.forEach((t) => { if (t.T >= to - BACKFILL_MS && t.T < to) out.push({ t: t.T, p: +t.p, usd: +t.p * +t.q, buy: !t.m }); }));
  log('[Algos] ' + symbol + ': ' + out.length + ' trades of history in ' + pages.length + ' pages');
  return out;
}

// ── Venues ──────────────────────────────────────────────────────────────────
// Each: one WS connection; coins come and go with subscribe / unsubscribe.
// A venue spec: id, url, key(symbol) → the venue's name for the coin (null =
// skip), sub(keys) / unsub(keys) → messages, parse(msg) → [{ key, t, p, usd, buy }],
// ping() → message to keep the link alive (or null), prepare(key) → Promise
// (contract sizes and the like, before subscribing).

function feed(spec, onTrade, log) {
  let ws = null, open = false, retry = 0, stopped = false, ping = null;
  const subs = new Map(); // venue key → symbol
  const send = (m) => { if (open && m) (Array.isArray(m) ? m : [m]).forEach((x) => ws.send(typeof x === 'string' ? x : JSON.stringify(x))); };
  function connect() {
    if (stopped) return;
    ws = new WebSocket(spec.url);
    ws.on('open', () => {
      open = true; retry = 0;
      if (subs.size) send(spec.sub([...subs.keys()]));
      clearInterval(ping);
      if (spec.ping) ping = setInterval(() => send(spec.ping()), spec.pingMs || 20000);
    });
    ws.on('message', (d) => {
      let rows;
      try { rows = spec.parse(d); } catch (e) { return; }
      (rows || []).forEach((r) => { const sym = subs.get(r.key); if (sym && r.usd > 0) onTrade(spec.id, sym, r.t, r.p, r.usd, r.buy); });
    });
    ws.on('close', () => { open = false; clearInterval(ping); if (!stopped) setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, retry++))); });
    ws.on('error', (e) => log('[Algos] ' + spec.id + ' WS: ' + e.message));
  }
  return {
    start() { stopped = false; connect(); },
    stop() { stopped = true; clearInterval(ping); if (ws) ws.close(); },
    async set(symbols) {
      const want = new Map();
      symbols.forEach((s) => { const k = spec.key(s); if (k) want.set(k, s); });
      const add = [...want.keys()].filter((k) => !subs.has(k));
      const del = [...subs.keys()].filter((k) => !want.has(k));
      for (const k of add) {
        try { if (spec.prepare) await spec.prepare(k); } catch (e) { log('[Algos] ' + spec.id + ' ' + k + ': ' + e.message); continue; }
        subs.set(k, want.get(k));
      }
      del.forEach((k) => subs.delete(k));
      const added = add.filter((k) => subs.has(k));
      if (added.length) send(spec.sub(added));
      if (del.length) send(spec.unsub(del));
    },
  };
}

const json = (d) => JSON.parse(typeof d === 'string' ? d : d.toString());
const base = (s) => baseOf(s);

// Binance futures / spot: aggTrade, m = the buyer was the maker (so the taker sold)
function binanceSpec(id, url, keyOf) {
  return {
    id, url, key: keyOf,
    sub: (keys) => ({ method: 'SUBSCRIBE', params: keys.map((k) => k.toLowerCase() + '@aggTrade'), id: Date.now() }),
    unsub: (keys) => ({ method: 'UNSUBSCRIBE', params: keys.map((k) => k.toLowerCase() + '@aggTrade'), id: Date.now() }),
    parse: (d) => { const m = json(d); return m.e === 'aggTrade' ? [{ key: m.s, t: m.T, p: +m.p, usd: +m.p * +m.q, buy: !m.m }] : []; },
  };
}

// Bybit linear / spot: publicTrade, S = the taker's side
function bybitSpec(id, category, keyOf) {
  return {
    id, url: 'wss://stream.bybit.com/v5/public/' + category, key: keyOf,
    // A topic of an unlisted coin fails the whole subscribe request: check first
    prepare: async (k) => {
      const r = await (await fetch('https://api.bybit.com/v5/market/instruments-info?category=' + category + '&symbol=' + k)).json();
      if (!r.result || !r.result.list || !r.result.list.some((x) => x.status === 'Trading')) throw new Error('not listed');
    },
    sub: (keys) => ({ op: 'subscribe', args: keys.map((k) => 'publicTrade.' + k) }),
    unsub: (keys) => ({ op: 'unsubscribe', args: keys.map((k) => 'publicTrade.' + k) }),
    ping: () => ({ op: 'ping' }),
    parse: (d) => {
      const m = json(d);
      if (!m.topic || !Array.isArray(m.data)) return [];
      return m.data.map((t) => ({ key: t.s, t: +t.T, p: +t.p, usd: +t.p * +t.v, buy: t.S === 'Buy' }));
    },
  };
}

// OKX swap / spot: trades; a swap's size is in contracts (× ctVal coins)
function okxSpec(id, instType, keyOf) {
  const ctVal = new Map();
  return {
    id, url: 'wss://ws.okx.com:8443/ws/v5/public', key: keyOf,
    prepare: async (k) => {
      if (ctVal.has(k)) return;
      const r = await (await fetch('https://www.okx.com/api/v5/public/instruments?instType=' + instType + '&instId=' + k)).json();
      if (!r.data || !r.data[0] || r.data[0].state !== 'live') throw new Error('not listed');
      ctVal.set(k, instType === 'SWAP' ? +r.data[0].ctVal : 1);
    },
    sub: (keys) => ({ op: 'subscribe', args: keys.map((k) => ({ channel: 'trades', instId: k })) }),
    unsub: (keys) => ({ op: 'unsubscribe', args: keys.map((k) => ({ channel: 'trades', instId: k })) }),
    ping: () => 'ping', pingMs: 25000,
    parse: (d) => {
      const s = d.toString();
      if (s === 'pong') return [];
      const m = JSON.parse(s);
      if (!m.arg || m.arg.channel !== 'trades' || !Array.isArray(m.data)) return [];
      return m.data.map((t) => ({ key: t.instId, t: +t.ts, p: +t.px, usd: +t.px * +t.sz * (ctVal.get(t.instId) || 1), buy: t.side === 'buy' }));
    },
  };
}

// Hyperliquid perps: trades, side B = the taker bought
function hyperliquidSpec(keyOf) {
  return {
    id: 'hlp', url: 'wss://api.hyperliquid.xyz/ws', key: keyOf,
    sub: (keys) => keys.map((k) => ({ method: 'subscribe', subscription: { type: 'trades', coin: k } })),
    unsub: (keys) => keys.map((k) => ({ method: 'unsubscribe', subscription: { type: 'trades', coin: k } })),
    ping: () => ({ method: 'ping' }), pingMs: 50000,
    parse: (d) => {
      const m = json(d);
      if (m.channel !== 'trades' || !Array.isArray(m.data)) return [];
      return m.data.map((t) => ({ key: t.coin, t: t.time, p: +t.px, usd: +t.px * +t.sz, buy: t.side === 'B' }));
    },
  };
}

// Upbit KRW spot: trade, ask_bid BID = the taker bought; KRW → USD by Upbit's KRW-USDT
function upbitSpec(keyOf) {
  let krwPerUsd = 0, rateTimer = null;
  const rate = () => fetch('https://api.upbit.com/v1/ticker?markets=KRW-USDT').then((r) => r.json()).then((j) => { if (j[0] && j[0].trade_price > 0) krwPerUsd = j[0].trade_price; }).catch(() => {});
  let all = [], markets = null;
  return {
    id: 'upb', url: 'wss://api.upbit.com/websocket/v1', key: keyOf,
    prepare: async (k) => {
      if (!markets) markets = new Set((await (await fetch('https://api.upbit.com/v1/market/all')).json()).map((m) => m.market));
      if (!markets.has(k)) throw new Error('not listed');
      if (!krwPerUsd) await rate();
      if (!rateTimer) { rateTimer = setInterval(rate, 60000); if (rateTimer.unref) rateTimer.unref(); }
    },
    // Upbit replaces the whole subscription with each request
    // One message, a JSON array: [ticket, type]
    sub: (keys) => { all = [...new Set(all.concat(keys))]; return JSON.stringify([{ ticket: 'qt-algos' }, { type: 'trade', codes: all }]); },
    unsub: (keys) => { all = all.filter((k) => keys.indexOf(k) < 0); return all.length ? JSON.stringify([{ ticket: 'qt-algos' }, { type: 'trade', codes: all }]) : null; },
    parse: (d) => {
      const m = json(d);
      if (m.type !== 'trade' || !(krwPerUsd > 0)) return [];
      const p = m.trade_price / krwPerUsd;
      return [{ key: m.code, t: m.trade_timestamp, p, usd: p * m.trade_volume, buy: m.ask_bid === 'BID' }];
    },
  };
}

const VENUE_SPECS = [
  binanceSpec('bnf', 'wss://fstream.binance.com/market/ws', (s) => s),
  binanceSpec('bns', 'wss://stream.binance.com:9443/ws', (s) => base(s) + 'USDT'),
  bybitSpec('byp', 'linear', (s) => s),
  bybitSpec('bys', 'spot', (s) => base(s) + 'USDT'),
  okxSpec('okp', 'SWAP', (s) => base(s) + '-USDT-SWAP'),
  okxSpec('oks', 'SPOT', (s) => base(s) + '-USDT'),
  hyperliquidSpec((s) => hlCoin(s)),
  upbitSpec((s) => 'KRW-' + base(s)),
];
const VENUES = VENUE_SPECS.map((v) => v.id);

// opts: symbols() → Promise<['SOLUSDT', …]> (what to watch now), log
function createCollector(opts) {
  const log = opts.log || (() => {});
  const tapes = new Map();   // 'bnf:SOLUSDT' → tape
  let symbols = [], timer = null;
  const backfilled = new Set();
  let backfillChain = Promise.resolve(); // one coin's history at a time (Binance weight)
  const tape = (venue, sym) => {
    const k = venue + ':' + sym;
    if (!tapes.has(k)) {
      const t = createTape();
      tapes.set(k, t);
      if (venue === 'bnf' && !backfilled.has(sym)) {
        backfilled.add(sym);
        const to = t.since();
        backfillChain = backfillChain
          .then(() => binanceHistory(sym, to, log))
          .then((trades) => { if (tapes.get(k) === t) t.addHistory(trades); })
          .catch((e) => log('[Algos] ' + sym + ' history: ' + e.message));
      }
    }
    return tapes.get(k);
  };
  const onTrade = (venue, sym, t, p, usd, buy) => { if (symbols.indexOf(sym) >= 0) tape(venue, sym).add(t, p, usd, buy); };
  const feeds = VENUE_SPECS.map((spec) => feed(spec, onTrade, log));

  async function refresh() {
    const now = Date.now();
    let next = [];
    try { next = (await opts.symbols()).slice().sort(); } catch (e) { log('[Algos] symbols: ' + e.message); return; }
    if (next.join() !== symbols.join()) {
      symbols = next;
      feeds.forEach((f) => f.set(symbols));
      log('[Algos] watching ' + (symbols.join(', ') || 'nothing'));
    }
    tapes.forEach((t, k) => { if (symbols.indexOf(k.split(':')[1]) < 0) { tapes.delete(k); backfilled.delete(k.split(':')[1]); } else t.prune(now); });
  }

  return {
    start() { feeds.forEach((f) => f.start()); refresh(); timer = setInterval(refresh, 60000); },
    stop() { clearInterval(timer); feeds.forEach((f) => f.stop()); },
    refresh,
    tapes(symbol) {
      const out = {};
      VENUES.forEach((v) => { const t = tapes.get(v + ':' + symbol); if (t) out[v] = t; });
      return out;
    },
    watching() { return symbols.slice(); },
  };
}

module.exports = { createCollector, createTape, hlCoin, VENUES };
