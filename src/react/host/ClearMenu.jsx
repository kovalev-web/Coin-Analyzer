// "Clear" on a chart: levels / rays / alerts of the coin, each with its count
import * as React from 'react';
import { Popover, PopoverContent } from '@/components/ui/popover';
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Badge } from '@/components/ui/badge';
import { clearLevels, clearRays, clearAlerts } from '../../ui.js';
import { AnchorBox, keepOpenOn } from './anchor.jsx';

export function ClearMenu({ sym, rect, counts, onClose }) {
  const rows = [
    ['Price levels', counts.levels, clearLevels, 'secondary'],
    ['Rays', counts.rays, clearRays, 'secondary'],
    ['Alerts', counts.alerts, clearAlerts, 'destructive'],
  ].filter((r) => r[1] > 0);
  return (
    <Popover open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AnchorBox rect={rect} />
      <PopoverContent align="start" className="w-56 p-1" onInteractOutside={keepOpenOn('[data-action="open-clear-popup"]')}>
        <ItemGroup>
          {rows.map(([label, n, clear, variant]) => (
            <Item key={label} size="sm" className="cursor-pointer px-2 py-2 hover:bg-accent" asChild>
              <button type="button" onClick={() => { onClose(); clear(sym); }}>
                <ItemContent><ItemTitle className="font-normal">{label}</ItemTitle></ItemContent>
                <ItemActions><Badge variant={variant}>{n}</Badge></ItemActions>
              </button>
            </Item>
          ))}
        </ItemGroup>
      </PopoverContent>
    </Popover>
  );
}
