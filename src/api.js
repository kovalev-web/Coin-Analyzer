import { state, STABLE_SYMBOLS, CACHE_TTL_MS, ANALYZE_DELAY_MS, filteredCoins } from './state.js';
import { fmt, sleep } from './utils.js';
import { emit } from './events.js';

// Coins excluded from Market Strength (too correlated with BTC, not altcoin pumps)
var MS_EXCLUDE = new Set(['btc', 'eth', 'sol']);

function getCurrentSessionId() {
  var utcMs = Date.now() + new Date().getTimezoneOffset() * 60000;
  var msk = new Date(utcMs + 3 * 3600 * 1000);
  var h = msk.getHours() + msk.getMinutes() / 60;
  var day = msk.toISOString().slice(0, 10);
  var session = h >= 22 ? 'night' : h >= 15.5 ? 'us' : h >= 9 ? 'europe' : h >= 2 ? 'asia' : 'night';
  return day + '_' + session;
}

// ── WebSocket connection ─────────────────────────────────────────────────

var ws = null;
export var wsConnected = false;
var _wsReady = null; // promise that resolves when WS connects
var _wsReadyResolve = null;
var _reqId = 0;
var _pending = {};

function connectWS() {
  if (_wsReady === null) {
    _wsReady = new Promise(function (resolve) { _wsReadyResolve = resolve; });
  }

  var url = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

  ws = new WebSocket(url);

  ws.onopen = function () {
    wsConnected = true;
    console.log('[WS] Connected to', url);
    if (_wsReadyResolve) { _wsReadyResolve(); _wsReadyResolve = null; }
    emit('ws:status');
  };

  ws.onmessage = function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }

    // Response to a pending request
    if (msg._id && _pending[msg._id]) {
      clearTimeout(_pending[msg._id].timer);
      _pending[msg._id].resolve(msg);
      delete _pending[msg._id];
      return;
    }

    // Push messages (no _id)
    switch (msg.type) {
      case 'ticker':
        processTickerPush(msg.data);
        break;
      case 'ticker_update':
        processSingleUpdate(msg);
        break;
      case 'error':
        console.error('[WS] Server error:', msg.message);
        break;
    }
  };

  ws.onclose = function () {
    wsConnected = false;
    console.log('[WS] Disconnected, reconnecting in 3s...');
    // Reject all pending requests
    Object.keys(_pending).forEach(function (id) {
      clearTimeout(_pending[id].timer);
      _pending[id].reject(new Error('WS disconnected'));
      delete _pending[id];
    });
    emit('ws:status');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = function () {
    if (!wsConnected && _wsReadyResolve) {
      _wsReadyResolve(); // resolve anyway so app doesn't hang
      _wsReadyResolve = null;
    }
  };
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function wsRequest(msg) {
  return new Promise(function (resolve, reject) {
    var id = String(++_reqId);
    msg._id = id;
    _pending[id] = {
      resolve: resolve,
      reject: reject,
      timer: setTimeout(function () {
        delete _pending[id];
        reject(new Error('WS timeout'));
      }, 20000),
    };
    wsSend(msg);
  });
}

// ── Start connection immediately ─────────────────────────────────────────

connectWS();

// ── Ticker processing ────────────────────────────────────────────────────

function processTickerPush(arr) {
  if (!Array.isArray(arr)) return;

  // Initial load — state.coins empty
  if (state.coins.length === 0) {
    state.coins = arr.filter(function (t) {
      return t.s.endsWith('USDT') && !STABLE_SYMBOLS.has(t.s.replace('USDT', '').toLowerCase()) && t.s !== 'USDTUSDT';
    }).map(function (t) {
      var sym = t.s.replace('USDT', '').toLowerCase();
      return {
        symbol: sym,
        name: sym.toUpperCase(),
        current_price: parseFloat(t.c),
        total_volume: Math.round(parseFloat(t.q)),
        price_change_percentage_24h: t.P != null ? parseFloat(t.P) : ((parseFloat(t.c) - parseFloat(t.o)) / parseFloat(t.o)) * 100,
      };
    }).sort(function (a, b) { return b.total_volume - a.total_volume; });
    state.lastUpdate = new Date();
    state.cacheExpires = Date.now() + CACHE_TTL_MS;
    emit('render');
    fetchAllNATR(filteredCoins());
    return;
  }

  // Push update — update existing coins and add new ones
  var newCoins = 0;
  arr.forEach(function (t) {
    var sym = t.s.replace('USDT', '').toLowerCase();
    var coin = state.coins.find(function (c) { return c.symbol === sym; });
    if (!coin) {
      if (!t.s.endsWith('USDT') || STABLE_SYMBOLS.has(sym) || sym === 'usdt') return;
      var qv = Math.round(parseFloat(t.q));
      var pc = ((parseFloat(t.c) - parseFloat(t.o)) / parseFloat(t.o)) * 100;
      if (qv < ((state.minVolume || 0) * 1e6) || pc < (state.minChange || 0)) return;
      state.coins.push({ symbol: sym, name: sym.toUpperCase(), current_price: parseFloat(t.c), total_volume: qv, price_change_percentage_24h: pc });
      newCoins++;
      return;
    }
    coin.current_price = parseFloat(t.c);
    coin.price_change_percentage_24h = t.P != null ? parseFloat(t.P) : ((parseFloat(t.c) - parseFloat(t.o)) / parseFloat(t.o)) * 100;
    coin.total_volume = Math.round(parseFloat(t.q));
  });

  if (newCoins) { emit('cards:sync'); fetchAllNATR(filteredCoins()); return; }
  applyLivePriceUpdates();
  applyLiveChartUpdates();
  emit('cards:sync');
}

// ── Individual ticker update (from per-coin WS subscriptions) ────────────

function processSingleUpdate(msg) {
  var t = msg.data;
  if (!t || !t.s) return;
  var sym = t.s.replace('USDT', '').toLowerCase();
  var coin = state.coins.find(function (c) { return c.symbol === sym; });
  if (!coin) return; // coin not in our filtered list
  coin.current_price = parseFloat(t.c);
  coin.price_change_percentage_24h = parseFloat(t.P);
  coin.total_volume = Math.round(parseFloat(t.q));
  applyLivePriceUpdates();
}

// ── Coin fetching ────────────────────────────────────────────────────────

export async function fetchCoins() {
  var now = Date.now();
  if (state.coins.length > 0 && now < state.cacheExpires) return;
  state.loading = true; state.error = null; emit('render');
  try {
    await _wsReady;
    // If no ticker data yet, request it explicitly
    if (state.coins.length === 0) {
      await wsRequest({ type: 'get_ticker' });
    }
    state.lastUpdate = new Date();
    state.cacheExpires = now + CACHE_TTL_MS;
    fetchAllNATR(filteredCoins());
  } catch (err) { state.error = 'Ошибка загрузки: ' + err.message; }
  state.loading = false; emit('render');
}

export async function refreshCoins() { state.cacheExpires = 0; await fetchCoins(); fetchMarketStrength(true); }

// ── Cache (AI analysis, unchanged) ───────────────────────────────────────

export function saveCache() {
  var obj = {};
  Object.keys(state.analysisCache).forEach(function (k) {
    var e = state.analysisCache[k];
    if (e.status === 'ok' && e.result) obj[k] = { status: 'ok', result: e.result, timestamp: Date.now() };
  });
  try { localStorage.setItem('pa_cache', JSON.stringify(obj)); } catch (e) { }
}

export function loadCache() {
  try {
    var d = localStorage.getItem('pa_cache');
    if (!d) return;
    var obj = JSON.parse(d), now = Date.now();
    Object.keys(obj).forEach(function (k) { if (now - obj[k].timestamp > 86400000) delete obj[k]; });
    Object.assign(state.analysisCache, obj);
  } catch (e) { }
}

// ── Live price updates (WS push) ─────────────────────────────────────────

export function applyLivePriceUpdates() {
  document.querySelectorAll('[data-sym]').forEach(function (el) {
    var sym = el.dataset.sym;
    var coin = state.coins.find(function (c) { return c.symbol === sym; });
    if (!coin) return;
    var spans = el.querySelectorAll('.card-inline-stats .stat-val');
    if (spans.length < 3) return;
    var ch = coin.price_change_percentage_24h || 0;
    var newChg = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
    if (spans[0].textContent !== newChg) { spans[0].textContent = newChg; spans[0].className = 'stat-val ' + (ch >= 0 ? 'up' : 'dn'); }
    var nd = state.natrData[sym];
    if (nd && nd !== 'loading' && nd !== 'error') {
      var v = nd.value;
      var newNat = v.toFixed(2);
      if (spans[1].textContent !== newNat) { spans[1].textContent = newNat; spans[1].className = 'stat-val ' + (v < 1 ? 'dn' : v < 2.5 ? 'warn' : 'up'); }
    }
    var newVol = fmt(Math.round(coin.total_volume || 0));
    if (spans[2].textContent !== newVol) spans[2].textContent = newVol;
  });

  // Update TV slot headers
  document.querySelectorAll('[data-tv-sym]').forEach(function (el) {
    var sym = el.dataset.tvSym;
    var coin = state.coins.find(function (c) { return c.symbol === sym; });
    if (!coin) return;
    var ch = coin.price_change_percentage_24h || 0;
    var chgEl = el.querySelector('.tv-chg');
    if (chgEl) { chgEl.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%'; chgEl.className = 'tv-chg ' + (ch >= 0 ? 'up' : 'dn'); }
    var prEl = el.querySelector('.tv-price');
    if (prEl && coin.current_price) prEl.textContent = '$' + coin.current_price;
  });

  emit('metrics:update');
}

// ── Live chart updates from ticker (каждый пуш обновляет последнюю свечу) ─

export function applyLiveChartUpdates() {
  var series = window.__chartSeries || {};
  var tvSeries = window.__tvChartSeries || {};
  var volSeries = window.__chartVolSeries || {};
  filteredCoins().forEach(function (coin) {
    var tf = state.chartTF[coin.symbol] || '5m';
    var key = coin.symbol + '_' + tf;
    var cd = state.chartData[key];
    if (!cd || cd.status !== 'ok' || !cd.candles.length) return;
    var last = cd.candles[cd.candles.length - 1];
    var price = coin.current_price;
    if (!price) return;
    var updated = {
      time: last.time,
      open: last.open,
      high: price > last.high ? price : last.high,
      low: price < last.low ? price : last.low,
      close: price,
      volume: last.volume,
    };
    cd.candles[cd.candles.length - 1] = updated;
    var s = series[coin.symbol];
    if (s) { try { s.update(updated); } catch (e) { } }
    var vs = volSeries[coin.symbol];
    if (vs) { try { vs.update({ time: updated.time, value: updated.volume, color: updated.close >= updated.open ? 'rgba(26,26,26,0.35)' : 'rgba(153,153,153,0.35)' }); } catch (e) { } }
    var ts = tvSeries[coin.symbol];
    if (ts) { try { ts.update(updated); } catch (e) { } }
  });
}

// ── Chart polling ────────────────────────────────────────────────────────

export async function pollCharts() {
  var coins = filteredCoins();
  for (var i = 0; i < coins.length; i++) {
    var c = coins[i], tf = state.chartTF[c.symbol] || '5m', key = c.symbol + '_' + tf;
    var cd = state.chartData[key];
    if (!cd || cd.status !== 'ok') continue;
    // Check series exists before making the network request
    if (!(window.__chartSeries || {})[c.symbol]) continue;
    try {
      var msg = await wsRequest({ type: 'fetch_klines', symbol: c.symbol, tf: tf, limit: 5 });
      var data = msg.data;
      if (!Array.isArray(data) || !data.length) continue;

      var arr = cd.candles;
      var hadNewCandle = false;

      // Process all returned candles in order — fixes missing/wrong closed candles during pumps
      for (var j = 0; j < data.length; j++) {
        var k = data[j];
        var isLast = j === data.length - 1;
        var candle = {
          time: Math.floor(parseInt(k[0]) / 1000),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        };
        // Apply live price only to the current (last, still-forming) candle
        if (isLast && c.current_price) {
          candle.close = c.current_price;
          candle.high = c.current_price > candle.high ? c.current_price : candle.high;
          candle.low = c.current_price < candle.low ? c.current_price : candle.low;
        }
        var last = arr[arr.length - 1];
        if (last && last.time === candle.time) {
          // Update existing candle — keep max H/L so live-tracked values aren't erased
          candle.high = candle.high > last.high ? candle.high : last.high;
          candle.low = candle.low < last.low ? candle.low : last.low;
          arr[arr.length - 1] = candle;
        } else if (!last || candle.time > last.time) {
          arr.push(candle);
          if (arr.length > 300) arr.shift();
          if (!isLast) hadNewCandle = true; // a closed candle was missing — need full redraw
        }
      }

      // Re-read series after await
      var s = (window.__chartSeries || {})[c.symbol];
      if (!s) continue;

      var lastCandle = arr[arr.length - 1];
      var lastVol = { time: lastCandle.time, value: lastCandle.volume, color: lastCandle.close >= lastCandle.open ? 'rgba(26,26,26,0.35)' : 'rgba(153,153,153,0.35)' };

      if (hadNewCandle) {
        // New closed candles were added — setData to ensure chart history is correct
        // Save + restore visible range so chart doesn't jump
        var chart = (window.__charts || {})[c.symbol];
        var visibleRange = null;
        if (chart) { try { visibleRange = chart.timeScale().getVisibleRange(); } catch (e) { } }
        try { s.setData(arr); } catch (e) { }
        var vs2 = (window.__chartVolSeries || {})[c.symbol];
        if (vs2) { try { vs2.setData(arr.map(function (x) { return { time: x.time, value: x.volume, color: x.close >= x.open ? 'rgba(26,26,26,0.35)' : 'rgba(153,153,153,0.35)' }; })); } catch (e) { } }
        if (chart && visibleRange) { try { chart.timeScale().setVisibleRange(visibleRange); } catch (e) { } }
      } else {
        try { s.update(lastCandle); } catch (e) { }
        var vs = (window.__chartVolSeries || {})[c.symbol];
        if (vs) { try { vs.update(lastVol); } catch (e) { } }
      }
    } catch (e) { }
  }
}

var _chartTimer = null;
var _liveTimer = null;

export function startChartPolling() {
  if (_chartTimer) clearInterval(_chartTimer);
  if (_liveTimer) clearInterval(_liveTimer);
  // Poll klines every 3s to sync H/L and detect new candles
  _chartTimer = setInterval(function () { pollCharts(); }, 3000);
  // Update live close price every 1s — independent of ticker push path
  _liveTimer = setInterval(function () { applyLiveChartUpdates(); }, 1000);
}

// ── Chart data (initial fetch, moved from ui.js) ─────────────────────────

export async function fetchChartData(symbol, tf) {
  tf = tf || state.chartTF[symbol] || '5m';
  var key = symbol + '_' + tf;
  if (state.chartData[key] && state.chartData[key].status === 'ok') return;
  try {
    var msg = await wsRequest({ type: 'fetch_klines', symbol: symbol, tf: tf, limit: 300 });
    var data = msg.data;
    if (!Array.isArray(data) || !data.length) throw new Error('No data');
    state.chartData[key] = {
      status: 'ok',
      candles: data.map(function (k) {
        return { time: Math.floor(parseInt(k[0]) / 1000), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) };
      }),
    };
  } catch (e) {
    state.chartData[key] = { status: 'error' };
  }
}

// ── NATR ─────────────────────────────────────────────────────────────────

export function calculateNATR(candles) {
  if (candles.length < 15) return null;
  var trs = [];
  for (var i = 1; i < candles.length; i++) { var h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close; trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
  var last14 = trs.slice(-14);
  var atr = last14.reduce(function (s, v) { return s + v; }, 0) / 14;
  var close = candles[candles.length - 1].close;
  return close > 0 ? (atr / close * 100) : null;
}

export async function fetchNATR(symbol) {
  state.natrData[symbol] = 'loading';
  try {
    var msg = await wsRequest({ type: 'fetch_natr', symbol: symbol });
    var data = msg.data;
    if (!Array.isArray(data) || data.length < 15) throw new Error();
    var candles = data.map(function (k) { return { high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }; });
    var v = calculateNATR(candles);
    state.natrData[symbol] = v !== null ? { value: v } : 'error';
  } catch (e) { state.natrData[symbol] = 'error'; }
}

export async function fetchAllNATR(coins) {
  for (var i = 0; i < coins.length; i++) {
    var c = coins[i];
    if (state.natrData[c.symbol] && state.natrData[c.symbol] !== 'error') continue;
    await fetchNATR(c.symbol);
    applyLivePriceUpdates();
    if (i < coins.length - 1) await sleep(80);
  }
}

// ── AI Analysis (unchanged) ──────────────────────────────────────────────

export async function analyzeCoin(coin) {
  var key = coin.symbol;
  state.analysisCache[key] = { status: 'loading', result: null };
  emit('card:update', key);
  var nd = state.natrData[coin.symbol];
  var natrVal = nd && nd !== 'loading' && nd !== 'error' ? nd.value : null;
  try {
    var res = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: coin.name, symbol: coin.symbol.toUpperCase(),
        change24h: (coin.price_change_percentage_24h || 0).toFixed(2),
        volume: Math.round(coin.total_volume || 0), price: coin.current_price || 0, natr: natrVal,
      }),
    });
    var json = await res.json();
    state.analysisCache[key] = (!res.ok || json.error)
      ? { status: 'error', result: null, error: json.error || 'Ошибка сервера' }
      : { status: 'ok', result: json, timestamp: Date.now() };
  } catch (err) { state.analysisCache[key] = { status: 'error', result: null, error: 'Сетевая ошибка: ' + err.message }; }
  emit('card:update', key);
  saveCache();
  emit('analysis:updated', key);
}

export function analyzeCoinBySymbol(symbol) {
  var c = state.coins.find(function (x) { return x.symbol === symbol; });
  if (c) analyzeCoin(c);
}

export async function analyzeAll() {
  if (state.analyzingAll) { state.analyzeAllAbort = true; return; }
  state.analyzingAll = true; state.analyzeAllAbort = false; emit('render');
  var coins = filteredCoins().filter(function (c) { var ch = state.analysisCache[c.symbol]; return !ch || ch.status === 'error'; });
  for (var i = 0; i < coins.length; i++) { if (state.analyzeAllAbort) break; await analyzeCoin(coins[i]); if (i < coins.length - 1) await sleep(ANALYZE_DELAY_MS); }
  state.analyzingAll = false; state.analyzeAllAbort = false; emit('render');
}

// ── Market Strength ──────────────────────────────────────────────────────

export async function fetchMarketStrength(force) {
  var sessionId = getCurrentSessionId();
  if (!force && state.marketStrength && state.marketStrength.status === 'ok' && state.marketStrength.session === sessionId) return;

  var top = state.coins
    .filter(function (c) { return !STABLE_SYMBOLS.has(c.symbol.toLowerCase()) && !MS_EXCLUDE.has(c.symbol.toLowerCase()); })
    .sort(function (a, b) { return b.total_volume - a.total_volume; })
    .slice(0, 20);
  if (!top.length) return;
  state.marketStrength = { status: 'loading' };
  emit('ms:update');

  try {
    var symbols = top.map(function (c) { return c.symbol; });
    var response = await wsRequest({ type: 'fetch_market_strength', symbols: symbols });
    var results = response.data;

    var valid = results.filter(function (r) { return r && Array.isArray(r.k1m) && Array.isArray(r.k1h); });
    if (!valid.length) { state.marketStrength = { status: 'error' }; emit('ms:update'); return; }

    var volumePulses = [], atrRatios = [], qualities = [], oiDirs = [], volAnomalies = [], inPlay = [];

    valid.forEach(function (r) {
      if (r.k1m.length >= 10) {
        var vols = r.k1m.map(function (k) { return parseFloat(k[5]); });
        var recent = vols.slice(-5).reduce(function (s, v) { return s + v; }, 0) / 5;
        var base = vols.slice(0, -5).reduce(function (s, v) { return s + v; }, 0) / Math.max(vols.slice(0, -5).length, 1);
        if (base > 0) volumePulses.push(Math.min(100, Math.round(recent / base * 50)));
      }
      if (r.k1h.length >= 7) {
        var trs = [];
        for (var i = 1; i < r.k1h.length; i++) {
          var h2 = parseFloat(r.k1h[i][2]), l2 = parseFloat(r.k1h[i][3]), pc = parseFloat(r.k1h[i - 1][4]);
          trs.push(Math.max(h2 - l2, Math.abs(h2 - pc), Math.abs(l2 - pc)));
        }
        var atrR = trs.slice(-5).reduce(function (s, v) { return s + v; }, 0) / 5;
        var atrB = trs.slice(0, -5).reduce(function (s, v) { return s + v; }, 0) / Math.max(trs.slice(0, -5).length, 1);
        if (atrB > 0) atrRatios.push(Math.min(100, Math.round(atrR / atrB * 50)));
      }
      if (r.k1h.length >= 5) {
        var qs = r.k1h.slice(-10).map(function (k) {
          var o = parseFloat(k[1]), c = parseFloat(k[4]), h3 = parseFloat(k[2]), l3 = parseFloat(k[3]);
          var range = h3 - l3; return range > 0 ? Math.abs(c - o) / range : 0;
        });
        qualities.push(Math.round(qs.reduce(function (s, v) { return s + v; }, 0) / qs.length * 100));
      }
      if (Array.isArray(r.oiHist) && r.oiHist.length >= 2) {
        var oiNew = parseFloat(r.oiHist[r.oiHist.length - 1].sumOpenInterest);
        var oiOld = parseFloat(r.oiHist[0].sumOpenInterest);
        var priceUp = (r.coin ? r.coin.price_change_percentage_24h || 0 : 0) > 0;
        var oiUp = oiNew > oiOld * 1.001;
        oiDirs.push(priceUp ? (oiUp ? 1 : -1) : 0);
      }
      if (Array.isArray(r.k1d) && r.k1d.length >= 5) {
        var prev = r.k1d.slice(0, -1);
        var avgVol = prev.reduce(function (s, k) { return s + parseFloat(k[7]); }, 0) / prev.length;
        if (avgVol > 0) {
          var coin = state.coins.find(function (c) { return c.symbol === r.symbol; });
          if (coin) {
            var ratio = coin.total_volume / avgVol;
            volAnomalies.push(Math.min(100, Math.round(ratio * 20)));
            if (ratio >= 3) inPlay.push(r.symbol.toUpperCase());
          }
        }
      }
    });

    function avg(arr) { return arr.length ? Math.round(arr.reduce(function (s, v) { return s + v; }, 0) / arr.length) : 50; }
    var vPulse = avg(volumePulses);
    var atrQ = avg(atrRatios);
    var moveQ = avg(qualities);
    var volAnom = avg(volAnomalies);
    var oiAvg = oiDirs.length ? oiDirs.reduce(function (s, v) { return s + v; }, 0) / oiDirs.length : 0;
    var oiDir = oiAvg > 0.2 ? 'up' : oiAvg < -0.2 ? 'down' : 'neutral';
    var oiScore = oiDir === 'up' ? 80 : oiDir === 'down' ? 20 : 50;

    var score = Math.round(vPulse * 0.25 + atrQ * 0.20 + moveQ * 0.25 + volAnom * 0.15 + oiScore * 0.15);
    var verdict = score >= 65 ? 'strong' : score >= 40 ? 'medium' : 'weak';

    state.marketStrength = {
      status: 'ok', verdict: verdict, score: score,
      metrics: { volumePulse: vPulse, volatility: atrQ, movement: moveQ, oiDir: oiDir },
      inPlay: inPlay, timestamp: Date.now(),
      session: sessionId,
    };
  } catch (e) {
    state.marketStrength = { status: 'error' };
  }
  emit('ms:update');
}

export function startMSPolling() {
  setInterval(function () { fetchMarketStrength(true); }, 5 * 60 * 1000);
}
