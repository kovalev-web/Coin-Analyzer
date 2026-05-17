export const STABLE_SYMBOLS = new Set([
  'usdt','usdc','busd','dai','tusd','usdp','gusd','frax','lusd','usdd','pyusd',
]);

export const CACHE_TTL_MS = 2 * 60 * 1000;
export const ANALYZE_DELAY_MS = 400;

export const state = {
  coins: [],
  analysisCache: {},
  chartData: {},
  natrData: {},
  chartTF: {},
  lastUpdate: null,
  cacheExpires: 0,
  loading: false,
  error: null,
  minVolume: 100,
  minChange: 1,
  sortCol: 'price_change_percentage_24h',
  sortDir: 'desc',
  analyzingAll: false,
  analyzeAllAbort: false,
  marketStrength: null,
};

export function filteredCoins() {
  var minVol = (state.minVolume || 0) * 1e6, minChg = state.minChange || 0;
  var coins = state.coins.filter(function (c) {
    return !STABLE_SYMBOLS.has(c.symbol.toLowerCase()) &&
      (c.total_volume || 0) >= minVol &&
      (c.price_change_percentage_24h || 0) >= minChg;
  });
  coins = [].concat(coins).sort(function (a, b) {
    if (state.sortCol === 'symbol') {
      var sa = a.symbol.toUpperCase(), sb = b.symbol.toUpperCase();
      return state.sortDir === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
    }
    var va = a[state.sortCol], vb = b[state.sortCol];
    return state.sortDir === 'asc' ? (va || 0) - (vb || 0) : (vb || 0) - (va || 0);
  });
  return coins;
}
