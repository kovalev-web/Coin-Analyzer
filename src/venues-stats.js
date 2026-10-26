// Symbol and price mapping for other venues (src/venues.js, src/venue-books.js).
// Tests: npm run test:venues

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
