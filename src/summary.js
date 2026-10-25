// ── Day summary strip on the main screen ──────────────────────────────────────
// Leaders (BTC, ETH, SOL: price, 24h change and a mini 1h-candle chart of the
// last 48 hours) and your own last-24h results
// per coin (realized PnL net of commission, from Binance income — via the
// trading key for the trading account, else the read-only journal key).

import { state } from './state.js';
import { API_BASE } from './api.js';

var LEADERS = ['btc', 'eth', 'sol'];
var REFRESH_MS = 60 * 1000; // server caches 30 s

var KLINES_MS = 5 * 60 * 1000;   // re-fetch the hourly candles every 5 min
var SPARK_HOURS = 48;

var S = { mine: null, loadedAt: 0, loading: false, timer: null, kl: {}, klAt: 0, charts: {} };

function fmtPrice(p) {
  if (p == null) return '—';
  return p >= 100 ? p.toLocaleString('en-US', { maximumFractionDigits: 1 }) : p.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function signed(n, digits) {
  return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(digits);
}

function coinOf(sym) { return (state.coins || []).find(function (x) { return x.symbol === sym; }); }

function changeOf(c) {
  return c ? (c.open_24h > 0 && c.current_price > 0 ? (c.current_price - c.open_24h) / c.open_24h * 100 : (c.price_change_percentage_24h || 0)) : null;
}

// Static skeleton: the chart element must survive the 5-second text refresh
function leaderHTML(sym) {
  return '<button class="ds-leader" data-action="expand" data-sym="' + sym + '" data-leader="' + sym + '">'
    + '<span class="ds-leader-top"><span class="ds-sym">' + sym.toUpperCase() + '</span>'
    + '<span class="ds-px" id="ds-px-' + sym + '"></span>'
    + '<span class="ds-ch" id="ds-ch-' + sym + '"></span></span>'
    + '<span class="ds-spark" id="ds-spark-' + sym + '"></span>'
    + '</button>';
}

function _paintLeaders() {
  LEADERS.forEach(function (sym) {
    var c = coinOf(sym), ch = changeOf(c);
    var px = document.getElementById('ds-px-' + sym), chEl = document.getElementById('ds-ch-' + sym);
    if (px) px.textContent = c ? fmtPrice(c.current_price) : '—';
    if (chEl) { chEl.textContent = ch == null ? '' : signed(ch, 2) + '%'; chEl.className = 'ds-ch ' + (ch > 0 ? 'up' : ch < 0 ? 'dn' : ''); }
    _updateLastCandle(sym, c);
  });
}

// ── Mini charts ─────────────────────────────────────────────────────────────

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

async function _loadKlines() {
  if (Date.now() - S.klAt < KLINES_MS) return;
  S.klAt = Date.now();
  await Promise.all(LEADERS.map(async function (sym) {
    try {
      var r = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + sym.toUpperCase() + 'USDT&interval=1h&limit=' + SPARK_HOURS);
      var rows = await r.json();
      if (!Array.isArray(rows)) return;
      S.kl[sym] = rows.map(function (k) {
        return { time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] };
      });
    } catch (e) {}
  }));
  _initCharts(true);
}

function _initCharts(newData) {
  var LC = window.LightweightCharts;
  if (!LC) { setTimeout(_initCharts, 300); return; }
  LEADERS.forEach(function (sym) {
    var el = document.getElementById('ds-spark-' + sym);
    var cur = S.charts[sym];
    if (cur && cur.el !== el) { try { cur.chart.remove(); } catch (e) {} cur = S.charts[sym] = null; } // re-rendered page
    if (!el || !S.kl[sym]) return;
    if (!cur) {
      var up = cssVar('--bullish') || '#16a34a', dn = cssVar('--danger') || '#ff5050';
      var chart = LC.createChart(el, {
        autoSize: true,
        layout: { background: { color: 'transparent' }, textColor: 'transparent', attributionLogo: false },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        rightPriceScale: { visible: false }, leftPriceScale: { visible: false },
        timeScale: { visible: false, borderVisible: false, rightOffset: 1 },
        crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        handleScroll: false, handleScale: false,
      });
      var series = chart.addCandlestickSeries({
        upColor: up, downColor: dn, wickUpColor: up, wickDownColor: dn, borderVisible: false,
        priceLineVisible: false, lastValueVisible: false,
      });
      cur = S.charts[sym] = { el: el, chart: chart, series: series };
      newData = true;
    }
    if (newData) { cur.series.setData(S.kl[sym]); cur.chart.timeScale().fitContent(); }
  });
}

// Live price moves the last hourly candle between kline refreshes
function _updateLastCandle(sym, c) {
  var cur = S.charts[sym], kl = S.kl[sym];
  if (!cur || !kl || !kl.length || !c || !(c.current_price > 0)) return;
  var last = kl[kl.length - 1];
  if (Math.abs(c.current_price - last.close) / last.close > 0.2) return; // bad tick, not a move
  var hourStart = Math.floor(Date.now() / 3600000) * 3600;
  if (hourStart > last.time) { last = { time: hourStart, open: last.close, high: last.close, low: last.close, close: last.close }; kl.push(last); kl.shift(); }
  last.close = c.current_price;
  last.high = Math.max(last.high, last.close);
  last.low = Math.min(last.low, last.close);
  try { cur.series.update(last); } catch (e) {}
}

var MAX_BARS = 8; // up to 8 trades a day; older ones drop off the left

// "Your 24h" card: total, W/L, and one bar per trade (height = size of the
// result, color = sign), coin under each bar.
function mineHTML() {
  if (state.isDemoMode) return '';
  var m = S.mine;
  var head = '<span class="ds-leader-top"><span class="ds-sym">Your 24h</span>';
  if (!m || m.error) {
    return '<div class="ds-leader ds-mine-card">' + head + '</span><span class="ds-mine-empty">'
      + (m && m.error ? m.error : S.loading ? 'Loading…' : '—') + '</span></div>';
  }
  var sm = m.summary;
  head += '<span class="ds-ch ' + (sm.pnlNet > 0 ? 'up' : sm.pnlNet < 0 ? 'dn' : '') + '">' + signed(sm.pnlNet, 2) + ' USDT</span></span>';
  var sub = '<span class="ds-mine-sub">' + (sm.trades ? sm.trades + ' trade' + (sm.trades === 1 ? '' : 's') + ' · ' + sm.wins + 'W / ' + sm.losses + 'L' : 'No trades')
    + (sm.open ? ' · ' + sm.open + ' open' : '') + '</span>';
  var trades = m.trades.slice(-MAX_BARS);
  if (!trades.length) return '<div class="ds-leader ds-mine-card">' + head + sub + '<span class="ds-mine-empty">No trades in the last 24 hours</span></div>';
  var maxAbs = Math.max.apply(null, trades.map(function (t) { return Math.abs(t.pnlNet) || 0; }).concat([1e-9]));
  var bars = trades.map(function (t) {
    var sym = t.symbol.replace(/USDT$/, '');
    var h = t.result === 'open' ? 30 : Math.max(8, Math.round(Math.abs(t.pnlNet) / maxAbs * 100));
    var cls = t.result === 'open' ? 'open' : t.pnlNet >= 0 ? 'up' : 'dn';
    var tip = sym + ' ' + t.side + ' · ' + (t.result === 'open' ? 'open' : signed(t.pnlNet, 2) + ' USDT');
    return '<span class="ds-bar" data-action="expand" data-sym="' + sym.toLowerCase() + '" title="' + tip + '">'
      + '<span class="ds-bar-fill ' + cls + '" style="height:' + h + '%"></span>'
      + '<span class="ds-bar-sym">' + sym + '</span></span>';
  }).join('');
  return '<div class="ds-leader ds-mine-card">' + head + sub + '<span class="ds-bars">' + bars + '</span></div>';
}

export function daySummaryHTML() {
  _ensureTimer();
  // Charts attach after render() puts this HTML into the page
  setTimeout(function () { _paintLeaders(); _initCharts(); _loadKlines(); }, 0);
  return '<div class="day-summary" id="day-summary">'
    + '<div class="ds-leaders">' + LEADERS.map(leaderHTML).join('')
    + '<div id="ds-mine-wrap">' + mineHTML() + '</div></div>'
    + '</div>';
}

function _paint() {
  if (!document.getElementById('day-summary')) return;
  _paintLeaders();
  var mine = document.getElementById('ds-mine-wrap');
  if (mine) mine.innerHTML = mineHTML();
}

function _ensureTimer() {
  if (S.timer) return;
  S.timer = setInterval(function () {
    if (!document.getElementById('day-summary')) return;
    if (Date.now() - S.loadedAt > REFRESH_MS) _loadMine(); else _paint(); // leaders follow live prices
    _loadKlines();
  }, 5000);
  _loadMine();
}

async function _loadMine() {
  if (state.isDemoMode || S.loading) return;
  S.loading = true;
  try {
    var res = await fetch(API_BASE + '/api/journal/last24h', { credentials: 'include' });
    var data = await res.json().catch(function () { return {}; });
    S.mine = res.ok ? data : { error: res.status === 403 ? 'Connect Binance API to see trades' : 'Unavailable' };
    S.loadedAt = Date.now();
  } catch (e) {
    S.mine = { error: 'Unavailable' };
  } finally {
    S.loading = false;
    _paint();
  }
}
