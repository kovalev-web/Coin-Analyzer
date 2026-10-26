// Automatic full scale for the ladder volume bars (src/terminal.js).
// The bar is full at a "typical big" level, not at the single biggest one:
// the AUTO_PERCENTILE of the visible levels' USDT, smoothed over time so the
// colors don't flicker. Tests: npm run test:ladder

export var AUTO_PERCENTILE = 90;
export var AUTO_TAU_MS = 10000; // smoothing time constant: ~63% of a change after 10 s

// Nearest-rank percentile of the non-zero values; null when there are none
export function levelPercentile(values, p) {
  var v = values.filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p / 100 * v.length) - 1))];
}

// Exponential smoothing that doesn't depend on how often the ladder renders
export function smoothScale(prev, target, dtMs, tauMs) {
  if (target == null) return prev;
  if (prev == null || !(dtMs >= 0)) return target;
  var a = 1 - Math.exp(-dtMs / (tauMs || AUTO_TAU_MS));
  return prev + (target - prev) * a;
}
