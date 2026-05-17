const { WebSocketServer, WebSocket } = require('ws');

var PORT = process.env.WSS_PORT || 3001;
var BINANCE_REST = 'https://fapi.binance.com';
var BINANCE_WS_URL = 'wss://fstream.binance.com/ws';

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
        };
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

// ── Push полный тикер всем клиентам каждые 2 секунды ────────────────────

function pushTicker() {
  var arr = Object.values(tickerCache);
  if (!arr.length) return;
  var msg = JSON.stringify({ type: 'ticker', data: arr });
  clients.forEach(function (c) { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

setInterval(pushTicker, 2000);

// ── WebSocket сервер для фронтенда ───────────────────────────────────────

var wss = new WebSocketServer({ port: PORT });
console.log('[Server] Pump Analyzer WS running on port', PORT);

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
        if (cur.length) ws.send(JSON.stringify({ type: 'ticker', data: cur }));
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
