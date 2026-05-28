export function fmt(n) {
  if (n == null) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(4);
}

export function fmtPrice(p) {
  if (p == null) return '—';
  if (p >= 1) return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 0.01) return '$' + p.toFixed(4);
  return '$' + p.toFixed(8);
}

export function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

export function escHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function icon(name, size, style) {
  size = size || 14;
  var key = name.replace(/-([a-z0-9])/g, function(_, c) { return c.toUpperCase(); });
  key = key.charAt(0).toUpperCase() + key.slice(1);
  var def = window.lucide && window.lucide[key];
  if (!def) return '';
  var base = def[1] || {}, attrs = {};
  Object.keys(base).forEach(function(k) { attrs[k] = base[k]; });
  attrs.width = size;
  attrs.height = size;
  if (style) attrs.style = style;
  var attrStr = Object.keys(attrs).map(function(k) { return k + '="' + attrs[k] + '"'; }).join(' ');
  function kids(arr) {
    return (arr || []).map(function(c) {
      var t = c[0], a = c[1] || {}, ch = c[2];
      var as = Object.keys(a).map(function(k) { return k + '="' + a[k] + '"'; }).join(' ');
      return ch && ch.length ? '<' + t + ' ' + as + '>' + kids(ch) + '</' + t + '>' : '<' + t + ' ' + as + '/>';
    }).join('');
  }
  return '<svg ' + attrStr + '>' + kids(def[2]) + '</svg>';
}

export function signalLabel(s) {
  if (s === 'bullish') return icon('arrow-up', 14);
  if (s === 'caution') return icon('triangle-alert', 14);
  return icon('eye-off', 14);
}
