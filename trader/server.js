'use strict';

// Trader process entry point. Internal HTTP API on 127.0.0.1 only; every
// request must carry x-trader-secret. pump-ws is the only caller.
//
//   GET  /status        → { env, tradingEnabled, positionMode, streamConnected, lastSyncAt }
//   GET  /account       → { balances, positions, orders, algoOrders }
//   GET  /events        → Server-Sent Events stream of trader events
//   POST /order         → place (MARKET | LIMIT | STOP_MARKET | TAKE_PROFIT_MARKET)
//   POST /cancel        → { symbol, orderId | clientOrderId } or { algoId | clientAlgoId }
//   POST /cancel-all    → { symbol }
//   POST /leverage      → { symbol, leverage }
//   POST /kill          → { closePositions? }  — disable trading + cancel everything
//   POST /resume        → re-enable trading

var http = require('http');
var fs = require('fs');
var crypto = require('crypto');
var { loadConfig } = require('./config');
var { createClient } = require('./binance');
var { createAudit } = require('./audit');
var { createUserStream } = require('./userstream');
var { Trader } = require('./trader');
var { describeError } = require('./errors');

var MAX_BODY = 16 * 1024;
var RULES_REFRESH_MS = 60 * 60 * 1000;
var TIME_SYNC_MS = 10 * 60 * 1000;

var config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

var client = createClient({ rest: config.rest, apiKey: config.apiKey, apiSecret: config.apiSecret });
var trader = new Trader({ client: client, dataDir: config.dataDir, audit: createAudit(config.dataDir) });
var secretBuf = Buffer.from(config.internalSecret);

function authorized(req) {
  var got = Buffer.from(String(req.headers['x-trader-secret'] || ''));
  return got.length === secretBuf.length && crypto.timingSafeEqual(got, secretBuf);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res, e) {
  if (e.name === 'TraderError') return send(res, e.status, { error: { message: e.message } });
  var d = describeError(e);
  var status = e.status === 400 ? 400 : (e.status === 418 || e.status === 429) ? 503 : 502;
  send(res, status, { error: d });
}

function readJson(req) {
  return new Promise(function (resolve, reject) {
    var body = '';
    req.on('data', function (chunk) {
      body += chunk;
      if (body.length > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { name: 'TraderError', status: 413 })); req.destroy(); }
    });
    req.on('end', function () {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { name: 'TraderError', status: 400 })); }
    });
  });
}

var sseClients = new Set();
trader.on('event', function (ev) {
  var line = 'data: ' + JSON.stringify(ev) + '\n\n';
  sseClients.forEach(function (res) { res.write(line); });
});
setInterval(function () {
  sseClients.forEach(function (res) { res.write(': ping\n\n'); });
}, 15000);

var routes = {
  'GET /status': function () { return Object.assign({ env: config.env }, trader.getStatus()); },
  'GET /account': function () { return trader.getAccount(); },
  'POST /order': function (b) { return trader.placeOrder(b); },
  'POST /cancel': function (b) { return trader.cancel(b); },
  'POST /cancel-all': function (b) { return trader.cancelAll(b); },
  'POST /leverage': function (b) { return trader.setLeverage(b); },
  'POST /kill': function (b) { return trader.kill(b); },
  'POST /resume': function () { return trader.resume(); },
};

var server = http.createServer(async function (req, res) {
  if (!authorized(req)) return send(res, 401, { error: { message: 'Unauthorized' } });
  var url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify({ type: 'status', status: Object.assign({ env: config.env }, trader.getStatus()) }) + '\n\n');
    sseClients.add(res);
    req.on('close', function () { sseClients.delete(res); });
    return;
  }

  var handler = routes[req.method + ' ' + url];
  if (!handler) return send(res, 404, { error: { message: 'Not found' } });
  try {
    var body = req.method === 'POST' ? await readJson(req) : {};
    send(res, 200, await handler(body));
  } catch (e) {
    sendError(res, e);
  }
});

var stream = createUserStream({
  client: client,
  urls: config.userStream,
  events: config.userStreamEvents,
  onMessage: function (msg) { trader.handleStreamEvent(msg); },
  onStatus: function (connected) {
    trader.setStreamStatus(connected);
    if (connected) resyncWithRetry();
  },
});

function resyncWithRetry() {
  trader.resync().catch(function (e) {
    console.error('[Trader] resync failed:', e.message, '— retrying in 10s');
    setTimeout(resyncWithRetry, 10000);
  });
}

async function start() {
  try {
    await trader.init();
  } catch (e) {
    console.error('[Trader] init failed:', describeError(e).message, '— retrying in 15s');
    return setTimeout(start, 15000);
  }
  console.log('[Trader] Ready on', config.env, '| position mode:', trader.positionMode,
    '| trading', trader.tradingEnabled ? 'enabled' : 'DISABLED');
  stream.start();
  setInterval(function () { trader.loadRules().catch(function (e) { console.error('[Trader] rules refresh failed:', e.message); }); }, RULES_REFRESH_MS);
  setInterval(function () { client.syncTime().catch(function () {}); }, TIME_SYNC_MS);
}

server.listen(config.port, '127.0.0.1', function () {
  console.log('[Trader] Listening on 127.0.0.1:' + config.port + ' (' + config.env + ')');
  start();
});

process.on('SIGTERM', function () { stream.stop(); server.close(); process.exit(0); });
