import { state } from './state.js';

let currentRoute = '/';
let routeHandlers = {};

export function registerRoute(path, handler) {
  routeHandlers[path] = handler;
}

export function navigate(path) {
  window.location.hash = '#' + path;
}

export function getCurrentRoute() {
  return currentRoute;
}

function routeChanged() {
  var hash = window.location.hash.replace(/^#/, '') || '/';
  if (hash === currentRoute) return;
  currentRoute = hash;
  var handler = routeHandlers[hash];
  if (handler) {
    handler();
  } else if (routeHandlers['/404']) {
    routeHandlers['/404']();
  }
}

export function initRouter(defaultRoute) {
  window.addEventListener('hashchange', routeChanged);
  if (!window.location.hash || window.location.hash === '#') {
    window.location.hash = '#' + (defaultRoute || '/');
  }
  currentRoute = window.location.hash.replace(/^#/, '') || '/';
  var handler = routeHandlers[currentRoute];
  if (handler) handler();
}
