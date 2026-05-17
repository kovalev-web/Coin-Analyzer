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

export function signalLabel(s) {
  return s === 'bullish' ? '↑ Bullish' : s === 'caution' ? '⚠ Caution' : '— Neutral';
}
