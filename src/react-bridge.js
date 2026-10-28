// Vanilla → React (shadcn/ui) surfaces: dialogs, popovers, palette, toasts.
// The React host (src/react/host) loads on idle after start or on first use;
// calls made before it's ready are queued. Names: src/react/host/surfaces.jsx.

var _host = null;
var _open = {};          // name → true while a surface is open (for Esc / outside logic)

function host() {
  return _host || (_host = import('./react/host/host.jsx').then(function (m) { m.init(); return m; }));
}

export function preloadReactHost() {
  var run = function () { host(); };
  if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 2000);
}

export function openSurface(name, props) {
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
