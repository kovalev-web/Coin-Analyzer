// Candles of a coin in a grid cell: Lightweight Charts (vanilla, like every
// chart of the site) inside a React box; 240 candles of history, then live.
// Built to run for 12+ hours on a TV, like the former TV mode: explicit size
// and one ResizeObserver instead of autoSize (old TV WebKit blanks the chart),
// charts created one after another (delay), colors read once, and the history
// reloaded on every Binance reconnect and every HISTORY_MS — closes gaps and
// keeps the number of candles bounded.
import * as React from 'react';
import { useSiteTheme } from '@/shared/use-site-theme';
import { fetchKlines, watchKlines, onKlinesReconnect } from './feed.js';

const HISTORY = 240;
const HISTORY_MS = 30 * 60000;

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function colors() {
  const up = cssVar('--candle-up'), dn = cssVar('--candle-dn');
  return {
    chart: {
      layout: { background: { color: 'transparent' }, textColor: cssVar('--graphite'), fontSize: 10, fontFamily: cssVar('--font-family') },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: cssVar('--steel') },
      timeScale: { borderColor: cssVar('--steel') },
    },
    candles: { upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn },
    volUp: cssVar('--vol-up'), volDn: cssVar('--vol-dn'),
  };
}

// Price precision from the price itself (same steps as the main charts)
function priceFormat(p) {
  if (!(p > 0)) return { type: 'price', precision: 4, minMove: 0.0001 };
  const d = p >= 10000 ? 0 : p >= 100 ? 1 : p >= 10 ? 2 : p >= 1 ? 3 : Math.min(8, 4 + Math.max(0, Math.floor(-Math.log10(p)) - 1));
  return { type: 'price', precision: d, minMove: Math.pow(10, -d) };
}

const candle = (k) => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] });

export function CoinChart({ sym, tf, delay = 0 }) {
  const box = React.useRef(null);
  const chart = React.useRef(null);
  const theme = useSiteTheme();

  React.useEffect(() => {
    const el = box.current;
    let alive = true, ch = null, stop = null, unReconnect = null, ro = null, timer = null, lastT = 0;
    const start = setTimeout(() => {
      const LW = window.LightweightCharts;
      if (!alive || !LW || !el) return;
      const c = colors();
      ch = LW.createChart(el, {
        autoSize: false, width: el.offsetWidth || 400, height: el.offsetHeight || 200, ...c.chart,
        crosshair: { mode: 0 },
        rightPriceScale: { ...c.chart.rightPriceScale, scaleMargins: { top: 0.06, bottom: 0.22 } },
        timeScale: { ...c.chart.timeScale, timeVisible: true, secondsVisible: false, rightOffset: 3 },
        handleScroll: true, handleScale: true,
      });
      ro = new ResizeObserver(() => { if (el.offsetWidth && el.offsetHeight) ch.resize(el.offsetWidth, el.offsetHeight); });
      ro.observe(el);
      const series = ch.addCandlestickSeries(c.candles);
      const vol = ch.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
      ch.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      chart.current = { ch, series, vol, c };

      const volBar = (t, o, cl, v) => ({ time: t, value: v, color: cl >= o ? chart.current.c.volUp : chart.current.c.volDn });

      // History over REST; the live stream fills in from the last candle
      const load = () => fetchKlines(sym, tf, HISTORY).then((rows) => {
        if (!alive || !rows.length) return;
        series.applyOptions({ priceFormat: priceFormat(+rows[rows.length - 1][4]) });
        series.setData(rows.map(candle));
        vol.setData(rows.map((k) => volBar(Math.floor(+k[0] / 1000), +k[1], +k[4], +k[7])));
        const first = !lastT;
        lastT = Math.floor(+rows[rows.length - 1][0] / 1000);
        if (first) ch.timeScale().scrollToRealTime();
      }).catch(() => {});

      load().then(() => {
        if (!alive) return;
        stop = watchKlines(sym, tf, (k) => {
          const t = Math.floor(k.t / 1000);
          if (!lastT || t < lastT) return;
          lastT = t;
          series.update({ time: t, open: +k.o, high: +k.h, low: +k.l, close: +k.c });
          vol.update(volBar(t, +k.o, +k.c, +k.q));
        });
        unReconnect = onKlinesReconnect(load);
        timer = setInterval(load, HISTORY_MS);
      });
    }, delay);
    return () => {
      alive = false;
      clearTimeout(start); clearInterval(timer);
      if (stop) stop();
      if (unReconnect) unReconnect();
      if (ro) ro.disconnect();
      if (ch) ch.remove();
      chart.current = null;
    };
  }, [sym, tf]);

  // Theme switch: recolor in place
  React.useEffect(() => {
    if (!chart.current) return;
    const c = colors();
    chart.current.c = c;
    chart.current.ch.applyOptions(c.chart);
    chart.current.series.applyOptions(c.candles);
  }, [theme]);

  return <div ref={box} className="min-h-0 flex-1" />;
}
