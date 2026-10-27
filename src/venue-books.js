// ── Order books of other venues, for the columns next to the ladder ─────────
// Live local books for Binance spot, Bybit linear and OKX swap, straight from
// the browser. Each is a pair of Maps: price on the Binance futures ladder →
// USDT resting there. Re-synced on any gap. Read by src/terminal.js.
//   Binance spot: REST snapshot + @depth@100ms diffs (U / u sequence)
//   Bybit:        orderbook.1000 snapshot + deltas (size 0 = remove)
//   OKX:          books (400 levels) snapshot + updates, seqId / prevSeqId
//                 (size in contracts × ctVal)

import { splitSymbol } from './venues-stats.js';

// Levels per side each feed gives at most: past them the venue has orders we
// can't see, so those rows are marked "no data" rather than shown as empty
var DEPTH_LIMIT = { BS: 1000, BB: 1000, OK: 400 };

export var BOOK_VENUES = [
  { id: 'BS', name: 'Spot', title: 'Binance spot' },
  { id: 'BB', name: 'Bybit', title: 'Bybit futures' },
  { id: 'OK', name: 'OKX', title: 'OKX futures' },
];

var B = { gen: 0, socks: [], timers: [], books: {}, listed: {}, onStatus: null };

// The venue doesn't trade this coin (Binance -1121; Bybit not in the list or not
// 'Trading', e.g. delisted; OKX no instrument or not 'live'): its column header
// turns red and stays folded
function _notListed(id) {
  if (B.listed[id] === false) return;
  B.listed[id] = false;
  if (B.onStatus) B.onStatus(id, false);
}

function _book(id) {
  return (B.books[id] = { bids: new Map(), asks: new Map(), ready: false, mult: 1 });
}

// side map, ladder price, native price × native qty
function _set(map, ladderPx, usd) {
  if (usd > 0) map.set(ladderPx, usd); else map.delete(ladderPx);
}

// Close a socket for good (no reconnect): the venue doesn't list the coin
function _stop(sock) { sock._done = true; try { sock.close(); } catch (e) {} }

function _ws(url, onOpen, onMessage, ping, onDrop) {
  var gen = B.gen, sock, timer;
  function connect() {
    if (gen !== B.gen) return;
    sock = new WebSocket(url);
    B.socks.push(sock);
    sock.onopen = function () {
      if (onOpen) onOpen(sock);
      if (ping) timer = setInterval(function () { try { sock.send(ping); } catch (e) {} }, 20000);
    };
    sock.onmessage = function (ev) {
      if (gen !== B.gen) return;
      if (ev.data === 'pong') return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      onMessage(m, sock);
    };
    sock.onclose = function () {
      clearInterval(timer);
      if (onDrop) onDrop();
      if (gen === B.gen && !sock._done) B.timers.push(setTimeout(connect, 3000));
    };
  }
  connect();
}

function _binanceSpot(coin, mult) {
  var gen = B.gen, book = _book('BS'), sym = coin + 'USDT';
  book.mult = mult;
  var buffer = [], lastU = 0, syncing = false, spotSock = null;
  function apply(map, levels) {
    levels.forEach(function (l) { var p = Number(l[0]); _set(map, p * mult, p * Number(l[1])); });
  }
  function snapshot() {
    if (syncing) return;
    syncing = true; book.ready = false;
    fetch('https://api.binance.com/api/v3/depth?symbol=' + sym + '&limit=1000').then(function (r) { return r.json(); }).then(function (s) {
      syncing = false;
      if (gen !== B.gen || !s) return;
      if (s.code === -1121) { _notListed('BS'); if (spotSock) _stop(spotSock); return; }
      if (!s.lastUpdateId) return;
      book.bids.clear(); book.asks.clear();
      apply(book.bids, s.bids); apply(book.asks, s.asks);
      lastU = s.lastUpdateId;
      var queued = buffer; buffer = [];
      book.ready = true;
      queued.forEach(onDiff);
    }).catch(function () { syncing = false; });
  }
  function onDiff(d) {
    if (!book.ready) { buffer.push(d); return; }
    if (d.u <= lastU) return;                 // older than what we have
    if (d.U > lastU + 1) { snapshot(); return; } // gap → resync
    apply(book.bids, d.b); apply(book.asks, d.a);
    lastU = d.u;
  }
  _ws('wss://stream.binance.com:9443/ws/' + sym.toLowerCase() + '@depth@100ms', function (sock) { spotSock = sock; snapshot(); }, function (d) {
    if (d.e === 'depthUpdate') onDiff(d);
  }, null, function () { book.ready = false; });
}

function _bybit(symbol) {
  var gen = B.gen, book = _book('BB');
  // Bybit accepts a subscription to a closed (delisted) symbol and then stays
  // silent, so ask the instrument list first: listed means status Trading
  fetch('https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=' + symbol).then(function (r) { return r.json(); }).then(function (j) {
    if (gen !== B.gen) return;
    var it = j && j.result && j.result.list && j.result.list[0];
    if (!it || it.status !== 'Trading') { _notListed('BB'); return; }
    _bybitStream(symbol, book);
  }).catch(function () { if (gen === B.gen) _bybitStream(symbol, book); }); // REST unreachable → just try the stream
}

function _bybitStream(symbol, book) {
  _ws('wss://stream.bybit.com/v5/public/linear', function (sock) {
    sock.send(JSON.stringify({ op: 'subscribe', args: ['orderbook.1000.' + symbol] }));
  }, function (m, sock) {
    if (m.op === 'subscribe' && m.success === false) { _notListed('BB'); _stop(sock); return; }
    if (!m.topic || !m.data) return;
    if (m.type === 'snapshot') { book.bids.clear(); book.asks.clear(); book.ready = true; }
    if (!book.ready) return;
    (m.data.b || []).forEach(function (l) { var p = Number(l[0]); _set(book.bids, p, p * Number(l[1])); });
    (m.data.a || []).forEach(function (l) { var p = Number(l[0]); _set(book.asks, p, p * Number(l[1])); });
  }, JSON.stringify({ op: 'ping' }), function () { book.ready = false; });
}

function _okx(coin, mult) {
  var gen = B.gen, book = _book('OK'), instId = coin + '-USDT-SWAP';
  book.mult = mult;
  fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=' + instId).then(function (r) { return r.json(); }).then(function (j) {
    if (gen !== B.gen || !j) return;
    if (!j.data || !j.data.length || (j.data[0].state && j.data[0].state !== 'live')) { _notListed('OK'); return; }
    var ctVal = Number(j.data[0].ctVal) || 1, lastSeq = null;
    function apply(map, levels) {
      levels.forEach(function (l) { var p = Number(l[0]); _set(map, p * mult, p * Number(l[1]) * ctVal); });
    }
    _ws('wss://ws.okx.com:8443/ws/v5/public', function (sock) {
      sock.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'books', instId: instId }] }));
    }, function (m, sock) {
      if (!m.arg || m.arg.channel !== 'books' || !Array.isArray(m.data) || !m.data.length) return;
      var d = m.data[0];
      if (m.action === 'snapshot') { book.bids.clear(); book.asks.clear(); book.ready = true; }
      else if (!book.ready || (d.prevSeqId !== -1 && d.prevSeqId !== lastSeq)) {
        // Missed an update: drop the connection, the reconnect brings a fresh snapshot
        book.ready = false;
        try { sock.close(); } catch (e) {}
        return;
      }
      apply(book.bids, d.bids || []); apply(book.asks, d.asks || []);
      lastSeq = d.seqId;
    }, 'ping', function () { book.ready = false; });
  }).catch(function () {});
}

export function booksStart(futuresSymbol, onStatus) {
  booksStop();
  B.onStatus = onStatus || null;
  var sp = splitSymbol(futuresSymbol);
  _binanceSpot(sp.coin, sp.mult);
  _bybit(futuresSymbol);
  _okx(sp.coin, sp.mult);
}

export function booksStop() {
  B.gen++;
  B.socks.forEach(function (s) { try { s.close(); } catch (e) {} });
  B.timers.forEach(clearTimeout);
  B.socks = []; B.timers = []; B.books = {}; B.listed = {}; B.onStatus = null;
}

// USDT resting at one exact ladder price on a side right now (0 if none / not ready)
export function bookAt(id, ladderPx, side) {
  var book = B.books[id];
  if (!book || !book.ready) return 0;
  return (side === 'ask' ? book.asks : book.bids).get(ladderPx) || 0;
}

// false when the venue doesn't list the coin; undefined while unknown / listed
export function bookListed(id) { return B.listed[id]; }

// USDT per ladder row for one venue: { bid: {idx: usd}, ask: {idx: usd}, ready }
// (same rounding as the Binance ladder: bids floor, asks ceil)
// askEdge / bidEdge: the last rows the feed covers when it's cut at its depth
// limit (null when we hold the whole side)
export function bookRows(id, step, lo, hi) {
  var book = B.books[id];
  if (!book || !book.ready) return null;
  var bid = {}, ask = {}, minBid = Infinity, maxAsk = 0;
  book.bids.forEach(function (usd, px) {
    if (px < minBid) minBid = px;
    var i = Math.floor(px / step + 1e-9);
    if (i >= lo && i <= hi) bid[i] = (bid[i] || 0) + usd;
  });
  book.asks.forEach(function (usd, px) {
    if (px > maxAsk) maxAsk = px;
    var i = Math.ceil(px / step - 1e-9);
    if (i >= lo && i <= hi) ask[i] = (ask[i] || 0) + usd;
  });
  var cut = (DEPTH_LIMIT[id] || 1000) * 0.9;
  return {
    bid: bid, ask: ask,
    bidEdge: book.bids.size >= cut && minBid < Infinity ? Math.floor(minBid / step + 1e-9) : null,
    askEdge: book.asks.size >= cut && maxAsk > 0 ? Math.ceil(maxAsk / step - 1e-9) : null,
  };
}
