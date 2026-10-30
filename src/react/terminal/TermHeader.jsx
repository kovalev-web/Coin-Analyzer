// Order book header: Live / Test (which trader and account the orders go to;
// the same segmented switch as everywhere), the connection indicator, the price scale
// (− finer / + coarser, one row = exchange tick × multiplier), settings; and
// under it the "view only" line when Test shows the live market.
// Buttons keep their data- attributes: the panel's click handler in
// terminal.js does what they do (_switchMode, _changeScale, _openSettings).
import * as React from 'react';
import { Minus, Plus, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEvents } from '@/shared/use-event';
import { termHeader } from '../../terminal.js';
import { PingBadge } from './PingBadge.jsx';

function Tip({ text, children }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent>{text}</TooltipContent></Tooltip>;
}

export function TermHeader() {
  useEvents(['term:header']);
  const h = termHeader();
  return (
    <div className="jr">
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <Tip text="Live: real account · Test: Binance Demo, practice money">
          <ToggleGroup type="single" variant="segmented" value={h.mode} className="h-7 shrink-0">
            <ToggleGroupItem value="live" data-mode="live" className="text-xs">Live</ToggleGroupItem>
            <ToggleGroupItem value="test" data-mode="test" className="text-xs">Test</ToggleGroupItem>
          </ToggleGroup>
        </Tip>
        <PingBadge />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Tip text="Finer price scale (−)">
            <Button variant="secondary" size="icon-xs" data-scale="-1" aria-label="Finer"><Minus /></Button>
          </Tip>
          <Tip text="Price scale: one row = exchange tick × multiplier">
            <span className="min-w-8 text-center text-2xs font-medium tabular-nums">{h.scale}</span>
          </Tip>
          <Tip text="Coarser price scale (+)">
            <Button variant="secondary" size="icon-xs" data-scale="1" aria-label="Coarser"><Plus /></Button>
          </Tip>
          <Tip text="Order book settings">
            <Button variant="secondary" size="icon-xs" className="ml-1" data-settings="1" aria-label="Order book settings"><Settings /></Button>
          </Tip>
        </div>
      </div>
      {h.viewOnly && <div className="bg-danger/15 px-3 py-1 text-center text-2xs font-medium text-danger">Live market · view only — trading is off</div>}
    </div>
  );
}
