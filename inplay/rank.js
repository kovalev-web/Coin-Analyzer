'use strict';
// "In play" screener (/grid): which coins one viewer sees and in what order.
// The viewer picks a window (5m…3h), a sort and how many cells; pinned coins
// come first. Sorts: move = range of the window, vol / trades = against the
// 24 h norm (all by the window); gvol / gtrades = growth 15m against 3h, ext =
// closest to the day's high or low (these don't depend on the window).
// The order is refreshed every HOLD_MS (or at once when the choice changes),
// in between the same coins stay in the same cells and only their numbers move.
// Tests: npm run test:inplay

const { CFG } = require('./metrics');

const SORTS = ['move', 'vol', 'trades', 'gvol', 'gtrades', 'ext'];
const HOLD_MS = 15000;
const MAX_CELLS = 12;

// Bigger = higher on the grid
function sortValue(row, win, sort) {
  if (sort === 'gvol') return row.gv;
  if (sort === 'gtrades') return row.gt;
  if (sort === 'ext') return row.ext ? -row.ext.pct : null;
  const w = row.w[win];
  if (!w) return null;
  return sort === 'move' ? w.range : sort === 'vol' ? w.vol : w.trades;
}

// Coins by the chosen window and sort, strongest first (only liquid ones)
function rankCoins(rows, win, sort) {
  return rows
    .filter((r) => r.ok && sortValue(r, win, sort) != null)
    .sort((a, b) => sortValue(b, win, sort) - sortValue(a, win, sort))
    .map((r) => r.s);
}

// A viewer's choice, cleaned up; null when it makes no sense
function parseView(msg) {
  if (!msg || !CFG.windows[msg.win] || SORTS.indexOf(msg.sort) < 0) return null;
  const n = Math.min(MAX_CELLS, Math.max(1, Math.round(+msg.n) || 0));
  const pins = Array.isArray(msg.pins)
    ? msg.pins.filter((p) => typeof p === 'string' && /^[A-Z0-9]{1,30}USDT$/.test(p)).slice(0, n)
    : [];
  return { win: msg.win, sort: msg.sort, n, pins };
}

// view: { win, sort, n, pins, shown: [sym], at: ms, key }; returns the next one.
// Pins take the first cells, the rest go to the top coins.
function nextShown(view, rows, now) {
  const key = [view.win, view.sort, view.n, view.pins.join(',')].join('|');
  if (view.key === key && now - view.at < HOLD_MS && view.shown.length) return view;
  const pinned = new Set(view.pins);
  const top = rankCoins(rows, view.win, view.sort).filter((s) => !pinned.has(s));
  const shown = view.pins.concat(top).slice(0, view.n);
  return Object.assign({}, view, { shown, at: now, key });
}

module.exports = { SORTS, HOLD_MS, MAX_CELLS, sortValue, rankCoins, parseView, nextShown };
