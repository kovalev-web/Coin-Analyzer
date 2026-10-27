'use strict';

// Trader config lives in its own JSON file (not in pump-ws .env) so the
// Binance keys are readable only by the trader process. Default location:
// /etc/questtick-trader/config.json, override with TRADER_CONFIG.
//
// {
//   "env": "testnet",                 // "testnet" | "mainnet"
//   "allowMainnet": false,            // must be true to run against real money
//   "masterKey": "64 hex chars",       // encrypts keys saved from the account page
//   "apiKey": "...",                  // optional legacy key for the active env;
//   "apiSecret": "...",               //   keys saved in the account page take precedence
//   "internalSecret": "...",          // shared with pump-ws (TRADER_INTERNAL_SECRET)
//   "port": 3010,
//   "dataDir": "/var/lib/questtick-trader",
//   "credentialsFile": "...",         // optional: share the key store with another
//                                     //   trader process (test mode runs a testnet one)
//   "localStops": true                // default on: close at once when a trade hits
//                                     //   your SL / TP (localstops.js); false = exchange only
// }

var fs = require('fs');

// Testnet = Binance "Demo Trading" for USDⓈ-M futures. Keys are created at
// demo.binance.com, not on the main site.
var ENDPOINTS = {
  testnet: {
    rest: 'https://demo-fapi.binance.com',
    marketWs: 'wss://demo-fstream.binance.com/public/ws',
    userStream: [
      'wss://demo-fstream.binance.com/private/ws?listenKey={listenKey}&events={events}',
      'wss://demo-fstream.binance.com/ws/{listenKey}',
      'wss://fstream.binancefuture.com/ws/{listenKey}',
    ],
  },
  mainnet: {
    rest: 'https://fapi.binance.com',
    marketWs: 'wss://fstream.binance.com/public/ws',
    userStream: [
      'wss://fstream.binance.com/private/ws?listenKey={listenKey}&events={events}',
    ],
  },
};

var USER_STREAM_EVENTS = ['ORDER_TRADE_UPDATE', 'ACCOUNT_UPDATE', 'ALGO_UPDATE'];

function loadConfig(path) {
  var file = path || process.env.TRADER_CONFIG || '/etc/questtick-trader/config.json';
  var raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return buildConfig(raw);
}

function buildConfig(raw) {
  var env = raw.env || 'testnet';
  if (!ENDPOINTS[env]) throw new Error('Unknown env: ' + env);
  if (env === 'mainnet' && raw.allowMainnet !== true) {
    throw new Error('Refusing to start on mainnet without "allowMainnet": true');
  }
  if (raw.masterKey && !/^[0-9a-f]{64}$/i.test(raw.masterKey)) throw new Error('masterKey must be 64 hex chars');
  if (!raw.internalSecret || String(raw.internalSecret).length < 32) {
    throw new Error('internalSecret must be at least 32 characters');
  }
  var ep = ENDPOINTS[env];
  return {
    env: env,
    apiKey: raw.apiKey || null,
    apiSecret: raw.apiSecret || null,
    masterKey: raw.masterKey || null,
    publicIp: raw.publicIp || null,     // shown in the account page for the key IP whitelist
    internalSecret: String(raw.internalSecret),
    port: raw.port || 3010,
    dataDir: raw.dataDir || '/var/lib/questtick-trader',
    credentialsFile: raw.credentialsFile || null,
    rest: raw.rest || ep.rest,
    marketWs: raw.marketWs || ep.marketWs,
    userStream: raw.userStream ? [].concat(raw.userStream) : ep.userStream,
    userStreamEvents: USER_STREAM_EVENTS,
    localStops: raw.localStops !== false,
  };
}

module.exports = { loadConfig, buildConfig, ENDPOINTS };
