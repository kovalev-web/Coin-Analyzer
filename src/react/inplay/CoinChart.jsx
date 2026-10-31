// Candles of a coin in a grid cell: Lightweight Charts (vanilla, like every
// chart of the site) inside a React box; 240 candles of history, then live.
import * as React from 'react';
import { useSiteTheme } from '@/shared/use-site-theme';
import { fetchKlines, watchKlines } from './feed.js';

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

export function CoinChart({ sym, tf }) {
  const box = React.useRef(null);
  const chart = React.useRef(null);
  const theme = useSiteTheme();

  React.useEffect(() => {
    const LW = window.LightweightCharts;
    if (!LW || !box.current) return;
    const c = colors();
    const ch = LW.createChart(box.current, {
      autoSize: true, ...c.chart,
      crosshair: { mode: 0 },
      rightPriceScale: { ...c.chart.rightPriceScale, scaleMargins: { top: 0.06, bottom: 0.22 } },
      timeScale: { ...c.chart.timeScale, timeVisible: true, secondsVisible: false, rightOffset: 3 },
      handleScroll: true, handleScale: true,
    });
    const series = ch.addCandlestickSeries(c.candles);
    const vol = ch.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    ch.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = { ch, series, vol };

    const volBar = (t, o, cl, v) => ({ time: t, value: v, color: cl >= o ? colors().volUp : colors().volDn });
    let alive = true, stop = null, lastT = 0;
    fetchKlines(sym, tf, 240).then((rows) => {
      if (!alive || !rows.length) return;
      series.applyOptions({ priceFormat: priceFormat(+rows[rows.length - 1][4]) });
      series.setData(rows.map(candle));
      vol.setData(rows.map((k) => volBar(Math.floor(+k[0] / 1000), +k[1], +k[4], +k[7])));
      lastT = Math.floor(+rows[rows.length - 1][0] / 1000);
      ch.timeScale().scrollToRealTime();
      stop = watchKlines(sym, tf, (k) => {
        const t = Math.floor(k.t / 1000);
        if (t < lastT) return;
        lastT = t;
        series.update({ time: t, open: +k.o, high: +k.h, low: +k.l, close: +k.c });
        vol.update(volBar(t, +k.o, +k.c, +k.q));
      });
    }).catch(() => {});
    return () => { alive = false; if (stop) stop(); ch.remove(); chart.current = null; };
  }, [sym, tf]);

  // Theme switch: recolor in place
  React.useEffect(() => {
    if (!chart.current) return;
    const c = colors();
    chart.current.ch.applyOptions(c.chart);
    chart.current.series.applyOptions(c.candles);
  }, [theme]);

  return <div ref={box} className="min-h-0 flex-1" />;
}
