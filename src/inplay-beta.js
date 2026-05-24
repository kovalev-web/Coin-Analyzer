// Inplay Beta — standalone module. No imports from src/.
// Connects to VPS WebSocket, renders inplay_top table.

if (import.meta.env.VITE_INPLAY_BETA_ENABLED !== 'true') {
  document.getElementById('status').textContent = '404 Not Found';
  document.querySelector('table').style.display = 'none';
  // stop here — no WS connection
} else {
  var wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';
  var statusEl = document.getElementById('status');
  var tbody    = document.getElementById('tbody');
  var ws;
  var reconnectTimer;

  function fmt(v, decimals) {
    if (v == null || v !== v) return '—';
    return Number(v).toFixed(decimals);
  }

  function renderRow(r) {
    var sign = r.inplay >= 0 ? 'pos' : 'neg';
    var dp5m = r.dp5m != null ? (Math.abs(r.dp5m) * 100).toFixed(2) + '%' : '—';
    var rvol = r.rvol5m != null ? fmt(r.rvol5m, 2) : '—';
    return '<tr>' +
      '<td>' + r.symbol + '</td>' +
      '<td class="' + sign + '">' + fmt(r.inplay, 3) + '</td>' +
      '<td>' + fmt(r.A, 2) + '</td>' +
      '<td class="' + (r.M >= 0 ? 'pos' : 'neg') + '">' + fmt(r.M, 2) + '</td>' +
      '<td>' + fmt(r.P, 2) + '</td>' +
      '<td>' + dp5m + '</td>' +
      '<td>' + rvol + '</td>' +
      '</tr>';
  }

  function onMessage(e) {
    var msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.type !== 'inplay_top') return;

    var rows = (msg.data || []).slice(0, 15).map(renderRow).join('');
    tbody.innerHTML = rows;

    var age = Math.round((Date.now() - msg.ts) / 1000);
    statusEl.textContent = 'updated ' + new Date(msg.ts).toLocaleTimeString() +
      ' (' + age + 's ago) — ' + (msg.data || []).length + ' signals';
  }

  function connect() {
    clearTimeout(reconnectTimer);
    statusEl.textContent = 'connecting…';
    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      statusEl.textContent = 'connected — waiting for data…';
    };

    ws.onmessage = onMessage;

    ws.onclose = function () {
      statusEl.textContent = 'disconnected — reconnecting in 5s…';
      reconnectTimer = setTimeout(connect, 5000);
    };

    ws.onerror = function () {
      ws.close();
    };
  }

  connect();
}
