const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// Load .env from project root if it exists (never committed to git)
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(function (line) {
    var m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (e) {}
const { analyzeCoin } = require('./shared/analyze');
const { getWatchlist, bootstrapBuffers, pushCandle, fillAllGaps } = require('./inplay/buffers');
const { updateAllScores } = require('./inplay/score');
const { updatePhases, defaultGetMicro, isInPhase } = require('./inplay/phase-detector');
const { initTradeState, processTrade, getTradeState } = require('./inplay/trade-buffers');
const { initOrderbookState, processDepthUpdate, updateEmaOBI, obi, getOrderbookMetrics } = require('./inplay/orderbook');
const inplayCfg = require('./inplay/config.json');
const { ensureAuthTables } = require('./db/setup');
const { getAuth } = require('./auth');
const { toNodeHandler } = require('better-auth/node');

// Create DB tables and init auth at startup
ensureAuthTables();

var INPLAY_BETA_ENABLED = process.env.INPLAY_BETA_ENABLED === 'true';

// File logger — only active when INPLAY_BETA_ENABLED
var _inplayLog = INPLAY_BETA_ENABLED
  ? fs.createWriteStream('./inplay.log', { flags: 'a' })
  : null;

function logInplay() {
  var args = Array.prototype.slice.call(arguments);
  var line = new Date().toISOString() + ' ' + args.join(' ') + '\n';
  if (_inplayLog) _inplayLog.write(line);
  console.log.apply(console, args);
}

// Returns CVD micro for a symbol, but signals cvd_skip=true during warmup window
// so the phase detector bypasses CVD alignment for freshly-added coins whose
// aggTrade history is too short to produce a reliable z-score.
function getMicro(sym) {
  var warmupMs = (inplayCfg.phase_detector.cvd_warmup_minutes || 60) * 60 * 1000;
  var joinTime = _joinTimes[sym];
  if (joinTime && (Date.now() - joinTime) < warmupMs) {
    return { cvd_z: null, cvd_skip: true };
  }
  return defaultGetMicro(sym);
}

var PORT = process.env.WSS_PORT || 3001;
var BINANCE_REST = 'https://fapi.binance.com';
var BINANCE_WS_URL = 'wss://fstream.binance.com/ws';
var BINANCE_KLINE_WS_URL     = 'wss://fstream.binance.com/market/ws'; // kline belongs to /market endpoint
var BINANCE_AGGTRADE_WS_URL = 'wss://fstream.binance.com/market/ws'; // aggTrade also on /market

// ── Redis (Upstash) helper ────────────────────────────────────────────────

var REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
var REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('Redis not configured');
  var res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return res.json();
}

// ── Telegram ─────────────────────────────────────────────────────────────

var TELEGRAM_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
var INPLAY_ALERT_CHAT_ID = process.env.INPLAY_ALERT_CHAT_ID || null; // beta-only phase alerts
var BRIEFING_USER_CODE  = (process.env.BRIEFING_USER_CODE || process.env.PROXY_SECRET || '').toLowerCase();
var APP_URL = (process.env.APP_URL || 'https://coin-analyzer.vercel.app').replace(/\/$/, '');
var _userUtcOffset = null; // loaded from Redis briefing_tz:{code} at startup, updated on save
var tgOffset = 0;

async function sendTG(chatId, text, replyMarkup) {
  if (!TELEGRAM_TOKEN || !chatId) return;
  var body = { chat_id: chatId, text: text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  var delays = [0, 3000, 10000];
  for (var i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(function (r) { setTimeout(r, delays[i]); });
    try {
      var r = await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) return;
      var errText = await r.text();
      if (r.status === 429) {
        var retryAfter = JSON.parse(errText).parameters && JSON.parse(errText).parameters.retry_after;
        if (retryAfter) await new Promise(function (r) { setTimeout(r, retryAfter * 1000); });
      }
      console.error('[TG] sendMessage failed:', r.status, errText);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) return; // non-retriable
    } catch (e) {
      console.error('[TG] sendMessage error (attempt ' + (i + 1) + '):', e.message);
    }
  }
}

async function pollTelegram() {
  if (!TELEGRAM_TOKEN) return;
  try {
    var r = await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getUpdates?offset=' + tgOffset + '&timeout=0&limit=10');
    var d = await r.json();
    if (!d.ok || !d.result) return;
    d.result.forEach(function (upd) {
      tgOffset = upd.update_id + 1;
      var msg = upd.message;
      if (msg && msg.text && msg.text.startsWith('/start')) {
        sendTG(msg.chat.id, 'Ваш Telegram chat_id:\n<code>' + msg.chat.id + '</code>\n\nВведите его в Pump Analyzer → кнопка ⚙️ → поле «Telegram chat_id».');
      } else if (msg && msg.text && msg.text.startsWith('/test')) {
        sendTG(msg.chat.id, '🚨 Inplay Phase\n<b>BTC</b> — 🟢 LONG ↑\nRVOL: 9.2x | Δp15m: +10.50% | CVD_z: 1.83\n24h Vol: $48.2B\n\n<i>Test alert — доставка работает ✓</i>');
      } else if (msg && msg.text && msg.text.startsWith('/briefing')) {
        sendWeeklyBriefingReport(msg.chat.id).catch(function (e) {
          sendTG(msg.chat.id, '❌ Ошибка: ' + e.message);
        });
      }
    });
  } catch (e) {}
}

setInterval(pollTelegram, 3000);

// ── Alerts ────────────────────────────────────────────────────────────────

var alertsMemory = {}; // code → {chatId, data: {sym: [{price, triggered}]}}
var prevPrices = {};   // sym (lowercase, no USDT) → last price

// Merge incoming alert data with existing, preserving triggered=true.
// Once an alert is triggered on the server it can never be un-triggered by a client save.
function mergeAlertData(existing, incoming) {
  var normData = {};
  Object.keys(incoming).forEach(function (s) {
    var symLc = s.toLowerCase();
    var existingSym = existing[symLc] || [];
    normData[symLc] = (incoming[s] || []).map(function (newA) {
      var prev = null;
      for (var i = 0; i < existingSym.length; i++) {
        var e = existingSym[i];
        var tol = Math.max(Math.abs(e.price) * 1e-6, 1e-9);
        if (Math.abs(e.price - newA.price) <= tol) { prev = e; break; }
      }
      return {
        id: newA.id,
        price: newA.price,
        triggered: newA.triggered || (prev ? prev.triggered : false),
        createdAt: newA.createdAt,
      };
    });
  });
  return normData;
}

async function saveAlertsToRedis(code) {
  try {
    await redis(['SET', 'alerts:' + code, JSON.stringify(alertsMemory[code])]);
    await redis(['SADD', 'alert_codes', code]);
  } catch (e) {}
}

async function loadAlertsOnStartup() {
  try {
    var r = await redis(['SMEMBERS', 'alert_codes']);
    var codes = r.result || [];
    for (var i = 0; i < codes.length; i++) {
      var code = codes[i];
      var ar = await redis(['GET', 'alerts:' + code]);
      if (ar.result) alertsMemory[code] = JSON.parse(ar.result);
    }
    console.log('[Alerts] Loaded', codes.length, 'codes from Redis');
  } catch (e) {
    console.error('[Alerts] Load failed:', e.message);
  }
}

// Reload alerts from Redis every 30 seconds to pick up changes saved via Vercel
setInterval(loadAlertsOnStartup, 30000);

// Called on every price update (ticker or kline close) — no polling delay
function checkAlertsForSym(fullSym, cur) {
  var sym = fullSym.replace(/USDT$/, '').toLowerCase();
  var prev = prevPrices[sym];
  prevPrices[sym] = cur;
  if (prev == null) return;
  var now = Date.now();
  var codes = Object.keys(alertsMemory);
  codes.forEach(function (code) {
    var entry = alertsMemory[code];
    if (!entry || !entry.data || !entry.data[sym]) return;
    var dirty = false;
    (entry.data[sym] || []).forEach(function (a) {
      if (a.triggered) return;
      // Grace period: ignore alerts set less than 5 seconds ago to prevent immediate firing
      if (a.createdAt && (now - a.createdAt) < 5000) return;
      var crossed = (prev < a.price && cur >= a.price) || (prev > a.price && cur <= a.price);
      if (!crossed) return;
      a.triggered = true;
      dirty = true;
      var fmtPrice = parseFloat(parseFloat(a.price).toPrecision(6));
      console.log('[Alert] ' + sym.toUpperCase() + ' crossed ' + fmtPrice + ' | chatId=' + (entry.chatId || 'EMPTY'));
      var alertMarkup = APP_URL ? { inline_keyboard: [[{ text: '📈 Открыть график', url: APP_URL + '/?sym=' + sym.toUpperCase() }]] } : undefined;
      sendTG(entry.chatId, '🕷️Price Alert!\n' + sym.toUpperCase() + ' — <code>' + fmtPrice + '</code>', alertMarkup);
      var payload = JSON.stringify({ type: 'alert_triggered', code: code, sym: sym, price: a.price });
      clients.forEach(function (c) { if (c.readyState === WebSocket.OPEN) c.send(payload); });
    });
    if (dirty) saveAlertsToRedis(code);
  });
}

var clients = new Set();
var tickerCache = {}; // symbol → { s, c, o, h, l, v, q }
var d1OpenCache = {}; // symbol (BTCUSDT) → '65000.00' — open цена текущего UTC-дня (1d kline)
var inplaySymbols     = []; // symbols passing pre-filter, populated after bootstrapTicker
var _joinTimes        = {}; // sym → ms when added to watchlist (for CVD warmup)
var _bootstrapPending = new Set(); // syms currently being bootstrapped (throttle guard)
var _klineFirstConnect = true; // gap-fill only on reconnect, not initial connect
var knownFuturesSyms = null; // Set<string> — all USDT symbols known at startup, for listing detection

// ── REST helper ──────────────────────────────────────────────────────────

async function fetchBinance(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ── Bootstrap: один REST-запрос при старте для мгновенного первого экрана

async function bootstrapTicker() {
  console.log('[Bootstrap] Fetching initial ticker via REST...');
  try {
    var data = await fetchBinance(BINANCE_REST + '/fapi/v1/ticker/24hr');
    data.forEach(function (t) {
      if (t.symbol.endsWith('USDT')) {
        tickerCache[t.symbol] = {
          s: t.symbol,
          c: t.lastPrice,
          o: t.openPrice,
          h: t.highPrice,
          l: t.lowPrice,
          v: t.volume,
          q: t.quoteVolume,
          P: t.priceChangePercent,
        };
        // Seed prevPrices so the first WS tick can detect alert crossings after restart
        var symLower = t.symbol.replace(/USDT$/, '').toLowerCase();
        prevPrices[symLower] = parseFloat(t.lastPrice);
      }
    });
    console.log('[Bootstrap] Loaded', Object.keys(tickerCache).length, 'tickers');
    pushTicker();
  } catch (e) {
    console.error('[Bootstrap] Failed:', e.message);
  }
}

// ── D1 Opens: суточный open (UTC-полночь) для всех символов ─────────────
// Батч-загрузка: 10 запросов параллельно, 500мс пауза между батчами.
// 600 монет / 10 = 60 батчей × 500мс ≈ 30с. Запускается один раз при старте,
// повторно — в полночь UTC для нового дня.

async function bootstrapD1Opens() {
  var symbols = Object.keys(tickerCache).filter(function(s) { return s.endsWith('USDT'); });
  if (!symbols.length) { console.log('[D1Opens] No symbols yet, skip'); return; }
  console.log('[D1Opens] Bootstrapping', symbols.length, 'symbols...');
  var loaded = 0;
  for (var i = 0; i < symbols.length; i += 10) {
    var batch = symbols.slice(i, i + 10);
    await Promise.all(batch.map(async function(sym) {
      try {
        var data = await fetchBinance(BINANCE_REST + '/fapi/v1/klines?symbol=' + sym + '&interval=1d&limit=1');
        if (Array.isArray(data) && data.length && data[0][1]) {
          d1OpenCache[sym] = data[0][1]; // строка — формат Binance
          loaded++;
        }
      } catch(e) {}
    }));
    if (i + 10 < symbols.length) await new Promise(function(r) { setTimeout(r, 500); });
  }
  console.log('[D1Opens] Loaded', loaded, '/', symbols.length);
  pushD1Opens();
}

function pushD1Opens() {
  if (!Object.keys(d1OpenCache).length) return;
  var msg = JSON.stringify({ type: 'd1opens', data: d1OpenCache });
  clients.forEach(function(c) { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// Сброс кэша в полночь UTC — fetchAllNATR на клиенте и re-bootstrap дадут свежие значения
var _d1Day = new Date().toISOString().slice(0, 10);
setInterval(function() {
  var today = new Date().toISOString().slice(0, 10);
  if (today !== _d1Day) {
    _d1Day = today;
    d1OpenCache = {};
    console.log('[D1Opens] New UTC day — re-bootstrapping...');
    bootstrapD1Opens();
  }
}, 60000);

// ── Binance WS: индивидуальные @ticker подписки (работают на VPS) ────────

var binanceWS = null;
var _pushPending = false;

function schedulePush() {
  if (_pushPending) return;
  _pushPending = true;
  setTimeout(function () { _pushPending = false; pushTicker(); }, 100);
}

async function startBinanceWS() {
  var symbols;
  try {
    var info = await fetchBinance(BINANCE_REST + '/fapi/v1/exchangeInfo');
    symbols = info.symbols
      .filter(function (s) { return s.symbol.endsWith('USDT') && s.status === 'TRADING'; })
      .map(function (s) { return s.symbol.toLowerCase() + '@ticker'; });
    console.log('[Binance] Got', symbols.length, 'symbols for WS');
    if (!knownFuturesSyms) {
      knownFuturesSyms = new Set(info.symbols
        .filter(function (s) { return s.symbol.endsWith('USDT') && s.status === 'TRADING'; })
        .map(function (s) { return s.symbol; }));
      console.log('[Listing] Baseline set:', knownFuturesSyms.size, 'symbols');
    }
  } catch (e) {
    console.error('[Binance] Symbol fetch failed:', e.message, '— retrying in 10s');
    setTimeout(startBinanceWS, 10000);
    return;
  }
  connectBinanceWS(symbols);
}

function connectBinanceWS(symbols) {
  binanceWS = new WebSocket(BINANCE_WS_URL);

  binanceWS.on('open', function () {
    console.log('[Binance] Connected, subscribing to', symbols.length, 'tickers...');
    // Binance limit: max 200 params per SUBSCRIBE message
    for (var i = 0; i < symbols.length; i += 200) {
      var batch = symbols.slice(i, i + 200);
      binanceWS.send(JSON.stringify({
        method: 'SUBSCRIBE',
        params: batch,
        id: Math.floor(i / 200) + 1,
      }));
    }
  });

  binanceWS.on('message', function (raw) {
    try {
      var msg = JSON.parse(raw.toString());
      // Subscription confirmation — ignore
      if (msg.id != null && msg.result === null) return;
      // Individual 24hrTicker event
      if (msg.e === '24hrTicker' && msg.s) {
        tickerCache[msg.s] = {
          s: msg.s,
          c: msg.c, // last price
          o: msg.o, // open price
          h: msg.h, // high
          l: msg.l, // low
          v: msg.v, // base volume
          q: msg.q, // quote volume (USDT)
          P: msg.P, // priceChangePercent (Binance pre-calculated)
        };
        checkAlertsForSym(msg.s, parseFloat(msg.c));
        schedulePush(); // push to clients ~100ms after this event
      }
    } catch (e) {}
  });

  binanceWS.on('close', function () {
    console.log('[Binance] Disconnected, reconnecting in 5s...');
    setTimeout(function () { connectBinanceWS(symbols); }, 5000);
  });

  binanceWS.on('error', function (e) {
    console.error('[Binance] Error:', e.message);
    binanceWS.close();
  });
}

// ── Push полный тикер всем клиентам каждую секунду ──────────────────────

function pushTicker() {
  var arr = Object.values(tickerCache);
  if (!arr.length) return;
  var msg = JSON.stringify({ type: 'ticker', data: arr });
  clients.forEach(function (c) { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

setInterval(pushTicker, 1000);

// ── Kline WebSocket: real-time свечи по каждой сделке ───────────────────
// Binance kline stream присылает обновление на КАЖДОЙ сделке (sub-100ms),
// в отличие от 24hrTicker который обновляется раз в ~1с.

var klineWS = null;
var klineSubscribed = new Set(); // 'btcusdt@kline_5m'
var klinePending = {}; // 'sym_tf' → последнее состояние свечи

// Флашим буфер раз в 200мс — независимо от частоты входящих событий
setInterval(function () {
  var keys = Object.keys(klinePending);
  if (!keys.length || !clients.size) return;
  keys.forEach(function (key) {
    var payload = JSON.stringify({ type: 'kline_update', symbol: klinePending[key].symbol, tf: klinePending[key].tf, candle: klinePending[key].candle });
    clients.forEach(function (c) { if (c.readyState === WebSocket.OPEN) c.send(payload); });
  });
  klinePending = {};
}, 200);

function subscribeKline(streamName) {
  if (klineSubscribed.has(streamName)) return;
  klineSubscribed.add(streamName);
  if (klineWS && klineWS.readyState === WebSocket.OPEN) {
    klineWS.send(JSON.stringify({ method: 'SUBSCRIBE', params: [streamName], id: Date.now() }));
    console.log('[KlineWS] Subscribed:', streamName);
  }
}

function startKlineWS() {
  klineWS = new WebSocket(BINANCE_KLINE_WS_URL);

  klineWS.on('open', function () {
    console.log('[KlineWS] Connected');
    // Переподписаться на все стримы после реконнекта
    var params = Array.from(klineSubscribed);
    for (var i = 0; i < params.length; i += 200) {
      klineWS.send(JSON.stringify({ method: 'SUBSCRIBE', params: params.slice(i, i + 200), id: i + 100 }));
    }
    // Gap-fill only on reconnect — initial data comes from bootstrapBuffers
    if (!_klineFirstConnect && inplaySymbols.length) {
      fillAllGaps(inplaySymbols).catch(function (e) {
        logInplay('[Inplay] Gap-fill error:', e.message);
      });
    }
    _klineFirstConnect = false;
  });

  klineWS.on('message', function (raw) {
    try {
      var msg = JSON.parse(raw.toString());
      // Игнорируем подтверждения подписки
      if (msg.id != null && msg.result === null) return;
      if (msg.e !== 'kline') return;

      var k = msg.k;
      var sym = k.s.replace('USDT', '').toLowerCase();
      checkAlertsForSym(k.s, parseFloat(k.c));
      // Push closed candle into inplay rolling buffer
      if (k.x) {
        pushCandle(k.s, k.i, {
          time:   k.t,
          open:   parseFloat(k.o),
          high:   parseFloat(k.h),
          low:    parseFloat(k.l),
          close:  parseFloat(k.c),
          volume: parseFloat(k.v),
          trades: k.n,
        });
      }
      // Буферизуем последнее состояние свечи — флашим раз в 200мс
      // Без этого активная монета шлёт 100+ событий/сек и WS захлёбывается
      klinePending[sym + '_' + k.i] = {
        symbol: sym,
        tf: k.i,
        candle: {
          time: Math.floor(k.t / 1000),
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
          closed: k.x,
        },
      };
    } catch (e) {}
  });

  klineWS.on('close', function () {
    console.log('[KlineWS] Disconnected, reconnecting in 5s...');
    setTimeout(startKlineWS, 5000);
  });

  klineWS.on('error', function (e) {
    console.error('[KlineWS] Error:', e.message);
    klineWS.close();
  });
}

// ── aggTrade WebSocket: поток сделок для микроструктуры ──────────────────

var aggTradeWS         = null;
var aggTradeSubscribed = new Set();  // 'btcusdt@aggTrade'
var _aggTradeFirstConnect = true;

function subscribeAggTrade(streamName) {
  if (aggTradeSubscribed.has(streamName)) return;
  aggTradeSubscribed.add(streamName);
  if (aggTradeWS && aggTradeWS.readyState === WebSocket.OPEN) {
    aggTradeWS.send(JSON.stringify({ method: 'SUBSCRIBE', params: [streamName], id: Date.now() }));
  }
}

async function fillAggTradeGap(symbol) {
  var state = getTradeState(symbol);
  if (!state || !state.lastTs) return;
  try {
    var url = BINANCE_REST + '/fapi/v1/aggTrades?symbol=' + symbol + '&startTime=' + (state.lastTs + 1) + '&limit=1000';
    var trades = await fetchBinance(url);
    if (!Array.isArray(trades)) return;
    trades.forEach(function (t) {
      processTrade(symbol, { time: t.T, qty: parseFloat(t.q), isBuyerMaker: t.m });
    });
    if (trades.length) logInplay('[AggTradeWS] Gap-filled', trades.length, 'trades for', symbol);
  } catch (e) {
    logInplay('[AggTradeWS] Gap-fill error for', symbol, ':', e.message);
  }
}

function startAggTradeWS() {
  aggTradeWS = new WebSocket(BINANCE_AGGTRADE_WS_URL);

  aggTradeWS.on('open', function () {
    logInplay('[AggTradeWS] Connected');
    // Re-subscribe after reconnect
    var params = Array.from(aggTradeSubscribed);
    for (var i = 0; i < params.length; i += 200) {
      aggTradeWS.send(JSON.stringify({ method: 'SUBSCRIBE', params: params.slice(i, i + 200), id: i + 200 }));
    }
    // Gap-fill on reconnect (skip first connect — buffers start empty)
    if (!_aggTradeFirstConnect && inplaySymbols.length) {
      inplaySymbols.forEach(function (sym) {
        fillAggTradeGap(sym).catch(function () {});
      });
    }
    _aggTradeFirstConnect = false;
  });

  aggTradeWS.on('message', function (raw) {
    try {
      var msg = JSON.parse(raw.toString());
      if (msg.id != null && msg.result === null) return;  // subscription ack
      if (msg.e !== 'aggTrade') return;
      processTrade(msg.s, {
        time:         msg.T,
        qty:          parseFloat(msg.q),
        isBuyerMaker: msg.m,
      });
    } catch (e) {}
  });

  aggTradeWS.on('close', function () {
    logInplay('[AggTradeWS] Disconnected, reconnecting in 5s...');
    setTimeout(startAggTradeWS, 5000);
  });

  aggTradeWS.on('error', function (e) {
    console.error('[AggTradeWS] Error:', e.message);
    aggTradeWS.close();
  });
}

// ── depth20 WebSocket: стакан для OBI и liquidity vacuum ─────────────────

var depthWS         = null;
var depthSubscribed = new Set();

function subscribeDepth(streamName) {
  if (depthSubscribed.has(streamName)) return;
  if (depthSubscribed.size >= 50) return;  // cap at 50 streams
  depthSubscribed.add(streamName);
}

// Called once after bootstrap — encodes all streams in the URL, no SUBSCRIBE messages needed.
function startDepthWS() {
  var streams = Array.from(depthSubscribed);
  if (!streams.length) return;
  var wsUrl = 'wss://fstream.binance.com/stream?streams=' + streams.join('/');
  depthWS = new WebSocket(wsUrl);

  depthWS.on('open', function () {
    logInplay('[DepthWS] Connected,', streams.length, 'streams');
  });

  depthWS.on('message', function (raw) {
    try {
      var msg = JSON.parse(raw.toString());
      // Combined stream format: { stream: 'sym@depth20@100ms', data: { e, s, b, a } }
      var payload = msg.data || msg;
      if (!payload.b && !payload.bids) return;
      var sym = payload.s
        ? payload.s.toUpperCase()
        : (msg.stream ? msg.stream.split('@')[0].toUpperCase() : null);
      if (!sym) return;
      var bids = (payload.b || payload.bids || []).map(function (l) { return [parseFloat(l[0]), parseFloat(l[1])]; });
      var asks = (payload.a || payload.asks || []).map(function (l) { return [parseFloat(l[0]), parseFloat(l[1])]; });
      processDepthUpdate(sym, bids, asks);
      updateEmaOBI(sym, obi(bids, asks, 5));
    } catch (e) {}
  });

  depthWS.on('close', function () {
    logInplay('[DepthWS] Disconnected, reconnecting in 5s...');
    setTimeout(startDepthWS, 5000);
  });

  depthWS.on('error', function (e) {
    console.error('[DepthWS] Error:', e.message);
  });
}

// ── HTTP сервер (REST + WS upgrade) ──────────────────────────────────────

var CORS_ORIGINS = ['https://questtick.com', 'https://www.questtick.com', 'http://localhost:5173'];

async function getSession(req) {
  try {
    return await getAuth().api.getSession({ headers: req.headers });
  } catch (e) { return null; }
}

function unauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

var httpServer = http.createServer(async function (req, res) {
  var origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGINS.includes(origin) ? origin : 'https://questtick.com');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Better Auth routes — rewrite /auth/* → /api/auth/* (BA default basePath)
  if (req.url.startsWith('/auth')) {
    var rewritten = '/api/auth' + req.url.slice(5);
    console.log('[Auth] ' + req.method + ' ' + req.url + ' → ' + rewritten);
    req.url = rewritten;
    return toNodeHandler(getAuth())(req, res);
  }

  if (req.method === 'POST' && req.url === '/api/analyze') {
    var analyzeBody = '';
    req.on('data', function (chunk) { analyzeBody += chunk; });
    req.on('end', async function () {
      try {
        var p = JSON.parse(analyzeBody);
        if (!p.name || !p.symbol) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing required fields' })); return; }
        var result = await analyzeCoin({ name: p.name, symbol: p.symbol, change24h: p.change24h, volume: p.volume, price: p.price, natr: p.natr });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        var code = (e.message || '').includes('API_KEY') ? 500 : 502;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'Internal error' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/levels') {
    var body = '';
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', async function () {
      try {
        var session = await getSession(req);
        if (!session) return unauthorized(res);
        var userId = session.user.id;

        var parsed = JSON.parse(body);
        var action = parsed.action, levels = parsed.levels;
        var key = 'levels:' + userId;
        if (action === 'get') {
          var r = await redis(['GET', key]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ levels: r.result ? JSON.parse(r.result) : {} }));
        } else if (action === 'save') {
          var normLevels = {};
          Object.keys(levels || {}).forEach(function (s) { normLevels[s.toLowerCase()] = levels[s]; });
          await redis(['SET', key, JSON.stringify(normLevels)]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown action' }));
        }
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/alerts') {
    var body2 = '';
    req.on('data', function (chunk) { body2 += chunk; });
    req.on('end', async function () {
      try {
        var session = await getSession(req);
        if (!session) return unauthorized(res);
        var userId = session.user.id;

        var parsed = JSON.parse(body2);
        var action = parsed.action, chatId = parsed.chatId, data = parsed.data;
        if (action === 'get') {
          if (!alertsMemory[userId]) {
            var ar = await redis(['GET', 'alerts:' + userId]);
            alertsMemory[userId] = ar.result ? JSON.parse(ar.result) : { chatId: '', data: {} };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(alertsMemory[userId]));
        } else if (action === 'save') {
          if (!alertsMemory[userId]) alertsMemory[userId] = { chatId: '', data: {} };
          if (chatId) alertsMemory[userId].chatId = String(chatId);
          if (data !== undefined) {
            alertsMemory[userId].data = mergeAlertData(alertsMemory[userId].data, data);
          }
          await saveAlertsToRedis(userId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown action' }));
        }
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/briefing') {
    var bodyBr = '';
    req.on('data', function (chunk) { bodyBr += chunk; });
    req.on('end', async function () {
      try {
        var session = await getSession(req);
        if (!session) return unauthorized(res);
        var userId = session.user.id;

        var parsed = JSON.parse(bodyBr);
        var action = parsed.action, entries = parsed.entries;
        var key = 'briefing:' + userId;
        var keyAI = 'briefing_ai:' + userId;
        if (action === 'get') {
          var r = await redis(['GET', key]);
          var rAI = await redis(['GET', keyAI]);
          var aiData = rAI.result ? JSON.parse(rAI.result) : {};
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            entries: r.result ? JSON.parse(r.result) : [],
            ai_summary: aiData.text || null,
            ai_traded_keys: aiData.keys || null,
            ai_summary_date: aiData.date || null,
          }));
        } else if (action === 'save') {
          if (!parsed.skip_entries) {
            await redis(['SET', key, JSON.stringify(entries || [])]);
          }
          if (parsed.ai_summary) {
            await redis(['SET', keyAI, JSON.stringify({ text: parsed.ai_summary, keys: parsed.ai_traded_keys || [], date: parsed.ai_summary_date || null })]);
          }
          if (typeof parsed.utcOffset === 'number' && isFinite(parsed.utcOffset)) {
            await redis(['SET', 'briefing_tz:' + userId, String(parsed.utcOffset)]);
            _userUtcOffset = parsed.utcOffset; // single-user — always update
          }
          if (!parsed.skip_entries) {
            var _bMsg = JSON.stringify({ type: 'briefing_updated' });
            clients.forEach(function (c) { if (c.readyState === WebSocket.OPEN) c.send(_bMsg); });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown action' }));
        }
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Proxy: Binance Futures + Gemini (keys stay server-side) ────────────────
  if (req.method === 'POST' && req.url === '/api/proxy') {
    var proxyBody = '';
    req.on('data', function (chunk) { proxyBody += chunk; });
    req.on('end', async function () {
      function proxyJson(code, data) {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      }
      try {
        var proxySession = await getSession(req);
        if (!proxySession) return proxyJson(401, { error: 'Unauthorized' });

        var p = JSON.parse(proxyBody);
        var service = p.service, payload = p.payload || {};

        if (service === 'binance') {
          var BIN_KEY = process.env.BINANCE_API_KEY;
          var BIN_SEC = process.env.BINANCE_API_SECRET;
          if (!BIN_KEY || !BIN_SEC) return proxyJson(500, { error: 'Binance keys not configured' });
          var sym = payload.symbol;
          if (!sym) return proxyJson(400, { error: 'symbol required' });
          var params = new URLSearchParams({ symbol: sym.toUpperCase(), timestamp: String(Date.now()), limit: String(payload.limit || 1000) });
          if (payload.startTime) params.set('startTime', String(payload.startTime));
          if (payload.endTime) params.set('endTime', String(payload.endTime));
          var qs = params.toString();
          var sig = crypto.createHmac('sha256', BIN_SEC).update(qs).digest('hex');
          var binUrl = 'https://fapi.binance.com/fapi/v1/userTrades?' + qs + '&signature=' + sig;
          var binRes = await fetch(binUrl, { headers: { 'X-MBX-APIKEY': BIN_KEY } });
          var binData = await binRes.json();
          if (!binRes.ok) return proxyJson(502, { error: binData.msg || 'Binance error', code: binData.code });
          return proxyJson(200, { trades: binData });
        }

        if (service === 'binance-income') {
          var BIN_KEY = process.env.BINANCE_API_KEY;
          var BIN_SEC = process.env.BINANCE_API_SECRET;
          if (!BIN_KEY || !BIN_SEC) return proxyJson(500, { error: 'Binance keys not configured' });
          var incParams = new URLSearchParams({ timestamp: String(Date.now()), limit: String(payload.limit || 1000) });
          if (payload.incomeType) incParams.set('incomeType', payload.incomeType);
          if (payload.startTime) incParams.set('startTime', String(payload.startTime));
          if (payload.endTime) incParams.set('endTime', String(payload.endTime));
          var incQs = incParams.toString();
          var incSig = crypto.createHmac('sha256', BIN_SEC).update(incQs).digest('hex');
          var incUrl = 'https://fapi.binance.com/fapi/v1/income?' + incQs + '&signature=' + incSig;
          var incRes = await fetch(incUrl, { headers: { 'X-MBX-APIKEY': BIN_KEY } });
          var incData = await incRes.json();
          if (!incRes.ok) return proxyJson(502, { error: incData.msg || 'Binance error', code: incData.code });
          return proxyJson(200, { income: incData });
        }

        if (service === 'gemini') {
          var GEM_KEY = process.env.GEMINI_API_KEY;
          if (!GEM_KEY) return proxyJson(500, { error: 'Gemini key not configured' });
          if (!payload.prompt) return proxyJson(400, { error: 'prompt required' });
          var gemUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEM_KEY;
          var gemRes = await fetch(gemUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: payload.prompt }] }] }) });
          var gemData = await gemRes.json();
          if (!gemRes.ok) return proxyJson(502, { error: 'Gemini error' });
          var text = (gemData.candidates && gemData.candidates[0] && gemData.candidates[0].content && gemData.candidates[0].content.parts && gemData.candidates[0].content.parts[0] && gemData.candidates[0].content.parts[0].text) || '';
          return proxyJson(200, { text: text });
        }

        return proxyJson(400, { error: 'Unknown service: ' + service });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
});

// ── WebSocket сервер для фронтенда ───────────────────────────────────────

var wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, function () {
  console.log('[Server] Pump Analyzer running on port', PORT);
  if (BRIEFING_USER_CODE) {
    redis(['GET', 'briefing_tz:' + BRIEFING_USER_CODE]).then(function (r) {
      if (r.result !== null) {
        var v = parseFloat(r.result);
        if (isFinite(v)) { _userUtcOffset = v; console.log('[Weekly] user utcOffset:', _userUtcOffset); }
      }
    }).catch(function () {});
  }
});

wss.on('connection', function (ws) {
  clients.add(ws);
  console.log('[Server] Client connected (' + clients.size + ' total)');

  // Отправить кэш сразу при подключении
  var arr = Object.values(tickerCache);
  if (arr.length) {
    ws.send(JSON.stringify({ type: 'ticker', data: arr }));
  }
  // Сразу шлём d1Opens если bootstrap уже завершён
  if (Object.keys(d1OpenCache).length) {
    ws.send(JSON.stringify({ type: 'd1opens', data: d1OpenCache }));
  }

  ws.on('message', async function (raw) {
    var msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    try {
      if (msg.type === 'get_ticker') {
        var cur = Object.values(tickerCache);
        if (cur.length) ws.send(JSON.stringify({ type: 'ticker', _id: msg._id, data: cur }));
      }

      else if (msg.type === 'fetch_klines') {
        var url = BINANCE_REST + '/fapi/v1/klines?symbol=' + msg.symbol.toUpperCase() + 'USDT&interval=' + msg.tf + '&limit=' + (msg.limit || 300);
        var data = await fetchBinance(url);
        ws.send(JSON.stringify({ type: 'klines', _id: msg._id, symbol: msg.symbol, tf: msg.tf, data: data }));
      }

      else if (msg.type === 'fetch_natr') {
        var natrSym = msg.symbol.toUpperCase() + 'USDT';
        // d1Open берём из кэша если уже есть (bootstrapD1Opens уже запустился) — экономим 1 REST вызов.
        // Если кэша нет (монета появилась позже, VPS только запустился) — фетчим 1d свечу.
        var cachedD1 = d1OpenCache[natrSym] || null;
        var fetches = [fetchBinance(BINANCE_REST + '/fapi/v1/klines?symbol=' + natrSym + '&interval=5m&limit=30')];
        if (!cachedD1) fetches.push(fetchBinance(BINANCE_REST + '/fapi/v1/klines?symbol=' + natrSym + '&interval=1d&limit=1'));
        var results = await Promise.all(fetches);
        var natrKlines = results[0];
        var d1Open = cachedD1;
        if (!d1Open && results[1]) {
          var d1Klines = results[1];
          d1Open = (Array.isArray(d1Klines) && d1Klines.length) ? d1Klines[0][1] : null;
          if (d1Open) d1OpenCache[natrSym] = d1Open; // добавляем в кэш если пропустил bootstrap
        }
        ws.send(JSON.stringify({ type: 'natr', _id: msg._id, symbol: msg.symbol, data: natrKlines, d1Open: d1Open }));
      }

      else if (msg.type === 'save_alerts') {
        // Frontend pushes userId as msg.code (replaces old user-defined code string).
        var wsUserId = msg.code;
        if (wsUserId && typeof wsUserId === 'string' && wsUserId.length > 0) {
          if (!alertsMemory[wsUserId]) alertsMemory[wsUserId] = { chatId: '', data: {} };
          if (msg.chatId) alertsMemory[wsUserId].chatId = String(msg.chatId);
          if (msg.data !== undefined) {
            alertsMemory[wsUserId].data = mergeAlertData(alertsMemory[wsUserId].data, msg.data);
          }
          saveAlertsToRedis(wsUserId);
        }
      }

      else if (msg.type === 'subscribe_klines') {
        // Клиент просит подписаться на real-time kline стримы для списка монет
        var syms = Array.isArray(msg.symbols) ? msg.symbols : [];
        var tf = msg.tf || '5m';
        syms.forEach(function (sym) {
          subscribeKline(sym.toLowerCase() + 'usdt@kline_' + tf);
        });
      }

      else if (msg.type === 'fetch_market_strength') {
        var results = await Promise.all(msg.symbols.map(async function (sym) {
          var s = sym.toUpperCase() + 'USDT';
          try {
            var [k1m, k1h, k1d, oi] = await Promise.all([
              fetchBinance(BINANCE_REST + '/fapi/v1/klines?symbol=' + s + '&interval=1m&limit=30'),
              fetchBinance(BINANCE_REST + '/fapi/v1/klines?symbol=' + s + '&interval=1h&limit=20'),
              fetchBinance(BINANCE_REST + '/fapi/v1/klines?symbol=' + s + '&interval=1d&limit=11'),
              fetchBinance(BINANCE_REST + '/futures/data/openInterestHist?symbol=' + s + '&period=5m&limit=4'),
            ]);
            return { symbol: sym, k1m: k1m, k1h: k1h, k1d: k1d, oiHist: oi };
          } catch (e) { return null; }
        }));
        ws.send(JSON.stringify({ type: 'market_strength', _id: msg._id, data: results }));
      }

    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', _id: msg && msg._id, message: e.message }));
    }
  });

  ws.on('close', function () { clients.delete(ws); console.log('[Server] Client disconnected (' + clients.size + ' total)'); });
  ws.on('error', function () { clients.delete(ws); });
});

// ── Старт ────────────────────────────────────────────────────────────────

bootstrapTicker().then(function() {
  // 2с задержка: не конкурируем с тикер-бутстрапом за rate limit
  setTimeout(bootstrapD1Opens, 2000);

  // Derive inplay watchlist and bootstrap rolling kline buffers
  if (!INPLAY_BETA_ENABLED) return;

  inplaySymbols = getWatchlist(tickerCache);
  var _startTime = Date.now();
  inplaySymbols.forEach(function (sym) { _joinTimes[sym] = _startTime; });
  logInplay('[Inplay] Watchlist:', inplaySymbols.length, 'symbols (q > $10M)');
  bootstrapBuffers(inplaySymbols).then(function () {
    // Subscribe klineWS to 1m and 5m for all inplay symbols
    inplaySymbols.forEach(function (sym) {
      subscribeKline(sym.toLowerCase() + '@kline_1m');
      subscribeKline(sym.toLowerCase() + '@kline_5m');
    });
    logInplay('[Inplay] Subscribed klineWS to', inplaySymbols.length * 2, 'streams');

    // Initialise trade state + subscribe aggTrade for each inplay symbol
    inplaySymbols.forEach(function (sym) {
      initTradeState(sym);
      subscribeAggTrade(sym.toLowerCase() + '@aggTrade');
    });
    logInplay('[Inplay] Subscribed aggTradeWS to', inplaySymbols.length, 'streams');

    // Initialise orderbook state + subscribe depth20@100ms for each inplay symbol
    inplaySymbols.forEach(function (sym) {
      initOrderbookState(sym);
      subscribeDepth(sym.toLowerCase() + '@depth20@100ms');
    });
    logInplay('[Inplay] Depth streams queued:', depthSubscribed.size, '(cap 50, watchlist', inplaySymbols.length, ')');
    startDepthWS();  // start after depthSubscribed is populated — streams encoded in URL

    // Start score update loop
    setInterval(function () {
      try {
        // Phase detector — independent of score, always broadcast
        var phaseResult = updatePhases(inplaySymbols, null, getMicro, logInplay);
        var phaseData = phaseResult.phases.map(function (p) {
          var tc  = tickerCache[p.symbol];
          var obm = getOrderbookMetrics(p.symbol);
          return Object.assign({}, p, {
            vol24h: tc  ? parseFloat(tc.q)    : null,
            spr:    obm ? obm.spread           : null,
            obi:    obm ? obm.emaOBI5          : null,
            vacU:   obm ? obm.vacuumAbove      : null,
            vacD:   obm ? obm.vacuumBelow      : null,
          });
        });
        var phaseMsg = JSON.stringify({ type: 'inplay_phases', data: phaseData, ts: Date.now(), watchlist: inplaySymbols.length });
        clients.forEach(function (c) { if (c.readyState === WebSocket.OPEN) c.send(phaseMsg); });

        // Telegram alerts for phase transitions (beta — only if INPLAY_ALERT_CHAT_ID is set)
        if (INPLAY_ALERT_CHAT_ID) {
          phaseResult.transitions.forEach(function (tr) {
            if (tr.to !== 'active') return; // only alert on entry/revival
            var p = phaseData.find(function (x) { return x.symbol === tr.symbol; });
            var isRevival = tr.from === 'cooling';
            var dirEmoji  = tr.direction > 0 ? '🟢 LONG ↑' : '🔴 SHORT ↓';
            var sym       = tr.symbol.replace('USDT', '');
            var vol       = p && p.vol24h ? (p.vol24h >= 1e9 ? '$' + (p.vol24h / 1e9).toFixed(1) + 'B' : '$' + (p.vol24h / 1e6).toFixed(0) + 'M') : '—';
            var dp        = p ? (p.delta_price >= 0 ? '+' : '') + p.delta_price.toFixed(2) + '%' : '—';
            var rvol      = p ? p.rvol_last.toFixed(1) + 'x' : '—';
            var cvd       = p && p.cvd_z !== null ? p.cvd_z.toFixed(2) : '—';
            var prefix    = isRevival ? '🔄 Revival' : '🚨 Inplay Phase';
            var text = prefix + '\n' +
              '<b>' + sym + '</b> — ' + dirEmoji + '\n' +
              'RVOL: ' + rvol + ' | Δp15m: ' + dp + ' | CVD_z: ' + cvd + '\n' +
              '24h Vol: ' + vol;
            sendTG(INPLAY_ALERT_CHAT_ID, text);
          });
        }

        // Legacy score ranking (kept for logging and comparison)
        var top = updateAllScores(inplaySymbols);
        if (!top.length) return;

        // Log breakdown for top entries
        top.forEach(function (r) {
          var cvdPart = r._cvdZ !== null && r._cvdZ !== undefined
            ? ' cvdZ=' + r._cvdZ.toFixed(2) + ' aggr=' + (r._aggrRatio !== null ? r._aggrRatio.toFixed(2) : 'n/a') + ' lts=' + (r._largeShare || 0).toFixed(2) + ' div=' + (r._cvdDiv || 0)
            : ' [no microstructure]';
          var bookPart = r._spread !== undefined
            ? ' spr=' + (r._spread !== null ? r._spread.toFixed(1) : 'n/a') + 'bps' +
              ' obi=' + (r._emaOBI5 !== null ? r._emaOBI5.toFixed(2) : 'n/a') +
              ' obiC=' + (r._obiConfirmed !== undefined ? r._obiConfirmed.toFixed(2) : 'n/a') +
              ' vacU=' + (r._vacuumAbove !== undefined ? r._vacuumAbove.toFixed(0) : '?') + 'bps' +
              ' vacD=' + (r._vacuumBelow !== undefined ? r._vacuumBelow.toFixed(0) : '?') + 'bps'
            : '';
          logInplay('[Inplay]', r.symbol,
            'score=' + r.inplay.toFixed(3),
            'A=' + r.A.toFixed(2),
            'M=' + r.M.toFixed(2),
            'P=' + r.P.toFixed(2),
            '| miatr=' + (r._miatr || 0).toFixed(2),
            'dvwap=' + (r._dvwap || 0).toFixed(2),
            'bbs=' + (r._bbs || 0).toFixed(2) + cvdPart + bookPart
          );
        });

        // Push to all connected clients
        var msg = JSON.stringify({
          type: 'inplay_top',
          data: top.map(function (r) {
            return {
              symbol: r.symbol, inplay: r.inplay,
              A: r.A, M: r.M, P: r.P,
              dp5m: r._dp5m, rvol5m: r._rvol5m,
            };
          }),
          ts: Date.now(),
        });
        clients.forEach(function (c) { if (c.readyState === WebSocket.OPEN) c.send(msg); });
      } catch (e) {
        logInplay('[Inplay] Score error:', e.message);
      }
    }, inplayCfg.score_update_interval_ms);

  }).catch(function (e) {
    logInplay('[Inplay] Bootstrap error:', e.message);
  });
});
startBinanceWS();       // параллельно: WS подписки для live-обновлений
startKlineWS();         // kline WS для real-time обновлений свечей
startAggTradeWS();      // aggTrade WS для CVD и микроструктуры
// startDepthWS() is called from within bootstrap after depthSubscribed is populated
loadAlertsOnStartup();  // загрузить алерты из Redis в память

// REST-рефреш каждые 60 секунд — только как fallback для восстановления
// после разрыва WS. Убрали частый опрос: он перезаписывал свежие WS-данные
// устаревшими HTTP-ответами и добавлял задержку.
setInterval(async function () {
  try {
    var data = await fetchBinance(BINANCE_REST + '/fapi/v1/ticker/24hr');
    data.forEach(function (t) {
      if (t.symbol.endsWith('USDT')) {
        tickerCache[t.symbol] = {
          s: t.symbol,
          c: t.lastPrice,
          o: t.openPrice,
          h: t.highPrice,
          l: t.lowPrice,
          v: t.volume,
          q: t.quoteVolume,
          P: t.priceChangePercent,
        };
      }
    });
  } catch (e) {
    console.error('[REST refresh] Failed:', e.message);
  }
}, 60000);

// ── Dynamic watchlist refresh ─────────────────────────────────────────────
// Every 60s:
//   1. Remove symbols that dropped below $7M (hysteresis) and aren't in a phase
//   2. Add new symbols that crossed the $10M threshold
//   3. Skip symbols already being bootstrapped (_bootstrapPending guard)
//   4. Tag new symbols with _joinTimes for CVD warmup grace period

setInterval(function () {
  if (!INPLAY_BETA_ENABLED) return;

  var minVol    = inplayCfg.prefilter.min_quote_volume_24h;        // $10M add
  var removeVol = inplayCfg.prefilter.watchlist_remove_vol || 7000000; // $7M remove

  // ── 1. Remove coins that fell below removeVol and are not in an active phase
  var toRemove = inplaySymbols.filter(function (sym) {
    var t = tickerCache[sym];
    if (!t || parseFloat(t.q) >= removeVol) return false; // still above threshold
    if (isInPhase(sym)) return false;                     // keep — phase in progress
    return true;
  });
  if (toRemove.length) {
    var removeSet = new Set(toRemove);
    inplaySymbols = inplaySymbols.filter(function (s) { return !removeSet.has(s); });
    logInplay('[Inplay] Watchlist -' + toRemove.length + ':', toRemove.join(', '));
  }

  // ── 2. Add new symbols that crossed the $10M threshold
  var currentSet = new Set(inplaySymbols);
  var newSyms = Object.values(tickerCache)
    .filter(function (t) {
      return parseFloat(t.q) >= minVol &&
             !currentSet.has(t.s) &&
             !_bootstrapPending.has(t.s); // skip if already bootstrapping
    })
    .map(function (t) { return t.s; });

  if (!newSyms.length) return;

  logInplay('[Inplay] Watchlist +' + newSyms.length + ':', newSyms.join(', '));
  var joinNow = Date.now();
  newSyms.forEach(function (sym) {
    inplaySymbols.push(sym);
    _joinTimes[sym] = joinNow;     // CVD warmup starts now
    _bootstrapPending.add(sym);    // guard against double-bootstrap
  });

  bootstrapBuffers(newSyms).then(function () {
    newSyms.forEach(function (sym) {
      subscribeKline(sym.toLowerCase() + '@kline_1m');
      subscribeKline(sym.toLowerCase() + '@kline_5m');
      initTradeState(sym);
      subscribeAggTrade(sym.toLowerCase() + '@aggTrade');
      initOrderbookState(sym);
      subscribeDepth(sym.toLowerCase() + '@depth20@100ms');
      _bootstrapPending.delete(sym);
    });
    logInplay('[Inplay] Watchlist now', inplaySymbols.length, 'symbols');
  }).catch(function (e) {
    newSyms.forEach(function (sym) { _bootstrapPending.delete(sym); });
    logInplay('[Inplay] Refresh bootstrap error:', e.message);
  });
}, 60000);

// ── New futures listing alerts ────────────────────────────────────────────
async function checkNewListings() {
  if (!INPLAY_ALERT_CHAT_ID || !knownFuturesSyms) return;
  try {
    var info = await fetchBinance(BINANCE_REST + '/fapi/v1/exchangeInfo');
    var newOnes = info.symbols.filter(function (s) {
      return s.symbol.endsWith('USDT') && s.status === 'TRADING' && !knownFuturesSyms.has(s.symbol);
    });
    for (var i = 0; i < newOnes.length; i++) {
      var sym = newOnes[i].symbol;
      knownFuturesSyms.add(sym);
      var coin = sym.replace(/USDT$/, '');
      var markup = APP_URL
        ? { inline_keyboard: [[{ text: '📈 Открыть график', url: APP_URL + '/?sym=' + coin }]] }
        : undefined;
      console.log('[Listing] New futures listing detected:', sym);
      await sendTG(INPLAY_ALERT_CHAT_ID, '🆕 Новый листинг!\n<b>' + sym + '</b>', markup);
    }
  } catch (e) {
    console.error('[Listing] exchangeInfo check failed:', e.message);
  }
}

setInterval(checkNewListings, 2 * 60 * 1000);

// ── Weekly briefing report ────────────────────────────────────────────────
async function sendWeeklyBriefingReport(chatId) {
  var GEM_KEY = process.env.GEMINI_API_KEY;
  var code = BRIEFING_USER_CODE;
  if (!chatId) return;
  if (!GEM_KEY) { await sendTG(chatId, '❌ GEMINI_API_KEY не настроен.'); return; }
  if (!code) { await sendTG(chatId, '❌ BRIEFING_USER_CODE не настроен.'); return; }
  var r = await redis(['GET', 'briefing:' + code]);
  var entries = r.result ? JSON.parse(r.result) : [];
  // Filter current week (Mon–Sun)
  var now = new Date();
  var daysToMon = now.getDay() === 0 ? 6 : now.getDay() - 1;
  var mon = new Date(now.getTime() - daysToMon * 24 * 3600 * 1000);
  var monStr = mon.getFullYear() + '-' + String(mon.getMonth() + 1).padStart(2, '0') + '-' + String(mon.getDate()).padStart(2, '0');
  entries = entries.filter(function (e) { return e.date >= monStr; });
  if (!entries.length) { await sendTG(chatId, '📋 Брифинг за эту неделю пуст.'); return; }
  var byDate = {};
  entries.forEach(function (e) { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e); });
  var statusLabels = { watching: 'наблюдение', traded: 'отработка', skip: 'отмена', missed: 'упущено' };
  var briefText = Object.keys(byDate).sort().reverse().map(function (date) {
    return date + ':\n' + byDate[date].map(function (e) {
      var st = e.status && e.status !== 'watching' ? ' [' + (statusLabels[e.status] || e.status) + ']' : '';
      return '  - ' + e.sym.toUpperCase() + st + (e.note ? ': ' + e.note : '');
    }).join('\n');
  }).join('\n\n');
  var prompt = 'Ты торговый аналитик и психолог. Вот мои заметки по монетам за неделю — мысли в моменте и статусы.\n\n'
    + briefText + '\n\n'
    + 'Напиши ответ из двух частей:\n'
    + '1. Психология (1-2 предложения): что повторяющийся паттерн в заметках говорит о моих решениях на этой неделе?\n'
    + '2. На следующую неделю (2-3 конкретных технических правила): что именно делать иначе — точечно, без воды.\n'
    + 'Без перечисления монет. На русском.';
  var gemUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEM_KEY;
  var gemRes = await fetch(gemUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  var gemData = await gemRes.json();
  if (!gemRes.ok) { await sendTG(chatId, '❌ Gemini error ' + gemRes.status + ': ' + (gemData.error && gemData.error.message || '')); return; }
  var summary = (gemData.candidates && gemData.candidates[0] && gemData.candidates[0].content
    && gemData.candidates[0].content.parts && gemData.candidates[0].content.parts[0]
    && gemData.candidates[0].content.parts[0].text) || '';
  if (!summary) { await sendTG(chatId, '❌ Gemini вернул пустой ответ.'); return; }
  await sendTG(chatId, '📋 <b>Итоги недели</b>\n\n' + summary);
  console.log('[Weekly report] Sent to', chatId);
}

var _weeklyReportSent = false;
setInterval(async function () {
  if (_userUtcOffset === null) return;
  var userDate = new Date(Date.now() + _userUtcOffset * 3600000);
  if (userDate.getUTCDay() !== 0 || userDate.getUTCHours() !== 22 || userDate.getUTCMinutes() !== 0) {
    _weeklyReportSent = false;
    return;
  }
  if (_weeklyReportSent) return;
  _weeklyReportSent = true;
  sendWeeklyBriefingReport(INPLAY_ALERT_CHAT_ID).catch(function (e) {
    console.error('[Weekly report]', e.message);
  });
}, 60000);
