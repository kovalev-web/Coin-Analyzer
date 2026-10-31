// Ruler on a grid chart, like on the main page cards (drawRuler in ui.js):
// hold Option (Alt) and drag with the left button — or drag with the middle
// one — to measure % and time between two points; let go and it's gone.
// A canvas over the chart plus a label; nothing runs while it isn't in use.

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function duration(d) {
  return d < 60 ? Math.round(d) + 's'
    : d < 3600 ? Math.round(d / 60) + 'm'
    : d < 86400 ? Math.floor(d / 3600) + 'h ' + Math.round((d % 3600) / 60) + 'm'
    : Math.floor(d / 86400) + 'd ' + Math.floor((d % 86400) / 3600) + 'h';
}

// el — the chart's box; ch / series — its chart and candle series. Returns cleanup.
export function attachRuler(el, ch, series) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pointer-events-none absolute top-0 left-0 z-[5]';
  const label = document.createElement('div');
  label.className = 'pointer-events-none absolute z-[6] hidden flex-col gap-1 whitespace-nowrap rounded-md bg-foreground px-1 py-0.5 text-[10px] leading-3 font-medium text-background tabular-nums';
  el.style.position = 'relative';
  el.append(canvas, label);
  let start = null;

  const at = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function clear() {
    start = null;
    label.classList.add('hidden');
    canvas.width = 0; canvas.height = 0;
  }

  function draw(p2) {
    const pr2 = series.coordinateToPrice(p2.y);
    if (pr2 == null) return;
    const p1 = start.pt, pr1 = start.price;
    const dpr = window.devicePixelRatio || 1;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const ink = cssVar('--ink-deep'), muted = cssVar('--graphite');
    ctx.fillStyle = 'rgba(150,150,150,0.07)';
    ctx.fillRect(0, Math.min(p1.y, p2.y), w, Math.abs(p2.y - p1.y) || 1);
    ctx.lineWidth = 1;
    ctx.strokeStyle = muted;
    ctx.beginPath(); ctx.moveTo(0, p1.y); ctx.lineTo(w, p1.y); ctx.stroke();
    ctx.strokeStyle = ink;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    ctx.fillStyle = ink;
    [p1, p2].forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill(); });

    const pct = (pr2 - pr1) / Math.abs(pr1) * 100;
    const ts = ch.timeScale();
    const t1 = ts.coordinateToTime(p1.x), t2 = ts.coordinateToTime(p2.x);
    const dur = t1 != null && t2 != null ? duration(Math.abs(t2 - t1)) : '';
    label.textContent = '';
    [(pct >= 0 ? '+' : '') + pct.toFixed(2) + '%', dur].filter(Boolean).forEach((t) => {
      const line = document.createElement('div');
      line.textContent = t;
      label.append(line);
    });
    let axis = 0;
    try { axis = ch.priceScale('right').width(); } catch (_) {}
    const flip = p2.x + 16 + 60 > w - axis;
    label.style.left = p2.x + 'px';
    label.style.top = Math.max(16, Math.min(h - 16, p2.y)) + 'px';
    label.style.transform = flip ? 'translate(calc(-100% - 16px),-50%)' : 'translate(16px,-50%)';
    label.classList.remove('hidden');
  }

  // Capture: the chart must not pan while measuring
  const down = (e) => {
    if (!((e.button === 0 && e.altKey) || e.button === 1)) return;
    e.stopPropagation(); e.preventDefault();
    const pt = at(e), price = series.coordinateToPrice(pt.y);
    if (price != null) start = { pt, price };
  };
  const move = (e) => { if (start && (e.buttons & 5)) draw(at(e)); };
  const up = () => { if (start) clear(); };

  el.addEventListener('mousedown', down, { capture: true });
  el.addEventListener('mousemove', move);
  el.addEventListener('mouseup', up);
  el.addEventListener('mouseleave', up);
  return () => {
    el.removeEventListener('mousedown', down, { capture: true });
    el.removeEventListener('mousemove', move);
    el.removeEventListener('mouseup', up);
    el.removeEventListener('mouseleave', up);
    canvas.remove(); label.remove();
  };
}
