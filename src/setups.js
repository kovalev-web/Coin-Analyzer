// ── Your setups ─────────────────────────────────────────────────────────────
// The list of entry types you tag trades with (Пробой, Отскок…), editable in
// "Мой edge": add, rename, hide from the buttons, leave out of the report
// (misclicks). Server: user_setups, GET/POST /api/journal/setups. Cached in
// state.setups; 'setups:updated' fires on change. Used by the order book tag
// row, the evening card and the edge report.

import { state } from './state.js';
import { emit } from './events.js';
import { API_BASE } from './api.js';
import { SETUP_DIAGRAMS } from './setup-diagrams.js';

var _loading = null;

function _set(list) {
  state.setups = list || [];
  emit('setups:updated');
  return state.setups;
}

export function ensureSetups() {
  if (state.setups) return Promise.resolve(state.setups);
  if (_loading) return _loading;
  _loading = fetch(API_BASE + '/api/journal/setups', { credentials: 'include' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { _loading = null; return d ? _set(d.setups) : []; })
    .catch(function () { _loading = null; return []; });
  return _loading;
}

// change: { action: 'add', name } | { action: 'rename', key, name } |
//         { action: 'exclude', key, exclude } | { action: 'archive', key, archived }
export function changeSetup(change) {
  return fetch(API_BASE + '/api/journal/setups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(change),
  }).then(function (r) { if (!r.ok) throw new Error('Setup not saved'); return r.json(); })
    .then(function (d) { return _set(d.setups); });
}

// Setups to offer as tag buttons: [[key, name]] (hidden ones left out)
export function setupButtons() {
  return (state.setups || []).filter(function (s) { return !s.archived; }).map(function (s) { return [s.key, s.name]; });
}

export function setupName(key) {
  var s = (state.setups || []).find(function (x) { return x.key === key; });
  return s ? s.name : key;
}

// ── Diagram tooltip ─────────────────────────────────────────────────────────
// Anything marked with diagramAttr(key) shows that setup's schematic on hover.
// Your own setups (no drawing) show nothing.

export function diagramAttr(key) {
  return SETUP_DIAGRAMS[key] ? ' data-setup-diagram="' + key + '"' : '';
}

var _tip = null, _tipKey = null;
function _hideTip() { if (_tip) _tip.style.display = 'none'; _tipKey = null; }

document.addEventListener('mouseover', function (e) {
  var el = e.target.closest && e.target.closest('[data-setup-diagram]');
  if (!el) { if (_tipKey) _hideTip(); return; }
  var key = el.dataset.setupDiagram;
  if (key === _tipKey) return;
  if (!_tip) { _tip = document.createElement('div'); _tip.className = 'setup-tip'; document.body.appendChild(_tip); }
  _tip.innerHTML = SETUP_DIAGRAMS[key] || '';
  _tip.style.display = 'block';
  _tipKey = key;
  // Below the button, or above it when there's no room; kept inside the window
  var r = el.getBoundingClientRect(), w = _tip.offsetWidth, h = _tip.offsetHeight;
  var top = r.bottom + 8 + h > window.innerHeight ? r.top - h - 8 : r.bottom + 8;
  _tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  _tip.style.top = Math.max(8, top) + 'px';
});
document.addEventListener('scroll', _hideTip, true);
