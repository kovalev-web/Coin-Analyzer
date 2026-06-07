'use strict';
/**
 * GET /api/kdata — Grid Screener backend
 * Implements TZ-screener-model.md (adapted for Vercel serverless, not Next.js App Router)
 *
 * §2  Config       → SCREENER_CONFIG
 * §4.1 Universe    → getUniverse()
 * §4.2 Snapshot    → getSnapshot() with SWR-style in-memory cache
 * §4.3 Delta       → computeDelta()
 * §4.5 Indicators  → calcNATR(), calcRVOL()  (pure, returned via klines; client recalculates)
 * §5   Cursor      → encodeCursor(), decodeCursor(), sliceFromCursor()
 * §4.4 Route       → handler (thin slicer, no direct Binance calls beyond snapshot)
 */

// ── §2 Config ────────────────────────────────────────────────────────────────

const CFG = {
  interval:        '5m',
  sortMode:        'abs',      // 'abs' | 'signed'  (abs = любое движение, signed = растущие сверху)
  deltaSource:     'live',     // 'live' = текущая формирующаяся свеча | 'closed' = предыдущая
  deltaFormula:    'body',     // 'body' = (close-open)/open*100 | 'prevClose' = (close-prevClose)/prevClose*100
  atrPeriod:       14,
  rvolPeriod:      20,
  klinesDepth:     50,
  pageSize:        20,
  universeQuote:   'USDT',
  universeStatus:  'TRADING',
  universeLimit:   100,        // топ-N по 24h quoteVolume; 0 = без лимита
  snapshotTtlMs:   8000,       // 8 секунд — чуть меньше client poll (10s) → всегда свежие данные
  universeTtlMs:   10 * 60 * 1000, // 10 минут
  concurrency:     15,         // параллельных klines-запросов к Binance
};

const FAPI = 'https://fapi.binance.com';

const EXCLUDE_BASE = new Set([
  'btc', 'eth', 'bnb',
  'usdt', 'usdc', 'busd', 'dai', 'tusd', 'usdp', 'gusd',
  'frax', 'lusd', 'usdd', 'pyusd', 'fdusd',
]);

const VALID_INTERVALS = new Set(['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d']);

// ── §4.3 Delta ───────────────────────────────────────────────────────────────

/**
 * computeDelta(klines, opts) → number
 * Pure function. klines = raw Binance array [[openTime,open,high,low,close,vol,closeTime],...]
 */
function computeDelta(klines, opts) {
  const { deltaSource, deltaFormula } = opts || CFG;
  if (!klines || klines.length < 2) return 0;

  const k    = deltaSource === 'live' ? klines[klines.length - 1] : klines[klines.length - 2];
  const prev = deltaSource === 'live' ? klines[klines.length - 2] : klines[klines.length - 3];

  if (deltaFormula === 'body') {
    const o = +k[1], c = +k[4];
    return o > 0 ? (c - o) / o * 100 : 0;
  }
  // prevClose
  if (!prev) return 0;
  const c = +k[4], pc = +prev[4];
  return pc > 0 ? (c - pc) / pc * 100 : 0;
}

// ── §4.5 Indicators ──────────────────────────────────────────────────────────

/**
 * calcNATR(klines, period) → %
 * Wilder ATR(period) / last_close * 100
 * Pure, тестируемая.
 */
function calcNATR(klines, period) {
  period = period || CFG.atrPeriod;
  if (!klines || klines.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = +klines[i][2], l = +klines[i][3], pc = +klines[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return 0;
  let atr = trs.slice(0, period).reduce((a, v) => a + v, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  const lc = +klines[klines.length - 1][4];
  return lc > 0 ? atr / lc * 100 : 0;
}

/**
 * calcRVOL(klines, period) → ratio
 * last candle volume / mean(last period CLOSED candles volume)
 * Note: live candle volume is incomplete → compare against closed candles only.
 */
function calcRVOL(klines, period) {
  period = period || CFG.rvolPeriod;
  if (!klines || klines.length < period + 2) return 0;
  const last   = +klines[klines.length - 1][5];
  const closed = klines.slice(-period - 1, -1); // последние period закрытых
  if (!closed.length) return 0;
  const avg = closed.reduce((s, k) => s + +k[5], 0) / closed.length;
  return avg > 0 ? last / avg : 0;
}

// ── §5 Cursor ────────────────────────────────────────────────────────────────

function encodeCursor(sortKeyValue, symbol) {
  // Форматируем число с фиксированной точностью для стабильного round-trip
  return encodeURIComponent(Number(sortKeyValue).toFixed(8) + '|' + symbol);
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const s   = decodeURIComponent(cursor);
    const idx = s.lastIndexOf('|');
    if (idx === -1) return null;
    const value = parseFloat(s.slice(0, idx));
    const symbol = s.slice(idx + 1);
    if (!isFinite(value) || !symbol) return null;
    return { value, symbol };
  } catch { return null; }
}

/**
 * sliceFromCursor(sorted, cursor, pageSize) → entry[]
 * sorted — массив с полем sortKey (число) и symbol (строка)
 * Курсор указывает на ПОСЛЕДНИЙ элемент предыдущей страницы.
 */
function sliceFromCursor(sorted, cursor, pageSize) {
  if (!cursor) return sorted.slice(0, pageSize);
  const c = decodeCursor(cursor);
  if (!c) return sorted.slice(0, pageSize);

  let start = sorted.length; // если не нашли — пустая страница
  for (let i = 0; i < sorted.length; i++) {
    // Тай-брейк: value должно совпасть с точностью 1e-6, symbol — точно
    if (Math.abs(sorted[i].sortKey - c.value) < 1e-6 && sorted[i].symbol === c.symbol) {
      start = i + 1;
      break;
    }
  }
  return sorted.slice(start, start + pageSize);
}

// ── §4.1 Universe ─────────────────────────────────────────────────────────────

let _uCache = null;
let _uAt    = 0;

async function getUniverse() {
  const now = Date.now();
  if (_uCache && (now - _uAt) < CFG.universeTtlMs) return _uCache;

  // Список perpetual USDT-M futures в статусе TRADING
  const infoResp = await fetch(`${FAPI}/fapi/v1/exchangeInfo`);
  if (!infoResp.ok) throw new Error('exchangeInfo ' + infoResp.status);
  const info = await infoResp.json();

  let symbols = info.symbols
    .filter(s =>
      s.quoteAsset === CFG.universeQuote &&
      s.status     === CFG.universeStatus &&
      s.contractType === 'PERPETUAL'
    )
    .map(s => s.symbol)
    .filter(sym => !EXCLUDE_BASE.has(sym.slice(0, -CFG.universeQuote.length).toLowerCase()));

  // Ограничение вселенной топ-N по 24h quoteVolume (один запрос на все символы)
  if (CFG.universeLimit > 0) {
    const tResp = await fetch(`${FAPI}/fapi/v1/ticker/24hr`);
    if (!tResp.ok) throw new Error('ticker/24hr ' + tResp.status);
    const tickers = await tResp.json();
    const volMap = {};
    tickers.forEach(t => { volMap[t.symbol] = parseFloat(t.quoteVolume) || 0; });
    symbols = symbols
      .sort((a, b) => (volMap[b] || 0) - (volMap[a] || 0))
      .slice(0, CFG.universeLimit);
  }

  _uCache = symbols;
  _uAt    = now;
  return symbols;
}

// ── §4.2 Snapshot ─────────────────────────────────────────────────────────────

let _snapshot = null; // { asOf, sorted: [{symbol,delta,natr,rvol,sortKey,klines}] }

/**
 * batchFetch — klines для всех символов, не более CFG.concurrency параллельных запросов
 */
async function batchFetch(symbols, interval, limit) {
  const results = {};
  for (let i = 0; i < symbols.length; i += CFG.concurrency) {
    const chunk = symbols.slice(i, i + CFG.concurrency);
    await Promise.all(chunk.map(async sym => {
      try {
        const r = await fetch(`${FAPI}/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
        if (r.ok) results[sym] = await r.json();
      } catch { /* skip one failed symbol */ }
    }));
  }
  return results;
}

async function buildSnapshot(universe, sortMode, interval) {
  const klinesMap = await batchFetch(universe, interval, CFG.klinesDepth);

  const entries = universe
    .filter(sym => {
      const k = klinesMap[sym];
      return k && k.length >= CFG.atrPeriod + 2;
    })
    .map(sym => {
      const klines  = klinesMap[sym];
      const delta   = computeDelta(klines);
      const natr    = calcNATR(klines);
      const rvol    = calcRVOL(klines);
      const sortKey = sortMode === 'signed' ? delta : Math.abs(delta);
      return { symbol: sym, delta, natr, rvol, sortKey, klines };
    });

  // Сортировка по sortKey desc, тай-брейк — symbol asc (обязателен для корректного курсора)
  entries.sort((a, b) => {
    const d = b.sortKey - a.sortKey;
    return d !== 0 ? d : a.symbol.localeCompare(b.symbol);
  });

  return { asOf: Date.now(), sorted: entries };
}

/**
 * getSnapshot — синхронный rebuild при stale, с дедупликацией промиса.
 *
 * Все параллельные запросы (например, двойной клик «обновить») ждут ОДИН и тот же промис.
 * При ошибке rebuild — возвращаем предыдущий снапшот, не падаем с 502.
 */
let _buildPromise = null;

async function getSnapshot(sortMode, interval) {
  const stale = !_snapshot || (Date.now() - _snapshot.asOf) >= CFG.snapshotTtlMs;

  if (stale) {
    if (!_buildPromise) {
      _buildPromise = getUniverse()
        .then(u => buildSnapshot(u, sortMode, interval))
        .then(snap => { _snapshot = snap; return snap; })
        .catch(err => {
          console.error('[kdata] snapshot build failed:', err.message);
          if (_snapshot) return _snapshot; // вернуть stale если есть
          throw err;                        // пробросить только при cold-start
        })
        .finally(() => { _buildPromise = null; });
    }
    return _buildPromise; // все параллельные запросы ждут один и тот же промис
  }

  return _snapshot;
}

// ── §4.4 Handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(200).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const {
    interval = CFG.interval,
    pageSize = String(CFG.pageSize),
    cursor   = '',
    sortMode = CFG.sortMode,
    order    = 'desc',
  } = req.query;

  // Валидация §4.4
  if (!VALID_INTERVALS.has(interval)) {
    return res.status(400).json({ error: 'Invalid interval. Allowed: ' + [...VALID_INTERVALS].join(', ') });
  }
  if (cursor && !decodeCursor(cursor)) {
    return res.status(400).json({ error: 'Invalid cursor format. Expected <value>|<symbol>' });
  }
  if (!['abs','signed'].includes(sortMode)) {
    return res.status(400).json({ error: 'sortMode must be abs or signed' });
  }

  const pageSizeN = Math.min(Math.max(parseInt(pageSize) || CFG.pageSize, 1), 50);

  let snapshot;
  try {
    snapshot = await getSnapshot(sortMode, interval);
  } catch (e) {
    return res.status(502).json({ error: 'Market data unavailable', detail: e.message });
  }

  // order=asc разворачивает (для падающих при sortMode=signed)
  const sorted = order === 'asc'
    ? [...snapshot.sorted].reverse()
    : snapshot.sorted;

  const page = sliceFromCursor(sorted, cursor, pageSizeN);
  if (!page.length && cursor) {
    return res.status(400).json({ error: 'Cursor out of range' });
  }

  // Формируем ответ §3 — klines обрезаем до [openTime,o,h,l,c,vol,closeTime]
  const klines  = {};
  const deltas  = {};
  const orderArr = [];

  page.forEach(entry => {
    klines[entry.symbol]  = entry.klines.map(k => [k[0], k[1], k[2], k[3], k[4], k[5], k[6]]);
    deltas[entry.symbol]  = entry.delta;
    orderArr.push(entry.symbol);
  });

  const last      = page[page.length - 1];
  const lastIdx   = last ? sorted.indexOf(last) : -1;
  const hasMore   = lastIdx !== -1 && lastIdx < sorted.length - 1;
  const nextCursor = hasMore ? encodeCursor(last.sortKey, last.symbol) : null;

  return res.status(200).json({
    klines,
    deltas,
    order:      orderArr,
    nextCursor,
    hasMore,
    asOf:       snapshot.asOf,
  });
};
