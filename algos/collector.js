'use strict';
// Trade tape of the watched coins, for the algorithm detector (algos/detect.js):
// Binance USDT-M futures (aggTrade) and Hyperliquid perps (trades), live by WS.
// Watched = the trader's coins in today's briefing + any coin opened on the
// chart (kept 6 h after the last look). Keeps 6 h: big prints (≥ detector's
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

// Binance: one /market connection, coins added and removed with SUBSCRIBE / UNSUBSCRIBE
function binanceFeed(onTrade, log) {
  let ws = null, open = false, retry = 0, stopped = false, id = 1;
  const subs = new Set();
  const send = (method, syms) => { if (open && syms.length) ws.send(JSON.stringify({ method, params: syms.map((s) => s.toLowerCase() + '@aggTrade'), id: id++ })); };
  function connect() {
    if (stopped) return;
    ws = new WebSocket('wss://fstream.binance.com/market/ws');
    ws.on('open', () => { open = true; retry = 0; send('SUBSCRIBE', [...subs]); });
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.e === 'aggTrade') onTrade(m.s, m.T, +m.p, +m.p * +m.q, !m.m);
    });
    ws.on('close', () => { open = false; if (!stopped) setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, retry++))); });
    ws.on('error', (e) => log('[Algos] Binance WS: ' + e.message));
  }
  return {
    start() { stopped = false; connect(); },
    stop() { stopped = true; if (ws) ws.close(); },
    set(symbols) {
      const add = symbols.filter((s) => !subs.has(s)), del = [...subs].filter((s) => symbols.indexOf(s) < 0);
      add.forEach((s) => subs.add(s)); del.forEach((s) => subs.delete(s));
      send('SUBSCRIBE', add); send('UNSUBSCRIBE', del);
    },
  };
}

// Hyperliquid: trades per coin; side B = the taker bought
function hyperliquidFeed(onTrade, log) {
  let ws = null, open = false, retry = 0, stopped = false, ping = null;
  const subs = new Map(); // coin → symbol
  const send = (method, coin) => { if (open) ws.send(JSON.stringify({ method, subscription: { type: 'trades', coin } })); };
  function connect() {
    if (stopped) return;
    ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
    ws.on('open', () => {
      open = true; retry = 0;
      subs.forEach((sym, coin) => send('subscribe', coin));
      clearInterval(ping);
      ping = setInterval(() => { if (open) ws.send(JSON.stringify({ method: 'ping' })); }, 50000);
    });
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m.channel !== 'trades' || !Array.isArray(m.data)) return;
      m.data.forEach((t) => { const sym = subs.get(t.coin); if (sym) onTrade(sym, t.time, +t.px, +t.px * +t.sz, t.side === 'B'); });
    });
    ws.on('close', () => { open = false; clearInterval(ping); if (!stopped) setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, retry++))); });
    ws.on('error', (e) => log('[Algos] Hyperliquid WS: ' + e.message));
  }
  return {
    start() { stopped = false; connect(); },
    stop() { stopped = true; clearInterval(ping); if (ws) ws.close(); },
    set(symbols) {
      const want = new Map(symbols.map((s) => [hlCoin(s), s]));
      want.forEach((sym, coin) => { if (!subs.has(coin)) { subs.set(coin, sym); send('subscribe', coin); } });
      [...subs.keys()].forEach((coin) => { if (!want.has(coin)) { subs.delete(coin); send('unsubscribe', coin); } });
    },
  };
}

// opts: briefingSymbols() → Promise<['SOLUSDT', …]>, log
function createCollector(opts) {
  const log = opts.log || (() => {});
  const tapes = new Map();   // 'bnf:SOLUSDT' → tape
  const viewed = new Map();  // symbol → last look (ms)
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
  const bn = binanceFeed((s, t, p, usd, buy) => { if (symbols.indexOf(s) >= 0) tape('bnf', s).add(t, p, usd, buy); }, log);
  const hl = hyperliquidFeed((s, t, p, usd, buy) => tape('hlp', s).add(t, p, usd, buy), log);

  async function refresh() {
    const now = Date.now();
    let brief = [];
    try { brief = await opts.briefingSymbols(); } catch (e) { log('[Algos] briefing: ' + e.message); }
    viewed.forEach((at, s) => { if (now - at > KEEP_MS) viewed.delete(s); });
    const next = [...new Set(brief.concat([...viewed.keys()]))].sort();
    if (next.join() !== symbols.join()) {
      symbols = next;
      bn.set(symbols); hl.set(symbols);
      log('[Algos] watching ' + (symbols.join(', ') || 'nothing'));
    }
    tapes.forEach((t, k) => { if (symbols.indexOf(k.split(':')[1]) < 0) { tapes.delete(k); backfilled.delete(k.split(':')[1]); } else t.prune(now); });
  }

  return {
    start() { bn.start(); hl.start(); refresh(); timer = setInterval(refresh, 60000); },
    stop() { clearInterval(timer); bn.stop(); hl.stop(); },
    // A look at the coin on the chart: start collecting it (if not yet)
    look(symbol) {
      const fresh = !viewed.has(symbol) && symbols.indexOf(symbol) < 0;
      viewed.set(symbol, Date.now());
      if (fresh) refresh();
    },
    tapes(symbol) {
      const out = {};
      ['bnf', 'hlp'].forEach((v) => { const t = tapes.get(v + ':' + symbol); if (t) out[v] = t; });
      return out;
    },
    watching() { return symbols.slice(); },
  };
}

module.exports = { createCollector, createTape, hlCoin };
