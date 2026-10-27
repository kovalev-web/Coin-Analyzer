// ── Your setups ─────────────────────────────────────────────────────────────
// The list of entry types you tag trades with (Пробой, Отскок…), editable in
// "Мой edge": add, rename, hide from the buttons, leave out of the report
// (misclicks). Server: user_setups, GET/POST /api/journal/setups. Cached in
// state.setups; 'setups:updated' fires on change. Used by the order book tag
// row, the evening card and the edge report.

import { state } from './state.js';
import { emit } from './events.js';
import { API_BASE } from './api.js';

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
