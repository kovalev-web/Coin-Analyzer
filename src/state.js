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
  volTier: 'high',
  minChange: 1,
  sortCol: 'price_change_percentage_24h',
  sortDir: 'desc',
  analyzingAll: false,
  analyzeAllAbort: false,
  marketStrength: null,
  briefing: [],        // [{sym, date, addedAt, status, note}]
  briefingViewDate: null, // currently viewed date in panel (null = today)
};

export function filteredCoins() {
  var tier = state.volTier || 'high';
  var minVol = tier === 'high' ? 100e6 : tier === 'mid' ? 50e6 : 12e6;
  var maxVol = tier === 'high' ? Infinity : tier === 'mid' ? 100e6 : 50e6;
  var minChg = state.minChange || 0;
  var coins = state.coins.filter(function (c) {
    var vol = c.total_volume || 0;
    return !STABLE_SYMBOLS.has(c.symbol.toLowerCase()) &&
      vol >= minVol &&
      (tier === 'high' || vol < maxVol) &&
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
