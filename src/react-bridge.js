// Vanilla → React (shadcn/ui) surfaces: dialogs, popovers, palette, toasts.
// The React host (src/react/host) loads on idle after start or on first use;
// calls made before it's ready are queued. Names: src/react/host/surfaces.jsx.

import { emit } from './events.js';

var _host = null;
var _open = {};          // name → true while a surface is open (for Esc / outside logic)

function host() {
  return _host || (_host = import('./react/host/host.jsx').then(function (m) { m.init(); return m; }));
}

export function preloadReactHost() {
  var run = function () { host(); };
  if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 2000);
}

// Popovers anchored to a button: only one at a time — opening one closes the others
var POPOVERS = { search: 1, notifications: 1, briefing: 1, notes: 1, analysis: 1, liquidity: 1, clear: 1 };

export function closePopovers(except) {
  Object.keys(POPOVERS).forEach(function (n) {
    if (n !== except && _open[n]) {
      closeSurface(n);
      if (n === 'briefing') emit('briefing:changed'); // the full view's star comes back
    }
  });
}

export function openSurface(name, props) {
  if (POPOVERS[name]) closePopovers(name);
  _open[name] = true;
  return host().then(function (h) { h.open(name, props); });
}

export function closeSurface(name) {
  delete _open[name];
  if (_host) _host.then(function (h) { h.close(name); });
}

// Called by the host when a surface closes itself (Esc, outside click, X)
export function _surfaceClosed(name) { delete _open[name]; }

export function isSurfaceOpen(name) { return name ? !!_open[name] : Object.keys(_open).length > 0; }

// sonner options: { duration, description, … }
export function toast(message, opts) {
  host().then(function (h) { h.toast(message, opts); });
}
