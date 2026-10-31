// Main page at / since 2026-10-31 (the previous one, the card grid, is at
// CLASSIC_ROUTE = /new for now; tag home-classic-2026-10-31). Top to bottom: the header without Tear / Gainers,
// the day strip (BTC / ETH / SOL, Your 24h, Open now), then three columns:
// the coins as a list with the volume tiers and sort, the chart of the coin
// picked in the list (the first one by default), and today's watchlist always
// open — a row there opens the full chart with the order book.
// Data — the same state.coins as the old page; the chart is the old card
// chart (mountCoinChart in ui.js): levels, alerts, rays and the ruler work as
// on the cards; notes open the notes popover of the full view.
import * as React from 'react';
import { BarChart2, ChevronRight, Maximize, Percent, Star, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEvents } from '@/shared/use-event';
import { cn } from '@/lib/utils';
import { state, filteredCoins } from '../../state.js';
import { fmt, fmtPrice } from '../../utils.js';
import { isInBriefing, mountCoinChart, unmountCoinChart, setChartTF } from '../../ui.js';
import { openSurface } from '../../react-bridge.js';
import { Topbar } from '../home/Topbar.jsx';
import { DaySummary } from '../home/DaySummary.jsx';
import { WatchlistPanel } from '../home/Briefing.jsx';

const TIERS = [['high', '100', '>100M USDT 24h volume'], ['mid', '50', '50M – 100M USDT'], ['low', '12', '12M – 50M USDT']];
const TFS = ['1m', '5m', '15m', '1h', '4h'];

function Tip({ text, children }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent>{text}</TooltipContent></Tooltip>;
}

const changeOf = (c) => (c.open_24h > 0 && c.current_price > 0
  ? (c.current_price - c.open_24h) / c.open_24h * 100
  : (c.price_change_percentage_24h || 0));

function Pct({ v, className }) {
  return <span className={cn('tabular-nums', v > 0 ? 'text-bullish' : v < 0 ? 'text-danger' : 'text-muted-foreground', className)}>{(v > 0 ? '+' : '') + v.toFixed(2)}%</span>;
}

function CoinList({ coins, current, onPick }) {
  const [, redraw] = React.useReducer((x) => x + 1, 0);
  const pick = (patch) => { Object.assign(state, patch); redraw(); };
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b p-2">
        <ToggleGroup type="single" variant="segmented" size="sm" value={state.volTier || 'high'} onValueChange={(v) => v && pick({ volTier: v })}>
          {TIERS.map(([v, label, tip]) => <Tip key={v} text={tip}><ToggleGroupItem value={v} className="gap-0.5 px-2.5"><ChevronRight className="size-3.5" />{label}</ToggleGroupItem></Tip>)}
        </ToggleGroup>
        <ToggleGroup type="single" variant="segmented" size="sm" className="ml-auto" value={state.sortCol} onValueChange={(v) => v && pick({ sortCol: v, sortDir: 'desc' })}>
          <Tip text="Sort by 24h change"><ToggleGroupItem value="price_change_percentage_24h" aria-label="Sort by change"><Percent /></ToggleGroupItem></Tip>
          <Tip text="Sort by volume"><ToggleGroupItem value="total_volume" aria-label="Sort by volume"><BarChart2 /></ToggleGroupItem></Tip>
        </ToggleGroup>
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 px-3 pt-2 pb-1 text-xs text-muted-foreground">
        <span>{coins.length} coins</span><span className="text-right">24h</span><span className="w-14 text-right">Vol</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1">
        {coins.map((c) => (
          <button key={c.symbol} type="button" onClick={() => onPick(c.symbol)}
            className={cn('grid w-full cursor-pointer grid-cols-[1fr_auto_auto] items-center gap-x-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted',
              current === c.symbol && 'bg-muted')}>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-semibold">{c.symbol.toUpperCase()}</span>
              {isInBriefing(c.symbol) && <Star className="size-3 shrink-0 fill-current text-level" />}
            </span>
            <Pct v={changeOf(c)} className="text-right text-xs" />
            <span className="w-14 text-right text-xs text-muted-foreground tabular-nums">{fmt(c.total_volume).replace('$', '')}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

// The card chart of the coin, mounted by ui.js into #chart-<sym>
function CardChart({ sym }) {
  React.useEffect(() => {
    if (!state.chartTF[sym]) state.chartTF[sym] = state.globalTF || '5m';
    mountCoinChart(sym);
    return () => unmountCoinChart(sym);
  }, [sym]);
  return <div id={'chart-' + sym} data-coin-chart={sym} className="relative min-h-0 flex-1" />;
}

function openNotes(sym, ev) {
  const r = ev.currentTarget.getBoundingClientRect();
  openSurface('notes', { sym, addToBriefing: true, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
}

function ChartPanel({ coin }) {
  const [, redraw] = React.useReducer((x) => x + 1, 0);
  if (!coin) return <section className="rounded-xl border bg-card" />;
  const sym = coin.symbol;
  const tf = state.chartTF[sym] || state.globalTF || '5m';
  const setTf = (v) => { setChartTF(sym, v); redraw(); };
  const starred = isInBriefing(sym);
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 border-b py-2 pr-2 pl-4">
        <span className="text-base font-bold tracking-wide">{sym.toUpperCase()}</span>
        <span className="text-sm tabular-nums">{fmtPrice(coin.current_price)}</span>
        <Pct v={changeOf(coin)} className="text-sm" />
        <span className="text-xs text-muted-foreground tabular-nums">{fmt(coin.total_volume)}</span>
        <ToggleGroup type="single" variant="segmented" size="sm" className="ml-auto" value={tf} onValueChange={(v) => v && setTf(v)}>
          {TFS.map((t) => <ToggleGroupItem key={t} value={t} className="px-2.5">{t}</ToggleGroupItem>)}
        </ToggleGroup>
        <Tip text={starred ? 'Remove from watchlist' : 'Add to watchlist'}>
          <Button variant="ghost" size="icon-sm" data-action="toggle-briefing" data-sym={sym} aria-label={starred ? 'Remove from watchlist' : 'Add to watchlist'}
            className={starred ? 'text-level [&_svg]:fill-current' : 'text-muted-foreground'}><Star /></Button>
        </Tip>
        <Tip text="Notes">
          <Button variant="ghost" size="icon-sm" aria-label="Notes" className="text-muted-foreground" onClick={(ev) => openNotes(sym, ev)}><StickyNote /></Button>
        </Tip>
        <Tip text="Chart and order book">
          <Button variant="ghost" size="icon-sm" data-action="expand" data-sym={sym} aria-label="Full screen"><Maximize /></Button>
        </Tip>
      </div>
      <CardChart key={sym} sym={sym} />
    </section>
  );
}

export function Home2() {
  useEvents(['briefing:changed', 'briefing:render', 'ws:status']);
  const [, tick] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => { const t = setInterval(tick, 1000); return () => clearInterval(t); }, []);
  const coins = filteredCoins();
  const [picked, setPicked] = React.useState(null);
  const current = coins.find((c) => c.symbol === picked) || coins[0] || null;

  return (
    <div className="jr flex h-dvh flex-col text-foreground">
      <Topbar tabs={false} />
      <DaySummary />
      <main className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)_20rem] gap-2 px-8 pt-2.5 pb-5 max-lg:grid-cols-[16rem_minmax(0,1fr)] max-md:grid-cols-1 max-md:px-3">
        <CoinList coins={coins} current={current && current.symbol} onPick={setPicked} />
        <ChartPanel coin={current} />
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card max-lg:hidden">
          <WatchlistPanel />
        </section>
      </main>
    </div>
  );
}
