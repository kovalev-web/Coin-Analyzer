// Which coins sit in the cells of the "in play" grid (/grid). The scores come
// from the server (inplay/metrics.js); here they only decide who takes a cell
// and who leaves it, so the grid doesn't jump: a coin enters at ENTER, leaves
// after staying under EXIT for EXIT_HOLD_MS, keeps its cell at least
// MIN_HOLD_MS, and a newcomer replaces the weakest coin only when clearly
// stronger. Cells never swap places. A pinned cell is the user's.
// Tests: npm run test:inplay

export var ENTER = 1.0;          // ≈ volume, trades and range twice the coin's norm
export var EXIT = 0.6;
export var EXIT_HOLD_MS = 60000;
export var MIN_HOLD_MS = 180000;
export var MARGIN = 0.25;        // a newcomer needs a score 25% above the weakest coin's

// slots: [{ sym, since, below, pinned } | null]; coins: { sym: { score, ok } }
export function selectGrid(slots, coins, now) {
  var out = slots.map(function (s) { return s ? Object.assign({}, s) : null; });
  var scoreOf = function (sym) { var c = coins[sym]; return c && c.score != null ? c.score : -Infinity; };

  // Coins that have cooled down long enough leave
  out.forEach(function (s, i) {
    if (!s || s.pinned) return;
    if (scoreOf(s.sym) >= EXIT) { s.below = null; return; }
    if (s.below == null) s.below = now;
    if (now - s.below >= EXIT_HOLD_MS && now - s.since >= MIN_HOLD_MS) out[i] = null;
  });

  var taken = {};
  out.forEach(function (s) { if (s) taken[s.sym] = true; });
  var newcomers = Object.keys(coins)
    .filter(function (sym) { return !taken[sym] && coins[sym].ok && coins[sym].score >= ENTER; })
    .sort(function (a, b) { return coins[b].score - coins[a].score; });

  newcomers.forEach(function (sym) {
    var free = out.indexOf(null);
    if (free >= 0) { out[free] = { sym: sym, since: now, below: null, pinned: false }; return; }
    var weakest = -1;
    out.forEach(function (s, i) {
      if (s.pinned || now - s.since < MIN_HOLD_MS) return;
      if (weakest < 0 || scoreOf(s.sym) < scoreOf(out[weakest].sym)) weakest = i;
    });
    if (weakest < 0) return;
    if (beats(coins[sym].score, scoreOf(out[weakest].sym))) out[weakest] = { sym: sym, since: now, below: null, pinned: false };
  });
  return out;
}

// Clearly stronger: MARGIN above a positive score, anything at ENTER above a non-positive one
export function beats(score, weakest) {
  if (!(weakest > 0)) return score >= ENTER;
  return score >= weakest * (1 + MARGIN);
}

// The user puts a coin into a cell by hand: the weakest unpinned one (an
// empty one first); it stays until unpinned. Already on the grid → just pinned.
export function pinCoin(slots, sym, coins, now) {
  var out = slots.slice();
  var at = out.findIndex(function (s) { return s && s.sym === sym; });
  if (at < 0) at = out.indexOf(null);
  if (at < 0) {
    var score = function (s) { var c = coins[s.sym]; return c && c.score != null ? c.score : -Infinity; };
    out.forEach(function (s, i) { if (!s.pinned && (at < 0 || score(s) < score(out[at]))) at = i; });
  }
  if (at < 0) return out; // every cell is pinned
  out[at] = { sym: sym, since: now, below: null, pinned: true };
  return out;
}

// Unpinned coins go back under the usual rules, with a fresh minimum hold
export function unpinCell(slots, i, now) {
  var out = slots.slice();
  if (out[i]) out[i] = Object.assign({}, out[i], { pinned: false, since: now, below: null });
  return out;
}
