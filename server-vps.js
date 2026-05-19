const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

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

var clients = new Set();
var tickerCache = {}; // symbol → { s, c, o, h, l, v, q }

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
        };
      }
    });
    console.log('[Bootstrap] Loaded', Object.keys(tickerCache).length, 'tickers');
    pushTicker();
  } catch (e) {
    console.error('[Bootstrap] Failed:', e.message);
  }
}

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
        var url2 = BINANCE_REST + '/fapi/v1/klines?symbol=' + msg.symbol.toUpperCase() + 'USDT&interval=5m&limit=30';
        var data2 = await fetchBinance(url2);
        ws.send(JSON.stringify({ type: 'natr', _id: msg._id, symbol: msg.symbol, data: data2 }));
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

bootstrapTicker(); // сразу: REST → кэш → push клиентам
startBinanceWS();  // параллельно: WS подписки для live-обновлений
startKlineWS();    // kline WS для real-time обновлений свечей

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
