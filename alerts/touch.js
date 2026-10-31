'use strict';
// Price alerts fire when the price touches the level — a wick counts, as in
// trading terminals. Fed by the 1-minute candle stream of each coin with
// alerts (server-vps.js): every event carries the forming candle's high and
// low, so a spike between two events is still seen. The 24h ticker (a
// last-price snapshot every second or two) feeds the same check as a backup.
// Tests: npm run test:alerts

// The price range traded since the previous event of the coin's candle stream.
// state: { t, h, l, c } of the last event (null — the first one: nothing known
// before it, so nothing is touched yet). k: { t, h, l, c } — candle open time,
// high, low, last price. Returns { range: [lo, hi] | null, state }.
function candleTouch(state, k) {
  var next = { t: k.t, h: k.h, l: k.l, c: k.c };
  if (!state) return { range: null, state: next };
  var lo, hi;
  if (k.t !== state.t) {
    // A new candle: all of it is after the previous event, plus the move from the last close
    lo = Math.min(state.c, k.l);
    hi = Math.max(state.c, k.h);
  } else {
    // The same candle: a new high or low was traded since; otherwise the move between the two last prices
    lo = k.l < state.l ? k.l : Math.min(state.c, k.c);
    hi = k.h > state.h ? k.h : Math.max(state.c, k.c);
  }
  return { range: [lo, hi], state: next };
}

// Two last-price snapshots (the ticker): the range between them
function snapshotRange(prev, cur) {
  if (prev == null || cur == null) return null;
  return [Math.min(prev, cur), Math.max(prev, cur)];
}

// Did the traded range reach the level (touching it exactly counts)
function touches(range, price) {
  return !!range && range[0] <= price && price <= range[1];
}

module.exports = { candleTouch, snapshotRange, touches };
