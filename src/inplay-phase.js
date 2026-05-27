// Inplay Phase Detector — standalone module. No imports from src/.

if (import.meta.env.VITE_INPLAY_BETA_ENABLED !== 'true') {
  document.getElementById('status').textContent = '404 Not Found';
} else {

var wsUrl    = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';
var statusEl = document.getElementById('status');
var tableEl  = document.getElementById('table');
var tbodyEl  = document.getElementById('tbody');
var emptyEl  = document.getElementById('empty');
var ws, reconnectTimer;

var lastData  = [];
var sort = { col: 'phase_start_time', dir: -1 }; // -1 = descending (longest at top)

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

// ── Rendering ─────────────────────────────────────────────────────────────

function sortedData() {
  var col = sort.col;
  var dir = sort.dir;
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
    return;
  }
  tableEl.style.display = '';
  emptyEl.style.display = 'none';

  var html = '';
  sortedData().forEach(function (p) {
    var isCooling = p.status === 'cooling';
    var rowClass  = isCooling ? 'row-cooling' : (p.direction > 0 ? 'row-long' : 'row-short');
    var dirHtml   = p.direction > 0
      ? '<span class="long">LONG ↑</span>'
      : '<span class="short">SHORT ↓</span>';
    var dpClass = p.delta_price >= 0 ? 'long' : 'short';
    var statusHtml = isCooling
      ? '<span class="muted">' + fmtStatus(p) + '</span>'
      : 'active';

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

// ── Sort headers ──────────────────────────────────────────────────────────

document.querySelectorAll('th[data-col]').forEach(function (th) {
  th.addEventListener('click', function () {
    var col = th.getAttribute('data-col');
    if (sort.col === col) {
      sort.dir *= -1;
    } else {
      sort.col = col;
      sort.dir = col === 'phase_start_time' ? -1 : 1; // default: phase time desc, others asc
    }
    updateSortClasses();
    renderRows();
  });
});

function updateSortClasses() {
  document.querySelectorAll('th[data-col]').forEach(function (th) {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.getAttribute('data-col') === sort.col) {
      th.classList.add(sort.dir > 0 ? 'sort-asc' : 'sort-desc');
    }
  });
}
updateSortClasses();

// Re-render every second to keep Phase Time and cooling countdown live
setInterval(renderRows, 1000);

// ── WebSocket ─────────────────────────────────────────────────────────────

function onMessage(e) {
  var msg;
  try { msg = JSON.parse(e.data); } catch (_) { return; }
  if (msg.type !== 'inplay_phases') return;

  lastData = msg.data || [];
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
