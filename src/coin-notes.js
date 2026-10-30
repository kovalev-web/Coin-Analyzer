// ── Coin notes ──────────────────────────────────────────────────────────────
// Thoughts written while watching a coin: many per coin, each with the time and
// the price it was written at. Written from the coin's chart island (note
// button), drawn on the chart as small icons (hover shows the text), listed in
// the briefing under that day. Stored on the server (coin_notes, /api/journal/notes),
// cached in state.coinNotes[SYM]. Used by src/ui.js.

import { state } from './state.js';
import { escHtml, icon, tzDateStr, tzTimeStr } from './utils.js';
import { on } from './events.js';
import { fetchCoinNotes, addCoinNote } from './api.js';

var N = { hits: [], canvas: null, loading: {} };

function _cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function _S(sym) { return String(sym || '').toUpperCase(); }

// Note bubbles on the chart can be hidden (remembered in this browser)
var SHOW_KEY = 'qt_notes_on_chart';
export function notesOnChart() {
  try { return localStorage.getItem(SHOW_KEY) !== '0'; } catch (e) { return true; }
}
export function setNotesOnChart(on) {
  try { localStorage.setItem(SHOW_KEY, on ? '1' : '0'); } catch (e) {}
  if (!on) clearNoteIcons();
}

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


// Read-only list for the briefing row: "09:15  text"
export function notesListHTML(sym, date) {
  var list = notesOnDay(sym, date);
  if (!list.length) return '';
  return '<div class="cn-list">' + list.map(function (n) {
    return '<div class="cn-item"><span class="cn-time">' + tzTimeStr(new Date(n.ts)) + '</span><span class="cn-text">' + escHtml(n.text) + '</span></div>';
  }).join('') + '</div>';
}

// Briefing row: write a note on the coin right there (same notes as the chart)
export function noteInputHTML(sym) {
  return '<input class="ds-input cn-brief-input" data-cn-sym="' + sym + '" placeholder="Заметка по ' + _S(sym) + ' — Enter, сохранится и на графике" maxlength="2000">';
}

document.addEventListener('keydown', function (e) {
  var inp = e.target && e.target.closest && e.target.closest('[data-cn-sym]');
  if (!inp || e.key !== 'Enter') return;
  e.preventDefault();
  var text = inp.value.trim(), sym = inp.dataset.cnSym;
  if (!text || inp.disabled) return;
  inp.disabled = true;
  var coin = state.coins.find(function (c) { return c.symbol === sym; });
  addCoinNote(sym, text, coin && coin.current_price > 0 ? coin.current_price : null).then(function () {
    inp.value = ''; inp.disabled = false;
  }).catch(function () { inp.disabled = false; });
});

// Chart closed: forget the icon positions and hide the tooltip
export function clearNoteIcons() {
  N.hits = [];
  _hideTip();
}

// The notes popover of the full view is shadcn: src/react/host/NotesPopover.jsx

// ── Icons on the chart ──────────────────────────────────────────────────────
// A small speech bubble pointing at the note's candle and price. Called from the
// chart overlay loop in ui.js (same canvas as the trade triangles).

export function drawNoteIcons(ctx, series, chart, sym, tfSec, w, h) {
  N.hits = [];
  N.canvas = ctx.canvas;
  var list = notesFor(sym);
  if (!list.length || !series || !chart || !notesOnChart()) return;
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

function _hitAt(e) {
  if (!N.hits.length || !N.canvas || !N.canvas.isConnected) return null;
  var r = N.canvas.getBoundingClientRect();
  if (!r.width) return null; // chart closed / hidden
  var x = e.clientX - r.left, y = e.clientY - r.top;
  for (var i = N.hits.length - 1; i >= 0; i--) {
    var b = N.hits[i];
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return b;
  }
  return null;
}

// "28 ОКТ" in the user's time zone
var RU_MONTHS = ['ЯНВ', 'ФЕВ', 'МАР', 'АПР', 'МАЙ', 'ИЮН', 'ИЮЛ', 'АВГ', 'СЕН', 'ОКТ', 'НОЯ', 'ДЕК'];
function _noteDate(d) {
  var ymd = tzDateStr(d).split('-');
  return Number(ymd[2]) + ' ' + RU_MONTHS[Number(ymd[1]) - 1];
}

function _hideTip() {
  if (_tip) _tip.style.display = 'none';
}

document.addEventListener('mousemove', function (e) {
  var hit = _hitAt(e);
  if (!hit) { _hideTip(); return; }
  if (!_tip) { _tip = document.createElement('div'); _tip.className = 'cn-tip'; document.body.appendChild(_tip); }
  var d = new Date(hit.note.ts);
  _tip.innerHTML = '<span class="cn-time">' + _noteDate(d) + ' ' + tzTimeStr(d) + '</span>' + escHtml(hit.note.text);
  _tip.style.display = 'block';
  _tip.style.left = Math.max(8, Math.min(window.innerWidth - _tip.offsetWidth - 8, e.clientX + 12)) + 'px';
  _tip.style.top = Math.max(8, e.clientY - _tip.offsetHeight - 10) + 'px';
});
