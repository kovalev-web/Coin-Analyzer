// Connections of the /grid page. Our server: the coins for this viewer's
// choice ('inplay' every 3 s — window, sort, cells, pins; inplay/rank.js).
// Binance: candles of the coins in the cells, straight from the browser
// (history over REST, then kline_<interval>).
import * as React from 'react';

const WS_URL = import.meta.env.VITE_WS_URL || '';
export const API_BASE = WS_URL.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws$/, '');

// ── Ranked coins from our server ────────────────────────────────────────────

const S = { status: 'connecting', data: null, syms: [], view: null, subs: new Set(), sock: null };
function set(patch) { Object.assign(S, patch); S.snap = { status: S.status, data: S.data, syms: S.syms }; S.subs.forEach((f) => f()); }
S.snap = { status: S.status, data: S.data, syms: S.syms };

function subscribe() {
  if (S.sock && S.sock.readyState === WebSocket.OPEN && S.view) S.sock.send(JSON.stringify({ type: 'subscribe_inplay', ...S.view }));
}

function connect() {
  const sock = S.sock = new WebSocket(WS_URL);
  sock.onopen = () => { set({ status: 'live' }); subscribe(); };
  sock.onmessage = (ev) => {
    if (!ev.data.startsWith('{"type":"inplay"')) return; // the rest is for the main page
    try {
      const d = JSON.parse(ev.data);
      set(d.syms ? { data: d, syms: d.syms } : { data: d });
    } catch (e) {}
  };
  sock.onclose = () => { set({ status: 'offline' }); setTimeout(connect, 2000); };
}

// view: { win, sort, n, pins } — sent again whenever it changes
export function useInplay(view) {
  const key = JSON.stringify(view);
  React.useEffect(() => { S.view = view; if (!S.sock) connect(); else subscribe(); }, [key]);
  return React.useSyncExternalStore((f) => { S.subs.add(f); return () => S.subs.delete(f); }, () => S.snap);
}

// ── Binance candles for the cells ───────────────────────────────────────────

const BINANCE_WS = 'wss://fstream.binance.com/market/ws';
const K = { sock: null, open: false, handlers: new Map(), id: 1 };

// Handlers by stream: 'solusdt@kline_5m'
const stream = (sym, tf) => sym.toLowerCase() + '@kline_' + tf;

function kSend(method, name) {
  if (K.open) K.sock.send(JSON.stringify({ method, params: [name], id: K.id++ }));
}

function kConnect() {
  const sock = K.sock = new WebSocket(BINANCE_WS);
  sock.onopen = () => { K.open = true; K.handlers.forEach((_, name) => kSend('SUBSCRIBE', name)); };
  sock.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.e !== 'kline' || !m.k) return;
    const fns = K.handlers.get(stream(m.k.s, m.k.i));
    if (fns) fns.forEach((f) => f(m.k));
  };
  sock.onclose = () => { K.open = false; if (K.handlers.size) setTimeout(kConnect, 2000); else K.sock = null; };
}

// Live candles of a coin on a timeframe (1m, 5m, 15m); returns the unsubscribe
export function watchKlines(sym, tf, fn) {
  const name = stream(sym, tf);
  let fns = K.handlers.get(name);
  if (!fns) { fns = new Set(); K.handlers.set(name, fns); kSend('SUBSCRIBE', name); }
  fns.add(fn);
  if (!K.sock) kConnect();
  return () => {
    fns.delete(fn);
    if (!fns.size) { K.handlers.delete(name); kSend('UNSUBSCRIBE', name); }
  };
}

export async function fetchKlines(sym, tf, limit) {
  const r = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + sym + '&interval=' + tf + '&limit=' + limit);
  if (!r.ok) throw new Error('klines ' + r.status);
  return r.json();
}

// Only signed-in users; the others go to the login page
export async function checkAuth() {
  if (!API_BASE) return;
  try {
    const r = await fetch(API_BASE + '/auth/get-session', { credentials: 'include' });
    const s = r.ok ? await r.json() : null;
    if (!s || !s.user || !s.user.id) throw new Error();
  } catch (e) {
    window.location.replace('/login');
    await new Promise(() => {});
  }
}
