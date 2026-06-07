// Grid Scanner — standalone page (/grid)
// No dependencies on the main app modules.

const API_BASE = (import.meta.env.VITE_WS_URL || '')
  .replace(/^wss?:\/\//, 'https://')
  .replace(/\/ws$/, '');

const EXCLUDE_BASE = new Set([
  'btc', 'eth', 'bnb',
  'usdt', 'usdc', 'busd', 'dai', 'tusd', 'usdp', 'gusd', 'frax', 'lusd', 'usdd', 'pyusd', 'fdusd',
]);

// Dark theme colors (matching main app dark mode)
const COLORS = {
  bg:       '#121517',
  grid:     'rgba(255,255,255,0.04)',
  border:   '#2d3940',
  text:     '#637880',
  up:       '#c2ccd0',
  dn:       '#3b4b54',
  volUp:    'rgba(194,204,208,0.25)',
  volDn:    'rgba(59,75,84,0.35)',
};

// ── Auth ───────────────────────────────────────────────────────────────────

async function checkAuth() {
  if (!API_BASE) return;
  try {
    const r = await fetch(API_BASE + '/auth/get-session', { credentials: 'include' });
    if (!r.ok) throw 0;
    const s = await r.json();
    if (!s || !s.user || !s.user.id) throw 0;
  } catch {
    window.location.replace('/login');
    await new Promise(() => {});
  }
}

// ── Binance proxy ──────────────────────────────────────────────────────────

async function binance(path, params) {
  const q = new URLSearchParams({ path, ...(params || {}) }).toString();
  let r;
  try {
    r = await fetch('/api/fapi?' + q);
  } catch (e) {
    throw new Error('network: ' + e.message);
  }
  if (!r.ok) {
    let detail = '';
    try { const j = await r.json(); detail = j.error || j.msg || ''; } catch {}
    throw new Error('fapi ' + r.status + (detail ? ' — ' + detail : ''));
  }
  return r.json();
}

// ── Indicators ─────────────────────────────────────────────────────────────

function delta5m(klines) {
  if (!klines || !klines.length) return 0;
  const k = klines[klines.length - 1];
  const o = +k[1], c = +k[4];
  return o > 0 ? (c - o) / o * 100 : 0;
}

function natr14(klines) {
  if (!klines || klines.length < 16) return 0;
  const p = 14;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = +klines[i][2], l = +klines[i][3], pc = +klines[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < p) return 0;
  let atr = 0;
  for (let i = 0; i < p; i++) atr += trs[i];
  atr /= p;
  for (let i = p; i < trs.length; i++) atr = (atr * (p - 1) + trs[i]) / p;
  const lc = +klines[klines.length - 1][4];
  return lc > 0 ? atr / lc * 100 : 0;
}

function rvol20(klines) {
  if (!klines || klines.length < 5) return 0;
  const last = +klines[klines.length - 1][5];
  const lb = klines.slice(-21, -1);
  if (!lb.length) return 0;
  const avg = lb.reduce((s, k) => s + +k[5], 0) / lb.length;
  return avg > 0 ? last / avg : 0;
}

function scoreAll(cache) {
  const entries = Object.keys(cache)
    .map(sym => ({
      sym,
      delta: delta5m(cache[sym]),
      natr:  natr14(cache[sym]),
      rvol:  rvol20(cache[sym]),
    }))
    .filter(e => cache[e.sym] && cache[e.sym].length >= 16);

  const mxD = Math.max(...entries.map(e => Math.abs(e.delta))) || 1;
  const mxN = Math.max(...entries.map(e => e.natr))            || 1;
  const mxR = Math.max(...entries.map(e => e.rvol))            || 1;

  return entries
    .map(e => ({ ...e, score: Math.abs(e.delta) / mxD + e.natr / mxN + e.rvol / mxR }))
    .sort((a, b) => b.score - a.score);
}

// ── State ──────────────────────────────────────────────────────────────────

const klineCache = {};
let candidates = [];
const chartInstances = {}; // sym → { chart, candles, vol }

// ── Fetch helpers ──────────────────────────────────────────────────────────

async function fetchKlines(sym, limit) {
  try {
    const data = await binance('/fapi/v1/klines', { symbol: sym, interval: '5m', limit: limit || 55 });
    if (Array.isArray(data)) klineCache[sym] = data;
  } catch { /* skip */ }
}

async function batchFetch(syms, limit, onProgress) {
  const size = 10;
  for (let i = 0; i < syms.length; i += size) {
    await Promise.all(syms.slice(i, i + size).map(s => fetchKlines(s, limit)));
    if (onProgress) onProgress(Math.min(i + size, syms.length), syms.length);
  }
}

// ── Chart helpers ──────────────────────────────────────────────────────────

function toCandles(klines) {
  return (klines || []).map(k => ({
    time: Math.floor(+k[0] / 1000),
    open: +k[1], high: +k[2], low: +k[3], close: +k[4],
  }));
}

function toVolume(klines) {
  return (klines || []).map(k => ({
    time: Math.floor(+k[0] / 1000),
    value: +k[5],
    color: +k[4] >= +k[1] ? COLORS.volUp : COLORS.volDn,
  }));
}

function tickFmt(ts, type) {
  const d = new Date(ts * 1000);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  if (type <= 1) return mon + ' ' + d.getFullYear();
  if (type === 2) return day + ' ' + mon;
  return h + ':' + m;
}

function destroyChart(sym) {
  if (chartInstances[sym]) {
    try { chartInstances[sym].chart.remove(); } catch {}
    delete chartInstances[sym];
  }
}

function destroyAll() {
  Object.keys(chartInstances).forEach(destroyChart);
}

function initChart(sym) {
  const wrap = document.getElementById('gc-' + sym);
  if (!wrap) return;

  // Safety: destroy stale instance if container was replaced
  if (chartInstances[sym]) destroyChart(sym);

  const chart = window.LightweightCharts.createChart(wrap, {
    autoSize: true,
    layout: {
      background: { color: COLORS.bg },
      textColor: COLORS.text,
      fontSize: 11,
      fontFamily: 'Manrope, Arial, sans-serif',
    },
    grid: {
      vertLines: { color: COLORS.grid },
      horzLines: { color: COLORS.grid },
    },
    crosshair: { mode: 0 },
    rightPriceScale: {
      visible: true,
      borderColor: COLORS.border,
      scaleMargins: { top: 0.05, bottom: 0.25 },
    },
    timeScale: {
      borderColor: COLORS.border,
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: tickFmt,
      rightOffset: 3,
    },
    handleScroll: false,
    handleScale: false,
  });

  const candles = chart.addCandlestickSeries({
    upColor:        COLORS.up,
    downColor:      COLORS.dn,
    borderUpColor:  COLORS.up,
    borderDownColor:COLORS.dn,
    wickUpColor:    COLORS.up,
    wickDownColor:  COLORS.dn,
  });

  const vol = chart.addHistogramSeries({
    color: COLORS.volUp,
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
    lastValueVisible: false,
    priceLineVisible: false,
  });
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  chartInstances[sym] = { chart, candles, vol };

  const klines = klineCache[sym];
  if (klines && klines.length) {
    candles.setData(toCandles(klines));
    vol.setData(toVolume(klines));
    chart.timeScale().fitContent();
  }
}

function updateChartData(sym) {
  const c = chartInstances[sym];
  if (!c) return;
  const klines = klineCache[sym];
  if (!klines || !klines.length) return;
  c.candles.setData(toCandles(klines));
  c.vol.setData(toVolume(klines));
  c.chart.timeScale().fitContent();
}

// ── Grid render ────────────────────────────────────────────────────────────

let currentSyms = [];

function pct(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function signCls(v) { return v >= 0 ? 'pos' : 'neg'; }

function renderGrid(top9) {
  const newSyms = top9.map(e => e.sym);
  const grid = document.getElementById('g-grid');

  if (newSyms.join(',') === currentSyms.join(',')) {
    // Same set + same order — update numbers and chart data only, no DOM changes
    top9.forEach(e => {
      const card = grid.querySelector(`.g-card[data-sym="${e.sym}"]`);
      if (!card) return;
      const dEl = card.querySelector('.g-delta');
      dEl.textContent = pct(e.delta);
      dEl.className = 'g-delta ' + signCls(e.delta);
      const badges = card.querySelectorAll('.g-badge');
      if (badges[0]) badges[0].textContent = 'NATR ' + e.natr.toFixed(2) + '%';
      if (badges[1]) badges[1].textContent = 'RVol ' + e.rvol.toFixed(2) + 'x';
      updateChartData(e.sym);
    });
    return;
  }

  // Symbols or order changed — destroy ALL old chart instances first (their DOM containers
  // are about to be replaced by innerHTML, so we must remove them cleanly before that)
  destroyAll();

  grid.innerHTML = top9.map(e => {
    const base = e.sym.replace(/USDT$/, '');
    return `<div class="g-card" data-sym="${e.sym}">
      <div class="g-head">
        <span class="g-sym">${base}</span>
        <span class="g-delta ${signCls(e.delta)}">${pct(e.delta)}</span>
        <span class="g-badge">NATR ${e.natr.toFixed(2)}%</span>
        <span class="g-badge">RVol ${e.rvol.toFixed(2)}x</span>
      </div>
      <div class="g-chart-wrap" id="gc-${e.sym}"></div>
    </div>`;
  }).join('');

  // Init charts after DOM is painted so autoSize can read container dimensions
  requestAnimationFrame(() => {
    top9.forEach(e => initChart(e.sym));
  });

  currentSyms = newSyms;
}

// ── Status line ────────────────────────────────────────────────────────────

function setMeta(text) {
  const el = document.getElementById('g-meta');
  if (el) el.textContent = text;
}

function tsNow() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Refresh cycles ─────────────────────────────────────────────────────────

async function quickRefresh() {
  if (!currentSyms.length) return;
  await Promise.all(currentSyms.map(s => fetchKlines(s, 55)));
  const scored = scoreAll(klineCache);
  renderGrid(scored.slice(0, 9));
  setMeta('Δ5m · NATR · RVol · ' + tsNow());
}

async function fullRefresh() {
  await batchFetch(candidates, 55);
  const scored = scoreAll(klineCache);
  renderGrid(scored.slice(0, 9));
  setMeta('Δ5m · NATR · RVol · ' + tsNow());
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  await checkAuth();
  setMeta('Fetching tickers…');

  let tickers;
  try {
    tickers = await binance('/fapi/v1/ticker/24hr');
  } catch (e) {
    setMeta('Error: ' + e.message);
    return;
  }

  candidates = tickers
    .filter(t => {
      if (!t.symbol.endsWith('USDT')) return false;
      return !EXCLUDE_BASE.has(t.symbol.slice(0, -4).toLowerCase());
    })
    .sort((a, b) => Math.abs(+b.priceChangePercent) - Math.abs(+a.priceChangePercent))
    .slice(0, 50)
    .map(t => t.symbol);

  await batchFetch(candidates, 55, (done, total) => {
    setMeta('Loading ' + done + '/' + total + '…');
  });

  const scored = scoreAll(klineCache);
  renderGrid(scored.slice(0, 9));
  setMeta('Δ5m · NATR · RVol · ' + tsNow());

  setInterval(quickRefresh, 10000);
  setInterval(fullRefresh, 60000);
}

init();
