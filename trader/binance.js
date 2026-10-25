'use strict';

// Minimal signed REST client for Binance USDⓈ-M futures.
// HMAC-SHA256 only (Tiger.com Broker keys are HMAC).

var crypto = require('crypto');

var RECV_WINDOW = 5000;
var REQUEST_TIMEOUT_MS = 10000;

class BinanceError extends Error {
  constructor(message, opts) {
    super(message);
    this.name = 'BinanceError';
    this.status = opts.status || null;       // HTTP status, null when the request never got a response
    this.code = opts.code != null ? opts.code : null; // Binance error code, e.g. -2019
    this.retryAfter = opts.retryAfter || null; // seconds, for 418/429
    this.noResponse = !!opts.noResponse;     // network error / timeout: outcome unknown
  }
}

function buildQuery(params) {
  return Object.keys(params)
    .filter(function (k) { return params[k] !== undefined && params[k] !== null; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])); })
    .join('&');
}

function sign(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

function createClient(opts) {
  var base = opts.rest;
  var apiKey = opts.apiKey;
  var apiSecret = opts.apiSecret;
  var fetchImpl = opts.fetch || fetch;
  var now = opts.now || Date.now;
  var timeOffset = 0; // serverTime - localTime

  async function syncTime() {
    var t0 = now();
    var data = await rawRequest('GET', '/fapi/v1/time', {}, false, false);
    var t1 = now();
    timeOffset = data.serverTime - Math.round((t0 + t1) / 2);
    return timeOffset;
  }

  async function rawRequest(method, path, params, signed, withKey) {
    var p = Object.assign({}, params);
    if (signed) {
      p.recvWindow = RECV_WINDOW;
      p.timestamp = now() + timeOffset;
    }
    var query = buildQuery(p);
    if (signed) query += (query ? '&' : '') + 'signature=' + sign(query, apiSecret);
    var url = base + path + (query ? '?' + query : '');
    var headers = {};
    if (signed || withKey) headers['X-MBX-APIKEY'] = apiKey;

    var res;
    try {
      res = await fetchImpl(url, { method: method, headers: headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      throw new BinanceError('Network error: ' + e.message, { noResponse: true });
    }
    var text = await res.text();
    var body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      var retryAfter = parseInt(res.headers.get('retry-after') || '', 10) || null;
      var msg = (body && body.msg) || ('HTTP ' + res.status);
      throw new BinanceError(msg, {
        status: res.status,
        code: body && body.code,
        retryAfter: retryAfter,
        // 5xx with -1007 (timeout waiting for backend) means the order may or may not exist
        noResponse: res.status >= 500 && (!body || body.code === -1007),
      });
    }
    return body;
  }

  async function request(method, path, params, signed) {
    try {
      return await rawRequest(method, path, params || {}, signed !== false, false);
    } catch (e) {
      // -1021: timestamp outside recvWindow — resync clock once and retry
      if (e.code === -1021 && signed !== false) {
        await syncTime();
        return rawRequest(method, path, params || {}, true, false);
      }
      throw e;
    }
  }

  // listenKey endpoints need the API key header but no signature
  function keyedRequest(method, path, params) {
    return rawRequest(method, path, params || {}, false, true);
  }

  return {
    syncTime: syncTime,
    request: request,
    keyedRequest: keyedRequest,
    getTimeOffset: function () { return timeOffset; },
  };
}

module.exports = { createClient, BinanceError, buildQuery, sign };
