import { state } from './state.js';

let currentRoute = '/';
let routeHandlers = {};

export function registerRoute(path, handler) {
  routeHandlers[path] = handler;
}

export function navigate(path) {
  window.history.pushState({}, '', path);
  routeChanged();
}

export function getCurrentRoute() {
  return currentRoute;
}

function routeChanged() {
  var path = window.location.pathname || '/';
  if (path === currentRoute) return;
  currentRoute = path;
  var handler = routeHandlers[path];
  if (handler) {
    handler();
  } else if (routeHandlers['/404']) {
    routeHandlers['/404']();
  }
}

// Force re-render of the current route, bypassing the currentRoute cache.
// Used when the page is restored from bfcache (iOS standalone app reopen)
// and JS state may be stale relative to the displayed page.
export function reloadRoute() {
  var path = window.location.pathname || '/';
  currentRoute = path;
  var handler = routeHandlers[path] || routeHandlers['/404'];
  if (handler) handler();
}

export function initRouter(defaultRoute) {
  window.addEventListener('popstate', routeChanged);
  currentRoute = window.location.pathname || defaultRoute || '/';
  var handler = routeHandlers[currentRoute] || routeHandlers['/404'];
  if (handler) handler();
}
