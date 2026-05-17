const { WebSocketServer, WebSocket } = require('ws');

var PORT = process.env.WSS_PORT || 3001;
var BINANCE_REST = 'https://fapi.binance.com';

var clients = new Set();
var tickerCache = null;
var binanceWS = null;

// ── Binance WebSocket (real-time tickers via SUBSCRIBE) ──────────────────

function connectBinance() {
  binanceWS = new WebSocket('wss://fstream.binance.com/ws');

  binanceWS.on('open', function () {
    console.log('[Binance] Connected, subscribing to !miniTicker@arr');
    binanceWS.send(JSON.stringify({
      method: 'SUBSCRIBE',
      params: ['!miniTicker@arr'],
      id: 1,
    }));
  });

  binanceWS.on('message', function (raw) {
    try {
      var parsed = JSON.parse(raw.toString());
      // SUBSCRIBE confirmation
      if (parsed.id === 1 && parsed.result === null) {
        console.log('[Binance] Subscribed to !miniTicker@arr');
        return;
      }
      // Ticker data
      if (Array.isArray(parsed)) {
        tickerCache = parsed;
        var msg = JSON.stringify({ type: 'ticker', data: parsed });
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

// ── Binance REST proxy ───────────────────────────────────────────────────

async function fetchBinance(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ── WebSocket Server (for frontend) ──────────────────────────────────────

var wss = new WebSocketServer({ port: PORT });
console.log('[Server] Pump Analyzer WS running on port', PORT);

wss.on('connection', function (ws) {
  clients.add(ws);
  console.log('[Server] Client connected (' + clients.size + ' total)');

  // Send cached ticker immediately on connect
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

connectBinance();
