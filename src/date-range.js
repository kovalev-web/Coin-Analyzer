// ── Date range picker ───────────────────────────────────────────────────────
// A button showing the range ("28.10 — 03.11") that opens a month calendar:
// first click picks the start, second the end (a click before the start
// restarts). Days outside min..max are disabled. Shaped like shadcn's
// date-range picker, built on the design tokens. Used by src/edge-view.js.
//
//   dateRangeHTML(id, from, to, placeholder)  → markup for the button
//   bindDateRange(root, id, { min, max, from, to, onChange(from, to) })

var MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
var DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function short(iso) { return iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) : ''; }
function iso(y, m, d) { return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }

export function dateRangeHTML(id, from, to, placeholder) {
  var label = from && to ? short(from) + ' — ' + short(to) : (placeholder || 'Выбрать даты');
  return '<span class="drp" data-drp="' + id + '"><button type="button" class="drp-btn' + (from && to ? ' set' : '') + '" data-drp-toggle>'
    + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>'
    + '<span>' + label + '</span></button></span>';
}

export function bindDateRange(root, id, opts) {
  var host = root.querySelector('[data-drp="' + id + '"]');
  if (!host) return;
  var pickFrom = opts.from || null, pickTo = opts.to || null;
  var base = (opts.to || opts.max || iso(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
  var view = { y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) - 1 };
  var pop = null;

  function close() {
    if (pop) pop.remove();
    pop = null;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', esc, true);
  }
  function outside(e) { if (pop && !host.contains(e.target)) close(); }
  function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

  function render() {
    var first = new Date(Date.UTC(view.y, view.m, 1));
    var lead = (first.getUTCDay() + 6) % 7; // Monday first
    var days = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
    var cells = '';
    for (var i = 0; i < lead; i++) cells += '<span></span>';
    for (var d = 1; d <= days; d++) {
      var v = iso(view.y, view.m, d);
      var off = (opts.min && v < opts.min) || (opts.max && v > opts.max);
      var end = v === pickFrom || v === pickTo;
      var mid = pickFrom && pickTo && v > pickFrom && v < pickTo;
      cells += '<button type="button" data-drp-day="' + v + '"' + (off ? ' disabled' : '') + ' class="' + (end ? 'end' : mid ? 'mid' : '') + '">' + d + '</button>';
    }
    pop.innerHTML = '<div class="drp-head"><button type="button" data-drp-nav="-1" aria-label="Предыдущий месяц">‹</button>'
      + '<b>' + MONTHS[view.m] + ' ' + view.y + '</b><button type="button" data-drp-nav="1" aria-label="Следующий месяц">›</button></div>'
      + '<div class="drp-grid">' + DAYS.map(function (x) { return '<i>' + x + '</i>'; }).join('') + cells + '</div>'
      + '<div class="drp-foot">' + (pickFrom && !pickTo ? 'Выбери конец периода' : 'Выбери начало периода') + '</div>';
  }

  host.querySelector('[data-drp-toggle]').onclick = function () {
    if (pop) { close(); return; }
    pop = document.createElement('div');
    pop.className = 'drp-pop';
    host.appendChild(pop);
    render();
    pop.addEventListener('click', function (e) {
      var nav = e.target.closest('[data-drp-nav]');
      if (nav) {
        view.m += Number(nav.dataset.drpNav);
        if (view.m < 0) { view.m = 11; view.y--; } else if (view.m > 11) { view.m = 0; view.y++; }
        render();
        return;
      }
      var day = e.target.closest('[data-drp-day]');
      if (!day || day.disabled) return;
      var v = day.dataset.drpDay;
      if (!pickFrom || pickTo || v < pickFrom) { pickFrom = v; pickTo = null; render(); return; }
      pickTo = v;
      render();
      close();
      opts.onChange(pickFrom, pickTo);
    });
    setTimeout(function () {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', esc, true);
    });
  };
}
