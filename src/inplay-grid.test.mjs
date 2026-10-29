import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectGrid, beats, pinCoin, unpinCell, EXIT_HOLD_MS, MIN_HOLD_MS } from './inplay-grid.js';

const empty = (n) => Array(n).fill(null);
const syms = (slots) => slots.map((s) => (s ? s.sym : null));

test('empty cells fill with coins at ENTER and above, strongest first; not ok or weak ones stay out', () => {
  const coins = { A: { score: 1.5, ok: true }, B: { score: 3, ok: true }, C: { score: 0.9, ok: true }, D: { score: 5, ok: false } };
  assert.deepEqual(syms(selectGrid(empty(3), coins, 0)), ['B', 'A', null]);
});

test('a coin under EXIT leaves only after EXIT_HOLD_MS below and MIN_HOLD_MS in the grid', () => {
  let g = selectGrid(empty(1), { A: { score: 2, ok: true } }, 0);
  const cold = { A: { score: 0.3, ok: true } };
  g = selectGrid(g, cold, MIN_HOLD_MS - 30000);        // starts cooling
  assert.deepEqual(syms(g), ['A']);
  g = selectGrid(g, cold, MIN_HOLD_MS + 20000);        // 50 s below — still there
  assert.deepEqual(syms(g), ['A']);
  g = selectGrid(g, cold, MIN_HOLD_MS + 30000);        // 60 s below — gone
  assert.deepEqual(syms(g), [null]);
});

test('climbing back over EXIT resets the cooling', () => {
  let g = selectGrid(empty(1), { A: { score: 2, ok: true } }, 0);
  g = selectGrid(g, { A: { score: 0.3, ok: true } }, MIN_HOLD_MS);
  g = selectGrid(g, { A: { score: 0.8, ok: true } }, MIN_HOLD_MS + 40000);
  assert.equal(g[0].below, null);
  g = selectGrid(g, { A: { score: 0.3, ok: true } }, MIN_HOLD_MS + EXIT_HOLD_MS);
  assert.deepEqual(syms(g), ['A']);
});

test('a missing coin counts as cold', () => {
  let g = selectGrid(empty(1), { A: { score: 2, ok: true } }, 0);
  g = selectGrid(g, {}, MIN_HOLD_MS);
  g = selectGrid(g, {}, MIN_HOLD_MS + EXIT_HOLD_MS);
  assert.deepEqual(syms(g), [null]);
});

test('a full grid: a newcomer replaces the weakest held coin only when 25% stronger, in its cell', () => {
  let g = selectGrid(empty(2), { A: { score: 2, ok: true }, B: { score: 3, ok: true } }, 0);
  let coins = { A: { score: 2, ok: true }, B: { score: 3, ok: true }, C: { score: 2.4, ok: true } };
  assert.deepEqual(syms(g), ['B', 'A']);
  assert.deepEqual(syms(selectGrid(g, coins, MIN_HOLD_MS)), ['B', 'A']);   // 20% stronger — not enough
  coins = { ...coins, C: { score: 2.5, ok: true } };
  assert.deepEqual(syms(selectGrid(g, coins, MIN_HOLD_MS - 1)), ['B', 'A']); // A is too fresh
  assert.deepEqual(syms(selectGrid(g, coins, MIN_HOLD_MS)), ['B', 'C']);
});

test('beats: margin over a positive score, ENTER over a non-positive one', () => {
  assert.equal(beats(2.5, 2), true);
  assert.equal(beats(2.4, 2), false);
  assert.equal(beats(1, -0.5), true);
  assert.equal(beats(0.9, -Infinity), false);
});

test('pinned cells never leave or get replaced; pin goes to an empty, then the weakest cell', () => {
  const coins = { A: { score: 2, ok: true }, B: { score: 3, ok: true }, X: { score: -1, ok: false } };
  let g = pinCoin(empty(2), 'X', coins, 0);
  assert.deepEqual(syms(g), ['X', null]);
  g = selectGrid(g, coins, 0);
  assert.deepEqual(syms(g), ['X', 'B']);
  g = selectGrid(g, coins, MIN_HOLD_MS + EXIT_HOLD_MS);
  assert.deepEqual(syms(g), ['X', 'B']);
  g = pinCoin(g, 'A', coins, 10);
  assert.deepEqual(syms(g), ['X', 'A']); // only B was unpinned
  assert.deepEqual(syms(pinCoin(g, 'B', coins, 20)), ['X', 'A']); // all pinned
  g = unpinCell(g, 0, 100);
  assert.equal(g[0].pinned, false);
  assert.equal(g[0].since, 100);
});
