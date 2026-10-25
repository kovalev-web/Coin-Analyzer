// ── "My edge" section on the journal page (journal stage 5) ─────────────────
// Where results come from: closed trades (from saved day facts) grouped by
// setup quality, what drove the entry, rule breaks, plan, level, morning state
// and time of day. Groups under the minimum sample are shown pale.

import { fetchJournalEdge } from './api.js';

var RANGES = [['1m', '1M'], ['3m', '3M'], ['6m', '6M'], ['all', 'All']];
var SECTIONS = [
  ['setup', 'Setup quality'],
  ['emotion', 'What drove the entry'],
  ['flags', 'Rule breaks'],
  ['plan', 'Briefing plan'],
  ['level', 'Signal level'],
  ['sleep', 'Sleep'],
  ['sleepQuality', 'Sleep quality'],
  ['energy', 'Energy'],
  ['carryover', 'Carrying yesterday'],
  ['focus', 'Focus'],
  ['hour', 'Time of day (your zone)'],
];

var _range = '3m';

function money(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2); }

function tableHTML(rows) {
  if (!rows || !rows.length) return '<div class="edge-empty">No trades yet</div>';
  return '<table class="edge-table"><thead><tr><th></th><th>n</th><th>Win</th><th>PnL</th><th>Avg</th></tr></thead><tbody>'
    + rows.map(function (r) {
        return '<tr class="' + (r.enough ? '' : 'thin') + '"><td>' + r.key + '</td><td>' + r.n + '</td><td>' + r.winRate + '%</td>'
          + '<td class="' + (r.pnl >= 0 ? 'up' : 'dn') + '">' + money(r.pnl) + '</td>'
          + '<td class="' + (r.avgPnl >= 0 ? 'up' : 'dn') + '">' + money(r.avgPnl) + '</td></tr>';
      }).join('')
    + '</tbody></table>';
}

export function renderEdgeSection(container) {
  if (!container) return;
  container.innerHTML = '<div class="edge-section"><div class="edge-head"><h3>My edge</h3><div class="edge-ranges">'
    + RANGES.map(function (r) { return '<button data-edge-range="' + r[0] + '" class="' + (r[0] === _range ? 'active' : '') + '">' + r[1] + '</button>'; }).join('')
    + '</div></div><div class="edge-body"><span class="big-spinner"></span></div></div>';
  container.querySelectorAll('[data-edge-range]').forEach(function (b) {
    b.onclick = function () { _range = b.dataset.edgeRange; renderEdgeSection(container); };
  });
  fetchJournalEdge(_range).then(function (e) {
    var body = container.querySelector('.edge-body');
    if (!body) return;
    if (!e || !e.total || !e.total.n) {
      body.innerHTML = '<div class="edge-empty">Nothing to show yet. Facts are saved with each evening review; tag trades right after they close to see setup and emotion groups.</div>';
      return;
    }
    var t = e.total;
    body.innerHTML = '<div class="edge-note">' + t.n + ' closed trades over ' + e.days + ' reviewed day' + (e.days === 1 ? '' : 's')
      + ' · ' + t.winRate + '% win · ' + money(t.pnl) + ' USDT · ' + e.tagged + ' tagged.'
      + ' Pale rows have fewer than ' + e.minN + ' trades — not enough to draw conclusions yet.</div>'
      + '<div class="edge-grid">' + SECTIONS.map(function (s) {
          return '<div class="edge-card"><div class="edge-card-title">' + s[1] + '</div>' + tableHTML(e.groups[s[0]]) + '</div>';
        }).join('') + '</div>';
  });
}
