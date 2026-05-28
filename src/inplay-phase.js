// Inplay Phase Detector — standalone module. No imports from src/.

if (import.meta.env.VITE_INPLAY_BETA_ENABLED !== 'true') {
  document.getElementById('status').textContent = '404 Not Found';
} else {

var wsUrl    = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';
var statusEl = document.getElementById('status');
var tableEl  = document.getElementById('table');
var tbodyEl  = document.getElementById('tbody');
var emptyEl  = document.getElementById('empty');
var histTbodyEl = document.getElementById('hist-tbody');
var histCountEl = document.getElementById('hist-count');
var ws, reconnectTimer;

var lastData = [];
var sort = { col: 'phase_start_time', dir: -1 };

// ── History (localStorage) ────────────────────────────────────────────────

var HIST_KEY      = 'inplay_phase_history';
var HIST_MAX      = 500; // cap entries to avoid bloat

// Load history; each entry is a snapshot of the phase at detection moment
var history = (function () {
  try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch (_) { return []; }
})();

// Set of "symbol::phase_start_time" keys we've already recorded
var seenKeys = new Set(history.map(function (h) { return h.symbol + '::' + h.phase_start_time; }));

function saveHistory() {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(history.slice(-HIST_MAX))); } catch (_) {}
}

function clearHistory() {
  history = [];
  seenKeys.clear();
  saveHistory();
  renderHistory();
}

// Called on every WS message — records phases we haven't seen before
function recordNewPhases(phases) {
  var added = false;
  phases.forEach(function (p) {
    // Only snapshot on initial detection (active), not during cooling
    if (p.status !== 'active') return;
    var key = p.symbol + '::' + p.phase_start_time;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    history.push({
      symbol:          p.symbol,
      phase_start_time: p.phase_start_time,
      direction:       p.direction,
      rvol_last:       p.rvol_last,
      rvol_avg:        p.rvol_avg,
      delta_price:     p.delta_price,
      cvd_z:           p.cvd_z,
      vol24h:          p.vol24h,
    });
    added = true;
  });
  if (added) { saveHistory(); renderHistory(); }
}

// ── Formatting ────────────────────────────────────────────────────────────

function fmtPhaseTime(startMs) {
  var d = Date.now() - startMs;
  var h = Math.floor(d / 3600000);
  var m = Math.floor((d % 3600000) / 60000);
  var s = Math.floor((d % 60000) / 1000);
  if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function fmtStatus(p) {
  if (p.status === 'active') return 'active';
  if (p.status === 'cooling' && p.cooling_ends_at) {
    var left = Math.max(0, Math.ceil((p.cooling_ends_at - Date.now()) / 60000));
    return 'cooling ' + left + 'm left';
  }
  return p.status;
}

function fmtVol(v) {
  if (v == null) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M';
  return '$' + (v / 1e3).toFixed(0) + 'K';
}

function fmtNum(v, dec) {
  return v == null ? '—' : Number(v).toFixed(dec);
}

function fmtDatetime(ms) {
  var d = new Date(ms);
  var date = d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
  var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return date + ' ' + time;
}

// ── Live table rendering ──────────────────────────────────────────────────

function sortedData() {
  var col = sort.col, dir = sort.dir;
  return lastData.slice().sort(function (a, b) {
    var av = a[col], bv = b[col];
    if (av == null) av = dir > 0 ? Infinity : -Infinity;
    if (bv == null) bv = dir > 0 ? Infinity : -Infinity;
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });
}

function renderRows() {
  if (!lastData.length) {
    tableEl.style.display = 'none';
    emptyEl.style.display = 'block';
  } else {
    tableEl.style.display = '';
    emptyEl.style.display = 'none';
    var html = '';
    sortedData().forEach(function (p) {
      var isCooling = p.status === 'cooling';
      var rowClass  = isCooling ? 'row-cooling' : (p.direction > 0 ? 'row-long' : 'row-short');
      var dirHtml   = p.direction > 0 ? '<span class="long">LONG ↑</span>' : '<span class="short">SHORT ↓</span>';
      var dpClass   = p.delta_price >= 0 ? 'long' : 'short';
      var statusHtml = isCooling ? '<span class="muted">' + fmtStatus(p) + '</span>' : 'active';
      html += '<tr class="' + rowClass + '">' +
        '<td>' + p.symbol.replace('USDT', '') + '</td>' +
        '<td>' + fmtPhaseTime(p.phase_start_time) + '</td>' +
        '<td>' + dirHtml + '</td>' +
        '<td>' + fmtNum(p.rvol_last, 1) + '</td>' +
        '<td>' + fmtNum(p.rvol_avg,  1) + '</td>' +
        '<td class="' + dpClass + '">' + (p.delta_price >= 0 ? '+' : '') + fmtNum(p.delta_price, 2) + '%</td>' +
        '<td>' + fmtNum(p.cvd_z, 2) + '</td>' +
        '<td>' + fmtVol(p.vol24h) + '</td>' +
        '<td>' + statusHtml + '</td>' +
        '</tr>';
    });
    tbodyEl.innerHTML = html;
  }
}

// ── History table rendering ───────────────────────────────────────────────

function renderHistory() {
  histCountEl.textContent = history.length ? history.length + ' entries' : '';
  if (!history.length) {
    histTbodyEl.innerHTML = '<tr><td colspan="8" style="color:#444;text-align:center;padding:12px">История пуста</td></tr>';
    return;
  }
  // Show newest first
  var html = '';
  history.slice().reverse().forEach(function (h) {
    var dirHtml = h.direction > 0 ? '<span class="long">LONG ↑</span>' : '<span class="short">SHORT ↓</span>';
    var dpClass = h.delta_price >= 0 ? 'long' : 'short';
    html += '<tr class="hist-row">' +
      '<td>' + h.symbol.replace('USDT', '') + '</td>' +
      '<td style="color:#888">' + fmtDatetime(h.phase_start_time) + '</td>' +
      '<td>' + dirHtml + '</td>' +
      '<td>' + fmtNum(h.rvol_last, 1) + '</td>' +
      '<td>' + fmtNum(h.rvol_avg,  1) + '</td>' +
      '<td class="' + dpClass + '">' + (h.delta_price >= 0 ? '+' : '') + fmtNum(h.delta_price, 2) + '%</td>' +
      '<td>' + fmtNum(h.cvd_z, 2) + '</td>' +
      '<td>' + fmtVol(h.vol24h) + '</td>' +
      '</tr>';
  });
  histTbodyEl.innerHTML = html;
}

renderHistory(); // paint from localStorage on load

// ── Sort headers (live table) ─────────────────────────────────────────────

document.querySelectorAll('th[data-col]').forEach(function (th) {
  th.addEventListener('click', function () {
    var col = th.getAttribute('data-col');
    sort.col === col ? (sort.dir *= -1) : (sort.col = col, sort.dir = col === 'phase_start_time' ? -1 : 1);
    updateSortClasses();
    renderRows();
  });
});

function updateSortClasses() {
  document.querySelectorAll('th[data-col]').forEach(function (th) {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.getAttribute('data-col') === sort.col)
      th.classList.add(sort.dir > 0 ? 'sort-asc' : 'sort-desc');
  });
}
updateSortClasses();

document.getElementById('clear-hist').addEventListener('click', function () {
  if (confirm('Очистить историю?')) clearHistory();
});

// Re-render live table every second for Phase Time / cooling countdown
setInterval(renderRows, 1000);

// ── WebSocket ─────────────────────────────────────────────────────────────

function onMessage(e) {
  var msg;
  try { msg = JSON.parse(e.data); } catch (_) { return; }
  if (msg.type !== 'inplay_phases') return;

  lastData = msg.data || [];
  recordNewPhases(lastData);
  renderRows();

  var age = Math.round((Date.now() - msg.ts) / 1000);
  statusEl.textContent = 'updated ' + new Date(msg.ts).toLocaleTimeString() +
    ' (' + age + 's ago) — ' + lastData.length + ' in phase';
}

function connect() {
  clearTimeout(reconnectTimer);
  statusEl.textContent = 'connecting…';
  ws = new WebSocket(wsUrl);
  ws.onopen    = function () { statusEl.textContent = 'connected — waiting for data…'; };
  ws.onmessage = onMessage;
  ws.onclose   = function () {
    statusEl.textContent = 'disconnected — reconnecting in 5s…';
    reconnectTimer = setTimeout(connect, 5000);
  };
  ws.onerror = function () { ws.close(); };
}

connect();

} // end VITE_INPLAY_BETA_ENABLED guard
