import { state, filteredCoins } from './state.js';
import { getCSSVar, getChartOpts, getSeriesColors, calcPriceFormat } from './ui.js';
import { fetchChartData } from './api.js';
import { mountIsland, unmountIslands } from './react/islands.jsx';
import { TvHead, TvExit } from './react/home/TvHead.jsx';

// ── TV Mode ────────────────────────────────────────────────────────────────

var _tvCharts = {};

// Заливает данные в уже созданный TV-чарт (вызывается сразу или после фетча)
function _tvApplyData(sym, s, vs, volClr) {
  var tf = state.chartTF[sym] || '5m';
  var cd = state.chartData[sym + '_' + tf];
  if (!cd || cd.status !== 'ok' || !cd.candles.length) return;
  var lastClose = cd.candles[cd.candles.length - 1].close;
  s.applyOptions({ priceFormat: calcPriceFormat(lastClose) });
  s.setData(cd.candles);
  var tvVolDn = getCSSVar('--vol-dn');
  vs.setData(cd.candles.map(function (k) { return { time: k.time, value: k.volume || 0, color: k.close >= k.open ? volClr : tvVolDn }; }));
  var chart = _tvCharts[sym];
  if (chart) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, cd.candles.length - 80), to: cd.candles.length - 1 });
}
var _tvInterval = null;
window.__tvChartSeries = {};
window.__tvChartVolSeries = {};

function _tvRefresh() {
  var overlay = document.getElementById('tv-overlay');
  if (!overlay || overlay.style.display === 'none') { clearInterval(_tvInterval); _tvInterval = null; return; }

  var newCoins = filteredCoins().slice(0, 6);
  var newSyms = newCoins.map(function (c) { return c.symbol; }).join(',');
  var oldSyms = Array.from(overlay.querySelectorAll('.tv-slot-head')).map(function (el) { return el.dataset.tvSym; }).join(',');

  if (newSyms !== oldSyms) {
    // Top-6 changed — full rebuild (stays in fullscreen)
    openTVMode();
    return;
  }

  // Same coins — the heads (React islands) redraw themselves
}

export function openTVMode() {
  var coins = filteredCoins().slice(0, 6);
  if (!coins.length) return;

  var overlay = document.getElementById('tv-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tv-overlay';
    overlay.className = 'tv-overlay overlay';
    document.body.appendChild(overlay);
  }

  // Slot heads and the exit button are React islands (src/react/home/TvHead.jsx)
  unmountIslands(overlay);
  overlay.innerHTML =
    '<div class="tv-exit"></div>' +
    '<div class="tv-grid">' +
    coins.map(function (c) {
      return '<div class="tv-slot">' +
        '<div class="tv-slot-head" data-tv-sym="' + c.symbol + '"></div>' +
        '<div class="tv-chart" id="tvchart-' + c.symbol + '"></div>' +
      '</div>';
    }).join('') +
    '</div>';
  mountIsland(overlay.querySelector('.tv-exit'), TvExit);
  overlay.querySelectorAll('.tv-slot-head').forEach(function (el) { mountIsland(el, TvHead, { sym: el.dataset.tvSym }); });

  overlay.style.display = 'block';
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    if (overlay.requestFullscreen) overlay.requestFullscreen().catch(function () {});
    else if (overlay.webkitRequestFullscreen) overlay.webkitRequestFullscreen();
  }

  // Periodic refresh: update headers every 30s, rebuild if top-6 changed
  if (_tvInterval) clearInterval(_tvInterval);
  _tvInterval = setInterval(_tvRefresh, 30000);

  // destroy previous TV charts
  Object.keys(_tvCharts).forEach(function (sym) { try { _tvCharts[sym].remove(); } catch (e) {} });
  _tvCharts = {};
  window.__tvChartSeries = {};
  window.__tvChartVolSeries = {};

  // create charts staggered — TV hardware needs time between each init.
  // autoSize:false + explicit dims avoids the dual-ResizeObserver conflict that
  // blanks charts on old TV WebKit (autoSize creates its own RO; ours conflicts).
  coins.forEach(function (c, idx) {
    setTimeout(function () {
      var el = document.getElementById('tvchart-' + c.symbol);
      if (!el || !window.LightweightCharts) return;

      // Explicit dimensions — more reliable than autoSize on TV browsers
      var w = el.offsetWidth || el.parentElement.offsetWidth || 400;
      var h = el.offsetHeight || Math.max(el.parentElement.offsetHeight - 34, 120);
      var opts = getChartOpts();
      opts.autoSize = false;
      opts.width = w;
      opts.height = h;

      var chart = window.LightweightCharts.createChart(el, opts);
      var s = chart.addCandlestickSeries(getSeriesColors());
      var volClr = getCSSVar('--vol-up');
      var vs = chart.addHistogramSeries({ color: volClr, priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      _tvCharts[c.symbol] = chart;
      window.__tvChartSeries[c.symbol] = s;
      window.__tvChartVolSeries[c.symbol] = vs;

      var tf = state.chartTF[c.symbol] || '5m';
      var cd = state.chartData[c.symbol + '_' + tf];
      if (cd && cd.status === 'ok' && cd.candles.length) {
        _tvApplyData(c.symbol, s, vs, volClr);
      } else {
        // Данные ещё не загружены — фетчим и заливаем когда придут
        fetchChartData(c.symbol, tf).then(function () {
          if (_tvCharts[c.symbol]) _tvApplyData(c.symbol, s, vs, volClr);
        });
      }

      // Single ResizeObserver — safe since autoSize is off
      new ResizeObserver(function () {
        var nw = el.offsetWidth, nh = el.offsetHeight;
        if (_tvCharts[c.symbol] && nw && nh) _tvCharts[c.symbol].resize(nw, nh);
      }).observe(el);
    }, 400 + idx * 200);
  });

  // Final forced resize after all charts are created + layout settles (~2.5s total)
  setTimeout(function () {
    coins.forEach(function (c) {
      var el = document.getElementById('tvchart-' + c.symbol);
      if (el && _tvCharts[c.symbol]) {
        var nw = el.offsetWidth, nh = el.offsetHeight;
        if (nw && nh) _tvCharts[c.symbol].resize(nw, nh);
      }
    });
  }, 400 + 6 * 200 + 300);
}

export function closeTVMode() {
  if (_tvInterval) { clearInterval(_tvInterval); _tvInterval = null; }
  var overlay = document.getElementById('tv-overlay');
  if (overlay) { overlay.style.display = 'none'; unmountIslands(overlay); }
  if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
  Object.keys(_tvCharts).forEach(function (sym) { try { _tvCharts[sym].remove(); } catch (e) {} });
  _tvCharts = {};
  window.__tvChartSeries = {};
  window.__tvChartVolSeries = {};
}

// close TV mode when user presses ESC / exits fullscreen
document.addEventListener('fullscreenchange', function () {
  if (!document.fullscreenElement) {
    var overlay = document.getElementById('tv-overlay');
    if (overlay && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
      unmountIslands(overlay);
      Object.keys(_tvCharts).forEach(function (sym) { try { _tvCharts[sym].remove(); } catch (e) {} });
      _tvCharts = {};
      window.__tvChartSeries = {};
      window.__tvChartVolSeries = {};
    }
  }
});
