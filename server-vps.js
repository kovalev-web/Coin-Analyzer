const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { analyzeCoin } = require('./shared/analyze');

var PORT = process.env.WSS_PORT || 3001;
var BINANCE_REST = 'https://fapi.binance.com';
var BINANCE_WS_URL = 'wss://fstream.binance.com/ws';
var BINANCE_KLINE_WS_URL = 'wss://fstream.binance.com/market/ws'; // kline belongs to /market endpoint

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

var TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
var APP_URL = (process.env.APP_URL || '').replace(/\/$/, ''); // e.g. https://yourdomain.com
var tgOffset = 0;

async function sendTG(chatId, text, replyMarkup) {
  if (!TELEGRAM_TOKEN || !chatId) return;
  try {
    var body = { chat_id: chatId, text: text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {}
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
      }
    });
  } catch (e) {}
}

setInterval(pollTelegram, 3000);

// ── Alerts ────────────────────────────────────────────────────────────────

var alertsMemory = {}; // code → {chatId, data: {sym: [{price, triggered}]}}
var prevPrices = {};   // sym (lowercase, no USDT) → last price

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

// Called on every price update (ticker or kline) — no polling delay
// hi/lo: candle high and low — if provided, wicks trigger alerts too
function checkAlertsForSym(fullSym, cur, hi, lo) {
  var sym = fullSym.replace(/USDT$/, '').toLowerCase();
  var prev = prevPrices[sym];
  prevPrices[sym] = cur;
  if (prev == null) return;
  var high = (hi != null) ? hi : cur;
  var low  = (lo != null) ? lo : cur;
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
      // Bidirectional close-price crossing — fire when cur crosses alert from either side.
      // Using close (cur) only, not candle hi/lo, to avoid false triggers from wicks
      // that were already in the candle's range at the time the alert was placed.
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
  });

  klineWS.on('message', function (raw) {
    try {
      var msg = JSON.parse(raw.toString());
      // Игнорируем подтверждения подписки
      if (msg.id != null && msg.result === null) return;
      if (msg.e !== 'kline') return;

      var k = msg.k;
      var sym = k.s.replace('USDT', '').toLowerCase();
      // Real-time alert check on every trade — pass high/low so wicks trigger too
      checkAlertsForSym(k.s, parseFloat(k.c), parseFloat(k.h), parseFloat(k.l));
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

// ── HTTP сервер (REST + WS upgrade) ──────────────────────────────────────

var httpServer = http.createServer(async function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

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
        var parsed = JSON.parse(body);
        var action = parsed.action, code = parsed.code, levels = parsed.levels;
        // Allow Latin, digits, underscore, hyphen, Cyrillic
        if (!code || typeof code !== 'string' || !/^[a-zA-Z0-9_\-Ѐ-ӿ]{2,40}$/.test(code)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid code' }));
          return;
        }
        var key = 'levels:' + code.toLowerCase();
        if (action === 'get') {
          var r = await redis(['GET', key]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ levels: r.result ? JSON.parse(r.result) : {} }));
        } else if (action === 'save') {
          await redis(['SET', key, JSON.stringify(levels || {})]);
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
        var parsed = JSON.parse(body2);
        var action = parsed.action, code = parsed.code, chatId = parsed.chatId, data = parsed.data;
        if (!code || typeof code !== 'string' || !/^[a-zA-Z0-9_\-Ѐ-ӿ]{2,40}$/.test(code)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid code' }));
          return;
        }
        var codeKey = code.toLowerCase();
        if (action === 'get') {
          if (!alertsMemory[codeKey]) {
            var ar = await redis(['GET', 'alerts:' + codeKey]);
            alertsMemory[codeKey] = ar.result ? JSON.parse(ar.result) : { chatId: '', data: {} };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(alertsMemory[codeKey]));
        } else if (action === 'save') {
          if (!alertsMemory[codeKey]) alertsMemory[codeKey] = { chatId: '', data: {} };
          if (chatId !== undefined) alertsMemory[codeKey].chatId = String(chatId);
          if (data !== undefined) alertsMemory[codeKey].data = data;
          await saveAlertsToRedis(codeKey);
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
        var parsed = JSON.parse(bodyBr);
        var action = parsed.action, code = parsed.code, entries = parsed.entries;
        if (!code || typeof code !== 'string' || !/^[a-zA-Z0-9_\-Ѐ-ӿ]{2,40}$/.test(code)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid code' }));
          return;
        }
        var key = 'briefing:' + code.toLowerCase();
        if (action === 'get') {
          var r = await redis(['GET', key]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ entries: r.result ? JSON.parse(r.result) : [] }));
        } else if (action === 'save') {
          await redis(['SET', key, JSON.stringify(entries || [])]);
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

  res.writeHead(404); res.end();
});

// ── WebSocket сервер для фронтенда ───────────────────────────────────────

var wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, function () {
  console.log('[Server] Pump Analyzer running on port', PORT);
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
        // Frontend pushes alert data directly — instant alertsMemory update, no Redis polling delay
        var code = msg.code;
        if (code && typeof code === 'string' && /^[a-zA-Z0-9_\-Ѐ-ӿ]{2,40}$/.test(code)) {
          var ck = code.toLowerCase();
          if (!alertsMemory[ck]) alertsMemory[ck] = { chatId: '', data: {} };
          if (msg.chatId) alertsMemory[ck].chatId = String(msg.chatId); // never overwrite with empty
          if (msg.data !== undefined) alertsMemory[ck].data = msg.data;
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
});
startBinanceWS();       // параллельно: WS подписки для live-обновлений
startKlineWS();         // kline WS для real-time обновлений свечей
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
