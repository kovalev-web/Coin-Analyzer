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

// Amounts typed in the settings: "2M", "500k", "1.5m", "2 000 000", "2,5М" → USD.
// Empty / zero / unreadable → 0 (= automatic / off).
export function parseUsd(text) {
  var s = String(text == null ? '' : text).trim().toLowerCase().replace(/\s+/g, '').replace(',', '.');
  var m = /^(\d+(?:\.\d+)?)([kкmм]?)$/.exec(s);
  if (!m) return 0;
  var n = Number(m[1]) * ({ k: 1e3, 'к': 1e3, m: 1e6, 'м': 1e6 }[m[2]] || 1);
  return n > 0 ? n : 0;
}

// 2000000 → "2M", 500000 → "500K", 1500 → "1.5K", 800 → "800"
export function formatUsdShort(n) {
  if (!(n > 0)) return '';
  function trim(x) { return String(Number(x.toFixed(2))); }
  if (n >= 1e6) return trim(n / 1e6) + 'M';
  if (n >= 1e3) return trim(n / 1e3) + 'K';
  return trim(n);
}

// Auto mode colors only densities: levels that stand out from the typical one.
// A level is colored when it's ≥ DENSITY_K × the median visible level (and
// above the % threshold of the full bar). A flat book (all levels alike) stays
// grey — nothing there is a density.
export var DENSITY_K = 3;

export function colorThreshold(medianUsd, fullUsd, highlightPct, k) {
  var byPct = fullUsd > 0 ? fullUsd * (highlightPct || 65) / 100 : 0;
  var byDensity = medianUsd > 0 ? medianUsd * (k || DENSITY_K) : 0;
  return Math.max(byPct, byDensity);
}

// Auto mode bar length: log scale from a floor (a quarter of the typical level)
// to the biggest level on screen, so 14K and 615K are clearly different bars
// while small levels still differ. 0.02 … 1.
export function barRatio(usd, typicalUsd, maxUsd) {
  if (!(usd > 0)) return 0;
  var floor = Math.max((typicalUsd || 0) / 4, 1);
  var hi = Math.max(maxUsd || 0, floor * 1.0001);
  if (usd <= floor) return 0.02;
  return Math.max(0.02, Math.min(1, Math.log(usd / floor) / Math.log(hi / floor)));
}

// The biggest level on screen: jumps up at once (a new wall shows full), eases
// down slowly (so a wall that's eaten doesn't make every bar jump)
export function trackMax(prev, target, dtMs, tauMs) {
  if (target == null) return prev;
  if (prev == null || target >= prev) return target;
  return smoothScale(prev, target, dtMs, tauMs);
}
