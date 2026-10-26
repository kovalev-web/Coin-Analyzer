// ── Connection quality for the order book terminal ──────────────────────────
// Measured on the paths trading actually uses:
//   ping   — you → our server → you, over the same WebSocket orders go through
//   binance— our server → Binance REST (measured on the server, sent with each pong)
//   book   — how old Binance order book events are when they reach you
//            (event time vs your clock corrected by the server's NTP clock)
//   order  — click → exchange accepted the order (full path, from real orders)
// Pings run every 2 s only while the terminal is open.

import { wsPing, wsReconnects } from './api.js';
import { percentile, jitter, clockOffset, edgeCity, countryName } from './latency-stats.js';

export { grade } from './latency-stats.js';

var PING_EVERY_MS = 2000;
var PING_TIMEOUT_MS = 3000;
var KEEP = 60;          // ~2 minutes of pings
var KEEP_BOOK = 100;

var L = {
  timer: null, listeners: [],
  rtt: [],              // ms, successful pings
  lost: [],             // 1 = timeout / socket down, 0 = ok, same window as rtt
  offset: null,         // server clock − local clock, ms (from the fastest recent ping)
  offsetRtt: Infinity,
  binance: null,
  book: [],
  order: null,          // { ms, at }
  reconnectsAtStart: 0,
  last: null,           // { ok, rtt, at }
};

// ── Measuring ────────────────────────────────────────────────────────────────

function _push(arr, v, max) { arr.push(v); if (arr.length > max) arr.shift(); }

function _tick() {
  wsPing(PING_TIMEOUT_MS).then(function (r) {
    _push(L.rtt, r.rtt, KEEP);
    _push(L.lost, 0, KEEP);
    // The fastest round trip gives the tightest clock estimate; refresh it now and then
    if (r.rtt <= L.offsetRtt * 1.2 || L.offset == null) {
      L.offset = clockOffset(r.sent, r.rtt, r.serverTime);
      L.offsetRtt = r.rtt;
    }
    L.offsetRtt *= 1.01; // let an old "best" age out
    L.binance = r.binanceMs;
    L.edge = r.edge || null;
    L.country = r.country || null;
    L.last = { ok: true, rtt: r.rtt, at: Date.now() };
  }).catch(function () {
    _push(L.lost, 1, KEEP);
    L.last = { ok: false, rtt: null, at: Date.now() };
  }).then(_emit);
}

function _emit() {
  var s = stats();
  L.listeners.forEach(function (fn) { fn(s); });
}

export function startLatency(onUpdate) {
  if (onUpdate && L.listeners.indexOf(onUpdate) === -1) L.listeners.push(onUpdate);
  if (L.timer) return;
  L.reconnectsAtStart = wsReconnects;
  _tick();
  L.timer = setInterval(_tick, PING_EVERY_MS);
}

export function stopLatency() {
  clearInterval(L.timer);
  L.timer = null;
  L.listeners = [];
  L.rtt = []; L.lost = []; L.book = [];
}

// Called by the terminal for each order book event (Binance event time, ms)
export function noteBookEvent(eventTime) {
  if (L.offset == null || !eventTime) return;
  var age = Date.now() + L.offset - eventTime;
  if (age > -1000 && age < 60000) _push(L.book, age, KEEP_BOOK);
}

// Called by the terminal when the exchange accepted an order: ms since the click
export function noteOrder(ms) {
  L.order = { ms: ms, at: Date.now() };
}

export function stats() {
  var lostN = L.lost.reduce(function (a, b) { return a + b; }, 0);
  return {
    down: !!(L.last && !L.last.ok && L.lost.slice(-2).every(function (x) { return x === 1; })),
    last: L.last && L.last.ok ? L.last.rtt : null,
    p50: percentile(L.rtt, 50),
    p95: percentile(L.rtt, 95),
    jitter: jitter(L.rtt.slice(-20)),
    loss: L.lost.length ? lostN / L.lost.length : 0,
    samples: L.rtt.length,
    binance: L.binance,
    book: percentile(L.book, 50),
    bookP95: percentile(L.book, 95),
    order: L.order,
    reconnects: wsReconnects - L.reconnectsAtStart,
    edge: L.edge,                     // Cloudflare edge code, e.g. 'NRT'
    edgeCity: edgeCity(L.edge),
    country: countryName(L.country),  // where your traffic exits (VPN / provider)
  };
}
