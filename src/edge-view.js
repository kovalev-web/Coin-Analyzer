// ── "My edge" section on the journal page (journal stage 5) ─────────────────
// Reads top-down: the result, how much data there is, what makes money, what
// costs money (each with what to do), dimensions with nothing to compare yet,
// and the full tables folded at the bottom. Conclusions: src/edge-insights.js.

import { fetchJournalEdge } from './api.js';
import { insights } from './edge-insights.js';

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

function findingHTML(f, good) {
  return '<div class="edge-find ' + (good ? 'good' : 'bad') + '">'
    + '<div class="edge-find-top"><span class="edge-find-key">' + f.key + '</span><span class="edge-find-dim">' + f.title + '</span>'
    + '<span class="edge-find-impact" title="Made or cost beyond the same number of your average trades">' + money(f.impact) + ' <small>vs avg</small></span></div>'
    + '<div class="edge-find-stats">' + f.n + ' trade' + (f.n === 1 ? '' : 's') + ' · ' + f.winRate + '% win · ' + money(f.pnl) + ' USDT</div>'
    + '<div class="edge-find-advice">' + f.advice + '</div>'
    + '</div>';
}

function columnHTML(title, list, good, empty) {
  return '<div class="edge-col"><div class="edge-col-title ' + (good ? 'good' : 'bad') + '">' + title + '</div>'
    + (list.length ? list.map(function (f) { return findingHTML(f, good); }).join('') : '<div class="edge-empty">' + empty + '</div>')
    + '</div>';
}

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
    var x = insights(e);
    body.innerHTML = '<div class="edge-stats">'
        + '<div class="edge-stat"><span>Result</span><b class="' + (t.pnl >= 0 ? 'up' : 'dn') + '">' + money(t.pnl) + ' USDT</b></div>'
        + '<div class="edge-stat"><span>Trades</span><b>' + t.n + '</b></div>'
        + '<div class="edge-stat"><span>Win rate</span><b>' + t.winRate + '%</b></div>'
        + '<div class="edge-stat"><span>Days reviewed</span><b>' + e.days + '</b></div>'
        + '<div class="edge-stat"><span>Tagged</span><b>' + e.tagged + ' / ' + t.n + '</b></div>'
      + '</div>'
      + (x.sample.early
        ? '<div class="edge-sample"><div class="edge-sample-bar"><i style="width:' + Math.round(x.sample.ratio * 100) + '%"></i></div>'
          + '<span>Early read: ' + t.n + ' of ' + x.sample.minN + ' trades. Treat these as hints — they firm up as trades add up.</span></div>'
        : '')
      + '<div class="edge-cols">'
        + columnHTML('What works', x.works, true, 'Nothing stands out yet')
        + columnHTML('What costs you', x.costs, false, 'Nothing is losing money beyond your average')
      + '</div>'
      + (x.flat.length ? '<div class="edge-flat"><b>Nothing to compare yet:</b> ' + x.flat.join(', ')
        + ' — all your trades fall into one group. They show up here once your days differ.</div>' : '')
      + '<details class="edge-details"><summary>All breakdowns</summary>'
      + '<div class="edge-note">The number on the right of each finding is what it made or cost beyond your average trade. Pale rows have fewer than ' + e.minN + ' trades.</div>'
      + '<div class="edge-grid">' + SECTIONS.map(function (s) {
          return '<div class="edge-card"><div class="edge-card-title">' + s[1] + '</div>' + tableHTML(e.groups[s[0]]) + '</div>';
        }).join('') + '</div></details>';
  });
}
