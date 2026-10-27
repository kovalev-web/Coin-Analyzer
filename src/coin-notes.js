// ── Coin notes ──────────────────────────────────────────────────────────────
// Thoughts written while watching a coin: many per coin, each with the time and
// the price it was written at. Written from the coin's chart island (note
// button), drawn on the chart as small icons (hover shows the text), listed in
// the briefing under that day. Stored on the server (coin_notes, /api/journal/notes),
// cached in state.coinNotes[SYM]. Used by src/ui.js.

import { state } from './state.js';
import { escHtml, icon, tzDateStr, tzTimeStr } from './utils.js';
import { on } from './events.js';
import { fetchCoinNotes, addCoinNote, deleteCoinNote } from './api.js';

var N = { hits: [], canvas: null, loading: {}, pop: null, popSym: null, onSaved: null };

function _cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function _S(sym) { return String(sym || '').toUpperCase(); }

export function notesFor(sym) { return state.coinNotes[_S(sym)] || []; }

// Load a coin's notes once (later changes come through add / delete)
export function ensureCoinNotes(sym) {
  var S = _S(sym);
  if (!S || state.coinNotes[S] || N.loading[S]) return;
  N.loading[S] = true;
  fetchCoinNotes(S).then(function () {
    delete N.loading[S];
    if (!state.coinNotes[S]) state.coinNotes[S] = []; // not signed in / offline: don't ask again
  });
}

// Notes of one coin written on one day (the briefing's date, user's timezone)
export function notesOnDay(sym, date) {
  return notesFor(sym).filter(function (n) { return tzDateStr(new Date(n.ts)) === date; });
}

export function noteButtonHTML(sym) {
  return '<button class="btn-icon btn-fv-note" data-action="fv-note" data-sym="' + sym + '" title="Note">' + icon('message-square-plus', 16) + '</button>';
}

// Read-only list for the briefing row: "09:15  text"
export function notesListHTML(sym, date) {
  var list = notesOnDay(sym, date);
  if (!list.length) return '';
  return '<div class="cn-list">' + list.map(function (n) {
    return '<div class="cn-item"><span class="cn-time">' + tzTimeStr(new Date(n.ts)) + '</span><span class="cn-text">' + escHtml(n.text) + '</span></div>';
  }).join('') + '</div>';
}

// ── Popover under the island: write a note, see and delete this coin's notes ──

function _currentPrice(sym) {
  try {
    var last = window.__fvSeries && window.__fvSeries.dataByIndex(1e9, -1);
    if (last && last.close > 0) return last.close;
  } catch (e) {}
  var coin = state.coins.find(function (c) { return c.symbol === sym; });
  return coin && coin.current_price > 0 ? coin.current_price : null;
}

function _renderPopList() {
  if (!N.pop) return;
  var box = N.pop.querySelector('.cn-pop-list');
  var list = notesFor(N.popSym).slice().reverse();
  box.innerHTML = list.map(function (n) {
    var d = new Date(n.ts);
    var day = tzDateStr(d) === tzDateStr() ? '' : tzDateStr(d).slice(5).replace('-', '.') + ' ';
    return '<div class="cn-item"><span class="cn-time">' + day + tzTimeStr(d) + '</span><span class="cn-text">' + escHtml(n.text) + '</span>'
      + '<button class="btn-icon cn-del" data-note-del="' + n.id + '" title="Delete">' + icon('x', 14) + '</button></div>';
  }).join('');
}

// Chart closed: forget the icon positions and hide the tooltip
export function clearNoteIcons() {
  N.hits = [];
  if (_tip) _tip.style.display = 'none';
}

export function closeNotePopover() {
  if (N.pop) N.pop.remove();
  N.pop = null; N.popSym = null; N.onSaved = null;
}

// sym: the coin; onSaved: called after a note is stored (the caller adds the coin to the briefing)
export function toggleNotePopover(sym, onSaved) {
  if (N.pop && N.popSym === sym) { closeNotePopover(); return; }
  closeNotePopover();
  var wrap = document.querySelector('#fv-overlay .fv-chart-wrap');
  if (!wrap) return;
  ensureCoinNotes(sym);
  var pop = document.createElement('div');
  pop.className = 'cn-pop';
  pop.innerHTML = '<textarea class="ds-input cn-input" rows="2" placeholder="What do you see? Enter saves, Shift+Enter new line"></textarea>'
    + '<div class="cn-pop-list"></div>';
  wrap.appendChild(pop);
  var island = wrap.querySelector('.fv-coin-info');
  if (island) pop.style.top = (island.offsetTop + island.offsetHeight + 8) + 'px';
  N.pop = pop; N.popSym = sym; N.onSaved = onSaved || null;
  _renderPopList();
  var ta = pop.querySelector('textarea');
  ta.focus();
  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeNotePopover(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    var text = ta.value.trim();
    if (!text || ta.disabled) return;
    ta.disabled = true;
    var cb = N.onSaved;
    addCoinNote(sym, text, _currentPrice(sym)).then(function () {
      ta.value = '';
      ta.disabled = false;
      ta.focus();
      if (cb) cb();
    }).catch(function (err) {
      ta.disabled = false;
      import('./ui.js').then(function (ui) { ui.showToast(err.message); });
    });
  });
  pop.addEventListener('click', function (e) {
    var del = e.target.closest('[data-note-del]');
    if (!del) return;
    deleteCoinNote(sym, Number(del.dataset.noteDel)).catch(function () {});
  });
}

on('coin-notes:updated', function (S) {
  if (N.pop && _S(N.popSym) === S) _renderPopList();
});

// ── Icons on the chart ──────────────────────────────────────────────────────
// A small speech bubble pointing at the note's candle and price. Called from the
// chart overlay loop in ui.js (same canvas as the trade triangles).

export function drawNoteIcons(ctx, series, chart, sym, tfSec, w, h) {
  N.hits = [];
  N.canvas = ctx.canvas;
  var list = notesFor(sym);
  if (!list.length || !series || !chart) return;
  var fill = _cssVar('--ink-deep'), ink = _cssVar('--paper');
  list.forEach(function (n) {
    if (!(n.price > 0)) return;
    var t = Math.floor(n.ts / 1000 / tfSec) * tfSec;
    var x = chart.timeScale().timeToCoordinate(t);
    var y = series.priceToCoordinate(n.price);
    if (x == null || y == null || x < 0 || x > w || y < 0 || y > h) return;
    var bw = 14, bh = 11, bx = x - bw / 2, by = y - bh - 5;
    ctx.save();
    ctx.fillStyle = fill;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 2); else ctx.rect(bx, by, bw, bh);
    ctx.moveTo(x - 3, by + bh); ctx.lineTo(x, y); ctx.lineTo(x + 3, by + bh);
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.fillRect(bx + 3, by + 3, bw - 6, 1);
    ctx.fillRect(bx + 3, by + 6, bw - 8, 1);
    ctx.restore();
    N.hits.push({ x0: bx - 2, x1: bx + bw + 2, y0: by - 2, y1: y + 1, note: n });
  });
}

// Hover a note icon → its time and text next to it
var _tip = null;
document.addEventListener('mousemove', function (e) {
  if (!N.hits.length || !N.canvas || !N.canvas.isConnected) { if (_tip) _tip.style.display = 'none'; return; }
  var r = N.canvas.getBoundingClientRect();
  if (!r.width) { N.hits = []; if (_tip) _tip.style.display = 'none'; return; } // chart closed / hidden
  var x = e.clientX - r.left, y = e.clientY - r.top;
  var hit = null;
  for (var i = N.hits.length - 1; i >= 0; i--) {
    var b = N.hits[i];
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) { hit = b; break; }
  }
  if (!hit) { if (_tip) _tip.style.display = 'none'; return; }
  if (!_tip) { _tip = document.createElement('div'); _tip.className = 'cn-tip'; document.body.appendChild(_tip); }
  var d = new Date(hit.note.ts);
  _tip.innerHTML = '<span class="cn-time">' + tzDateStr(d).slice(5).replace('-', '.') + ' ' + tzTimeStr(d) + '</span>' + escHtml(hit.note.text);
  _tip.style.display = 'block';
  _tip.style.left = Math.min(window.innerWidth - _tip.offsetWidth - 8, e.clientX + 12) + 'px';
  _tip.style.top = Math.max(8, e.clientY - _tip.offsetHeight - 10) + 'px';
});
