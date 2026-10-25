// ── Day summary strip on the main screen ──────────────────────────────────────
// Leaders (BTC, ETH, SOL: price and 24h change) and your own last-24h results
// per coin (realized PnL net of commission, from Binance income — via the
// trading key for the trading account, else the read-only journal key).

import { state } from './state.js';
import { API_BASE } from './api.js';

var LEADERS = ['btc', 'eth', 'sol'];
var REFRESH_MS = 60 * 1000;

var S = { mine: null, loadedAt: 0, loading: false, timer: null };

function fmtPrice(p) {
  if (p == null) return '—';
  return p >= 100 ? p.toLocaleString('en-US', { maximumFractionDigits: 1 }) : p.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function signed(n, digits) {
  return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(digits);
}

function leaderHTML(sym) {
  var c = (state.coins || []).find(function (x) { return x.symbol === sym; });
  var ch = c ? (c.open_24h > 0 && c.current_price > 0 ? (c.current_price - c.open_24h) / c.open_24h * 100 : (c.price_change_percentage_24h || 0)) : null;
  return '<button class="ds-leader" data-action="expand" data-sym="' + sym + '" data-leader="' + sym + '">'
    + '<span class="ds-sym">' + sym.toUpperCase() + '</span>'
    + '<span class="ds-px">' + (c ? fmtPrice(c.current_price) : '—') + '</span>'
    + '<span class="ds-ch ' + (ch > 0 ? 'up' : ch < 0 ? 'dn' : '') + '">' + (ch == null ? '' : signed(ch, 2) + '%') + '</span>'
    + '</button>';
}

function mineHTML() {
  if (state.isDemoMode) return '';
  var m = S.mine;
  if (!m) return '<div class="ds-mine"><span class="ds-label">Your 24h</span><span class="ds-muted">' + (S.loading ? 'Loading…' : '—') + '</span></div>';
  if (m.error) return '<div class="ds-mine"><span class="ds-label">Your 24h</span><span class="ds-muted">' + m.error + '</span></div>';
  if (!m.coins.length) return '<div class="ds-mine"><span class="ds-label">Your 24h</span><span class="ds-muted">No trades</span></div>';
  return '<div class="ds-mine"><span class="ds-label">Your 24h</span>'
    + '<span class="ds-total ' + (m.total >= 0 ? 'up' : 'dn') + '">' + signed(m.total, 2) + ' USDT</span>'
    + m.coins.map(function (c) {
        return '<button class="ds-coin" data-action="expand" data-sym="' + c.sym + '">' + c.sym.toUpperCase()
          + ' <b class="' + (c.net >= 0 ? 'up' : 'dn') + '">' + signed(c.net, 2) + '</b></button>';
      }).join('')
    + '</div>';
}

export function daySummaryHTML() {
  _ensureTimer();
  return '<div class="day-summary" id="day-summary">'
    + '<div class="ds-leaders">' + LEADERS.map(leaderHTML).join('') + '</div>'
    + mineHTML()
    + '</div>';
}

function _paint() {
  var el = document.getElementById('day-summary');
  if (!el) return;
  el.innerHTML = '<div class="ds-leaders">' + LEADERS.map(leaderHTML).join('') + '</div>' + mineHTML();
}

function _ensureTimer() {
  if (S.timer) return;
  S.timer = setInterval(function () {
    if (!document.getElementById('day-summary')) return;
    if (Date.now() - S.loadedAt > REFRESH_MS) _loadMine(); else _paint(); // leaders follow live prices
  }, 5000);
  _loadMine();
}

async function _loadMine() {
  if (state.isDemoMode || S.loading) return;
  S.loading = true;
  try {
    var end = Date.now(), start = end - 24 * 3600 * 1000;
    var res = await fetch(API_BASE + '/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ service: 'binance-income', payload: { startTime: start, endTime: end, limit: 1000 } }),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      S.mine = { error: res.status === 403 ? 'Connect Binance API to see trades' : 'Unavailable' };
    } else {
      var by = {};
      (data.income || []).forEach(function (r) {
        if (!r.symbol || !/USDT$/.test(r.symbol)) return;
        if (r.incomeType !== 'REALIZED_PNL' && r.incomeType !== 'COMMISSION' && r.incomeType !== 'FUNDING_FEE') return;
        var sym = r.symbol.replace(/USDT$/, '').toLowerCase();
        by[sym] = (by[sym] || 0) + Number(r.income);
      });
      var coins = Object.keys(by).map(function (sym) { return { sym: sym, net: by[sym] }; })
        .sort(function (a, b) { return Math.abs(b.net) - Math.abs(a.net); });
      S.mine = { coins: coins, total: coins.reduce(function (s, c) { return s + c.net; }, 0) };
    }
    S.loadedAt = Date.now();
  } catch (e) {
    S.mine = { error: 'Unavailable' };
  } finally {
    S.loading = false;
    _paint();
  }
}
