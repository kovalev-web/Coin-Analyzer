// Formulas behind the venue strip in the order book (src/venues.js).
// Tests: npm run test:venues

export var WINDOW_MS = 30000;      // strip numbers: last 30 s
export var SPIKE_MS = 5000;        // a burst is measured over 5 s …
export var BASELINE_MS = 120000;   // … against the 2-minute average rate
export var SPIKE_RATIO = 3;        // burst = rate ≥ 3× the usual
export var SPIKE_MIN_USD = 5000;   // and at least this much traded in those 5 s

// trades: [{ t, usd, buy }] (any order). Totals for [now − windowMs, now].
export function windowTotals(trades, now, windowMs) {
  var from = now - windowMs, buy = 0, sell = 0;
  for (var i = 0; i < trades.length; i++) {
    var x = trades[i];
    if (x.t < from || x.t > now) continue;
    if (x.buy) buy += x.usd; else sell += x.usd;
  }
  var vol = buy + sell;
  return { vol: vol, buy: buy, sell: sell, delta: buy - sell, buyShare: vol ? buy / vol : null };
}

// Is this venue trading much faster than usual right now? Compares the last
// SPIKE_MS with the average rate of the BASELINE_MS before it.
export function isSpike(trades, now) {
  var recent = windowTotals(trades, now, SPIKE_MS).vol;
  if (recent < SPIKE_MIN_USD) return false;
  var before = windowTotals(trades, now - SPIKE_MS, BASELINE_MS).vol;
  var usualRate = before / BASELINE_MS, rate = recent / SPIKE_MS;
  return !usualRate || rate >= SPIKE_RATIO * usualRate;
}

// Price on this venue → price on the Binance futures ladder. Coins listed in
// thousands there (1000PEPEUSDT) trade per single coin on spot / OKX.
export function ladderPrice(price, multiplier) {
  return Number(price) * (multiplier || 1);
}

// 'BTCUSDT' → { coin: 'BTC', mult: 1 }; '1000PEPEUSDT' → { coin: 'PEPE', mult: 1000 }
export function splitSymbol(futuresSymbol) {
  var base = String(futuresSymbol).replace(/USDT$/, '');
  var m = /^(1000000|1000)(.+)$/.exec(base);
  return m ? { coin: m[2], mult: Number(m[1]) } : { coin: base, mult: 1 };
}
