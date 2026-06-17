export const STABLE_SYMBOLS = new Set([
  'usdt','usdc','busd','dai','tusd','usdp','gusd','frax','lusd','usdd','pyusd',
]);

// Major coins excluded from the altcoin screener
export const SCREENER_EXCLUDE = new Set(['btc','eth','bnb']);

export const CACHE_TTL_MS = 2 * 60 * 1000;
export const ANALYZE_DELAY_MS = 400;

export const state = {
  coins: [],
  analysisCache: {},
  chartData: {},
  natrData: {},
  chartTF: {},
  globalTF: '5m',
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
  dailyOpen: {},       // symbol → D1 open price (UTC midnight) — для корректного суточного %
  briefing: [],        // [{sym, date, addedAt, status, note}]
  briefingViewDate: null, // currently viewed date in panel (null = today)
  trades: {},          // 'sym:date' → {status:'ok'|'loading'|'error', pnl, count, entries[]}
  weekSummary: null,   // агрегат за неделю {pnl, tradeCount, winRate, conversion, ...}
  aiSummary: null,     // текст от Gemini
  aiSummaryTradedKeys: null, // 'sym:date' traded-записей на момент генерации
  aiSummaryDate: null,      // ISO timestamp последней генерации
  aiSummaryTradeCount: null, // tradeCount из weekSummary на момент генерации
  briefingTab: 'coins', // активный таб дровера: 'coins' | 'week' | 'ai'
  journalToday: null,  // { date, morningAt, morningState, ... } | null
  journalEntries: null, // cached /api/journal/recent result for instant render
  notifications: [],
  notifUnread: 0,
  inplayTop: [],   // [{symbol, inplay, A, M, P, dp5m, rvol5m}] — from server inplay_top WS push
};

export function filteredCoins() {
  var tier = state.volTier || 'high';
  // low-тир: 12M–50M — показывает небольшие альткоины включая новые листинги
  // mid-тир: 50M–100M — средние монеты
  // high-тир: 100M+ — крупные монеты
  var minVol = tier === 'high' ? 100e6 : tier === 'mid' ? 50e6 : 12e6;
  var maxVol = tier === 'high' ? Infinity : tier === 'mid' ? 100e6 : 50e6;
  var minChg = state.minChange || 0;
  var coins = state.coins.filter(function (c) {
    var sym = c.symbol.toLowerCase();
    var vol = c.total_volume || 0;
    return !STABLE_SYMBOLS.has(sym) &&
      !SCREENER_EXCLUDE.has(sym) &&
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
