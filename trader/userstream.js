'use strict';

// Binance User Data Stream: listenKey lifecycle + WebSocket with reconnect.
// Every (re)connect is reported via onStatus(true) so the trader can resync
// from REST and not miss anything that happened while disconnected.

var KEEPALIVE_MS = 30 * 60 * 1000;          // listenKey lives 60 min
var FORCED_RECONNECT_MS = 23 * 60 * 60 * 1000; // Binance drops connections at 24h
var BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

function createUserStream(opts) {
  var client = opts.client;
  var templates = opts.urls;
  var events = (opts.events || []).join('/');
  var WebSocketImpl = opts.WebSocket || require('ws');
  var onMessage = opts.onMessage;
  var onStatus = opts.onStatus || function () {};
  var log = opts.log || console;

  var ws = null;
  var urlIndex = 0;
  var attempt = 0;
  var stopped = false;
  var keepaliveTimer = null;
  var forcedTimer = null;
  var reconnectTimer = null;

  function buildUrl(listenKey) {
    return templates[urlIndex]
      .replace('{listenKey}', encodeURIComponent(listenKey))
      .replace('{events}', events);
  }

  async function connect() {
    if (stopped) return;
    var listenKey;
    try {
      listenKey = (await client.keyedRequest('POST', '/fapi/v1/listenKey')).listenKey;
    } catch (e) {
      log.error('[UserStream] listenKey failed:', e.message);
      return scheduleReconnect();
    }
    var opened = false;
    var url = buildUrl(listenKey);
    ws = new WebSocketImpl(url);

    ws.on('open', function () {
      opened = true;
      attempt = 0;
      log.log('[UserStream] Connected via', templates[urlIndex].split('?')[0].replace('{listenKey}', '…'));
      startKeepalive();
      clearTimeout(forcedTimer);
      forcedTimer = setTimeout(function () { if (ws) ws.close(); }, FORCED_RECONNECT_MS);
      onStatus(true);
    });

    ws.on('message', function (raw) {
      var msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg && msg.data && msg.stream) msg = msg.data; // stream-mode wrapper
      if (msg.e === 'listenKeyExpired') {
        log.log('[UserStream] listenKey expired, reconnecting');
        if (ws) ws.close();
        return;
      }
      try { onMessage(msg); } catch (e) { log.error('[UserStream] handler error:', e.message); }
    });

    ws.on('close', function () {
      stopKeepalive();
      clearTimeout(forcedTimer);
      ws = null;
      onStatus(false);
      // Never opened → this URL form doesn't work here, try the next one
      if (!opened && templates.length > 1) urlIndex = (urlIndex + 1) % templates.length;
      scheduleReconnect();
    });

    ws.on('error', function (e) {
      log.error('[UserStream] Error:', e.message);
    });
  }

  function scheduleReconnect() {
    if (stopped) return;
    var delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function startKeepalive() {
    stopKeepalive();
    keepaliveTimer = setInterval(function () {
      client.keyedRequest('PUT', '/fapi/v1/listenKey').catch(function (e) {
        log.error('[UserStream] keepalive failed:', e.message);
        if (e.code === -1125 && ws) ws.close(); // key gone → reconnect with a new one
      });
    }, KEEPALIVE_MS);
  }

  function stopKeepalive() { clearInterval(keepaliveTimer); keepaliveTimer = null; }

  return {
    start: connect,
    stop: function () {
      stopped = true;
      stopKeepalive();
      clearTimeout(forcedTimer);
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
    // for tests / manual recovery
    reconnect: function () { if (ws) ws.close(); },
  };
}

module.exports = { createUserStream };
