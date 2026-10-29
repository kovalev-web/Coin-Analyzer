// Connections of the /grid page. Our server: the ranked coins ('inplay',
// every 2 s, inplay/feed.js). Binance: 1-minute candles of the coins in the
// cells, straight from the browser (history over REST, then kline_1m).
import * as React from 'react';

const WS_URL = import.meta.env.VITE_WS_URL || '';
export const API_BASE = WS_URL.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws$/, '');

// ── Ranked coins from our server ────────────────────────────────────────────

const S = { status: 'connecting', data: null, subs: new Set(), sock: null };
function set(patch) { Object.assign(S, patch); S.snap = { status: S.status, data: S.data }; S.subs.forEach((f) => f()); }
S.snap = { status: S.status, data: S.data };

function connect() {
  const sock = S.sock = new WebSocket(WS_URL);
  sock.onopen = () => { set({ status: 'live' }); sock.send(JSON.stringify({ type: 'subscribe_inplay' })); };
  sock.onmessage = (ev) => {
    if (!ev.data.startsWith('{"type":"inplay"')) return; // the rest is for the main page
    try { set({ data: JSON.parse(ev.data) }); } catch (e) {}
  };
  sock.onclose = () => { set({ status: 'offline' }); setTimeout(connect, 2000); };
}

export function useInplay() {
  React.useEffect(() => { if (!S.sock) connect(); }, []);
  return React.useSyncExternalStore((f) => { S.subs.add(f); return () => S.subs.delete(f); }, () => S.snap);
}

// ── Binance candles for the cells ───────────────────────────────────────────

const BINANCE_WS = 'wss://fstream.binance.com/market/ws';
const K = { sock: null, open: false, handlers: new Map(), id: 1 };

function kSend(method, sym) {
  if (K.open) K.sock.send(JSON.stringify({ method, params: [sym.toLowerCase() + '@kline_1m'], id: K.id++ }));
}

function kConnect() {
  const sock = K.sock = new WebSocket(BINANCE_WS);
  sock.onopen = () => { K.open = true; K.handlers.forEach((_, sym) => kSend('SUBSCRIBE', sym)); };
  sock.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.e !== 'kline' || !m.k) return;
    const fns = K.handlers.get(m.k.s);
    if (fns) fns.forEach((f) => f(m.k));
  };
  sock.onclose = () => { K.open = false; if (K.handlers.size) setTimeout(kConnect, 2000); else K.sock = null; };
}

// Live 1-minute candles of a coin; returns the unsubscribe
export function watchKlines(sym, fn) {
  let fns = K.handlers.get(sym);
  if (!fns) { fns = new Set(); K.handlers.set(sym, fns); kSend('SUBSCRIBE', sym); }
  fns.add(fn);
  if (!K.sock) kConnect();
  return () => {
    fns.delete(fn);
    if (!fns.size) { K.handlers.delete(sym); kSend('UNSUBSCRIBE', sym); }
  };
}

export async function fetchKlines(sym, limit) {
  const r = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + sym + '&interval=1m&limit=' + limit);
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
