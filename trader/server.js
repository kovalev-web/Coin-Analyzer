'use strict';

// Trader process entry point. Internal HTTP API on 127.0.0.1 only; every
// request must carry x-trader-secret. pump-ws is the only caller.
//
//   GET  /status        → { env, tradingEnabled, positionMode, streamConnected, lastSyncAt }
//   GET  /account       → { balances, positions, orders, algoOrders }
//   GET  /rules?symbol= → tick/lot/notional rules for one symbol
//   GET  /events        → Server-Sent Events stream of trader events
//   POST /order         → place (MARKET | LIMIT | STOP_MARKET | TAKE_PROFIT_MARKET)
//   POST /cancel        → { symbol, orderId | clientOrderId } or { algoId | clientAlgoId }
//   POST /cancel-all    → { symbol }
//   POST /move          → { symbol, orderId | algoId, price } drag in the ladder
//   POST /leverage      → { symbol, leverage }
//   POST /kill          → { closePositions? }  — disable trading + cancel everything
//   POST /resume        → re-enable trading
//   GET  /keys          → which environments have a key saved (masked, never the secret)
//   POST /keys          → { env, apiKey, apiSecret } — validate with Binance, store encrypted
//   POST /keys/delete   → { env }
//   GET  /history/trades?symbol=&startTime=&endTime=  → Binance userTrades (read-only)
//   GET  /history/income?incomeType=&startTime=&endTime= → Binance income (read-only)
//   GET  /2fa           → { enabled, unlockedUntil, required }
//   POST /2fa/setup     → new pending seed { secret, uri }
//   POST /2fa/confirm   → { code } enables 2FA with the pending seed
//   POST /2fa/disable   → { code }
//   POST /unlock        → { code } opens trading for UNLOCK_MS
//   POST /lock          → closes it now
//
// With 2FA on, opening risk (new orders, leverage, resume) needs an unlock;
// cancels, kill and reduce-only / close-position orders always work. Live
// trading refuses to run without 2FA.
//
// Keys for the active environment (config.env) are hot-swapped: saving or
// deleting them restarts the Binance client and user data stream in place.

var http = require('http');
var fs = require('fs');
var crypto = require('crypto');
var { loadConfig } = require('./config');
var { createClient } = require('./binance');
var { createAudit } = require('./audit');
var { createUserStream } = require('./userstream');
var { createLocalStops, marketTradesUrl } = require('./localstops');
var { Trader } = require('./trader');
var { describeError } = require('./errors');
var { createStore } = require('./credentials');
var { validateKeys } = require('./keys');
var { ENDPOINTS } = require('./config');
var totp = require('./totp');
var path = require('path');

var MAX_BODY = 16 * 1024;
var UNLOCK_MS = 12 * 60 * 60 * 1000;
var RULES_REFRESH_MS = 60 * 60 * 1000;
var TIME_SYNC_MS = 10 * 60 * 1000;

var config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

var audit = createAudit(config.dataDir);
var storeFile = config.credentialsFile || path.join(config.dataDir, 'credentials.enc');
var store = config.masterKey ? createStore(storeFile, config.masterKey) : null;
// Testnet is practice money (test mode in the terminal): no 2FA lock there
var PRACTICE = config.env !== 'mainnet';
var client = null;   // Binance client for the active key (null = no key yet)
var stream = null;   // user data stream for that client
var generation = 0;  // bumps on every key change; stale retries stop themselves
var trader = new Trader({ client: null, dataDir: config.dataDir, audit: audit });
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

// Local stops: watch trades on symbols with an SL / TP and close at once when
// one prints through it; the exchange order stays as the backup
var localStops = config.localStops ? createLocalStops({ trader: trader, url: marketTradesUrl(config.marketWs) }) : null;
trader.on('event', function (ev) {
  if (localStops && (ev.type === 'algo' || ev.type === 'snapshot' || ev.type === 'position')) localStops.sync();
});

var sseClients = new Set();
trader.on('event', function (ev) {
  var line = 'data: ' + JSON.stringify(ev) + '\n\n';
  sseClients.forEach(function (res) { res.write(line); });
});
setInterval(function () {
  sseClients.forEach(function (res) { res.write(': ping\n\n'); });
}, 15000);

// ── 2FA ──────────────────────────────────────────────────────────────────

var unlockedUntil = 0;
var codeFails = [];

function twoFactor() { return store ? store.getSecure('totp') : null; }
function twoFactorEnabled() { var t = twoFactor(); return !!(t && t.enabled); }

function terr(status, message) { return Object.assign(new Error(message), { name: 'TraderError', status: status }); }

// Verifies a code against the enabled seed (or the pending one while
// confirming), with replay protection and throttling of wrong codes.
function checkCode(code, usePending) {
  var now = Date.now();
  codeFails = codeFails.filter(function (t) { return now - t < 15 * 60 * 1000; });
  if (codeFails.length >= 5) throw terr(429, 'Too many wrong codes. Try again in 15 minutes.');
  var t = twoFactor();
  var seed = t && (usePending ? t.pending : (t.enabled && t.secret));
  if (!seed) throw terr(400, usePending ? 'Start 2FA setup first' : '2FA is not set up');
  var counter = totp.verify(seed, code, now);
  if (counter == null || (!usePending && t.lastCounter != null && counter <= t.lastCounter)) {
    codeFails.push(now);
    throw terr(403, 'Wrong or already used code');
  }
  return counter;
}

// checkCode + remember the counter so the same code can't be reused
function useCode(code) {
  var counter = checkCode(code, false);
  var t = twoFactor();
  t.lastCounter = counter;
  store.setSecure('totp', t);
}

function twoFactorStatus() {
  if (PRACTICE) return { enabled: false, unlockedUntil: 0, required: false, practice: true };
  return {
    enabled: twoFactorEnabled(),
    unlockedUntil: unlockedUntil > Date.now() ? unlockedUntil : 0,
    required: config.env === 'mainnet',
  };
}

function emitStatus() { trader.emit('event', { type: 'status', status: statusBody() }); }

// Opening risk needs an unlock when 2FA is on; live needs 2FA at all.
function requireUnlocked(b) {
  var reducing = b && (b.reduceOnly === true || b.reduceOnly === 'true' || b.closePosition === true || b.closePosition === 'true');
  if (reducing || PRACTICE) return;
  if (!twoFactorEnabled()) {
    if (config.env === 'mainnet') throw terr(423, 'Set up 2FA in your account before live trading');
    return;
  }
  if (unlockedUntil <= Date.now()) throw terr(423, 'Trading is locked — enter your 2FA code');
}

function locked(fn) {
  return function (b, q) { requireUnlocked(b); return fn(b, q); };
}

// Journal/briefing reads: time window and limit only, nothing else passes through
function historyParams(q, extra) {
  var p = Object.assign({}, extra);
  ['startTime', 'endTime'].forEach(function (k) { var v = Number(q.get(k)); if (v > 0) p[k] = Math.floor(v); });
  p.limit = Math.min(1000, Math.max(1, Number(q.get('limit')) || 1000));
  return p;
}

function needKey(fn) {
  return function (b, q) {
    if (!client) throw Object.assign(new Error('No trading key saved for ' + config.env), { name: 'TraderError', status: 503 });
    return fn(b, q);
  };
}

function statusBody() {
  return Object.assign({ env: config.env, localStops: !!localStops, marketWs: config.marketWs, marketRest: config.rest, publicIp: config.publicIp, configured: !!client, twoFactor: twoFactorStatus() }, trader.getStatus());
}

var routes = {
  'GET /status': statusBody,
  'GET /rules': function (b, q) { return trader.getRules(q.get('symbol')); },
  'GET /account': function () { return trader.getAccount(); },
  'POST /order': needKey(locked(function (b) { return trader.placeOrder(b); })),
  'POST /cancel': needKey(function (b) { return trader.cancel(b); }),
  // Opening-risk orders need the 2FA unlock (checked inside, after reading the order)
  'POST /move': needKey(function (b) { return trader.move(b, { requireUnlocked: function () { requireUnlocked({}); } }); }),
  'POST /cancel-all': needKey(function (b) { return trader.cancelAll(b); }),
  'POST /leverage': needKey(locked(function (b) { return trader.setLeverage(b); })),
  'POST /kill': needKey(function (b) { return trader.kill(b); }),
  'POST /resume': locked(function () { return trader.resume(); }),
  'GET /keys': function () { return describeKeys(); },
  'POST /keys': function (b) { return saveKeys(b); },
  'POST /keys/delete': function (b) { return deleteKeys(b); },
  'GET /history/trades': needKey(function (b, q) {
    var symbol = String(q.get('symbol') || '').toUpperCase();
    if (!/^[A-Z0-9]{2,30}$/.test(symbol)) throw terr(400, 'Invalid symbol');
    return client.request('GET', '/fapi/v1/userTrades', historyParams(q, { symbol: symbol }));
  }),
  'GET /history/income': needKey(function (b, q) {
    var type = q.get('incomeType');
    if (type && !/^[A-Z_]{3,40}$/.test(type)) throw terr(400, 'Invalid incomeType');
    return client.request('GET', '/fapi/v1/income', historyParams(q, { incomeType: type || undefined }));
  }),
  'GET /2fa': function () { return twoFactorStatus(); },
  'POST /2fa/setup': function () {
    requireStore();
    if (twoFactorEnabled()) throw terr(409, '2FA is already on — disable it first');
    var secret = totp.generateSecret();
    store.setSecure('totp', { pending: secret });
    audit('2fa-setup', {}, { result: { started: true } });
    return { secret: secret, uri: totp.otpauthUri(secret, 'trading', 'QuestTick') };
  },
  'POST /2fa/confirm': function (b) {
    requireStore();
    var counter = checkCode(b.code, true);
    var t = twoFactor();
    store.setSecure('totp', { secret: t.pending, enabled: true, lastCounter: counter, enabledAt: new Date().toISOString() });
    audit('2fa-enable', {}, { result: { enabled: true } });
    emitStatus();
    return twoFactorStatus();
  },
  'POST /2fa/disable': function (b) {
    requireStore();
    checkCode(b.code, false);
    store.setSecure('totp', null);
    unlockedUntil = 0;
    audit('2fa-disable', {}, { result: { enabled: false } });
    emitStatus();
    return twoFactorStatus();
  },
  'POST /unlock': function (b) {
    useCode(b.code);
    unlockedUntil = Date.now() + UNLOCK_MS;
    audit('unlock', {}, { result: { until: new Date(unlockedUntil).toISOString() } });
    emitStatus();
    return twoFactorStatus();
  },
  'POST /lock': function () {
    unlockedUntil = 0;
    audit('lock', {}, { result: { locked: true } });
    emitStatus();
    return twoFactorStatus();
  },
};

// ── Keys ───────────────────────────────────────────────────────────────────

function requireStore() {
  if (!store) throw Object.assign(new Error('Key storage is not set up (masterKey missing in trader config)'), { name: 'TraderError', status: 503 });
}

function describeKeys() {
  var keys = store ? store.describe() : { testnet: null, mainnet: null };
  // Legacy: keys still written in the config file count for the active env
  if (!keys[config.env] && config.apiKey) keys[config.env] = { apiKey: require('./credentials').mask(config.apiKey), savedAt: null, source: 'config' };
  return { activeEnv: config.env, keys: keys };
}

async function saveKeys(b) {
  requireStore();
  if (twoFactorEnabled()) useCode(b.code);
  var env = b.env, apiKey = String(b.apiKey || '').trim(), apiSecret = String(b.apiSecret || '').trim();
  if (!ENDPOINTS[env]) throw Object.assign(new Error('env must be testnet or mainnet'), { name: 'TraderError', status: 400 });
  if (!/^[A-Za-z0-9]{16,128}$/.test(apiKey) || !/^[A-Za-z0-9]{16,128}$/.test(apiSecret)) {
    throw Object.assign(new Error('API key and secret look malformed'), { name: 'TraderError', status: 400 });
  }
  var v;
  try {
    v = await validateKeys({ env: env, rest: ENDPOINTS[env].rest, apiKey: apiKey, apiSecret: apiSecret });
  } catch (e) {
    audit('keys-save', { env: env }, { error: { message: e.message, code: e.code } });
    throw Object.assign(new Error('Binance rejected the key: ' + describeError(e).message), { name: 'TraderError', status: 400 });
  }
  if (!v.ok) {
    audit('keys-save', { env: env }, { error: { message: v.error } });
    throw Object.assign(new Error(v.error), { name: 'TraderError', status: 400 });
  }
  store.set(env, { apiKey: apiKey, apiSecret: apiSecret, checks: v.checks });
  audit('keys-save', { env: env, apiKey: require('./credentials').mask(apiKey) }, { result: v.checks });
  if (env === config.env) activate();
  return Object.assign(describeKeys(), { saved: env, checks: v.checks });
}

function deleteKeys(b) {
  requireStore();
  if (twoFactorEnabled()) useCode(b.code);
  if (!ENDPOINTS[b.env]) throw Object.assign(new Error('env must be testnet or mainnet'), { name: 'TraderError', status: 400 });
  store.remove(b.env);
  audit('keys-delete', { env: b.env }, { result: { ok: true } });
  if (b.env === config.env) activate();
  return describeKeys();
}

function activeCreds() {
  var c = store ? store.get(config.env) : null;
  if (c) return c;
  if (config.apiKey && config.apiSecret) return { apiKey: config.apiKey, apiSecret: config.apiSecret };
  return null;
}

var server = http.createServer(async function (req, res) {
  if (!authorized(req)) return send(res, 401, { error: { message: 'Unauthorized' } });
  var parsed = new URL(req.url, 'http://local');
  var url = parsed.pathname;

  if (req.method === 'GET' && url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify({ type: 'status', status: statusBody() }) + '\n\n');
    sseClients.add(res);
    req.on('close', function () { sseClients.delete(res); });
    return;
  }

  var handler = routes[req.method + ' ' + url];
  if (!handler) return send(res, 404, { error: { message: 'Not found' } });
  try {
    var body = req.method === 'POST' ? await readJson(req) : {};
    send(res, 200, await handler(body, parsed.searchParams));
  } catch (e) {
    sendError(res, e);
  }
});

// (Re)build the Binance client and user data stream from the active key.
function activate() {
  var gen = ++generation;
  if (stream) { stream.stop(); stream = null; }
  trader.setStreamStatus(false);
  var creds = activeCreds();
  if (!creds) {
    client = null;
    trader.client = null;
    console.log('[Trader] No trading key for', config.env, '— waiting for one');
    trader.emit('event', { type: 'status', status: statusBody() });
    return;
  }
  client = createClient({ rest: config.rest, apiKey: creds.apiKey, apiSecret: creds.apiSecret });
  trader.client = client;
  var s = createUserStream({
    client: client,
    urls: config.userStream,
    events: config.userStreamEvents,
    onMessage: function (msg) { if (gen === generation) trader.handleStreamEvent(msg); },
    onStatus: function (connected) {
      if (gen !== generation) return;
      trader.setStreamStatus(connected);
      if (connected) resyncWithRetry(gen);
    },
  });
  stream = s;
  start(gen);
}

function resyncWithRetry(gen) {
  if (gen !== generation) return;
  trader.resync().catch(function (e) {
    console.error('[Trader] resync failed:', e.message, '— retrying in 10s');
    setTimeout(function () { resyncWithRetry(gen); }, 10000);
  });
}

async function start(gen) {
  if (gen !== generation) return;
  try {
    await trader.init();
  } catch (e) {
    if (gen !== generation) return;
    console.error('[Trader] init failed:', describeError(e).message, '— retrying in 15s');
    return setTimeout(function () { start(gen); }, 15000);
  }
  if (gen !== generation) return;
  console.log('[Trader] Ready on', config.env, '| position mode:', trader.positionMode,
    '| trading', trader.tradingEnabled ? 'enabled' : 'DISABLED');
  stream.start();
}

setInterval(function () {
  if (client) trader.loadRules().catch(function (e) { console.error('[Trader] rules refresh failed:', e.message); });
}, RULES_REFRESH_MS);
setInterval(function () { if (client) client.syncTime().catch(function () {}); }, TIME_SYNC_MS);

// A shared key store can be changed by the other trader process (keys are
// saved through the live one): pick up a new key for our env without a restart.
if (store && config.credentialsFile) {
  var lastKey = (activeCreds() || {}).apiKey || null;
  fs.watchFile(storeFile, { interval: 5000 }, function () {
    var k = null;
    try { k = (activeCreds() || {}).apiKey || null; } catch (e) { return; }
    if (k !== lastKey) { lastKey = k; console.log('[Trader] Key store changed — reloading the', config.env, 'key'); activate(); }
  });
}

server.listen(config.port, '127.0.0.1', function () {
  console.log('[Trader] Listening on 127.0.0.1:' + config.port + ' (' + config.env + ')'
    + (store ? '' : ' — key storage disabled (no masterKey)'));
  activate();
});

process.on('SIGTERM', function () { if (stream) stream.stop(); if (localStops) localStops.stop(); server.close(); process.exit(0); });
