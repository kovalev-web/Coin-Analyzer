// "Is this trade big for here and now?" — thresholds that adapt to each coin
// and venue instead of a fixed number of dollars. Used by the frames on the
// other venues' books and by the trades tape (src/terminal.js).
// Tests: npm run test:hits

export var HIT_WINDOW_MS = 500;       // trades on one level within this add up to one hit
export var SIZE_HISTORY_MS = 180000;  // a venue's "usual" trade size: its last 3 minutes
export var FRAME_PERCENTILE = 90;     // a frame needs a hit bigger than 90% of the usual trades …
export var EAT_SHARE = 0.2;           // … or one that ate ≥ 20% of what was resting there
export var TAPE_PERCENTILE = 60;      // the tape hides prints smaller than 60% of the usual ones
export var MIN_SAMPLE = 20;           // fewer trades than this → no opinion yet

// Nearest-rank percentile of trade sizes; null until there's enough history
export function autoThreshold(sizes, p) {
  if (!sizes || sizes.length < MIN_SAMPLE) return null;
  var v = sizes.slice().sort(function (a, b) { return a - b; });
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p / 100 * v.length) - 1))];
}

// 0 = not worth a frame; 1 / 2 / 3 = how strong (≥ 1×, 2×, 4× the bar).
// hitUsd: traded on the level within HIT_WINDOW_MS; beforeUsd: what stood there
// when the first of those trades came. Eating counts only on a real level (at
// least the venue's usual big trade), so a small trade at a thin price is no frame.
export function hitStrength(hitUsd, threshold, beforeUsd) {
  if (!(hitUsd > 0)) return 0;
  var bySize = threshold > 0 ? hitUsd / threshold : 0;
  var before = Math.max(beforeUsd || 0, hitUsd);
  var byEat = threshold > 0 && before >= threshold ? (hitUsd / before) / EAT_SHARE : 0;
  var r = Math.max(bySize, byEat);
  return r >= 4 ? 3 : r >= 2 ? 2 : r >= 1 ? 1 : 0;
}
