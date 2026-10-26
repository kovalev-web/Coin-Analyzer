// ── Other venues for the open coin (order book terminal) ────────────────────
// Public trade streams, straight from the browser (no keys): Binance futures,
// Binance spot, Bybit linear and OKX swap. Every trade goes to onTrade, priced
// on the Binance futures ladder (the tape, and the flash in the venue columns).
// A venue that doesn't list the coin just stays silent. Always the real
// market, also in Test mode.

import { splitSymbol, ladderPrice } from './venues-stats.js';

export var VENUES = [
  { id: 'BF', name: 'Binance F', short: '' },  // home venue: unlabeled on the tape
  { id: 'BS', name: 'Binance S', short: 'S' },
  { id: 'BB', name: 'Bybit F', short: 'B' },
  { id: 'OK', name: 'OKX F', short: 'O' },
];


var V = { sym: null, socks: [], timers: [], onTrade: null, gen: 0 };

function _push(id, t, price, usd, buy) {
  if (V.onTrade) V.onTrade(id, price, usd, buy, t);
}

function _ws(url, onOpen, onMessage, ping) {
  var gen = V.gen, sock, timer;
  function connect() {
    if (gen !== V.gen) return;
    sock = new WebSocket(url);
    V.socks.push(sock);
    sock.onopen = function () {
      if (onOpen) onOpen(sock);
      if (ping) timer = setInterval(function () { try { sock.send(ping); } catch (e) {} }, 20000);
    };
    sock.onmessage = function (ev) {
      if (gen !== V.gen) return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      onMessage(m);
    };
    sock.onclose = function () {
      clearInterval(timer);
      if (gen === V.gen) V.timers.push(setTimeout(connect, 3000));
    };
  }
  connect();
}

export function venuesStart(futuresSymbol, onTrade) {
  venuesStop();
  var gen = V.gen;
  V.sym = futuresSymbol;
  V.onTrade = onTrade;
  var sp = splitSymbol(futuresSymbol), mult = sp.mult, s = futuresSymbol.toLowerCase();

  // Binance futures and spot: aggTrade (m = buyer is maker → the aggressor sold)
  _ws('wss://fstream.binance.com/market/ws/' + s + '@aggTrade', null, function (d) {
    if (d.e === 'aggTrade') _push('BF', d.T, Number(d.p), Number(d.p) * Number(d.q), !d.m);
  });
  _ws('wss://stream.binance.com:9443/ws/' + (sp.coin + 'USDT').toLowerCase() + '@aggTrade', null, function (d) {
    if (d.e === 'aggTrade') _push('BS', d.T, ladderPrice(d.p, mult), Number(d.p) * Number(d.q), !d.m);
  });

  // Bybit linear: same symbol as Binance futures (1000PEPEUSDT too); S = taker side
  _ws('wss://stream.bybit.com/v5/public/linear', function (sock) {
    sock.send(JSON.stringify({ op: 'subscribe', args: ['publicTrade.' + futuresSymbol] }));
  }, function (m) {
    if (!m.topic || !Array.isArray(m.data)) return;
    m.data.forEach(function (x) { _push('BB', Number(x.T), Number(x.p), Number(x.p) * Number(x.v), x.S === 'Buy'); });
  }, JSON.stringify({ op: 'ping' }));

  // OKX swap: size is in contracts → × ctVal coins; priced per single coin
  var instId = sp.coin + '-USDT-SWAP';
  fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=' + instId).then(function (r) { return r.json(); }).then(function (j) {
    if (gen !== V.gen || !j || !j.data || !j.data.length) return;
    var ctVal = Number(j.data[0].ctVal) || 1;
    _ws('wss://ws.okx.com:8443/ws/v5/public', function (sock) {
      sock.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'trades', instId: instId }] }));
    }, function (m) {
      if (!m.arg || m.arg.channel !== 'trades' || !Array.isArray(m.data)) return;
      m.data.forEach(function (x) {
        var px = Number(x.px), qty = Number(x.sz) * ctVal;
        _push('OK', Number(x.ts), ladderPrice(px, mult), px * qty, x.side === 'buy');
      });
    }, 'ping');
  }).catch(function () {});
}

export function venuesStop() {
  V.gen++;
  V.socks.forEach(function (s) { try { s.close(); } catch (e) {} });
  V.timers.forEach(clearTimeout);
  V.socks = []; V.timers = [];
  V.sym = null; V.onTrade = null;
}
