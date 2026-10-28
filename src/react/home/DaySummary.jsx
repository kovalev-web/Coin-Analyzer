// Day strip on the main screen: leaders (BTC, ETH, SOL: price, 24h change and
// a mini 1h-candle chart of the last 48 hours), "Your 24h" (realized PnL net
// of commission per trade, from Binance income — via the trading key for the
// trading account, else the read-only journal key) and "Open now" (trading
// account only: positions with live PnL, resting orders, close everything).
import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEvents } from '@/shared/use-event';
import { state } from '../../state.js';
import { API_BASE } from '../../api.js';
import { checkAccess, tradingSnapshot, closeAllPositions } from '../../terminal.js';
import { toast } from '../../react-bridge.js';

const LEADERS = ['btc', 'eth', 'sol'];
const REFRESH_MS = 60 * 1000;      // your 24h (server caches 30 s)
const KLINES_MS = 5 * 60 * 1000;   // re-fetch the hourly candles every 5 min
const SPARK_HOURS = 48;
const MAX_BARS = 8;                // up to 8 trades a day; older ones drop off the left
const MAX_POSITIONS = 4;           // one line each
const CONFIRM_MS = 5000;           // "Close all" asks once more within this window

// Survives re-renders of the page (render() remounts the strip)
const S = { mine: null, loadedAt: 0, loading: false, kl: {}, klAt: 0 };

const fmtPrice = (p) => p == null ? '—' : p >= 100 ? p.toLocaleString('en-US', { maximumFractionDigits: 1 }) : p.toLocaleString('en-US', { maximumFractionDigits: 4 });
const signed = (n, d) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d);
const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : n >= 10 ? n.toFixed(0) : n.toFixed(1);
const tone = (n) => n > 0 ? 'text-bullish' : n < 0 ? 'text-danger' : '';
const coinOf = (sym) => (state.coins || []).find((x) => x.symbol === sym);
const changeOf = (c) => c ? (c.open_24h > 0 && c.current_price > 0 ? (c.current_price - c.open_24h) / c.open_24h * 100 : (c.price_change_percentage_24h || 0)) : null;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

async function loadMine(done) {
  if (state.isDemoMode || S.loading) return;
  S.loading = true;
  try {
    const res = await fetch(API_BASE + '/api/journal/last24h', { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    S.mine = res.ok ? data : { error: res.status === 403 ? 'Connect Binance API to see trades' : 'Unavailable' };
    S.loadedAt = Date.now();
  } catch (e) {
    S.mine = { error: 'Unavailable' };
  } finally {
    S.loading = false;
    done();
  }
}

async function loadKlines(done) {
  if (Date.now() - S.klAt < KLINES_MS) return;
  S.klAt = Date.now();
  await Promise.all(LEADERS.map(async (sym) => {
    try {
      const r = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + sym.toUpperCase() + 'USDT&interval=1h&limit=' + SPARK_HOURS);
      const rows = await r.json();
      if (Array.isArray(rows)) S.kl[sym] = rows.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
    } catch (e) {}
  }));
  done();
}

// Live price moves the last hourly candle between kline refreshes
function lastCandle(sym, price) {
  const kl = S.kl[sym];
  if (!kl || !kl.length || !(price > 0)) return null;
  let last = kl[kl.length - 1];
  if (Math.abs(price - last.close) / last.close > 0.2) return null; // bad tick, not a move
  const hourStart = Math.floor(Date.now() / 3600000) * 3600;
  if (hourStart > last.time) { last = { time: hourStart, open: last.close, high: last.close, low: last.close, close: last.close }; kl.push(last); kl.shift(); }
  last.close = price;
  last.high = Math.max(last.high, price);
  last.low = Math.min(last.low, price);
  return last;
}

// Mini candle chart (lightweight-charts) inside a React-owned box
function Spark({ sym, candles, price }) {
  const box = React.useRef(null), chart = React.useRef(null);
  React.useEffect(() => {
    const LC = window.LightweightCharts;
    if (!LC || !box.current || !candles) return;
    if (!chart.current) {
      const up = cssVar('--bullish') || '#16a34a', dn = cssVar('--danger') || '#ff5050';
      const c = LC.createChart(box.current, {
        autoSize: true,
        layout: { background: { color: 'transparent' }, textColor: 'transparent', attributionLogo: false },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        rightPriceScale: { visible: false }, leftPriceScale: { visible: false },
        timeScale: { visible: false, borderVisible: false, rightOffset: 1 },
        crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        handleScroll: false, handleScale: false,
      });
      const series = c.addCandlestickSeries({ upColor: up, downColor: dn, wickUpColor: up, wickDownColor: dn, borderVisible: false, priceLineVisible: false, lastValueVisible: false });
      chart.current = { c, series };
    }
    chart.current.series.setData(candles);
    chart.current.c.timeScale().fitContent();
  }, [candles]);
  React.useEffect(() => {
    const last = chart.current && lastCandle(sym, price);
    if (last) try { chart.current.series.update(last); } catch (e) {}
  }, [sym, price]);
  React.useEffect(() => () => { if (chart.current) try { chart.current.c.remove(); } catch (e) {} }, []);
  return <div ref={box} className="pointer-events-none h-14 w-full" />;
}

function Leader({ sym }) {
  const c = coinOf(sym), ch = changeOf(c);
  return (
    <Card role="button" tabIndex={0} data-action="expand" data-sym={sym}
      className="w-52 cursor-pointer gap-1 rounded-lg px-3 py-2 shadow-none transition-colors hover:bg-accent max-md:w-auto max-md:min-w-0 max-md:flex-1">
      <div className="flex items-baseline gap-2 text-sm">
        <b>{sym.toUpperCase()}</b>
        <span className="tabular-nums">{c ? fmtPrice(c.current_price) : '—'}</span>
        <span className={'ml-auto tabular-nums max-md:hidden ' + tone(ch)}>{ch == null ? '' : signed(ch, 2) + '%'}</span>
      </div>
      <span className={'hidden text-xs tabular-nums max-md:block ' + tone(ch)}>{ch == null ? '' : signed(ch, 2) + '%'}</span>
      <Spark sym={sym} candles={S.kl[sym]} price={c && c.current_price} />
    </Card>
  );
}

// "Your 24h": total, W/L, one bar per trade (height = size, color = sign)
function Mine() {
  const m = S.mine;
  const head = (right) => (
    <div className="flex items-baseline gap-2 text-sm"><b>Your 24h</b>{right}</div>
  );
  const box = 'w-64 gap-1 rounded-lg px-3 py-2 shadow-none max-md:w-full';
  if (!m || m.error) {
    return <Card className={box}>{head()}<span className="flex h-14 items-center text-xs text-muted-foreground">{m && m.error ? m.error : S.loading ? 'Loading…' : '—'}</span></Card>;
  }
  const sm = m.summary;
  const trades = m.trades.slice(-MAX_BARS);
  const maxAbs = Math.max(...trades.map((t) => Math.abs(t.pnlNet) || 0), 1e-9);
  return (
    <Card className={box}>
      {head(<span className={'ml-auto tabular-nums ' + tone(sm.pnlNet)}>{signed(sm.pnlNet, 2)} USDT</span>)}
      <span className="text-xs text-muted-foreground">
        {sm.trades ? sm.trades + ' trade' + (sm.trades === 1 ? '' : 's') + ' · ' + sm.wins + 'W / ' + sm.losses + 'L' : 'No trades'}
        {sm.open ? ' · ' + sm.open + ' open' : ''}
      </span>
      {!trades.length
        ? <span className="flex h-14 items-center text-xs text-muted-foreground">No trades in the last 24 hours</span>
        : (
          <div className="flex h-14 items-end gap-1">
            {trades.map((t, i) => {
              const sym = t.symbol.replace(/USDT$/, '');
              const h = t.result === 'open' ? 30 : Math.max(8, Math.round(Math.abs(t.pnlNet) / maxAbs * 100));
              const color = t.result === 'open' ? 'bg-input' : t.pnlNet >= 0 ? 'bg-bullish' : 'bg-danger';
              return (
                <Tooltip key={i}>
                  <TooltipTrigger asChild>
                    <span data-action="expand" data-sym={sym.toLowerCase()} className="flex h-full max-w-7 flex-1 cursor-pointer flex-col items-center justify-end gap-0.5">
                      <span className={'min-h-1 w-full rounded-t-sm ' + color} style={{ height: h + '%' }} />
                      <span className="max-w-full overflow-hidden text-2xs leading-none whitespace-nowrap text-muted-foreground">{sym}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{sym} {t.side} · {t.result === 'open' ? 'open' : signed(t.pnlNet, 2) + ' USDT'}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        )}
    </Card>
  );
}

// Orders per coin: B / S (limits, with size), BS / SS (stop entries), TP, SL
function ordersByCoin(acc) {
  const by = {};
  const add = (sym, kind, usd) => {
    const g = by[sym] = by[sym] || { kinds: {}, list: [] };
    if (!g.kinds[kind]) { g.kinds[kind] = { usd: null, n: 0 }; g.list.push(kind); }
    g.kinds[kind].n++;
    if (usd != null) g.kinds[kind].usd = (g.kinds[kind].usd || 0) + usd;
  };
  acc.orders.forEach((o) => add(o.symbol, o.side === 'BUY' ? 'B' : 'S', (Number(o.origQty) - Number(o.executedQty || 0)) * Number(o.price)));
  acc.algoOrders.forEach((a) => {
    const entry = a.type === 'STOP_MARKET' && !a.closePosition && !a.reduceOnly;
    add(a.symbol, entry ? (a.side === 'BUY' ? 'BS' : 'SS') : a.type === 'TAKE_PROFIT_MARKET' ? 'TP' : 'SL', entry ? Number(a.quantity) * Number(a.triggerPrice) : null);
  });
  return by;
}

const CHIP = {
  B: 'border-transparent bg-bullish/20 text-bullish', TP: 'border-transparent bg-bullish/20 text-bullish',
  S: 'border-transparent bg-danger/20 text-danger', SL: 'border-transparent bg-danger/20 text-danger',
  BS: 'border-bullish bg-transparent text-bullish', SS: 'border-danger bg-transparent text-danger',
};
function Chips({ g }) {
  if (!g) return null;
  return g.list.map((k) => {
    const x = g.kinds[k];
    return <Badge key={k} variant="outline" className={'h-4 rounded-sm px-1 text-2xs font-semibold ' + CHIP[k]}>{k}{x.usd != null ? ' ' + fmtK(x.usd) : x.n > 1 ? ' ×' + x.n : ''}</Badge>;
  });
}

function OpenNow() {
  const [confirmAt, setConfirmAt] = React.useState(0);
  const [closing, setClosing] = React.useState(false);
  const [, tick] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    if (!confirmAt) return;
    const t = setTimeout(tick, CONFIRM_MS + 50); // back to the normal label if not confirmed
    return () => clearTimeout(t);
  }, [confirmAt]);

  if (state.isDemoMode) return null;
  const snap = tradingSnapshot();
  if (!snap || !snap.account) return null;
  const acc = snap.account;
  const positions = acc.positions.filter((p) => Number(p.amount) !== 0);
  const orders = ordersByCoin(acc);
  let total = 0;
  const rows = positions.map((p) => {
    const coin = p.symbol.replace(/USDT$/, '');
    const amt = Number(p.amount), entry = Number(p.entryPrice);
    const c = coinOf(coin.toLowerCase());
    const pnl = c && c.current_price > 0 ? amt * (c.current_price - entry) : Number(p.unrealizedPnl || 0);
    total += pnl;
    return { p, coin, amt, entry, pnl };
  });
  const orderOnly = Object.keys(orders).filter((sym) => !positions.some((p) => p.symbol === sym));
  const confirming = Date.now() - confirmAt < CONFIRM_MS;

  const closeAll = () => {
    if (closing) return;
    if (!confirming) { setConfirmAt(Date.now()); return; }
    setConfirmAt(0);
    setClosing(true);
    closeAllPositions().then((res) => {
      const bad = res.filter((r) => !r.ok);
      toast(bad.length
        ? 'Not closed: ' + bad.map((r) => r.symbol.replace(/USDT$/, '') + ' (' + r.error + ')').join(', ')
        : 'Closed ' + res.length + ' position' + (res.length === 1 ? '' : 's') + ', their orders cancelled');
    }).finally(() => setClosing(false));
  };

  return (
    <Card className="w-[340px] gap-1 rounded-lg px-3 py-2 shadow-none max-md:w-full">
      <div className="flex items-baseline gap-2 text-sm">
        <b>Open now</b>
        {snap.mode === 'test' && <Badge variant="secondary" className="h-4 px-1 text-2xs uppercase">Test</Badge>}
        {positions.length > 0 && <span className="text-xs font-semibold text-muted-foreground">{positions.length}</span>}
        {positions.length > 0 && <span className={'ml-auto tabular-nums ' + tone(total)}>{signed(total, 2)} USDT</span>}
      </div>
      {!positions.length && !orderOnly.length
        ? <span className="flex h-14 items-center text-xs text-muted-foreground">No open positions or orders</span>
        : <>
            {rows.length > 0 && (
              <div className="flex flex-col">
                {rows.slice(0, MAX_POSITIONS).map(({ p, coin, amt, entry, pnl }) => (
                  <div key={p.symbol} data-action="expand" data-sym={coin.toLowerCase()} title={'Open ' + coin}
                    className="grid h-5 cursor-pointer grid-cols-[3rem_4.5rem_1fr_auto] items-center gap-x-1.5 rounded-sm px-1 text-xs hover:bg-accent">
                    <b className="truncate">{coin}</b>
                    <span className={'font-medium whitespace-nowrap ' + (amt > 0 ? 'text-bullish' : 'text-danger')}>{(amt > 0 ? 'Long ' : 'Short ') + fmtK(Math.abs(amt) * entry)}</span>
                    <span className="flex min-w-0 gap-0.5 overflow-hidden"><Chips g={orders[p.symbol]} /></span>
                    <b className={'text-right tabular-nums ' + tone(pnl)}>{signed(pnl, 2)}</b>
                  </div>
                ))}
                {rows.length > MAX_POSITIONS && <span className="text-2xs text-muted-foreground">+{rows.length - MAX_POSITIONS} more</span>}
              </div>
            )}
            {orderOnly.length > 0 && (
              <div className="flex items-center gap-1 overflow-hidden text-2xs whitespace-nowrap text-muted-foreground">
                <span className="mr-0.5">Orders</span>
                {orderOnly.map((sym) => {
                  const coin = sym.replace(/USDT$/, '');
                  return (
                    <React.Fragment key={sym}>
                      <b className="ml-1 cursor-pointer text-foreground" data-action="expand" data-sym={coin.toLowerCase()}>{coin}</b>
                      <Chips g={orders[sym]} />
                    </React.Fragment>
                  );
                })}
              </div>
            )}
            {positions.length > 0 && (
              <Button size="sm" variant={confirming ? 'destructive' : 'outline'} className={'mt-1 h-7 ' + (confirming ? '' : 'text-danger')} disabled={closing} onClick={closeAll}>
                {closing ? 'Closing…' : confirming ? 'Confirm: close ' + positions.length + ' at market' : 'Close all positions'}
              </Button>
            )}
          </>}
    </Card>
  );
}

export function DaySummary() {
  const [, redraw] = React.useReducer((x) => x + 1, 0);
  useEvents(['terminal:account']);
  React.useEffect(() => {
    // Every 5 s: leaders follow live prices, your 24h refreshes once a minute
    const t = setInterval(() => {
      if (Date.now() - S.loadedAt > REFRESH_MS) loadMine(redraw); else redraw();
      loadKlines(redraw);
    }, 5000);
    loadMine(redraw);
    loadKlines(redraw);
    checkAccess().then(redraw).catch(() => {}); // loads the trader account (trading account only)
    return () => clearInterval(t);
  }, []);

  return (
    <div className="jr flex flex-wrap gap-2 px-8 pt-2.5 max-md:px-3">
      <div className="flex gap-2 max-md:w-full">
        {LEADERS.map((sym) => <Leader key={sym} sym={sym} />)}
      </div>
      {!state.isDemoMode && <Mine />}
      <OpenNow />
    </div>
  );
}
