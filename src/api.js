import { state, STABLE_SYMBOLS, CACHE_TTL_MS, ANALYZE_DELAY_MS, filteredCoins } from './state.js';
import { fmt, sleep } from './utils.js';
import { emit } from './events.js';

// API base URL — derived from VITE_WS_URL so Vercel frontend hits the VPS
var _wsEnv = import.meta.env.VITE_WS_URL || '';
export var API_BASE = _wsEnv
  ? _wsEnv.replace(/^wss?:\/\//, 'https://').replace(/\/ws$/, '')
  : '';

// Coins excluded from Market Strength (too correlated with BTC, not altcoin pumps)
var MS_EXCLUDE = new Set(['btc', 'eth', 'sol']);

// TV update throttle: max once per 2s (TV hardware is slow)
var _tvKlineThrottle = {};
var _tvHeaderLast = 0;
var TV_THROTTLE_MS = 2000;

function volClrs() {
  var s = getComputedStyle(document.documentElement);
  return {
    up: s.getPropertyValue('--vol-up').trim() || 'rgba(26,26,26,0.35)',
    dn: s.getPropertyValue('--vol-dn').trim() || 'rgba(153,153,153,0.35)',
  };
}

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
    // Clear connection errors on successful reconnect
    if (state.error && (state.error.startsWith('Нет подключения') || state.error.startsWith('Сервер'))) {
      state.error = null;
    }
    emit('ws:status');
    emit('render');
    // On reconnect (coins already in state) — force-refresh NATR for all visible coins.
    // Wait 800ms for the ticker push to arrive so state.coins is up to date.
    if (state.coins.length > 0) {
      setTimeout(function () { emit('natr:force-refresh'); }, 800);
    }
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
      case 'd1opens':
        processD1Opens(msg.data);
        break;
      case 'ticker_update':
        processSingleUpdate(msg);
        break;
      case 'kline_update':
        processKlineUpdate(msg);
        break;
      case 'alert_triggered':
        emit('alert:triggered', msg);
        break;
      case 'briefing_updated':
        emit('briefing:updated');
        break;
      case 'notify':
        state.notifications.unshift(msg.entry);
        if (state.notifications.length > 50) state.notifications.length = 50;
        state.notifUnread++;
        emit('notify:received', msg.entry);
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
      state.error = navigator.onLine
        ? 'Сервер временно недоступен. Переподключаемся...'
        : 'Нет подключения к интернету.';
      emit('render');
    }
  };
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

var _applyLivePriceTimer = null;
function _scheduleApplyLivePrice() {
  if (_applyLivePriceTimer) return;
  _applyLivePriceTimer = setTimeout(function () {
    _applyLivePriceTimer = null;
    applyLivePriceUpdates();
  }, 50);
}

export function sendWS(obj) { wsSend(obj); }

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
        open_24h: parseFloat(t.o),
        total_volume: Math.round(parseFloat(t.q)),
        price_change_percentage_24h: t.P != null ? parseFloat(t.P) : ((parseFloat(t.c) - parseFloat(t.o)) / parseFloat(t.o)) * 100,
      };
    }).sort(function (a, b) { return b.total_volume - a.total_volume; });
    state.lastUpdate = new Date();
    state.cacheExpires = Date.now() + CACHE_TTL_MS;
    emit('render');
    emit('natr:refresh');
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
      // Используем t.P (Binance прерасчитанный priceChangePercent) если есть, иначе вычисляем
      var pc = t.P != null ? parseFloat(t.P) : ((parseFloat(t.c) - parseFloat(t.o)) / parseFloat(t.o)) * 100;
      // Не фильтруем по объёму здесь — filteredCoins() применяет тир-фильтр для отображения.
      // Фильтруем только явно нулевые объёмы (монеты не торгуются).
      if (qv < 1e6 || pc < (state.minChange || 0)) return;
      state.coins.push({ symbol: sym, name: sym.toUpperCase(), current_price: parseFloat(t.c), open_24h: parseFloat(t.o), total_volume: qv, price_change_percentage_24h: pc });
      newCoins++;
      return;
    }
    coin.current_price = parseFloat(t.c);
    coin.total_volume = Math.round(parseFloat(t.q));
    if (t.P != null) coin.price_change_percentage_24h = parseFloat(t.P);
    var _now = Date.now();
    if (t.o != null && (!coin._openSyncAt || _now - coin._openSyncAt > 60000)) {
      coin.open_24h = parseFloat(t.o);
      coin._openSyncAt = _now;
    }
  });

  applyLivePriceUpdates();

  if (newCoins) { emit('render'); emit('natr:refresh'); return; }

  // Snapshot DOM before sync, then find coins that ACTUALLY entered the visible area after sync.
  // (Don't use filteredCoins() diff — in screener mode that's ~100 coins vs 6 visible = 94 false positives)
  var _preSync = new Set(Array.from(document.querySelectorAll('.coin-card[data-sym]')).map(function (el) { return el.dataset.sym; }));
  // При смене порядка: переставляем карточки через renderCards (cards:sync),
  // а не полный render() — render() уничтожает все чарты и пересоздаёт их,
  // что вызывало флик раз в 1-2 минуты при изменении рейтинга по объёму.
  emit('cards:sync');
  // Fetch NATR only for coins that just appeared in the DOM (1-2 at most)
  var _addedToDOM = Array.from(document.querySelectorAll('.coin-card[data-sym]')).map(function (el) { return el.dataset.sym; }).filter(function (s) {
    return !_preSync.has(s) && (!state.natrData[s] || state.natrData[s] === 'error');
  });
  if (_addedToDOM.length) fetchAllNATR(_addedToDOM.map(function (s) { return { symbol: s }; }));
}

// ── Individual ticker update (from per-coin WS subscriptions) ────────────

function processSingleUpdate(msg) {
  var t = msg.data;
  if (!t || !t.s) return;
  var sym = t.s.replace('USDT', '').toLowerCase();
  var coin = state.coins.find(function (c) { return c.symbol === sym; });
  if (!coin) return; // coin not in our filtered list
  coin.current_price = parseFloat(t.c);
  coin.total_volume = Math.round(parseFloat(t.q));
  if (t.P != null) coin.price_change_percentage_24h = parseFloat(t.P);
  applyLivePriceUpdates();
}

// ── Real-time kline update (fires on every trade from server kline WS) ──

// Трекер последнего kline WS обновления по символу — используется в pollCharts
// чтобы не перетирать актуальные данные стейл-данными из REST.
var _lastKlineAt = {}; // sym → timestamp ms

function isValidCandle(k) {
  if (!k || !k.time) return false;
  if (!(k.open > 0) || !(k.high > 0) || !(k.low > 0) || !(k.close > 0)) return false;
  if (k.low > k.open || k.low > k.close || k.low > k.high) return false;
  if (k.high < k.open || k.high < k.close) return false;
  return true;
}

function processKlineUpdate(msg) {
  var sym = msg.symbol;
  var tf = msg.tf;
  var k = msg.candle;
  if (!isValidCandle(k)) return;

  // Update live price for all kline subscribers regardless of chart data state.
  // Without this, coins without loaded chart data (e.g. briefing coins not yet viewed in FV)
  // skip the price update and appear frozen in the briefing popup.
  var _priceCoin = state.coins.find(function (c) { return c.symbol === sym; });
  if (_priceCoin) { _priceCoin.current_price = k.close; _scheduleApplyLivePrice(); }

  var key = sym + '_' + tf;
  var cd = state.chartData[key];
  if (!cd || cd.status !== 'ok' || !cd.candles.length) return;

  var arr = cd.candles;
  var last = arr[arr.length - 1];

  if (last && last.time === k.time) {
    // Binance kline WS уже присылает кумулятивные H/L за весь период свечи —
    // каждый пакет содержит правильный max/min начиная с открытия.
    // Накопление max/min на клиенте было лишним и вызывало ghost wicks:
    // один аномальный пакет (k.high=0.160) замораживался навсегда.
    arr[arr.length - 1] = k;
  } else if (!last || k.time > last.time) {
    arr.push(k);
    if (arr.length > 300) arr.shift();
  } else {
    return; // старая свеча — игнорируем
  }

  _lastKlineAt[sym] = Date.now();

  // Обновляем chart только если tf совпадает с текущим TF карточки.
  // Сервер не отписывается от старых TF — если монета была на 5m, потом переключили
  // на 1m, сервер шлёт оба потока. Без проверки 5m-свеча с чужим time перезапишет 1m-chart.
  var currentTF = state.chartTF[sym] || '5m';
  if (tf !== currentTF) return;

  var s = (window.__chartSeries || {})[sym];
  if (s) { try { s.update(k); } catch (e) {} }

  var vc = volClrs();
  var volClr = k.close >= k.open ? vc.up : vc.dn;
  var vs = (window.__chartVolSeries || {})[sym];
  if (vs) { try { vs.update({ time: k.time, value: k.volume, color: volClr }); } catch (e) {} }

  // TV-режим: обновляем не чаще TV_THROTTLE_MS (слабые TV-процессоры не справляются с каждым тиком)
  var _tvNow = Date.now();
  if (!_tvKlineThrottle[sym] || _tvNow - _tvKlineThrottle[sym] >= TV_THROTTLE_MS) {
    _tvKlineThrottle[sym] = _tvNow;
    var ts = (window.__tvChartSeries || {})[sym];
    if (ts) { try { ts.update(k); } catch (e) {} }
    var tvs = (window.__tvChartVolSeries || {})[sym];
    if (tvs) { try { tvs.update({ time: k.time, value: k.volume, color: volClr }); } catch (e) {} }
  }

  // Full view обновляем если открыт для этой монеты и совпадает таймфрейм
  if (window.__fvSymbol === sym && window.__fvTF === tf) {
    var fvs = window.__fvSeries;
    if (fvs) { try { fvs.update(k); } catch (e) {} }
    var fvvs = window.__fvVolSeries;
    if (fvvs) {
      try { fvvs.update({ time: k.time, value: k.volume, color: volClr }); } catch (e) {}
      var _vl = document.getElementById('fv-vol-label');
      if (_vl && !_vl.dataset.hovered) _vl.textContent = 'vol. ' + fmt(k.volume || 0).replace('$', '');
    }
  }

}

// ── D1 opens: суточный % от UTC-полуночи ─────────────────────────────────
// VPS шлёт { type:'d1opens', data:{ BTCUSDT:'65000.00', ... } } при старте и в полночь UTC.
// Это единственный источник state.dailyOpen — клиент никогда не вычисляет d1Open сам.

function processD1Opens(d1Map) {
  // d1Opens сохраняем в state.dailyOpen для справки (могут использоваться в других местах),
  // но % не трогаем — он живёт в t.P из тикера (rolling 24h от Binance).
  if (!d1Map || typeof d1Map !== 'object') return;
  Object.keys(d1Map).forEach(function(fullSym) {
    var sym = fullSym.replace('USDT', '').toLowerCase();
    if (STABLE_SYMBOLS.has(sym) || sym === 'usdt') return;
    var d1 = parseFloat(d1Map[fullSym]);
    if (d1 > 0) state.dailyOpen[sym] = d1;
  });
}

// ── Coin fetching ────────────────────────────────────────────────────────

export async function fetchCoins() {
  var now = Date.now();
  if (state.coins.length > 0 && now < state.cacheExpires) return;
  state.loading = true; state.error = null; emit('render');
  try {
    await _wsReady;
    if (!wsConnected) {
      state.error = navigator.onLine
        ? 'Сервер временно недоступен. Переподключаемся...'
        : 'Нет подключения к интернету.';
      state.loading = false; emit('render'); return;
    }
    // If no ticker data yet, request it explicitly
    if (state.coins.length === 0) {
      await wsRequest({ type: 'get_ticker' });
    }
    if (state.coins.length === 0) {
      state.error = 'Данные с Binance не получены. Попробуйте обновить страницу.';
      state.loading = false; emit('render'); return;
    }
    state.error = null;
    state.lastUpdate = new Date();
    state.cacheExpires = now + CACHE_TTL_MS;
    emit('natr:refresh');
  } catch (err) {
    if (err.message === 'WS timeout') {
      state.error = navigator.onLine
        ? 'Сервер не ответил вовремя. Переподключаемся...'
        : 'Нет подключения к интернету.';
    } else {
      state.error = 'Ошибка загрузки: ' + err.message;
    }
  }
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
  var _tvEl = document.getElementById('tv-overlay');
  var _tvOpen = _tvEl && _tvEl.style.display !== 'none';

  if (!_tvOpen) {
  document.querySelectorAll('[data-sym]').forEach(function (el) {
    var sym = el.dataset.sym;
    var coin = state.coins.find(function (c) { return c.symbol === sym; });
    if (!coin) return;
    var spans = el.querySelectorAll('.card-chart-stats .stat-val');
    if (spans.length < 3) return;
    // spans[0] (%) handled by _refreshCardPct interval
    var nd = state.natrData[sym];
    if (nd && nd !== 'loading' && nd !== 'error') {
      var v = nd.value;
      var newNat = v.toFixed(2);
      if (spans[1].textContent !== newNat) { spans[1].textContent = newNat; spans[1].className = v >= 1.8 ? 'stat-val natr-hi' : 'stat-val'; }
    }
    var newVol = fmt(Math.round(coin.total_volume || 0)).replace('$', '');
    if (spans[2].textContent !== newVol) spans[2].textContent = newVol;
  });

  // Update full view stats (когда монета развёрнута)
  var fvSym = window.__fvSymbol;
  if (fvSym) {
    var fvCoin = state.coins.find(function (c) { return c.symbol === fvSym; });
    var fvStatsEl = document.querySelector('.fv-info-stats');
    if (fvCoin && fvStatsEl) {
      var fvSpans = fvStatsEl.querySelectorAll('.stat-val');
      if (fvSpans.length >= 3) {
        // fvSpans[0] (%) handled by _refreshCardPct interval
        var fvNd = state.natrData[fvSym];
        if (fvNd && fvNd !== 'loading' && fvNd !== 'error') {
          var fvV = fvNd.value;
          var newFvNat = fvV.toFixed(2);
          if (fvSpans[1].textContent !== newFvNat) { fvSpans[1].textContent = newFvNat; fvSpans[1].className = fvV >= 1.8 ? 'stat-val natr-hi' : 'stat-val'; }
        }
        var newFvVol = fmt(Math.round(fvCoin.total_volume || 0)).replace('$', '');
        if (fvSpans[2].textContent !== newFvVol) fvSpans[2].textContent = newFvVol;
      }
    }
  }

  } // end !_tvOpen

  // Update TV slot headers — only when overlay is visible, throttled + diff-guarded
  if (_tvOpen) {
    var _tvHNow = Date.now();
    if (_tvHNow - _tvHeaderLast >= TV_THROTTLE_MS) {
      _tvHeaderLast = _tvHNow;
      document.querySelectorAll('[data-tv-sym]').forEach(function (el) {
        var sym = el.dataset.tvSym;
        var coin = state.coins.find(function (c) { return c.symbol === sym; });
        if (!coin) return;
        var ch = (coin.open_24h > 0 && coin.current_price > 0)
          ? (coin.current_price - coin.open_24h) / coin.open_24h * 100
          : (coin.price_change_percentage_24h || 0);
        var newChg = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
        var newCls = 'tv-chg ' + (ch >= 0 ? 'up' : 'dn');
        var chgEl = el.querySelector('.tv-chg');
        if (chgEl) {
          if (chgEl.textContent !== newChg) chgEl.textContent = newChg;
          if (chgEl.className !== newCls) chgEl.className = newCls;
        }
        var prEl = el.querySelector('.tv-price');
        if (prEl && coin.current_price) prEl.textContent = '$' + coin.current_price;
      });
    }
  }

  emit('metrics:update');
}

function _refreshCardPct() {
  var _tvEl = document.getElementById('tv-overlay');
  if (_tvEl && _tvEl.style.display !== 'none') return;
  var coinMap = {};
  state.coins.forEach(function (c) { coinMap[c.symbol] = c; });
  document.querySelectorAll('[data-sym]').forEach(function (el) {
    var coin = coinMap[el.dataset.sym];
    if (!coin) return;
    var spans = el.querySelectorAll('.card-chart-stats .stat-val');
    if (!spans.length) return;
    var ch = (coin.open_24h > 0 && coin.current_price > 0)
      ? (coin.current_price - coin.open_24h) / coin.open_24h * 100
      : (coin.price_change_percentage_24h || 0);
    var newChg = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
    var newCls = 'stat-val ' + (ch >= 0 ? 'up' : 'dn');
    if (spans[0].textContent !== newChg) spans[0].textContent = newChg;
    if (spans[0].className !== newCls) spans[0].className = newCls;
  });
  var fvSym = window.__fvSymbol;
  if (fvSym) {
    var fvCoin = coinMap[fvSym];
    var fvStatsEl = document.querySelector('.fv-info-stats');
    if (fvCoin && fvStatsEl) {
      var fvSpans = fvStatsEl.querySelectorAll('.stat-val');
      if (fvSpans.length >= 1) {
        var fvCh = (fvCoin.open_24h > 0 && fvCoin.current_price > 0)
          ? (fvCoin.current_price - fvCoin.open_24h) / fvCoin.open_24h * 100
          : (fvCoin.price_change_percentage_24h || 0);
        var newFvChg = (fvCh >= 0 ? '+' : '') + fvCh.toFixed(2) + '%';
        var newFvCls = 'stat-val ' + (fvCh >= 0 ? 'up' : 'dn');
        if (fvSpans[0].textContent !== newFvChg) fvSpans[0].textContent = newFvChg;
        if (fvSpans[0].className !== newFvCls) fvSpans[0].className = newFvCls;
      }
    }
  }
}
setInterval(_refreshCardPct, 500);

// ── Chart polling ────────────────────────────────────────────────────────

export async function pollCharts(deep) {
  var coins = filteredCoins();
  for (var i = 0; i < coins.length; i++) {
    var c = coins[i], tf = state.chartTF[c.symbol] || '5m', key = c.symbol + '_' + tf;
    var cd = state.chartData[key];
    if (!cd || cd.status !== 'ok') continue;
    // Check series exists before making the network request
    if (!(window.__chartSeries || {})[c.symbol]) continue;
    try {
      var msg = await wsRequest({ type: 'fetch_klines', symbol: c.symbol, tf: tf, limit: deep ? 300 : 5 });
      var data = msg.data;
      if (!Array.isArray(data) || !data.length) continue;

      var arr = cd.candles;
      var hadNewCandle = false;

      // Вычисляем klineRecent ДО цикла — нужен внутри цикла для пропуска последней свечи.
      // Пока kline WS активен (<5с), последняя (формирующаяся) свеча не должна
      // обновляться из REST+current_price: open из REST + close из тикера = фейковое тело.
      var klineRecent = (Date.now() - (_lastKlineAt[c.symbol] || 0)) < 5000;

      // Process all returned candles in order — fixes missing/wrong closed candles during pumps
      for (var j = 0; j < data.length; j++) {
        var k = data[j];
        var isLast = j === data.length - 1;
        // Когда kline WS активен — не трогаем последнюю свечу в state вообще.
        // kline WS поддерживает её точно; REST присылает данные с задержкой ~1с,
        // а current_price — из тикера другого момента времени → открытие расходится с ценой.
        if (isLast && klineRecent) continue;
        var candle = {
          time: Math.floor(parseInt(k[0]) / 1000),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        };
        if (!isValidCandle(candle)) continue;
        var last = arr[arr.length - 1];
        if (last && last.time === candle.time) {
          // REST — источник истины для закрытых свечей.
          arr[arr.length - 1] = candle;
        } else if (!last || candle.time > last.time) {
          arr.push(candle);
          if (arr.length > 300) arr.shift();
          if (!isLast) hadNewCandle = true; // a closed candle was missing — need full redraw
        }
      }

      // pollCharts обновляет chart только если kline WS молчит >5с (разрыв соединения).
      // Пока kline WS активен — он единственный рендерер графика.
      if (klineRecent) continue;

      // Kline WS неактивен — используем pollCharts как fallback
      var s = (window.__chartSeries || {})[c.symbol];
      if (!s) continue;

      var lastCandle = arr[arr.length - 1];
      var _vc = volClrs();
      var lastVol = { time: lastCandle.time, value: lastCandle.volume, color: lastCandle.close >= lastCandle.open ? _vc.up : _vc.dn };

      if (hadNewCandle) {
        var chart = (window.__charts || {})[c.symbol];
        var visibleRange = null;
        if (chart) { try { visibleRange = chart.timeScale().getVisibleRange(); } catch (e) { } }
        try { s.setData(arr); } catch (e) { }
        var vs2 = (window.__chartVolSeries || {})[c.symbol];
        if (vs2) { try { vs2.setData(arr.map(function (x) { return { time: x.time, value: x.volume, color: x.close >= x.open ? volClrs().up : volClrs().dn }; })); } catch (e) { } }
        var tvs2 = (window.__tvChartVolSeries || {})[c.symbol];
        if (tvs2) { try { tvs2.setData(arr.map(function (x) { return { time: x.time, value: x.volume, color: x.close >= x.open ? volClrs().up : volClrs().dn }; })); } catch (e) { } }
        if (chart && visibleRange) { try { chart.timeScale().setVisibleRange(visibleRange); } catch (e) { } }
      } else {
        try { s.update(lastCandle); } catch (e) { }
        var vs = (window.__chartVolSeries || {})[c.symbol];
        if (vs) { try { vs.update(lastVol); } catch (e) { } }
        var tvvs2 = (window.__tvChartVolSeries || {})[c.symbol];
        if (tvvs2) { try { tvvs2.update(lastVol); } catch (e) { } }
      }
    } catch (e) { }
  }
}

var _chartTimer = null;
var _liveTimer = null;

export function startChartPolling() {
  if (_chartTimer) clearInterval(_chartTimer);
  if (_liveTimer) clearInterval(_liveTimer);
  // Sync кlines каждые 10с — только для восстановления после разрыва WS.
  // Основной источник обновлений — kline_update push (processKlineUpdate).
  _chartTimer = setInterval(function () { pollCharts(); }, 10000);
  // Гарантированный 2с-таймер для обновления % и объёма в DOM.
  _liveTimer = setInterval(function () { applyLivePriceUpdates(); }, 2000);
  // Обновляем NATR раз в 5 минут: каждые 5м закрывается новая свеча, окно смещается.
  setInterval(function () { emit('natr:force-refresh'); }, 5 * 60 * 1000);
  // Сброс d1Open при смене UTC-дня: dailyOpen хранит open полуночи UTC,
  // при смене суток он устаревает и % начинает расходиться с Binance.
  var _lastDay = new Date().toISOString().slice(0, 10);
  setInterval(function () {
    var today = new Date().toISOString().slice(0, 10);
    if (today !== _lastDay) {
      _lastDay = today;
      Object.keys(state.dailyOpen).forEach(function (k) { delete state.dailyOpen[k]; });
      Object.keys(state.natrData).forEach(function (k) { delete state.natrData[k]; });
      emit('natr:refresh');
    }
  }, 60000);
  // iOS PWA: восстанавливаем данные после разморозки из фона.
  // WS-соединение рвётся при уходе в бэкграунд — при возврате догружаем свечи и NATR.
  var _hiddenAt = null;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      _hiddenAt = Date.now();
    } else if (_hiddenAt !== null && Date.now() - _hiddenAt > 2 * 60 * 1000) {
      _hiddenAt = null;
      pollCharts(true);
      emit('natr:force-refresh');
    } else {
      _hiddenAt = null;
    }
  });
}

// ── Chart data (initial fetch, moved from ui.js) ─────────────────────────

export async function fetchChartData(symbol, tf) {
  tf = tf || state.chartTF[symbol] || '5m';
  var key = symbol + '_' + tf;
  if (state.chartData[key] && state.chartData[key].status === 'ok') {
    // Данные уже есть — просто убедимся что подписка активна
    wsSend({ type: 'subscribe_klines', symbols: [symbol], tf: tf });
    return;
  }
  try {
    var msg = await wsRequest({ type: 'fetch_klines', symbol: symbol, tf: tf, limit: 1000 });
    var data = msg.data;
    if (!Array.isArray(data) || !data.length) throw new Error('No data');
    state.chartData[key] = {
      status: 'ok',
      candles: data.map(function (k) {
        return { time: Math.floor(parseInt(k[0]) / 1000), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) };
      }),
    };

    // Подписываемся на real-time kline стрим — обновления будут приходить через processKlineUpdate
    wsSend({ type: 'subscribe_klines', symbols: [symbol], tf: tf });
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

    // d1Open сохраняем для справки, % не трогаем — он живёт в t.P из тикера (rolling 24h).
    if (msg.d1Open != null) {
      var d1 = parseFloat(msg.d1Open);
      if (d1 > 0) state.dailyOpen[symbol] = d1;
    }

    var data = msg.data;
    if (!Array.isArray(data) || data.length < 15) throw new Error();
    var candles = data.map(function (k) { return { high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }; });
    var v = calculateNATR(candles);
    state.natrData[symbol] = v !== null ? { value: v } : 'error';
  } catch (e) { state.natrData[symbol] = 'error'; }
}

export async function fetchAllNATR(coins, force) {
  for (var i = 0; i < coins.length; i++) {
    var c = coins[i];
    if (!force && state.natrData[c.symbol] && state.natrData[c.symbol] !== 'error') continue;
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
    var res = await fetch(API_BASE + '/api/analyze', {
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

export function fetchNotifications() {
  return fetch(API_BASE + '/api/notifications', { credentials: 'include' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      state.notifications = d.notifications || [];
      state.notifUnread = state.notifications.filter(function (n) { return !n.read; }).length;
      emit('notify:ready');
    })
    .catch(function () {});
}

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
  setInterval(function () { fetchMarketStrength(false); }, 5 * 60 * 1000);
}

// ── Trades (Binance Futures via proxy) ────────────────────────────────────

function _dateToMs(dateStr, endOfDay) {
  var p = dateStr.split('-');
  var d = new Date(+p[0], +p[1] - 1, +p[2],
    endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return d.getTime();
}

// Proxy calls use session cookie for auth (no user_code needed after auth migration)

// Fetch trades for one symbol on one date. Results cached in state.trades.
var _fetchTradesInFlight = {};

export async function fetchTrades(symbol, dateStr) {
  var key = symbol + ':' + dateStr;
  var cached = state.trades[key];
  if (cached && cached.status === 'ok') return cached;
  if (_fetchTradesInFlight[key]) return _fetchTradesInFlight[key];

  state.trades[key] = { status: 'loading' };

  var p = (async function () {
    try {
      var binSym = symbol.toUpperCase() + 'USDT';
      var res = await fetch(API_BASE + '/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          service: 'binance',
          payload: {
            symbol: binSym,
            startTime: _dateToMs(dateStr, false),
            endTime: _dateToMs(dateStr, true),
          },
        }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Proxy error');

      var trades = data.trades || [];
      var pnl = 0, commission = 0;
      for (var i = 0; i < trades.length; i++) {
        pnl += parseFloat(trades[i].realizedPnl || 0);
        commission += parseFloat(trades[i].commission || 0);
      }
      state.trades[key] = { status: 'ok', pnl: pnl - commission, count: trades.length, entries: trades };
    } catch (e) {
      state.trades[key] = { status: 'error', error: e.message };
    }
    delete _fetchTradesInFlight[key];
    return state.trades[key];
  })();

  _fetchTradesInFlight[key] = p;
  return p;
}

// Fetch trades for all briefing entries on a given date, then notify UI.
export async function fetchBriefingTrades(dateStr) {
  var entries = (state.briefing || []).filter(function (e) { return e.date === dateStr; });
  if (!entries.length) return;
  await Promise.all(entries.map(function (e) { return fetchTrades(e.sym, dateStr); }));
  emit('trades:updated', dateStr);
}

// Fetch trades for every entry in state.briefing (all dates) — used by FV drawer.
export async function fetchAllBriefingTrades() {
  var entries = state.briefing || [];
  if (!entries.length) return;
  await Promise.all(entries.map(function (e) { return fetchTrades(e.sym, e.date); }));
  emit('trades:updated');
}

// Fetch trades for all briefing entries this week (Mon–today), compute weekly aggregate.
// Counts by unique orderId (not fills) to match Binance trade count.
export async function fetchWeekTrades(force) {
  var today = new Date();
  var todayStr = today.getFullYear() + '-'
    + String(today.getMonth() + 1).padStart(2, '0') + '-'
    + String(today.getDate()).padStart(2, '0');

  // Compute Monday of current week
  var daysToMon = today.getDay() === 0 ? 6 : today.getDay() - 1;
  var mon = new Date(today.getTime() - daysToMon * 24 * 3600 * 1000);
  var monStr = mon.getFullYear() + '-' + String(mon.getMonth() + 1).padStart(2, '0') + '-' + String(mon.getDate()).padStart(2, '0');

  // All briefing entries Mon–today
  var entries = (state.briefing || []).filter(function (e) { return !e.auto && e.date >= monStr && e.date <= todayStr; });
  if (!entries.length) { emit('trades:week-updated'); return null; }

  // Always refetch (day isn't over, new trades may appear). Clear cache every time.
  entries.forEach(function (e) { delete state.trades[e.sym + ':' + e.date]; });

  await Promise.all(entries.map(function (e) { return fetchTrades(e.sym, e.date); }));

  // Group fills by (sym:positionSide) stream, dedup by fill id across multiple
  // date-range fetches of the same symbol. Track net position per stream.
  var streams = {}; // key -> { id: fill }
  entries.forEach(function (e) {
    var t = state.trades[e.sym + ':' + e.date];
    if (!t || t.status !== 'ok' || !t.entries) return;
    t.entries.forEach(function (fill) {
      var key = e.sym + ':' + (fill.positionSide || 'BOTH');
      if (!streams[key]) streams[key] = {};
      streams[key][fill.id] = fill;
    });
  });

  // Count round-trips: position 0→X→0 = one trade (open+adds+partial closes+close).
  // Uses net PnL (realizedPnl - commission) for win/loss determination.
  var tradeCount = 0, winCount = 0;
  Object.values(streams).forEach(function (fillMap) {
    var fills = Object.values(fillMap).sort(function (a, b) { return a.time - b.time; });
    var position = 0, roundPnl = 0;
    fills.forEach(function (fill) {
      position += fill.side === 'BUY' ? parseFloat(fill.qty) : -parseFloat(fill.qty);
      roundPnl += parseFloat(fill.realizedPnl || 0) - parseFloat(fill.commission || 0);
      if (Math.abs(position) < 0.00001) {
        tradeCount++;
        if (roundPnl > 0) winCount++;
        roundPnl = 0;
      }
    });
  });

  // PnL: sum from state.trades (already commission-deducted)
  var totalPnl = 0;
  entries.forEach(function (e) {
    var t = state.trades[e.sym + ':' + e.date];
    if (t && t.status === 'ok') totalPnl += t.pnl;
  });

  state.weekSummary = {
    pnl: totalPnl,
    tradeCount: tradeCount,
    winCount: winCount,
    winRate: tradeCount > 0 ? Math.round(winCount / tradeCount * 100) : 0,
    fromDate: todayStr,
  };
  emit('trades:week-updated');
  return state.weekSummary;
}

// Call Gemini via proxy to generate a weekly trading summary.
export async function generateWeeklySummary() {
  var today = new Date();
  var dayOfWeek = today.getDay(); // 0=Sun,1=Mon,...,6=Sat
  var daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  var monday = new Date(today.getTime() - daysToMonday * 24 * 3600 * 1000);
  var weekAgoStr = monday.getFullYear() + '-'
    + String(monday.getMonth() + 1).padStart(2, '0') + '-'
    + String(monday.getDate()).padStart(2, '0');
  var entries = (state.briefing || []).filter(function (e) { return e.date >= weekAgoStr; });

  // Build briefing text grouped by date
  var byDate = {};
  entries.forEach(function (e) { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e); });

  var briefingText = Object.keys(byDate).sort().reverse().map(function (date) {
    return date + ':\n' + byDate[date].map(function (e) {
      var t = state.trades[e.sym + ':' + e.date];
      var pnlStr;
      if (t && t.status === 'ok' && t.count > 0) {
        // Count round-trips (0→X→0) by positionSide — same logic as fetchWeekTrades
        var _streams = {};
        (t.entries || []).sort(function (a, b) { return a.time - b.time; }).forEach(function (f) {
          var ps = f.positionSide || 'BOTH';
          if (!_streams[ps]) _streams[ps] = [];
          _streams[ps].push(f);
        });
        var _rt = 0;
        Object.values(_streams).forEach(function (fs) {
          var p = 0;
          fs.forEach(function (f) {
            p += f.side === 'BUY' ? parseFloat(f.qty) : -parseFloat(f.qty);
            if (Math.abs(p) < 0.00001) { _rt++; p = 0; }
          });
        });
        pnlStr = ' | PnL: $' + t.pnl.toFixed(2) + ' (' + (_rt || t.count) + ' сд.)';
      } else {
        pnlStr = ' | нет сделок';
      }
      var statusLabels = { watching: 'наблюдение', traded: 'отработка', skip: 'отмена', missed: 'упущено' };
      var statusStr = e.status && e.status !== 'watching' ? ' [' + (statusLabels[e.status] || e.status) + ']' : '';
      return '  - ' + e.sym.toUpperCase() + statusStr + (e.note ? ': ' + e.note : '') + pnlStr;
    }).join('\n');
  }).join('\n\n');

  var ws = state.weekSummary;
  var statsText = ws
    ? 'Итого за неделю: PnL $' + ws.pnl.toFixed(2) + ', сделок ' + ws.tradeCount
      + ', win rate ' + ws.winRate + '%, конверсия ' + ws.conversion + '%'
    : '';

  var prompt = 'Ты торговый аналитик. Разбери мою торговую неделю.\n\n'
    + 'Брифинги (монеты + заметки с уровнями + реальный PnL по каждой):\n'
    + briefingText + '\n\n' + statsText
    + '\n\nНапиши краткий разбор: что сработало, что нет, паттерны в заметках vs реальных сделках. '
    + 'До 300 слов. На русском.';

  var res = await fetch(API_BASE + '/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      service: 'gemini',
      payload: { prompt: prompt },
    }),
  });
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Proxy error');
  state.aiSummary = data.text || '';
  var tradedKeys = (state.briefing || [])
    .filter(function (e) { return e.status === 'traded'; })
    .map(function (e) { return e.sym + ':' + e.date; })
    .sort();
  state.aiSummaryTradedKeys = tradedKeys;
  state.aiSummaryDate = new Date().toISOString();
  state.aiSummaryTradeCount = state.weekSummary ? state.weekSummary.tradeCount : 0;
  try {
    localStorage.setItem('pa_ai_summary', state.aiSummary);
    localStorage.setItem('pa_ai_traded_keys', JSON.stringify(tradedKeys));
    localStorage.setItem('pa_ai_summary_date', state.aiSummaryDate);
    localStorage.setItem('pa_ai_trade_count', String(state.aiSummaryTradeCount));
  } catch (e) {}
  fetch(API_BASE + '/api/briefing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ action: 'save', entries: state.briefing,
      ai_summary: state.aiSummary, ai_traded_keys: state.aiSummaryTradedKeys, ai_summary_date: state.aiSummaryDate }),
  }).catch(function () {});
  emit('trades:ai-updated');
  return state.aiSummary;
}