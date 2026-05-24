'use strict';

var config = require('./config.json');

var BINANCE_REST = 'https://fapi.binance.com';
var BUFFER_SIZE = config.windows.buffer_size;
var TFS = ['1m', '5m'];
var TF_MS = { '1m': 60000, '5m': 300000 };
var BOOTSTRAP_BATCH = 10;
var BOOTSTRAP_DELAY_MS = 500;

// klineBuffers['BTCUSDT']['1m'] = array of up to BUFFER_SIZE closed candles
var klineBuffers = {};

// lastCandleTime['BTCUSDT']['1m'] = open-time (ms) of the last closed candle in buffer
var lastCandleTime = {};

// ── Helpers ───────────────────────────────────────────────────────────────

async function fetchBinance(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// REST kline array → candle object
function parseRestCandle(arr) {
  return {
    time:   arr[0],               // open time ms
    open:   parseFloat(arr[1]),
    high:   parseFloat(arr[2]),
    low:    parseFloat(arr[3]),
    close:  parseFloat(arr[4]),
    volume: parseFloat(arr[5]),
    trades: parseInt(arr[8], 10), // number of trades
  };
}

// ── Public API ────────────────────────────────────────────────────────────

// Returns list of USDT symbols from tickerCache passing the 24h volume pre-filter
function getWatchlist(tickerCache) {
  var minQ = config.prefilter.min_quote_volume_24h;
  return Object.keys(tickerCache).filter(function (sym) {
    return sym.endsWith('USDT') && parseFloat(tickerCache[sym].q || 0) >= minQ;
  });
}

// Add a closed candle to the rolling buffer. Deduplicates by open time.
function pushCandle(symbol, tf, candle) {
  if (!klineBuffers[symbol]) klineBuffers[symbol] = {};
  if (!klineBuffers[symbol][tf]) klineBuffers[symbol][tf] = [];
  var buf = klineBuffers[symbol][tf];
  if (buf.length && buf[buf.length - 1].time === candle.time) {
    buf[buf.length - 1] = candle; // same candle re-sent, update in place
    return;
  }
  buf.push(candle);
  if (buf.length > BUFFER_SIZE) buf.shift();
  if (!lastCandleTime[symbol]) lastCandleTime[symbol] = {};
  lastCandleTime[symbol][tf] = candle.time;
}

// Returns the buffer (may be empty or partial before bootstrap finishes)
function getBuffer(symbol, tf) {
  return (klineBuffers[symbol] && klineBuffers[symbol][tf]) || [];
}

// Bootstrap: fetch last BUFFER_SIZE closed candles for all symbols × TFs.
// Batches 10 symbols at a time with 500ms pause to stay inside Binance rate limits.
async function bootstrapBuffers(symbols) {
  console.log('[Inplay] Bootstrapping buffers for', symbols.length, 'symbols...');
  var loaded = 0;
  var failed = 0;

  for (var i = 0; i < symbols.length; i += BOOTSTRAP_BATCH) {
    var batch = symbols.slice(i, i + BOOTSTRAP_BATCH);
    await Promise.all(batch.map(async function (sym) {
      if (!klineBuffers[sym]) klineBuffers[sym] = {};
      if (!lastCandleTime[sym]) lastCandleTime[sym] = {};
      await Promise.all(TFS.map(async function (tf) {
        if (!klineBuffers[sym][tf]) klineBuffers[sym][tf] = [];
        try {
          // limit=100 → request weight=1 (101+ costs weight=2 and risks 429 during concurrent D1Opens bootstrap)
          var data = await fetchBinance(
            BINANCE_REST + '/fapi/v1/klines?symbol=' + sym +
            '&interval=' + tf + '&limit=' + BUFFER_SIZE
          );
          // Drop the last candle — it may still be open
          var candles = data.slice(0, -1).map(parseRestCandle);
          klineBuffers[sym][tf] = candles;
          if (candles.length) lastCandleTime[sym][tf] = candles[candles.length - 1].time;
          loaded++;
        } catch (e) {
          failed++;
          // Leave buffer empty — prefilter (min_buffer_5m) will exclude this symbol
        }
      }));
    }));
    if (i + BOOTSTRAP_BATCH < symbols.length) {
      await new Promise(function (r) { setTimeout(r, BOOTSTRAP_DELAY_MS); });
    }
  }

  var symCount = loaded / TFS.length;
  console.log('[Inplay] Bootstrap done —', symCount, '/', symbols.length, 'symbols loaded' +
    (failed ? ', ' + failed + ' TF-fetches failed' : ''));
}

// Gap-fill a single symbol/TF: fetch candles that arrived while WS was down
async function fillGap(symbol, tf) {
  if (!lastCandleTime[symbol] || !lastCandleTime[symbol][tf]) return;
  var since = lastCandleTime[symbol][tf] + TF_MS[tf];
  if (since >= Date.now()) return; // no gap
  try {
    var limit = Math.min(Math.ceil((Date.now() - since) / TF_MS[tf]) + 2, BUFFER_SIZE);
    var data = await fetchBinance(
      BINANCE_REST + '/fapi/v1/klines?symbol=' + symbol +
      '&interval=' + tf + '&startTime=' + since + '&limit=' + limit
    );
    // Drop the last element — it may be the currently-open candle
    var candles = data.slice(0, -1).map(parseRestCandle);
    candles.forEach(function (c) { pushCandle(symbol, tf, c); });
    if (candles.length) {
      console.log('[Inplay] Gap-fill', symbol, tf, '+' + candles.length);
    }
  } catch (e) {
    // non-fatal — next tick will self-correct via WS
  }
}

// Fill gaps for all symbols after a WS reconnect. Batched to avoid rate-limit burst.
async function fillAllGaps(symbols) {
  var GAP_BATCH = 20;
  for (var i = 0; i < symbols.length; i += GAP_BATCH) {
    var batch = symbols.slice(i, i + GAP_BATCH);
    await Promise.all(batch.map(function (sym) {
      return Promise.all(TFS.map(function (tf) { return fillGap(sym, tf); }));
    }));
  }
}

module.exports = { getWatchlist, bootstrapBuffers, pushCandle, getBuffer, fillAllGaps };
