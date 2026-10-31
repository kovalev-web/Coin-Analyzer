'use strict';
// "In play" feed for /grid (server-vps.js): 1-minute bars of every Binance
// USDT-M perpetual — 3 h of history over REST, then the kline_1m streams —
// the 24 h norm of each coin (ticker/24hr, every minute), and every TICK_MS
// the windows 5m…3h of every coin (inplay/metrics.js). Runs all the time, so
// the page has data the moment it opens.

const WebSocket = require('ws');
const { CFG, coinWindows, dayNorm } = require('./metrics');

const REST = 'https://fapi.binance.com';
const WS_URL = 'wss://fstream.binance.com/market/ws'; // kline belongs to the /market endpoint
const TICK_MS = 3000;
const KEEP_BARS = CFG.keepBars;
const NORM_MS = 60000;                // 24 h tickers (weight 40)
const STREAMS_PER_SOCKET = 800;       // Binance: ≤ 1024 streams per connection
const REST_GAP_MS = 80;               // ~12 history requests a second (weight 2 each)
const UNIVERSE_TTL_MS = 30 * 60000;   // new listings join within half an hour

function toBar(k) {
  return { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], q: +k[7], n: +k[8], closed: true };
}

function createInplayFeed(opts) {
  const fetchJson = opts.fetchJson;
  const log = opts.log || function () {};
  const F = {
    running: false, syms: [], bars: new Map(), live: new Map(), norms: new Map(), rows: [],
    socks: [], queue: [], queued: new Set(), pumping: false, timers: [],
  };

  async function loadUniverse() {
    const info = await fetchJson(REST + '/fapi/v1/exchangeInfo');
    return info.symbols
      .filter((s) => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING')
      .map((s) => s.symbol);
  }

  // History over REST, one coin at a time (start, a new listing, a gap after a reconnect)
  function refill(sym) {
    if (F.queued.has(sym)) return;
    F.queued.add(sym);
    F.queue.push(sym);
    pump();
  }
  async function pump() {
    if (F.pumping) return;
    F.pumping = true;
    while (F.running && F.queue.length) {
      const sym = F.queue.shift();
      F.queued.delete(sym);
      try {
        const rows = await fetchJson(REST + '/fapi/v1/klines?symbol=' + sym + '&interval=1m&limit=' + KEEP_BARS);
        const now = Date.now();
        const closed = rows.filter((k) => +k[6] < now).map(toBar);
        F.bars.set(sym, closed);
      } catch (e) {
        log('[Inplay] history ' + sym + ': ' + e.message);
      }
      await new Promise((r) => setTimeout(r, REST_GAP_MS));
    }
    F.pumping = false;
  }

  function onKline(k) {
    const sym = k.s;
    const bar = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, q: +k.q, n: +k.n, closed: !!k.x };
    if (!bar.closed) { F.live.set(sym, bar); return; }
    F.live.delete(sym);
    const bars = F.bars.get(sym);
    if (!bars) return; // history not loaded yet — it will bring this minute too
    const last = bars[bars.length - 1];
    if (last && bar.t <= last.t) return;
    if (last && bar.t > last.t + 60000) { refill(sym); return; } // missed minutes
    bars.push(bar);
    if (bars.length > KEEP_BARS) bars.splice(0, bars.length - KEEP_BARS);
  }

  function connect(streams) {
    let sock = null, closedByUs = false;
    const entry = { close: function () { closedByUs = true; if (sock) sock.terminate(); } };
    function open() {
      if (!F.running || closedByUs) return;
      sock = new WebSocket(WS_URL);
      sock.on('open', function () {
        // ≤ 200 params per SUBSCRIBE, ≤ 10 messages a second
        for (let i = 0; i < streams.length; i += 200) {
          const params = streams.slice(i, i + 200);
          setTimeout(function () {
            if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: Date.now() + i }));
          }, (i / 200) * 250);
        }
      });
      sock.on('message', function (raw) {
        let m;
        try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        if (m.e === 'kline' && m.k) onKline(m.k);
      });
      sock.on('close', function () { if (F.running && !closedByUs) setTimeout(open, 2000); });
      sock.on('error', function (e) { log('[Inplay] ws: ' + e.message); });
    }
    open();
    return entry;
  }

  function subscribeAll() {
    F.socks.forEach((s) => s.close());
    F.socks = [];
    const streams = F.syms.map((s) => s.toLowerCase() + '@kline_1m');
    for (let i = 0; i < streams.length; i += STREAMS_PER_SOCKET) F.socks.push(connect(streams.slice(i, i + STREAMS_PER_SOCKET)));
  }

  async function refreshUniverse() {
    try {
      const syms = await loadUniverse();
      const known = new Set(F.syms);
      const changed = syms.length !== F.syms.length || syms.some((s) => !known.has(s));
      F.syms = syms;
      const keep = new Set(syms);
      for (const s of Array.from(F.bars.keys())) if (!keep.has(s)) { F.bars.delete(s); F.live.delete(s); }
      syms.forEach((s) => { if (!F.bars.has(s)) refill(s); });
      if (changed) subscribeAll();
    } catch (e) {
      log('[Inplay] universe: ' + e.message);
    }
  }

  async function refreshNorms() {
    try {
      const rows = await fetchJson(REST + '/fapi/v1/ticker/24hr');
      rows.forEach((t) => F.norms.set(t.symbol, dayNorm(t)));
    } catch (e) {
      log('[Inplay] norms: ' + e.message);
    }
  }

  function tick() {
    const now = Date.now();
    const rows = [];
    for (const sym of F.syms) {
      const bars = F.bars.get(sym);
      if (!bars) continue;
      const live = F.live.get(sym);
      const all = live && (!bars.length || live.t > bars[bars.length - 1].t) ? bars.concat([live]) : bars;
      const c = coinWindows(all, now, F.norms.get(sym));
      rows.push({ s: sym, ok: c.ok, w: c.w });
    }
    F.rows = rows;
    opts.onUpdate({ t: now, ready: rows.length, total: F.syms.length });
  }

  return {
    start: async function () {
      if (F.running) return;
      F.running = true;
      log('[Inplay] start');
      await Promise.all([refreshNorms(), refreshUniverse()]);
      F.timers.push(setInterval(tick, TICK_MS), setInterval(refreshNorms, NORM_MS), setInterval(refreshUniverse, UNIVERSE_TTL_MS));
    },
    stop: function () {
      if (!F.running) return;
      F.running = false;
      log('[Inplay] stop');
      F.timers.forEach(clearInterval);
      F.timers = [];
      F.socks.forEach((s) => s.close());
      F.socks = [];
      F.syms = []; F.bars.clear(); F.live.clear(); F.norms.clear(); F.rows = [];
      F.queue = []; F.queued.clear();
    },
    get running() { return F.running; },
    get rows() { return F.rows; },   // [{ s, ok, w: { '5m': {chg, range, usd, vol, trades} | null, … } }]
    get syms() { return F.syms; },
  };
}

module.exports = { createInplayFeed };
