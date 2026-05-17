import { state, STABLE_SYMBOLS, CACHE_TTL_MS, ANALYZE_DELAY_MS, filteredCoins } from './state.js';
import { fmt, sleep } from './utils.js';
import { emit } from './events.js';

// ── Coin fetching ──────────────────────────────────────────────────────────

export async function fetchCoins() {
  var now = Date.now();
  if (state.coins.length > 0 && now < state.cacheExpires) return;
  state.loading = true; state.error = null; emit('render');
  try {
    var res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
    if (!res.ok) throw new Error('Binance HTTP ' + res.status);
    var data = await res.json();
    state.coins = data.filter(function (t) {
      return t.symbol.endsWith('USDT') && !STABLE_SYMBOLS.has(t.symbol.replace('USDT', '').toLowerCase()) && t.symbol !== 'USDTUSDT';
    }).map(function (t) {
      var sym = t.symbol.replace('USDT', '').toLowerCase();
      return { symbol: sym, name: sym.toUpperCase(), current_price: parseFloat(t.lastPrice), total_volume: Math.round(parseFloat(t.quoteVolume)), price_change_percentage_24h: parseFloat(t.priceChangePercent) };
    }).sort(function (a, b) { return b.total_volume - a.total_volume; });
    state.lastUpdate = new Date();
    state.cacheExpires = now + CACHE_TTL_MS;
    fetchAllNATR(filteredCoins());
  } catch (err) { state.error = 'Ошибка загрузки Binance Futures: ' + err.message; }
  state.loading = false; emit('render');
}

export async function refreshCoins() { state.cacheExpires = 0; await fetchCoins(); fetchMarketStrength(); }

// ── Cache ──────────────────────────────────────────────────────────────────

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

// ── Live price updates (REST polling) ──────────────────────────────────────

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
}

export async function pollPrices() {
  try {
    var res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
    if (!res.ok) return;
    var arr = await res.json();
    var newCoins = 0;
    arr.forEach(function (t) {
      var sym = t.symbol.replace('USDT', '').toLowerCase();
      var coin = state.coins.find(function (c) { return c.symbol === sym; });
      if (!coin) {
        if (!t.symbol.endsWith('USDT') || STABLE_SYMBOLS.has(sym) || sym === 'usdt') return;
        var qv = Math.round(parseFloat(t.quoteVolume));
        var pc = parseFloat(t.priceChangePercent);
        if (qv < ((state.minVolume || 0) * 1e6) || pc < (state.minChange || 0)) return;
        state.coins.push({ symbol: sym, name: sym.toUpperCase(), current_price: parseFloat(t.lastPrice), total_volume: qv, price_change_percentage_24h: pc });
        newCoins++;
        return;
      }
      coin.current_price = parseFloat(t.lastPrice);
      coin.price_change_percentage_24h = parseFloat(t.priceChangePercent);
      coin.total_volume = Math.round(parseFloat(t.quoteVolume));
    });
    if (newCoins) { emit('render'); return; }
    applyLivePriceUpdates();
  } catch (e) { }
}

export async function pollCharts() {
  var series = window.__chartSeries || {};
  var volSeries = window.__chartVolSeries || {};
  var coins = filteredCoins();
  for (var i = 0; i < coins.length; i++) {
    var c = coins[i], tf = state.chartTF[c.symbol] || '5m', key = c.symbol + '_' + tf;
    var cd = state.chartData[key];
    if (!cd || cd.status !== 'ok') continue;
    var s = series[c.symbol];
    if (!s) continue;
    try {
      var res = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + c.symbol.toUpperCase() + 'USDT&interval=' + tf + '&limit=2');
      if (!res.ok) continue;
      var data = await res.json();
      if (!Array.isArray(data) || !data.length) continue;
      var k = data[data.length - 1];
      var newCandle = { time: Math.floor(parseInt(k[0]) / 1000), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) };
      var arr = cd.candles, last = arr[arr.length - 1];
      if (last && last.time === newCandle.time) { arr[arr.length - 1] = newCandle; }
      else if (!last || newCandle.time > last.time) { arr.push(newCandle); if (arr.length > 300) arr.shift(); }
      s.update(newCandle);
      var vs = volSeries[c.symbol];
      if (vs) vs.update({ time: newCandle.time, value: newCandle.volume, color: newCandle.close >= newCandle.open ? 'rgba(26,26,26,0.35)' : 'rgba(153,153,153,0.35)' });
    } catch (e) { }
  }
}

var _pollTimer = null;

export function startPricePolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(function () { pollPrices(); pollCharts(); }, 3000);
}

// ── NATR ───────────────────────────────────────────────────────────────────

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
    var res = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + symbol.toUpperCase() + 'USDT&interval=5m&limit=30');
    if (!res.ok) throw new Error();
    var data = await res.json();
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

// ── AI Analysis ────────────────────────────────────────────────────────────

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

// ── Market Strength ────────────────────────────────────────────────────────

export async function fetchMarketStrength() {
  var sorted = filteredCoins().slice().sort(function (a, b) { return b.total_volume - a.total_volume; });
  var top = sorted.slice(0, 10);
  if (!top.length) return;
  state.marketStrength = { status: 'loading' };
  emit('ms:update');

  var results = await Promise.all(top.map(async function (coin) {
    var sym = coin.symbol.toUpperCase() + 'USDT';
    try {
      var [k1m, k1h, k1d, oiHist] = await Promise.all([
        fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + sym + '&interval=1m&limit=30').then(function (r) { return r.json(); }),
        fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + sym + '&interval=1h&limit=20').then(function (r) { return r.json(); }),
        fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + sym + '&interval=1d&limit=11').then(function (r) { return r.json(); }),
        fetch('https://fapi.binance.com/futures/data/openInterestHist?symbol=' + sym + '&period=5m&limit=4').then(function (r) { return r.json(); }),
      ]);
      return { coin: coin, k1m: k1m, k1h: k1h, k1d: k1d, oiHist: oiHist };
    } catch (e) { return null; }
  }));

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
      var priceUp = (r.coin.price_change_percentage_24h || 0) > 0;
      var oiUp = oiNew > oiOld * 1.001;
      oiDirs.push(priceUp ? (oiUp ? 1 : -1) : 0);
    }
    if (Array.isArray(r.k1d) && r.k1d.length >= 5) {
      var prev = r.k1d.slice(0, -1);
      var avgVol = prev.reduce(function (s, k) { return s + parseFloat(k[7]); }, 0) / prev.length;
      if (avgVol > 0) {
        var ratio = r.coin.total_volume / avgVol;
        volAnomalies.push(Math.min(100, Math.round(ratio * 20)));
        if (ratio >= 3) inPlay.push(r.coin.symbol.toUpperCase());
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
  };
  emit('ms:update');
}
