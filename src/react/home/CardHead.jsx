// Head of a coin card on the main screen: ticker (click copies), 24h change,
// NATR, volume, the card's timeframe, watchlist star, full view. The card
// box and its chart stay vanilla (ui.js renderCard / initCharts); this head
// is a React island mounted into each card. Live numbers redraw on a shared
// half-second tick (like the old _refreshCardPct), the star on briefing changes.
import * as React from 'react';
import { ChevronDown, Maximize, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useEvents } from '@/shared/use-event';
import { state } from '../../state.js';
import { fmt } from '../../utils.js';
import { isInBriefing, setChartTF } from '../../ui.js';

const TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

// One timer for every card head
const tick = { n: 0, subs: new Set(), timer: null };
function subscribe(fn) {
  tick.subs.add(fn);
  if (!tick.timer) tick.timer = setInterval(() => { tick.n++; tick.subs.forEach((f) => f()); }, 500);
  return () => { tick.subs.delete(fn); if (!tick.subs.size) { clearInterval(tick.timer); tick.timer = null; } };
}
const useTick = () => React.useSyncExternalStore(subscribe, () => tick.n);

function Stat({ tip, className, children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className={'cursor-default text-xs font-medium tabular-nums ' + (className || '')}>{children}</span></TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

export function CardHead({ sym }) {
  useTick();
  useEvents(['briefing:changed', 'natr:updated']);
  const coin = (state.coins || []).find((c) => c.symbol === sym);
  if (!coin) return null;
  const change = coin.open_24h > 0 && coin.current_price > 0
    ? (coin.current_price - coin.open_24h) / coin.open_24h * 100
    : (coin.price_change_percentage_24h || 0);
  const nd = state.natrData[sym];
  const natr = nd && nd !== 'loading' && nd !== 'error' ? nd.value : null;
  const tf = state.chartTF[sym] || state.globalTF || '5m';
  const starred = isInBriefing(sym);

  return (
    <div className="jr flex h-11 items-center gap-2 bg-background pr-1.5 pl-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" data-action="copy-sym" data-sym={sym} className="cursor-pointer text-base font-bold tracking-wide whitespace-nowrap">{sym.toUpperCase()}</button>
        </TooltipTrigger>
        <TooltipContent>Copy ticker</TooltipContent>
      </Tooltip>
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <Stat tip="24h change" className={'min-w-12 ' + (change >= 0 ? 'text-muted-foreground' : 'text-danger')}>{(change >= 0 ? '+' : '') + change.toFixed(2)}%</Stat>
        <Stat tip="NATR — volatility (5m × 30 candles)" className={natr == null ? 'text-input' : natr >= 1.8 ? 'text-bullish' : 'text-muted-foreground'}>{natr == null ? '—' : natr.toFixed(2)}</Stat>
        <Stat tip="24h trading volume" className="text-muted-foreground">{fmt(coin.total_volume).replace('$', '')}</Stat>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="xs" className="gap-0.5 px-2" aria-label="Timeframe">{tf}<ChevronDown className="opacity-60" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-24">
            <DropdownMenuRadioGroup value={tf} onValueChange={(v) => setChartTF(sym, v)}>
              {TFS.map((t) => <DropdownMenuRadioItem key={t} value={t}>{t}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" data-action="toggle-briefing" data-sym={sym} aria-label={starred ? 'Remove from watchlist' : 'Add to watchlist'}
              className={starred ? 'text-level [&_svg]:fill-current' : ''}>
              <Star />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{starred ? 'Remove from watchlist' : 'Add to watchlist'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" data-action="expand" data-sym={sym} aria-label="Full screen"><Maximize /></Button>
          </TooltipTrigger>
          <TooltipContent>Full screen</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
