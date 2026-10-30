'use strict';
// Trade tape of the watched coins, for the algorithm detector (algos/detect.js):
// Binance USDT-M futures (aggTrade) and Hyperliquid perps (trades), live by WS.
// Watched = the trader's coins in today's briefing + any coin opened on the
// chart (kept 6 h after the last look). Keeps 6 h: big prints (≥ detector's
// minUsd) and the venue's turnover in 10-second buckets (for "share of turnover").

const WebSocket = require('ws');
const { CFG } = require('./detect');

const KEEP_MS = 6 * 3600 * 1000;
const BUCKET_MS = 10000;
const MAX_PRINTS = 200000; // per venue + coin, a guard against a runaway coin

function baseOf(symbol) { return symbol.replace(/USDT$/, '').replace(/^1000000|^1000/, ''); }
function hlCoin(symbol) { return /^1000/.test(symbol) ? 'k' + baseOf(symbol) : baseOf(symbol); }

// One venue + coin: prints merged from trades, turnover buckets
function createTape() {
  const prints = [];
  const buckets = new Map(); // bucket start → USD
  let last = null, since = Date.now();
  return {
    add(t, p, usd, buy) {
      const b = Math.floor(t / BUCKET_MS) * BUCKET_MS;
      buckets.set(b, (buckets.get(b) || 0) + usd);
      if (last && last.buy === buy && t - last.t <= CFG.mergeMs) {
        last.pq += p * usd; last.usd += usd; last.p = last.pq / last.usd;
        if (!last.kept && last.usd >= CFG.minUsd) { last.kept = true; prints.push(last); }
        return;
      }
      last = { t, p, usd, buy, pq: p * usd, kept: usd >= CFG.minUsd };
      if (last.kept) prints.push(last);
      if (prints.length > MAX_PRINTS) prints.splice(0, prints.length - MAX_PRINTS);
    },
    prune(now) {
      let cut = 0;
      while (cut < prints.length && now - prints[cut].t > KEEP_MS) cut++;
      if (cut) prints.splice(0, cut);
      for (const b of buckets.keys()) if (now - b > KEEP_MS) buckets.delete(b);
      if (now - since > KEEP_MS) since = now - KEEP_MS;
    },
    prints() { return prints.map((x) => ({ t: x.t, p: x.p, usd: x.usd, buy: x.buy })); },
    turnover(from, to) {
      let s = 0;
      for (const [b, v] of buckets) if (b + BUCKET_MS > from && b <= to) s += v;
      return s;
    },
    since() { return since; },
  };
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
  const tape = (venue, sym) => {
    const k = venue + ':' + sym;
    if (!tapes.has(k)) tapes.set(k, createTape());
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
    tapes.forEach((t, k) => { if (symbols.indexOf(k.split(':')[1]) < 0) tapes.delete(k); else t.prune(now); });
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
