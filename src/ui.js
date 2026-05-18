import { state, filteredCoins } from './state.js';
import { fmt, fmtPrice, escHtml, signalLabel } from './utils.js';
import { on } from './events.js';
import { fetchMarketStrength, analyzeCoinBySymbol, fetchChartData } from './api.js';

// ── Utility ────────────────────────────────────────────────────────────────

function natrDisplay(symbol) {
  var nd = state.natrData[symbol];
  if (!nd || nd === 'loading' || nd === 'error') return { val: '—', cls: 'dim' };
  var v = nd.value, cls = v < 1 ? 'dn' : v < 2.5 ? 'warn' : 'up';
  return { val: v.toFixed(2), cls: cls };
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderCard(coin) {
  var cache = state.analysisCache[coin.symbol];
  var hasA = cache && cache.status === 'ok', isL = cache && cache.status === 'loading', isE = cache && cache.status === 'error';
  var signal = hasA ? cache.result.signal : null;
  var tf = state.chartTF[coin.symbol] || '5m';
  var change = coin.price_change_percentage_24h || 0;
  var natr = natrDisplay(coin.symbol);

  var badge = '';
  if (isL) badge = '<span class="btn-pressed">Анализ</span>';
  else if (isE) badge = '<button class="btn-retry" data-action="analyze" data-sym="' + coin.symbol + '">Повтор</button>';
  else if (hasA) badge = '<span class="signal-badge ' + signal + '" data-action="open-analysis" data-sym="' + coin.symbol + '">' + signalLabel(signal) + '</span>';
  else badge = '<button class="btn-analyze-one" data-action="analyze" data-sym="' + coin.symbol + '">Анализ</button>';

  var tfPicker = '<div class="tf-picker">' +
    '<button class="tf-pill" data-action="tf-pick" data-sym="' + coin.symbol + '">' + tf + '</button>' +
    '<div class="tf-dd" style="display:none">' +
    ['1m', '5m', '15m', '1h', '4h'].map(function (t) {
      return '<button class="' + (t === tf ? 'active' : '') + '" data-action="tf-opt" data-sym="' + coin.symbol + '" data-tf="' + t + '">' + t + '</button>';
    }).join('') +
    '</div>' +
    '</div>';

  return '<div class="coin-card' + (signal ? ' ' + signal : '') + '" data-sym="' + coin.symbol + '">' +
    '<div class="card-head">' +
    '<div class="card-head-left">' +
    '<span class="card-sym">' + coin.symbol.toUpperCase() + '</span>' +
    '<div class="card-inline-stats">' +
    '<span class="stat-val ' + (change >= 0 ? 'up' : 'dn') + '">' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%</span>' +
    '<span class="stat-val ' + natr.cls + '">' + natr.val + '</span>' +
    '<span class="stat-val">' + fmt(coin.total_volume) + '</span>' +
    '</div>' +
    '</div>' +
    '<div class="card-head-right">' +
    tfPicker +
    badge +
    '</div>' +
    '</div>' +
    '<div class="chart-container" id="chart-' + coin.symbol + '"></div>' +
    '</div>';
}

export function renderCards() {
  var grid = document.getElementById('cards-grid');
  if (!grid) return;
  var coins = filteredCoins();
  var existing = {};
  grid.querySelectorAll('.coin-card').forEach(function (el) { existing[el.dataset.sym] = el; });
  var seen = {};
  coins.forEach(function (coin) {
    seen[coin.symbol] = true;
    if (existing[coin.symbol]) return;
    var card = document.createElement('div');
    card.innerHTML = renderCard(coin);
    grid.appendChild(card.firstElementChild);
  });
  Object.keys(existing).forEach(function (sym) {
    if (!seen[sym]) { var el = existing[sym]; if (el) el.remove(); }
  });
  initCharts();
}

export function updateCardBadge(symbol) {
  var el = document.querySelector('[data-ck="' + symbol + '"]');
  if (!el) el = document.querySelector('[data-action="open-analysis"][data-sym="' + symbol + '"]');
  if (!el) el = document.querySelector('[data-action="analyze"][data-sym="' + symbol + '"]');
  var cache = state.analysisCache[symbol];
  var hasA = cache && cache.status === 'ok', isL = cache && cache.status === 'loading', isE = cache && cache.status === 'error';
  var signal = hasA ? cache.result.signal : null;
  var tag = 'span';
  var html = '';
  if (isL) { tag = 'span'; html = 'Анализ'; }
  else if (isE) { tag = 'button'; html = 'Повтор'; }
  else if (hasA) { tag = 'span'; html = signalLabel(signal); }
  else { tag = 'button'; html = 'Анализ'; }

  var newEl = document.createElement(tag);
  if (isE) { newEl.className = 'btn-retry'; newEl.dataset.action = 'analyze'; newEl.dataset.sym = symbol; }
  else if (hasA) { newEl.className = 'signal-badge ' + signal; newEl.dataset.action = 'open-analysis'; newEl.dataset.sym = symbol; }
  else if (isL) { newEl.className = 'btn-pressed'; }
  else { newEl.className = 'btn-analyze-one'; newEl.dataset.action = 'analyze'; newEl.dataset.sym = symbol; }
  newEl.textContent = html;

  if (el && el.parentNode) {
    var ckAttr = document.createAttribute('data-ck');
    ckAttr.value = symbol;
    newEl.setAttributeNode(ckAttr);
    el.parentNode.replaceChild(newEl, el);
  }

  var coins = filteredCoins();
  var bc = coins.filter(function (c) { return state.analysisCache[c.symbol] && state.analysisCache[c.symbol].result && state.analysisCache[c.symbol].result.signal === 'bullish'; }).length;
  var metric = document.querySelector('.metric-card:nth-child(4) .value');
  if (metric) metric.textContent = bc;
}

// ── Charts ─────────────────────────────────────────────────────────────────

var _charts = {}, _fullSeries = {}, _volSeries = {}, _rulers = {};
// Expose for api.js pollCharts (no circular dependency)
window.__chartSeries = _fullSeries;
window.__chartVolSeries = _volSeries;

function calcPriceFormat(price) {
  if (!price || price <= 0) return { type: 'price', precision: 4, minMove: 0.0001 };
  if (price < 0.00001) return { type: 'price', precision: 8, minMove: 0.00000001 };
  if (price < 0.0001)  return { type: 'price', precision: 7, minMove: 0.0000001 };
  if (price < 0.001)   return { type: 'price', precision: 6, minMove: 0.000001 };
  if (price < 0.01)    return { type: 'price', precision: 5, minMove: 0.00001 };
  if (price < 0.1)     return { type: 'price', precision: 4, minMove: 0.0001 };
  if (price < 1)       return { type: 'price', precision: 4, minMove: 0.0001 };
  if (price < 10)      return { type: 'price', precision: 3, minMove: 0.001 };
  if (price < 100)     return { type: 'price', precision: 2, minMove: 0.01 };
  if (price < 10000)   return { type: 'price', precision: 1, minMove: 0.1 };
  return { type: 'price', precision: 0, minMove: 1 };
}

function getChartOpts(width) {
  return {
    width: width, height: 300,
    layout: { background: { color: '#ffffff' }, textColor: '#636363' },
    grid: { vertLines: { color: '#e8e8e8' }, horzLines: { color: '#e8e8e8' } },
    crosshair: { mode: 1 },
    rightPriceScale: { visible: true, borderColor: '#e8e8e8', scaleMargins: { top: 0.05, bottom: 0.25 } },
    timeScale: { borderColor: '#e8e8e8', timeVisible: true, secondsVisible: false },
    handleScroll: true, handleScale: true,
  };
}

function fetchChart(symbol, tf) {
  tf = tf || state.chartTF[symbol] || '5m';
  var key = symbol + '_' + tf;
  if (state.chartData[key] && state.chartData[key].status === 'ok') { updateChart(symbol); return; }
  fetchChartData(symbol, tf).then(function () { updateChart(symbol); });
}

function updateChart(symbol) {
  var s = _fullSeries[symbol], chart = _charts[symbol];
  if (!s || !chart) return;
  var tf = state.chartTF[symbol] || '5m';
  var cd = state.chartData[symbol + '_' + tf];
  if (!cd || cd.status !== 'ok' || !cd.candles.length) return;
  var lastClose = cd.candles[cd.candles.length - 1].close;
  s.applyOptions({ priceFormat: calcPriceFormat(lastClose) });
  s.setData(cd.candles);
  var vs = _volSeries[symbol];
  if (vs) vs.setData(cd.candles.map(function (c) {
    return { time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(26,26,26,0.35)' : 'rgba(153,153,153,0.35)' };
  }));
  var total = cd.candles.length;
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - 80), to: total - 1 });
}

export function setChartTF(symbol, tf) {
  state.chartTF[symbol] = tf;
  clearRuler(symbol);
  var card = document.querySelector('.coin-card[data-sym="' + symbol + '"]');
  if (card) {
    var pill = card.querySelector('.tf-pill');
    if (pill) pill.textContent = tf;
    card.querySelectorAll('.tf-dd button').forEach(function (btn) {
      btn.className = btn.dataset.tf === tf ? 'active' : '';
    });
  }
  fetchChart(symbol, tf);
}

export function destroyCharts() {
  Object.keys(_charts).forEach(function (sym) { try { _charts[sym].remove(); } catch (e) { } });
  _charts = {}; _fullSeries = {}; _volSeries = {}; _rulers = {};
  window.__chartSeries = _fullSeries;
  window.__chartVolSeries = _volSeries;
}

function drawRuler(sym, p1, p2, pr1, pr2) {
  var ruler = _rulers[sym]; if (!ruler || !ruler.canvas) return;
  var rc = ruler.canvas, ctx = rc.getContext('2d');
  ctx.clearRect(0, 0, rc.width, rc.height);
  if (!p1 || !p2 || pr1 == null || pr2 == null) return;
  var isUp = pr2 >= pr1, color = isUp ? '#16a34a' : '#dc2626';
  var pct = ((pr2 - pr1) / Math.abs(pr1) * 100);
  var pctStr = (isUp ? '+' : '') + pct.toFixed(2) + '%';
  var chart = _charts[sym];
  if (chart) {
    var t1 = chart.timeScale().coordinateToTime(p1.x), t2 = chart.timeScale().coordinateToTime(p2.x);
    if (t1 != null && t2 != null) {
      var d = Math.abs(t2 - t1);
      var dur = d < 60 ? Math.round(d) + 'с' : d < 3600 ? Math.round(d / 60) + 'м' : d < 86400 ? Math.floor(d / 3600) + 'ч ' + Math.round((d % 3600) / 60) + 'м' : Math.floor(d / 86400) + 'д ' + Math.floor((d % 86400) / 3600) + 'ч';
      pctStr += '  ·  ' + dur;
    }
  }
  // Fill zone between the two price levels
  ctx.fillStyle = isUp ? 'rgba(22,163,74,0.09)' : 'rgba(220,38,38,0.09)';
  ctx.fillRect(0, Math.min(p1.y, p2.y), rc.width, Math.abs(p2.y - p1.y) || 1);
  // Horizontal dashed lines at each price level
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, p1.y); ctx.lineTo(rc.width, p1.y);
  ctx.moveTo(0, p2.y); ctx.lineTo(rc.width, p2.y);
  ctx.stroke(); ctx.setLineDash([]);
  // Diagonal line from start to end point
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
  // Dots at endpoints
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(p1.x, p1.y, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(p2.x, p2.y, 3.5, 0, Math.PI * 2); ctx.fill();
  // Label
  ctx.font = 'bold 16px Manrope,Arial,sans-serif'; ctx.fillStyle = color;
  var lx = p2.x + 12, ly = p2.y - 10;
  if (lx + 170 > rc.width) lx = p2.x - 175; if (lx < 2) lx = 2;
  if (ly < 14) ly = p2.y + 20; if (ly > rc.height - 4) ly = rc.height - 4;
  ctx.fillText(pctStr, lx, ly);
}

function clearRuler(sym) {
  var ruler = _rulers[sym]; if (!ruler) return;
  ruler.start = null;
  if (ruler.canvas) { var ctx = ruler.canvas.getContext('2d'); ctx.clearRect(0, 0, ruler.canvas.width, ruler.canvas.height); }
}

function initCharts() {
  if (!window.LightweightCharts) return;
  filteredCoins().forEach(function (c) {
    var el = document.getElementById('chart-' + c.symbol);
    if (!el) return;
    if (_charts[c.symbol]) return;
    var chart = window.LightweightCharts.createChart(el, getChartOpts(el.offsetWidth || 400));
    var s = chart.addCandlestickSeries({ upColor: '#1a1a1a', downColor: '#999999', borderUpColor: '#1a1a1a', borderDownColor: '#999999', wickUpColor: '#1a1a1a', wickDownColor: '#999999' });
    var vs = chart.addHistogramSeries({ color: '#94a3b8', priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    _charts[c.symbol] = chart; _fullSeries[c.symbol] = s; _volSeries[c.symbol] = vs;
    var rc = document.createElement('canvas');
    rc.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:5;';
    el.style.position = 'relative'; el.appendChild(rc);
    rc.width = el.offsetWidth || 400; rc.height = el.offsetHeight || 300;
    _rulers[c.symbol] = { start: null, canvas: rc };
    (function (sym, container, cs) {
      container.addEventListener('mousedown', function (e) {
        if (e.button !== 1) return;
        e.preventDefault();
        var rect = container.getBoundingClientRect();
        var pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        var pr = cs.coordinateToPrice(pt.y);
        if (pr != null) _rulers[sym].start = { pt: pt, price: pr };
      }, { capture: true });
      container.addEventListener('mousemove', function (e) {
        var ruler = _rulers[sym];
        if (!ruler.start || !(e.buttons & 4)) return;
        var rect = container.getBoundingClientRect();
        var pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        drawRuler(sym, ruler.start.pt, pt, ruler.start.price, cs.coordinateToPrice(pt.y));
      });
      container.addEventListener('mouseup', function (e) { if (e.button === 1) clearRuler(sym); });
      container.addEventListener('mouseleave', function () { clearRuler(sym); });
      new ResizeObserver(function () {
        if (_charts[sym]) _charts[sym].resize(container.offsetWidth, 300);
        if (_rulers[sym] && _rulers[sym].canvas) { _rulers[sym].canvas.width = container.offsetWidth; _rulers[sym].canvas.height = container.offsetHeight; }
      }).observe(container);
    })(c.symbol, el, s);
    fetchChart(c.symbol, state.chartTF[c.symbol] || '5m');
  });
}

// ── Analysis Popup ─────────────────────────────────────────────────────────

function getOverlay() {
  var el = document.getElementById('analysis-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'analysis-overlay';
    el.className = 'analysis-overlay';
    el.innerHTML =
      '<div style="display:flex;justify-content:flex-end;margin-bottom:4px;">' +
        '<button class="ms-popup-close" data-action="close-analysis">✕</button>' +
      '</div>' +
      '<div class="ao-spinner"><span class="spinner"></span></div>' +
      '<div class="ao-content"></div>';
    document.body.appendChild(el);
  }
  return el;
}

export function openAnalysisPopup(sym, btn) {
  var popup = getOverlay();
  var cache = state.analysisCache[sym];
  var spinner = popup.querySelector('.ao-spinner');
  var content = popup.querySelector('.ao-content');
  spinner.style.display = 'flex';
  content.style.display = 'none';
  popup.style.display = 'block';
  popup.dataset.sym = sym;
  var rect = btn.getBoundingClientRect();
  if (window.innerWidth <= 768) {
    var top = rect.bottom + 8;
    if (rect.bottom + 300 > window.innerHeight) top = Math.max(8, rect.top - 300);
    popup.style.position = 'fixed';
    popup.style.top = top + 'px';
    popup.style.left = '16px';
    popup.style.right = '16px';
    popup.style.width = 'auto';
    popup.style.maxWidth = 'none';
    popup.style.transform = 'none';
  } else {
    popup.style.position = 'fixed';
    popup.style.right = '';
    popup.style.width = '';
    popup.style.maxWidth = '';
    popup.style.transform = '';
    var top = rect.bottom + 8, left = rect.left;
    if (left + 380 > window.innerWidth) left = Math.max(8, rect.right - 380);
    if (rect.bottom + 300 > window.innerHeight) top = Math.max(8, rect.top - 280);
    popup.style.top = top + 'px'; popup.style.left = left + 'px';
  }
  if (cache && cache.status === 'loading') return;
  if (cache && (cache.status === 'ok' || cache.status === 'error')) { updateAnalysisPopup(sym); return; }
  analyzeCoinBySymbol(sym);
}

export function updateAnalysisPopup(sym) {
  var popup = document.getElementById('analysis-overlay');
  if (!popup || popup.style.display !== 'block' || popup.dataset.sym !== sym) return;
  var cache = state.analysisCache[sym];
  var content = popup.querySelector('.ao-content');
  var spinner = popup.querySelector('.ao-spinner');
  if (!cache || cache.status === 'loading') return;
  spinner.style.display = 'none';
  content.style.display = 'block';
  if (cache.status === 'ok' && cache.result) {
    var r = cache.result;
    var ts = cache.timestamp ? new Date(cache.timestamp).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    var extIcon = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-left:3px;margin-bottom:1px"><path d="M7 1h4v4M11 1L5 7M4 3H2a1 1 0 00-1 1v6a1 1 0 001 1h6a1 1 0 001-1V8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var newsBlock = '';
    if (r.news_summary) {
      var hasRealNews = r.news_url && !r.news_summary.toLowerCase().includes('не найдено');
      if (hasRealNews) {
        newsBlock = '<div class="ao-row"><a href="' + escHtml(r.news_url) + '" target="_blank" rel="noopener" style="color:var(--primary);font-weight:700;text-decoration:none;">Новости' + extIcon + '</a><br>' + escHtml(r.news_summary) + '</div>';
      } else {
        newsBlock = '<div class="ao-row">' + escHtml(r.news_summary) + '</div>';
      }
    }
    content.innerHTML = '<div style="font-size:16px;font-weight:700;color:var(--ink);letter-spacing:0.4px;margin-bottom:10px;">' + escHtml(sym.toUpperCase()) + '</div>' +
      '<div class="ao-row"><strong>Катализатор:</strong> ' + escHtml(r.catalyst) + '</div>' +
      newsBlock +
      (ts ? '<div style="margin-top:12px;font-size:11px;color:var(--graphite);font-weight:600;">Анализ: ' + ts + '</div>' : '') +
      '<button class="ao-reanalyze" data-action="reanalyze" data-sym="' + sym + '">Повторный анализ</button>';
  } else {
    content.innerHTML = '<div class="ao-err">' + (cache.error || 'Ошибка') + '</div>' +
      '<button class="ao-reanalyze" data-action="reanalyze" data-sym="' + sym + '">Повторный анализ</button>';
  }
}

// ── Market Strength ─────────────────────────────────────────────────────────

function getMSKPhase() {
  var utcMs = Date.now() + new Date().getTimezoneOffset() * 60000;
  var msk = new Date(utcMs + 3 * 3600 * 1000);
  var h = msk.getHours() + msk.getMinutes() / 60;
  var timeStr = msk.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (h >= 0 && h < 2) return { label: 'Ночь', time: timeStr };
  if (h >= 2 && h < 9) return { label: 'Азия', time: timeStr };
  if (h >= 9 && h < 11) return { label: 'Открытие Европы', time: timeStr };
  if (h >= 11 && h < 15.5) return { label: 'Обед Европы', time: timeStr };
  if (h >= 15.5 && h < 19.5) return { label: 'Оверлап США+Европа', time: timeStr };
  return { label: 'Вечер Америки', time: timeStr };
}

function msBar(val) {
  var cls = val >= 65 ? 'strong' : val >= 40 ? 'medium' : 'weak';
  return '<div class="ms-bar-row"><div class="ms-bar"><div class="ms-bar-fill ' + cls + '" style="width:' + val + '%"></div></div><span class="ms-bar-pct">' + val + '</span></div>';
}

function msCardInner() {
  var ms = state.marketStrength;
  if (!ms) {
    return '<div class="label">Сила рынка</div>' +
      '<div style="font-size:18px;font-weight:700;color:var(--primary);margin-top:8px;">Оценить →</div>';
  }
  if (ms.status === 'loading') {
    return '<div class="label">Сила рынка</div>' +
      '<div style="display:flex;align-items:center;gap:6px;margin-top:8px;"><span class="spinner"></span>' +
      '<span style="font-size:13px;font-weight:500;color:var(--graphite);">Анализирую...</span></div>';
  }
  if (ms.status === 'error') {
    return '<div class="label">Сила рынка</div>' +
      '<div style="font-size:16px;font-weight:700;color:var(--bloom-deep);margin-top:8px;">Ошибка</div>' +
      '<div class="ms-card-sub">Нажмите для повтора</div>';
  }
  var vLabel = ms.verdict === 'strong' ? '💪 Сильный' : ms.verdict === 'medium' ? '😐 Средний' : '😵 Слабый';
  var vColor = ms.verdict === 'strong' ? 'var(--bullish)' : ms.verdict === 'medium' ? 'var(--caution)' : 'var(--bloom-deep)';
  return '<div class="label">Сила рынка</div>' +
    '<div style="font-size:20px;font-weight:700;color:' + vColor + ';margin-top:6px;">' + vLabel + '</div>';
}

function msPopupInner() {
  var ms = state.marketStrength;
  var phase = getMSKPhase();
  var closeBtn = '<button class="ms-popup-close" data-action="close-ms">✕</button>';
  if (!ms || ms.status === 'loading') {
    return '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
      '<div class="ms-title">Сила рынка</div>' + closeBtn + '</div>' +
      '<div class="ms-loading"><span class="spinner"></span>Анализирую рынок...</div>';
  }
  if (ms.status === 'error') {
    return '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
      '<div class="ms-title">Сила рынка</div>' + closeBtn + '</div>' +
      '<div style="color:var(--bloom-deep);font-size:13px;font-weight:600;margin-bottom:12px;">Ошибка загрузки данных</div>' +
      '<button style="width:100%;height:36px;background:var(--ink);color:var(--on-ink);border-radius:8px;font-family:\'Manrope\',Arial,sans-serif;font-size:14px;cursor:pointer;" data-action="refresh-ms">Повторить</button>';
  }
  var m = ms.metrics;
  var vLabel = ms.verdict === 'strong' ? '💪 Сильный' : ms.verdict === 'medium' ? '😐 Средний' : '😵 Слабый';
  var vClass = 'ms-verdict-' + ms.verdict;
  var oiHtml = '<span class="ms-oi-badge ' + (m.oiDir === 'up' ? 'up' : m.oiDir === 'down' ? 'down' : 'neutral') + '">' + (m.oiDir === 'up' ? '▲ Подтверждён' : m.oiDir === 'down' ? '▼ Ликвидации' : '— Нейтрально') + '</span>';
  var ts = new Date(ms.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  var inPlayHtml = ms.inPlay.length ?
    '<div class="ms-inplay"><div class="ms-inplay-label">⚡ In-play (объём ×3+)</div><div class="ms-inplay-coins">' +
    ms.inPlay.map(function (s) { return '<span class="ms-inplay-pill">' + s + '</span>'; }).join('') +
    '</div></div>' : '';

  function tip(text) {
    return '<span class="ms-tip-wrap" tabindex="0">' +
      '<span class="ms-tip-icon">i</span>' +
      '<span class="ms-tip-text">' + text + '</span>' +
      '</span>';
  }

  var tips = {
    vol: 'Сравниваем объём последних 5 свечей (1м) с предыдущими 25. Высокий — рынок разогрет, деньги заходят. Низкий — всё вяло, даже хорошая точка входа может не отработать.',
    move: 'Насколько тело свечи заполняет её диапазон на 1ч. Высокая — движение устойчивое, свечи закрываются уверенно. Низкая — много хвостов и неопределённости, рынок болтает без чёткого вектора.',
    vol2: 'ATR — средний размах свечи за последние 5 часов против базового. Высокая — диапазоны расширяются, есть куда двигаться. Низкая — рынок зажат, пробои часто оказываются ложными.',
    oi: '▲ Подтверждён — цена растёт и открытых позиций больше: реальные покупатели заходят, движение надёжное. ▼ Ликвидации — цена растёт, но OI падает: выносят шортистов. Рост резкий, но может не удержаться. — Нейтрально — картина неоднозначная, сигнала нет.',
  };

  return '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
    '<div class="ms-phase" style="font-size:13px;">' + phase.label + ' · ' + phase.time + ' МСК</div>' +
    closeBtn +
    '</div>' +
    '<div class="ms-metrics-grid">' +
    '<div class="ms-metric"><div class="ms-metric-label">Объём' + tip(tips.vol) + '</div>' + msBar(m.volumePulse) + '</div>' +
    '<div class="ms-metric"><div class="ms-metric-label">Направленность' + tip(tips.move) + '</div>' + msBar(m.movement) + '</div>' +
    '<div class="ms-metric"><div class="ms-metric-label">Волатильность' + tip(tips.vol2) + '</div>' + msBar(m.volatility) + '</div>' +
    '<div class="ms-metric"><div class="ms-metric-label">Open Interest' + tip(tips.oi) + '</div>' + oiHtml + '</div>' +
    '</div>' +
    inPlayHtml +
    '<div class="ms-footer">Оценка: ' + ms.score + ' · топ-20 по объёму · ' + ts + '</div>' +
    '<button style="width:100%;height:36px;margin-top:12px;background:var(--canvas);color:var(--ink);border:1px solid var(--ink);border-radius:8px;font-family:\'Manrope\',Arial,sans-serif;font-size:14px;cursor:pointer;" data-action="refresh-ms">Обновить</button>';
}

function getMSPopup() {
  var el = document.getElementById('ms-popup');
  if (!el) { el = document.createElement('div'); el.id = 'ms-popup'; el.className = 'ms-popup'; document.body.appendChild(el); }
  return el;
}

export function openMSPopup() {
  if (!state.marketStrength) fetchMarketStrength();
  var popup = getMSPopup();
  popup.innerHTML = msPopupInner();
  popup.style.display = 'block';
  if (window.innerWidth <= 768) {
    popup.style.position = 'fixed';
    popup.style.top = '16px';
    popup.style.left = '16px';
    popup.style.right = '16px';
    popup.style.width = 'auto';
    popup.style.maxWidth = 'none';
    popup.style.transform = 'none';
  } else {
    popup.style.position = 'fixed';
    popup.style.right = '';
    popup.style.width = '';
    popup.style.maxWidth = '';
    popup.style.transform = '';
    var card = document.getElementById('ms-card');
    if (card) {
      var rect = card.getBoundingClientRect();
      var top = rect.bottom + 8;
      var left = rect.left;
      if (left + 440 > window.innerWidth) left = Math.max(8, window.innerWidth - 448);
      if (rect.bottom + 360 > window.innerHeight) top = Math.max(8, rect.top - 380);
      popup.style.top = top + 'px'; popup.style.left = left + 'px';
    }
  }
}

export function closeMSPopup() {
  var el = document.getElementById('ms-popup');
  if (el) el.style.display = 'none';
}

export function updateMSPanel() {
  var card = document.getElementById('ms-card');
  if (card) card.innerHTML = msCardInner();
  var popup = document.getElementById('ms-popup');
  if (popup && popup.style.display !== 'none') popup.innerHTML = msPopupInner();
}

// ── Main Render ────────────────────────────────────────────────────────────

export function render() {
  var app = document.getElementById('app');
  if (state.loading) {
    destroyCharts();
    app.innerHTML = '<div class="loading-overlay"><div class="big-spinner"></div><p>Загружаю данные с Binance Futures...</p></div>';
    return;
  }
  var coins = filteredCoins();

  destroyCharts();
  var coinsHtml = coins.length
    ? '<div class="cards-area">'
      + '<div class="cards-sort">'
      + '<button class="sort-pill' + (state.sortCol === 'price_change_percentage_24h' ? ' active' : '') + '" data-action="sort" data-col="price_change_percentage_24h">По росту</button>'
      + '<button class="sort-pill' + (state.sortCol === 'total_volume' ? ' active' : '') + '" data-action="sort" data-col="total_volume">По объёму</button>'
      + '<button class="sort-pill' + (state.sortCol === 'symbol' ? ' active' : '') + '" data-action="sort" data-col="symbol">По тикеру</button>'
      + '</div><div class="cards-grid" id="cards-grid">'
      + coins.map(function (c) { return renderCard(c); }).join('')
      + '</div></div>'
    : '<div class="empty-state">Нет монет, соответствующих фильтру.</div>';

  var bc = coins.filter(function (c) { return state.analysisCache[c.symbol] && state.analysisCache[c.symbol].result && state.analysisCache[c.symbol].result.signal === 'bullish'; }).length;
  var maxRise = coins.length ? Math.max.apply(null, coins.map(function (c) { return c.price_change_percentage_24h || 0; })).toFixed(2) : '—';
  var mv = coins.length ? Math.max.apply(null, coins.map(function (c) { return c.total_volume || 0; })) : 0;

  app.innerHTML =
    '<div class="topbar"><div class="filters">'
    + '<div class="filter-group vol-desktop"><label>Объём:</label>'
    + [20, 30, 50, 100, 200].map(function (v) { return '<button class="filter-pill' + (state.minVolume === v ? ' active' : '') + '" data-action="pick-vol" data-val="' + v + '">' + v + 'M</button>'; }).join('')
    + '</div>'
    + '<div class="filter-group change-desktop"><label>Рост:</label>'
    + [1, 2, 5, 10].map(function (v) { return '<button class="filter-pill' + (state.minChange === v ? ' active' : '') + '" data-action="pick-change" data-val="' + v + '">' + v + '%</button>'; }).join('')
    + '</div>'
    + '<div class="mobile-filters-row">'
    + '<div class="tf-picker">'
    + '<button class="tf-pill" data-action="vol-pick">' + state.minVolume + 'M</button>'
    + '<div class="tf-dd" id="vol-dd" style="display:none">'
    + [20, 30, 50, 100, 200].map(function (v) { return '<button class="' + (v === state.minVolume ? 'active' : '') + '" data-action="pick-vol" data-val="' + v + '">' + v + 'M</button>'; }).join('')
    + '</div></div>'
    + '<div class="tf-picker">'
    + '<button class="tf-pill" data-action="change-pick">' + state.minChange + '%</button>'
    + '<div class="tf-dd" id="change-dd" style="display:none">'
    + [1, 2, 5, 10].map(function (v) { return '<button class="' + (v === state.minChange ? 'active' : '') + '" data-action="pick-change" data-val="' + v + '">' + v + '%</button>'; }).join('')
    + '</div></div>'
    + (state.lastUpdate ? '<span class="mobile-update">' + state.lastUpdate.toLocaleTimeString() + '</span>' : '')
    + '<button class="btn-refresh-icon" data-action="refresh" title="Обновить">'
    + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
    + '</button>'
    + '</div>'
    + '<div class="filters-right">'
    + '<span class="last-update">' + (state.lastUpdate ? 'Обновлено: ' + state.lastUpdate.toLocaleTimeString('ru-RU') : '') + '</span>'
    + '<button class="btn-refresh" data-action="refresh">Обновить</button>'
    + '</div>'
    + '</div></div>'
    + '<div class="metrics">'
    + '<div class="metric-card"><div class="label">Монет в фильтре</div><div class="value">' + coins.length + '</div></div>'
    + '<div class="metric-card"><div class="label">Максимальный рост</div><div class="value green">+' + maxRise + '%</div></div>'
    + '<div class="metric-card"><div class="label">Максимальный объем</div><div class="value">' + (function () { if (mv >= 1e9) return '$' + (mv / 1e9).toFixed(1) + 'B'; if (mv >= 1e6) return '$' + (mv / 1e6).toFixed(1) + 'M'; return '$' + (mv / 1e3).toFixed(1) + 'K'; })() + '</div></div>'
    + '<div class="metric-card"><div class="label">Bullish AI</div><div class="value green">' + bc + '</div></div>'
    + '<div class="metric-card ms-card" id="ms-card" data-action="open-ms">'
    + msCardInner()
    + '</div>'
    + '</div>'
    + coinsHtml;
  initCharts();
}

// ── Tooltip positioning ────────────────────────────────────────────────────

var _activeTip = null;
var _activeWrap = null;

function showTip(wrap) {
  var tip = wrap.querySelector('.ms-tip-text');
  if (!tip) return;
  if (_activeTip && _activeTip !== tip) { _activeTip.style.display = 'none'; }
  _activeTip = tip;
  _activeWrap = wrap;
  // Render off-screen first to measure height
  tip.style.top = '-9999px'; tip.style.left = '-9999px';
  tip.style.display = 'block';
  var TIP_W = 210, MARGIN = 8;
  var rect = wrap.getBoundingClientRect();
  var tipH = tip.offsetHeight || 100;
  var top = rect.bottom + 4;
  var left = rect.left;
  // Flip above if goes below viewport
  if (top + tipH > window.innerHeight - MARGIN) top = rect.top - tipH - 4;
  if (top < MARGIN) top = MARGIN;
  // Clamp horizontally
  if (left + TIP_W > window.innerWidth - MARGIN) left = window.innerWidth - TIP_W - MARGIN;
  if (left < MARGIN) left = MARGIN;
  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
}

function hideTip(wrap) {
  var tip = wrap.querySelector('.ms-tip-text');
  if (tip) { tip.style.display = 'none'; _activeTip = null; _activeWrap = null; }
}

// Reposition tooltip on page scroll so it follows the icon
window.addEventListener('scroll', function () {
  if (_activeWrap) showTip(_activeWrap);
}, { passive: true });

document.body.addEventListener('mouseover', function (e) {
  var wrap = e.target.closest('.ms-tip-wrap');
  if (wrap) showTip(wrap);
});
document.body.addEventListener('mouseout', function (e) {
  var wrap = e.target.closest('.ms-tip-wrap');
  if (!wrap) return;
  if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
  hideTip(wrap);
});
document.body.addEventListener('focus', function (e) {
  var wrap = e.target.closest('.ms-tip-wrap');
  if (wrap) showTip(wrap);
}, true);
document.body.addEventListener('blur', function (e) {
  var wrap = e.target.closest('.ms-tip-wrap');
  if (wrap) hideTip(wrap);
}, true);

// ── Event listeners ────────────────────────────────────────────────────────

on('render', render);
on('card:update', function (sym) { updateCardBadge(sym); updateAnalysisPopup(sym); });
on('ms:update', updateMSPanel);
