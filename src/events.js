var handlers = {};

export function on(event, fn) {
  if (!handlers[event]) handlers[event] = [];
  handlers[event].push(fn);
}

export function emit(event) {
  var args = Array.prototype.slice.call(arguments, 1);
  var fns = handlers[event] || [];
  for (var i = 0; i < fns.length; i++) fns[i].apply(null, args);
}
