// Full-view chart controls (shadcn): the island over the chart on desktop and
// the bottom bar on phones — back, ticker (copies), timeframe, order book,
// liquidity panel, watchlist star, notes, clear drawings, analysis. In review
// mode (a trade from the journal) only back / ticker / timeframe and a label.
// Also the 24h / NATR / volume line in the chart's corner (FvStats).
// The chart itself stays vanilla (ui.js); buttons keep their data-action.
import * as React from 'react';
import { Activity, ArrowLeft, Radar, ArrowUp, ChevronDown, EyeOff, ListOrdered, MessageSquarePlus, Star, Trash2, TriangleAlert, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useEvents } from '@/shared/use-event';
import { state } from '../../state.js';
import { fmt } from '../../utils.js';
import { msUntilWarm } from '../../orderbook.js';
import { terminalButton } from '../../terminal.js';
import { closePopovers } from '../../react-bridge.js';
import { drawingsCount, isBriefingPanelOpen, isInBriefing, setFVChartTF } from '../../ui.js';

const TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];
const SIGNAL = { bullish: ['text-bullish', ArrowUp], caution: ['text-level', TriangleAlert], neutral: ['text-muted-foreground', EyeOff] };

function Act({ label, children, ...rest }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} {...rest}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Tf({ tf, up }) {
  return (
    <DropdownMenu onOpenChange={(o) => { if (o) closePopovers(); }}>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="xs" className="group gap-0.5 px-2" aria-label="Timeframe">{tf}<ChevronDown className="opacity-60 transition-transform duration-150 group-data-[state=open]:rotate-180" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={up ? 'top' : 'bottom'} className="min-w-24">
        <DropdownMenuRadioGroup value={tf} onValueChange={setFVChartTF}>
          {TFS.map((t) => <DropdownMenuRadioItem key={t} value={t}>{t}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Analysis: run it / its signal / retry (hidden in demo)
function Analysis({ sym }) {
  if (state.isDemoMode) return null;
  const cache = state.analysisCache[sym];
  if (cache && cache.status === 'error') return <Button variant="outline" size="xs" data-action="analyze" data-sym={sym}>Retry</Button>;
  if (cache && cache.status === 'ok') {
    const [cls, Icon] = SIGNAL[cache.result.signal] || SIGNAL.neutral;
    return <Act label="Analysis" data-action="open-analysis" data-sym={sym} className={cls}><Icon /></Act>;
  }
  return <Act label="Analyze" data-action="analyze" data-sym={sym}><Zap /></Act>;
}

export function FvControls({ sym, review, bar }) {
  useEvents(['terminal:button', 'briefing:changed', 'drawings:changed', 'card:update', 'fv:tf']);
  const [, redraw] = React.useReducer((x) => x + 1, 0);
  // The liquidity panel needs the order book warm first
  const warmIn = msUntilWarm();
  React.useEffect(() => { if (warmIn > 0) { const t = setTimeout(redraw, warmIn); return () => clearTimeout(t); } }, [warmIn]);

  const tf = state.chartTF[sym] || '5m';
  const term = terminalButton();
  const starred = isInBriefing(sym);
  const drawings = drawingsCount(sym);

  return (
    <div className="jr flex w-full items-center justify-between gap-1">
      <div className="flex items-center gap-1.5">
        <Act label="Back" data-action="close-fv"><ArrowLeft /></Act>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" data-action="copy-sym" data-sym={sym} className="cursor-pointer px-1 text-base font-bold whitespace-nowrap max-sm:text-sm">{sym.toUpperCase()}</button>
          </TooltipTrigger>
          <TooltipContent>Copy ticker</TooltipContent>
        </Tooltip>
        <Tf tf={tf} up={bar} />
      </div>
      {review
        ? <span className="ml-3 text-2xs text-muted-foreground">Разбор сделки · ПКМ — уровень только здесь</span>
        : (
          <div className="flex items-center gap-0.5">
            {!bar && term.visible && (
              <Act label="Order book" data-action="toggle-terminal" className={term.active ? 'bg-accent text-foreground' : ''}><ListOrdered /></Act>
            )}
            <Act label={warmIn > 0 ? 'Orderbook — warming up' : 'Orderbook'} data-action="toggle-liq-panel" disabled={warmIn > 0}><Activity /></Act>
            <Act label="Откуда ход — все биржи" data-action="open-origin" data-sym={sym}><Radar /></Act>
            {!isBriefingPanelOpen() && (
              <Act label={starred ? 'Remove from watchlist' : 'Add to watchlist'} data-action="toggle-briefing" data-sym={sym} className={starred ? 'text-level [&_svg]:fill-current' : ''}><Star /></Act>
            )}
            <Act label="Note" data-action="fv-note" data-sym={sym}><MessageSquarePlus /></Act>
            {drawings > 0 && <Act label="Delete levels / rays / alerts" data-action="open-clear-popup" data-sym={sym}><Trash2 /></Act>}
            {!bar && <Analysis sym={sym} />}
          </div>
        )}
    </div>
  );
}

// 24h change, NATR, volume — redrawn every half second
export function FvStats({ sym }) {
  const [, tick] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => { const t = setInterval(tick, 500); return () => clearInterval(t); }, []);
  const coin = (state.coins || []).find((c) => c.symbol === sym);
  if (!coin) return null;
  const change = coin.open_24h > 0 && coin.current_price > 0 ? (coin.current_price - coin.open_24h) / coin.open_24h * 100 : (coin.price_change_percentage_24h || 0);
  const nd = state.natrData[sym];
  const natr = nd && nd !== 'loading' && nd !== 'error' ? nd.value : null;
  return (
    <div className="jr flex items-center gap-2.5 text-xs font-medium tabular-nums">
      <span className={'min-w-12 ' + (change < 0 ? 'text-danger' : '')}>{(change >= 0 ? '+' : '') + change.toFixed(2)}%</span>
      <span className={natr == null ? 'text-input' : natr >= 1.8 ? 'text-bullish' : ''}>{natr == null ? '—' : natr.toFixed(2)}</span>
      <span>{fmt(coin.total_volume).replace('$', '')}</span>
    </div>
  );
}
