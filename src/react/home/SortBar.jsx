// Filter bar over the cards: volume tier, live-data dot, coin count, the
// timeframe for every card, sort by 24h change / volume (Tear only)
import * as React from 'react';
import { BarChart2, ChevronDown, ChevronRight, Percent } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useEvents } from '@/shared/use-event';
import { state, filteredCoins } from '../../state.js';
import { wsConnected } from '../../api.js';
import { screenerCoins, setGlobalTF } from '../../ui.js';
import { closePopovers } from '../../react-bridge.js';

const TIERS = [['high', '100', '>100M USDT 24h volume'], ['mid', '50', '50M – 100M USDT'], ['low', '12', '12M – 50M USDT']];
const TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

// Tooltip's own data-state replaces the toggle's on the same element, so the
// toggles below style the chosen one by aria-checked instead
function Tip({ text, children }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent>{text}</TooltipContent></Tooltip>;
}

export function SortBar({ screener }) {
  useEvents(['ws:status', 'metrics:update', 'cards:sync']);
  const [tf, setTf] = React.useState(state.globalTF);
  const count = (screener ? screenerCoins() : filteredCoins()).length;

  return (
    <div className="jr flex items-center gap-2 px-8 py-2.5 max-md:gap-1.5 max-md:px-3">
      {!screener && (
        <ToggleGroup type="single" variant="segmented" size="sm" value={state.volTier}>
          {TIERS.map(([v, label, tip]) => (
            <Tip key={v} text={tip}>
              <ToggleGroupItem value={v} data-action="pick-tier" data-val={v} className="gap-0.5 px-3 max-md:px-2"><ChevronRight className="size-3.5" />{label}</ToggleGroupItem>
            </Tip>
          ))}
        </ToggleGroup>
      )}
      <Tip text={wsConnected ? 'Live data: connected' : 'Live data: disconnected'}>
        <span className={'ml-1 size-2 shrink-0 rounded-full ' + (wsConnected ? 'bg-bullish' : 'bg-danger')} />
      </Tip>
      <span className="text-xs whitespace-nowrap text-muted-foreground">{count}<span className="max-[400px]:hidden"> coins</span></span>

      <div className="ml-auto flex items-center gap-1 max-md:gap-0.5">
        <DropdownMenu onOpenChange={(o) => { if (o) closePopovers(); }}>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" className="group gap-1 px-2.5">{tf}<ChevronDown className="size-3.5 opacity-60 transition-transform duration-150 group-data-[state=open]:rotate-180" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-28">
            <DropdownMenuLabel className="text-xs text-muted-foreground">All charts</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={tf} onValueChange={(v) => { setTf(v); setGlobalTF(v); }}>
              {TFS.map((t) => <DropdownMenuRadioItem key={t} value={t}>{t}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {!screener && (
          <ToggleGroup type="single" variant="segmented" size="sm" value={state.sortCol}>
            <Tip text="Sort by 24h change">
              <ToggleGroupItem value="price_change_percentage_24h" data-action="sort" data-col="price_change_percentage_24h" aria-label="Sort by change"><Percent /></ToggleGroupItem>
            </Tip>
            <Tip text="Sort by volume">
              <ToggleGroupItem value="total_volume" data-action="sort" data-col="total_volume" aria-label="Sort by volume"><BarChart2 /></ToggleGroupItem>
            </Tip>
          </ToggleGroup>
        )}
      </div>
    </div>
  );
}
