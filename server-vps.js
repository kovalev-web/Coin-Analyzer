const { WebSocketServer, WebSocket } = require('ws');

var PORT = process.env.WSS_PORT || 3001;
var BINANCE_REST = 'https://fapi.binance.com';
var BINANCE_WS = 'wss://fstream.binance.com/ws';

var clients = new Set();
var tickerCache = null;

// ── Get all USDT symbols from REST, then subscribe individually ──────────

var allSymbols = [];

async function fetchSymbols() {
  try {
    var res = await fetch(BINANCE_REST + '/fapi/v1/exchangeInfo');
    var data = await res.json();
    allSymbols = data.symbols
      .filter(function (s) { return s.symbol.endsWith('USDT') && s.status === 'TRADING'; })
      .map(function (s) { return s.symbol.toLowerCase() + '@ticker'; });
    console.log('[Binance] Loaded', allSymbols.length, 'USDT symbols');
    return allSymbols;
  } catch (e) {
    console.error('[Binance] Failed to load symbols:', e.message);
    return [];
  }
}

// ── WebSocket connection (individual subscriptions) ──────────────────────

var binanceWS = null;

function connectBinance() {
  binanceWS = new WebSocket(BINANCE_WS);

  binanceWS.on('open', function () {
    console.log('[Binance] Connected, subscribing to', allSymbols.length, 'tickers...');
    // Subscribe in batches of 200
    for (var i = 0; i < allSymbols.length; i += 200) {
      var batch = allSymbols.slice(i, i + 200);
      binanceWS.send(JSON.stringify({
        method: 'SUBSCRIBE',
        params: batch,
        id: i / 200 + 1,
      }));
    }
  });

  binanceWS.on('message', function (raw) {
    try {
      var parsed = JSON.parse(raw.toString());
      // Single ticker: { "e": "24hrTicker", "s": "BTCUSDT", "c": "...", ... }
      if (parsed.e === '24hrTicker' && parsed.s) {
        var ticker = parsed;
        var sym = ticker.s.replace('USDT', '').toLowerCase();
        // Update cache
        if (tickerCache) {
          var found = false;
          for (var i = 0; i < tickerCache.length; i++) {
            if (tickerCache[i].s === ticker.s) {
              tickerCache[i] = ticker;
              found = true;
              break;
            }
          }
          if (!found) tickerCache.push(ticker);
        }
        // Push to clients (only changed coin to reduce bandwidth)
        var msg = JSON.stringify({ type: 'ticker_update', data: ticker, symbol: sym });
        clients.forEach(function (c) { if (c.readyState === WebSocket.OPEN) c.send(msg); });
      }
    } catch (e) {}
  });

  binanceWS.on('close', function () {
    console.log('[Binance] Disconnected, reconnecting in 3s');
    setTimeout(connectBinance, 3000);
  });

  binanceWS.on('error', function (e) {
    console.error('[Binance] Error:', e.message);
    binanceWS.close();
  });
}

// ── Initial full ticker fetch (REST) for first load ──────────────────────

async function fetchFullTicker() {
  try {
    var res = await fetch(BINANCE_REST + '/fapi/v1/ticker/24hr');
    if (!res.ok) return;
    var data = await res.json();
    // Convert REST format to WS format (frontend uses t.s, t.c, t.q, t.o)
    tickerCache = data.map(function (t) {
      return {
        e: '24hrTicker', s: t.symbol,
        c: t.lastPrice, o: t.openPrice,
        h: t.highPrice, l: t.lowPrice,
        v: t.volume, q: t.quoteVolume,
        p: t.priceChange, P: t.priceChangePercent,
      };
    });
    var msg = JSON.stringify({ type: 'ticker', data: tickerCache });
    clients.forEach(function (c) { if (c.readyState === WebSocket.OPEN) c.send(msg); });
  } catch (e) {
    console.error('[Binance] Initial fetch error:', e.message);
  }
}

// ── REST proxy ───────────────────────────────────────────────────────────

async function fetchBinance(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ── WebSocket Server (for frontend) ──────────────────────────────────────

var wss = new WebSocketServer({ port: PORT });
console.log('[Server] Pump Analyzer WS on port', PORT);

wss.on('connection', function (ws) {
  clients.add(ws);
  console.log('[Server] Client connected (' + clients.size + ' total)');

  if (tickerCache) {
    ws.send(JSON.stringify({ type: 'ticker', data: tickerCache }));
  }

  ws.on('message', async function (raw) {
    var msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    try {
      if (msg.type === 'get_ticker') {
        if (tickerCache) ws.send(JSON.stringify({ type: 'ticker', data: tickerCache }));
      }

      else if (msg.type === 'fetch_klines') {
        var url = BINANCE_REST + '/fapi/v1/klines?symbol=' + msg.symbol.toUpperCase() + 'USDT&interval=' + msg.tf + '&limit=' + (msg.limit || 300);
        var data = await fetchBinance(url);
        ws.send(JSON.stringify({ type: 'klines', _id: msg._id, symbol: msg.symbol, tf: msg.tf, data: data }));
      }

      else if (msg.type === 'fetch_natr') {
        var url = BINANCE_REST + '/fapi/v1/klines?symbol=' + msg.symbol.toUpperCase() + 'USDT&interval=5m&limit=30';
        var data = await fetchBinance(url);
        ws.send(JSON.stringify({ type: 'natr', _id: msg._id, symbol: msg.symbol, data: data }));
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

// ── Start ────────────────────────────────────────────────────────────────

fetchSymbols().then(function () {
  connectBinance();
  fetchFullTicker(); // initial data immediately
  // Refresh full ticker every 30s (to catch new coins)
  setInterval(fetchFullTicker, 30000);
});
