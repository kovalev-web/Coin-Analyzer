/**
 * Grid Scanner client — §4.6 useScreener (adapted: vanilla JS, no React)
 *
 * Fetches /api/kdata, calculates NATR + RVOL client-side from returned klines,
 * renders top-9 as LightweightCharts candlestick grid.
 */

const API_BASE = (import.meta.env.VITE_WS_URL || '')
  .replace(/^wss?:\/\//, 'https://')
  .replace(/\/ws$/, '');

// ── Auth ─────────────────────────────────────────────────────────────────────

async function checkAuth() {
  if (!API_BASE) return;
  try {
    const r = await fetch(API_BASE + '/auth/get-session', { credentials: 'include' });
    if (!r.ok) throw 0;
    const s = await r.json();
    if (!s?.user?.id) throw 0;
  } catch {
    window.location.replace('/login');
    await new Promise(() => {});
  }
}

// ── §4.6 Indicators (client-side, pure functions matching backend) ────────────

const ATR_PERIOD  = 14;
const RVOL_PERIOD = 20;

function calcNATR(klines) {
  if (!klines || klines.length < ATR_PERIOD + 1) return 0;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = +klines[i][2], l = +klines[i][3], pc = +klines[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < ATR_PERIOD) return 0;
  let atr = trs.slice(0, ATR_PERIOD).reduce((a, v) => a + v, 0) / ATR_PERIOD;
  for (let i = ATR_PERIOD; i < trs.length; i++) atr = (atr * (ATR_PERIOD - 1) + trs[i]) / ATR_PERIOD;
  const lc = +klines[klines.length - 1][4];
  return lc > 0 ? atr / lc * 100 : 0;
}

function calcRVOL(klines) {
  if (!klines || klines.length < RVOL_PERIOD + 2) return 0;
  const last   = +klines[klines.length - 1][5];
  const closed = klines.slice(-RVOL_PERIOD - 1, -1);
  if (!closed.length) return 0;
  const avg = closed.reduce((s, k) => s + +k[5], 0) / closed.length;
  return avg > 0 ? last / avg : 0;
}

// ── §4.6 fetchPage — one call, gets klines + deltas for pageSize symbols ─────

async function fetchPage(pageSize) {
  const r = await fetch(`/api/kdata?pageSize=${pageSize}&sortMode=abs&order=desc`);
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error((j.error || 'kdata') + ' ' + r.status);
  }
  return r.json(); // { klines, deltas, order, nextCursor, hasMore, asOf }
}

// ── Charts ───────────────────────────────────────────────────────────────────

const LW = () => window.LightweightCharts;

const CHART_OPTS = {
  autoSize: true,
  layout: {
    background:  { color: '#0f1114' },
    textColor:   '#5a6872',
    fontSize:    11,
    fontFamily:  'Manrope, system-ui, sans-serif',
  },
  grid: {
    vertLines: { color: 'rgba(255,255,255,0.03)' },
    horzLines: { color: 'rgba(255,255,255,0.03)' },
  },
  crosshair: { mode: 1 },
  rightPriceScale: {
    borderColor:   '#1e262c',
    scaleMargins:  { top: 0.05, bottom: 0.22 },
  },
  timeScale: {
    borderColor:     '#1e262c',
    timeVisible:     true,
    secondsVisible:  false,
    rightOffset:     3,
  },
  handleScroll: true,
  handleScale:  true,
};

const CANDLE_OPTS = {
  upColor:         '#4dab90',
  downColor:       '#d9534f',
  borderUpColor:   '#4dab90',
  borderDownColor: '#d9534f',
  wickUpColor:     '#4dab90',
  wickDownColor:   '#d9534f',
};

const charts = {}; // sym → { chart, series, vol }

function toCandles(klines) {
  return klines.map(k => ({
    time: Math.floor(+k[0] / 1000),
    open: +k[1], high: +k[2], low: +k[3], close: +k[4],
  }));
}
function toVol(klines) {
  return klines.map(k => ({
    time:  Math.floor(+k[0] / 1000),
    value: +k[5],
    color: +k[4] >= +k[1] ? 'rgba(77,171,144,0.3)' : 'rgba(217,83,79,0.3)',
  }));
}

function destroyAll() {
  Object.keys(charts).forEach(sym => {
    try { charts[sym].chart.remove(); } catch {}
    delete charts[sym];
  });
}

function initChart(sym, klines) {
  const wrap = document.getElementById('gc-' + sym);
  if (!wrap) return;

  const chart  = LW().createChart(wrap, CHART_OPTS);
  const series = chart.addCandlestickSeries(CANDLE_OPTS);
  const vol    = chart.addHistogramSeries({
    priceFormat:      { type: 'volume' },
    priceScaleId:     'vol',
    lastValueVisible:  false,
    priceLineVisible:  false,
  });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  if (klines.length) {
    series.setData(toCandles(klines));
    vol.setData(toVol(klines));
    chart.timeScale().fitContent();
  }

  charts[sym] = { chart, series, vol };
}

function updateChart(sym, klines) {
  const c = charts[sym];
  if (!c || !klines.length) return;
  c.series.setData(toCandles(klines));
  c.vol.setData(toVol(klines));
  c.chart.timeScale().fitContent();
}

// ── Render ───────────────────────────────────────────────────────────────────

let currentSyms = [];

function fmtDelta(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function fmtPct(v)   { return v.toFixed(2) + '%'; }
function fmtX(v)     { return v.toFixed(2) + 'x'; }

function render(response) {
  const { klines: klinesMap, deltas, order: syms, asOf } = response;
  const grid = document.getElementById('g-grid');
  const newSyms = syms.slice(0, 9);

  // Compute NATR + RVOL client-side from returned klines (§4.6)
  const rows = newSyms.map(sym => ({
    sym,
    delta: deltas[sym] || 0,
    natr:  calcNATR(klinesMap[sym]),
    rvol:  calcRVOL(klinesMap[sym]),
    klines: klinesMap[sym] || [],
  }));

  const sameSet = newSyms.join(',') === currentSyms.join(',');

  if (sameSet) {
    // Same symbols — update text + chart data in-place (no DOM thrash)
    rows.forEach(row => {
      const card = grid.querySelector(`.g-card[data-sym="${row.sym}"]`);
      if (!card) return;
      const d = card.querySelector('.g-delta');
      d.textContent  = fmtDelta(row.delta);
      d.className    = 'g-delta ' + (row.delta >= 0 ? 'up' : 'dn');
      card.querySelector('.g-natr').textContent = fmtPct(row.natr);
      card.querySelector('.g-rvol').textContent = fmtX(row.rvol);
      updateChart(row.sym, row.klines);
    });
  } else {
    // Symbols changed — full re-render
    destroyAll();
    grid.innerHTML = rows.map(row => {
      const base = row.sym.replace(/USDT$/, '');
      const dCls = row.delta >= 0 ? 'up' : 'dn';
      return `<div class="g-card" data-sym="${row.sym}">
        <div class="g-head">
          <span class="g-sym">${base}</span>
          <span class="g-delta ${dCls}">${fmtDelta(row.delta)}</span>
          <span class="g-label">NATR</span><span class="g-natr">${fmtPct(row.natr)}</span>
          <span class="g-label">RVol</span><span class="g-rvol">${fmtX(row.rvol)}</span>
        </div>
        <div class="g-chart" id="gc-${row.sym}"></div>
      </div>`;
    }).join('');

    requestAnimationFrame(() => {
      rows.forEach(row => initChart(row.sym, row.klines));
    });

    currentSyms = newSyms;
  }

  setMeta('asOf ' + new Date(asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
}

// ── Status ───────────────────────────────────────────────────────────────────

function setMeta(t) {
  const el = document.getElementById('g-meta');
  if (el) el.textContent = t;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const data = await fetchPage(9);
    render(data);
  } catch (e) {
    setMeta('Error: ' + e.message);
  }
}

async function init() {
  await checkAuth();
  setMeta('Building snapshot…');
  await refresh();
  setInterval(refresh, 10000); // TTL на сервере 8s → к моменту следующего запроса данные всегда свежие
}

init();
