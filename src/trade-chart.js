// ── Trade chart ─────────────────────────────────────────────────────────────
// A small candle chart of one trade, opened from the journal's day drill-down:
// candles around the trade straight from Binance's public API (no load on our
// server), every fill as a ▲ / ▼ where it happened, dashed lines at the average
// entry and exit, and the result. Built on click, one at a time, removed on
// close. Used by src/edge-view.js. Tests: npm run test:tradechart

import { tzTimeStr } from './utils.js';

// Candle size and window for a trade: 1m up to 90 min held, 5m up to 8 h,
// else 15m; a margin of max(20 candles, half the hold) before and after.
// → { interval, ms, from, to }
export function chartWindow(openMs, closeMs) {
  var hold = Math.max(0, (closeMs || openMs) - openMs);
  var interval = hold <= 90 * 60000 ? '1m' : hold <= 8 * 3600000 ? '5m' : '15m';
  var ms = { '1m': 60000, '5m': 300000, '15m': 900000 }[interval];
  var pad = Math.max(20 * ms, hold / 2);
  return { interval: interval, ms: ms, from: Math.floor((openMs - pad) / ms) * ms, to: Math.ceil(((closeMs || openMs) + pad) / ms) * ms };
}

// Average price of the entry fills and of the exit fills (by quantity).
// side 'long': BUY fills enter, SELL exit; 'short' the other way round.
export function avgPrices(execs, side) {
  var inSide = side === 'long' ? 'BUY' : 'SELL';
  var acc = { inQ: 0, inV: 0, outQ: 0, outV: 0 };
  (execs || []).forEach(function (e) {
    if (e.s === inSide) { acc.inQ += e.q; acc.inV += e.q * e.p; } else { acc.outQ += e.q; acc.outV += e.q * e.p; }
  });
  return { entry: acc.inQ ? acc.inV / acc.inQ : null, exit: acc.outQ ? acc.outV / acc.outQ : null };
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

var _open = null; // { chart, box }

export function closeTradeChart() {
  if (_open) { try { _open.chart.remove(); } catch (e) {} _open.box.remove(); }
  _open = null;
}

// host: element the chart goes into; trade: { symbol, side, openTime, closeTime, execs, r, pnlNet, notional }
export function openTradeChart(host, trade) {
  closeTradeChart();
  var LW = window.LightweightCharts;
  if (!LW || !host) return;
  var box = document.createElement('div');
  box.className = 'trade-chart';
  box.innerHTML = '<div class="trade-chart-plot"></div><div class="trade-chart-note">Загружаю свечи…</div>';
  host.appendChild(box);
  var plot = box.firstChild, note = box.lastChild;
  var chart = LW.createChart(plot, {
    height: 240, autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: cssVar('--graphite'), fontSize: 11 },
    grid: { vertLines: { color: 'transparent' }, horzLines: { color: cssVar('--steel') } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false,
      tickMarkFormatter: function (t) { return tzTimeStr(new Date(t * 1000)); } },
    localization: { timeFormatter: function (t) { return tzTimeStr(new Date(t * 1000)); } }, // your timezone, like the rest of the journal
    crosshair: { mode: 0 },
    handleScroll: true, handleScale: true,
  });
  _open = { chart: chart, box: box };
  var series = chart.addCandlestickSeries({
    upColor: cssVar('--bullish'), downColor: cssVar('--danger'), borderVisible: false,
    wickUpColor: cssVar('--bullish'), wickDownColor: cssVar('--danger'),
  });

  var w = chartWindow(trade.openTime, trade.closeTime);
  var url = 'https://fapi.binance.com/fapi/v1/klines?symbol=' + encodeURIComponent(trade.symbol)
    + '&interval=' + w.interval + '&startTime=' + w.from + '&endTime=' + w.to + '&limit=1500';
  fetch(url).then(function (r) { return r.json(); }).then(function (rows) {
    if (!_open || _open.chart !== chart) return;
    if (!Array.isArray(rows) || !rows.length) { note.textContent = 'Binance не отдал свечи за это время'; return; }
    series.setData(rows.map(function (k) { return { time: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4] }; }));
    // Every fill: ▲ buy below the candle, ▼ sell above, at the fill's candle
    var execs = (trade.execs || []).slice().sort(function (a, b) { return a.t - b.t; });
    series.setMarkers(execs.map(function (e) {
      var buy = e.s === 'BUY';
      return { time: Math.floor(e.t / w.ms) * w.ms / 1000, position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown',
        color: cssVar(buy ? '--bullish' : '--danger'), text: String(e.p) };
    }));
    var avg = avgPrices(execs, trade.side);
    if (avg.entry) series.createPriceLine({ price: avg.entry, color: cssVar('--ink-deep'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'вход' });
    if (avg.exit) series.createPriceLine({ price: avg.exit, color: cssVar(trade.pnlNet >= 0 ? '--bullish' : '--danger'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'выход' });
    var pct = avg.entry && avg.exit ? (trade.side === 'long' ? avg.exit / avg.entry - 1 : 1 - avg.exit / avg.entry) * 100 : null;
    note.innerHTML = (trade.r != null ? '<b class="' + (trade.r >= 0 ? 'up' : 'dn') + '">' + (trade.r > 0 ? '+' : trade.r < 0 ? '−' : '') + Math.abs(trade.r).toFixed(2) + 'R</b>' : '')
      + (pct != null ? ' · ' + (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct).toFixed(2) + '%' : '')
      + ' · свечи ' + w.interval + (execs.length ? '' : ' · исполнений нет (сделка из старых данных)');
    chart.timeScale().fitContent();
  }).catch(function () { if (_open && _open.chart === chart) note.textContent = 'Не удалось загрузить свечи с Binance'; });
}
