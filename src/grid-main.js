// Grid Scanner — standalone page (/grid)
// No dependencies on the main app modules.

const API_BASE = (import.meta.env.VITE_WS_URL || '')
  .replace(/^wss?:\/\//, 'https://')
  .replace(/\/ws$/, '');

// Symbols excluded from the altcoin universe (base part, lowercase, no USDT suffix)
const EXCLUDE_BASE = new Set([
  'btc', 'eth', 'bnb',
  'usdt', 'usdc', 'busd', 'dai', 'tusd', 'usdp', 'gusd', 'frax', 'lusd', 'usdd', 'pyusd', 'fdusd',
]);

// ── Auth ───────────────────────────────────────────────────────────────────

async function checkAuth() {
  if (!API_BASE) return; // local dev without VPS — skip
  try {
    const r = await fetch(API_BASE + '/auth/get-session', { credentials: 'include' });
    if (!r.ok) throw 0;
    const s = await r.json();
    if (!s || !s.user || !s.user.id) throw 0;
  } catch {
    window.location.replace('/login');
    await new Promise(() => {}); // hang while redirecting
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

// delta5m: (close - open) / open * 100 of the last (live) 5m candle
function delta5m(klines) {
  if (!klines || !klines.length) return 0;
  const k = klines[klines.length - 1];
  const o = +k[1], c = +k[4];
  return o > 0 ? (c - o) / o * 100 : 0;
}

// natr14: Wilder ATR(14) / last_close * 100
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

// rvol20: last candle volume / mean of 20 previous closed candle volumes
function rvol20(klines) {
  if (!klines || klines.length < 5) return 0;
  const last = +klines[klines.length - 1][5];
  const lb = klines.slice(-21, -1);
  if (!lb.length) return 0;
  const avg = lb.reduce((s, k) => s + +k[5], 0) / lb.length;
  return avg > 0 ? last / avg : 0;
}

// score all entries in klineCache and sort by composite score desc
function scoreAll(cache) {
  const entries = Object.keys(cache)
    .map(sym => ({
      sym,
      delta: delta5m(cache[sym]),
      natr: natr14(cache[sym]),
      rvol: rvol20(cache[sym]),
    }))
    .filter(e => cache[e.sym] && cache[e.sym].length >= 16);

  const mxD = Math.max(...entries.map(e => Math.abs(e.delta))) || 1;
  const mxN = Math.max(...entries.map(e => e.natr)) || 1;
  const mxR = Math.max(...entries.map(e => e.rvol)) || 1;

  return entries
    .map(e => ({ ...e, score: Math.abs(e.delta) / mxD + e.natr / mxN + e.rvol / mxR }))
    .sort((a, b) => b.score - a.score);
}

// ── State ──────────────────────────────────────────────────────────────────

const klineCache = {}; // sym → raw Binance klines array
let candidates = []; // top-50 symbols by |24h%|, the scoring universe
const chartInstances = {}; // sym → { chart, series }

// ── Fetch helpers ──────────────────────────────────────────────────────────

async function fetchKlines(sym, limit) {
  try {
    const data = await binance('/fapi/v1/klines', { symbol: sym, interval: '5m', limit: limit || 55 });
    if (Array.isArray(data)) klineCache[sym] = data;
  } catch { /* silently skip */ }
}

async function batchFetch(syms, limit, onProgress) {
  const size = 10;
  for (let i = 0; i < syms.length; i += size) {
    const batch = syms.slice(i, i + size);
    await Promise.all(batch.map(s => fetchKlines(s, limit)));
    if (onProgress) onProgress(Math.min(i + size, syms.length), syms.length);
  }
}

// ── Chart helpers ──────────────────────────────────────────────────────────

function toChartData(klines) {
  return (klines || []).map(k => ({
    time: Math.floor(+k[0] / 1000),
    open: +k[1], high: +k[2], low: +k[3], close: +k[4],
  }));
}

function initChart(sym) {
  const wrap = document.getElementById('gc-' + sym);
  if (!wrap || chartInstances[sym]) return;

  const chart = window.LightweightCharts.createChart(wrap, {
    width: wrap.clientWidth,
    height: wrap.clientHeight,
    layout: { background: { color: 'transparent' }, textColor: '#555', fontSize: 10 },
    grid: { vertLines: { color: '#1c1c1c' }, horzLines: { color: '#1c1c1c' } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.12 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    handleScroll: false,
    handleScale: false,
  });

  const series = chart.addCandlestickSeries({
    upColor: '#26a69a', downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a', wickDownColor: '#ef5350',
  });

  chartInstances[sym] = { chart, series };

  const data = toChartData(klineCache[sym]);
  if (data.length) {
    series.setData(data);
    chart.timeScale().fitContent();
  }

  const ro = new ResizeObserver(() => {
    if (chartInstances[sym]) {
      chartInstances[sym].chart.resize(wrap.clientWidth, wrap.clientHeight);
    }
  });
  ro.observe(wrap);
}

function updateChart(sym) {
  const c = chartInstances[sym];
  if (!c) return;
  const data = toChartData(klineCache[sym]);
  if (data.length) {
    c.series.setData(data);
    c.chart.timeScale().fitContent();
  }
}

function destroyChart(sym) {
  if (chartInstances[sym]) {
    chartInstances[sym].chart.remove();
    delete chartInstances[sym];
  }
}

// ── Grid render ────────────────────────────────────────────────────────────

let currentSyms = [];

function pct(v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
function sign(v) { return v >= 0 ? 'pos' : 'neg'; }

function renderGrid(top9) {
  const newSyms = top9.map(e => e.sym);
  const grid = document.getElementById('g-grid');

  if (newSyms.join(',') === currentSyms.join(',')) {
    // Same set — just update numbers and charts in-place
    top9.forEach(e => {
      const card = grid.querySelector(`.g-card[data-sym="${e.sym}"]`);
      if (!card) return;
      card.querySelector('.g-delta').textContent = pct(e.delta);
      card.querySelector('.g-delta').className = 'g-delta ' + sign(e.delta);
      card.querySelector('.g-natr').textContent = 'NATR ' + e.natr.toFixed(2) + '%';
      card.querySelector('.g-rvol').textContent = 'RVol ' + e.rvol.toFixed(2) + 'x';
      updateChart(e.sym);
    });
    return;
  }

  // Symbols changed — destroy removed charts and re-render
  currentSyms.filter(s => !newSyms.includes(s)).forEach(destroyChart);

  grid.innerHTML = top9.map(e => {
    const base = e.sym.replace(/USDT$/, '');
    return `<div class="g-card" data-sym="${e.sym}">
      <div class="g-head">
        <span class="g-sym">${base}</span>
        <span class="g-delta ${sign(e.delta)}">${pct(e.delta)}</span>
        <span class="g-natr">NATR ${e.natr.toFixed(2)}%</span>
        <span class="g-rvol">RVol ${e.rvol.toFixed(2)}x</span>
      </div>
      <div class="g-chart-wrap" id="gc-${e.sym}"></div>
    </div>`;
  }).join('');

  top9.forEach(e => initChart(e.sym));
  currentSyms = newSyms;
}

// ── Status line ────────────────────────────────────────────────────────────

function setMeta(text) {
  const el = document.getElementById('g-meta');
  if (el) el.textContent = text;
}

// ── Refresh cycles ─────────────────────────────────────────────────────────

// Every 10s: refresh klines for current top-9, re-score universe
async function quickRefresh() {
  await Promise.all(currentSyms.map(s => fetchKlines(s, 55)));
  const scored = scoreAll(klineCache);
  renderGrid(scored.slice(0, 9));
  setMeta('Δ5m · NATR · RVol · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
}

// Every 60s: re-fetch all candidates to catch new entrants
async function fullRefresh() {
  await batchFetch(candidates, 55);
  const scored = scoreAll(klineCache);
  renderGrid(scored.slice(0, 9));
  setMeta('Δ5m · NATR · RVol · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
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

  // Filter to USDT perps, exclude stables and major coins
  candidates = tickers
    .filter(t => {
      const s = t.symbol;
      if (!s.endsWith('USDT')) return false;
      const base = s.slice(0, -4).toLowerCase();
      return !EXCLUDE_BASE.has(base);
    })
    .sort((a, b) => Math.abs(+b.priceChangePercent) - Math.abs(+a.priceChangePercent))
    .slice(0, 50)
    .map(t => t.symbol);

  // Prefetch 5m klines for all candidates
  await batchFetch(candidates, 55, (done, total) => {
    setMeta('Loading ' + done + '/' + total + '…');
  });

  const scored = scoreAll(klineCache);
  renderGrid(scored.slice(0, 9));
  setMeta('Δ5m · NATR · RVol · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

  setInterval(quickRefresh, 10000);
  setInterval(fullRefresh, 60000);
}

init();
