// Phones: the long-press menu on the full-view chart — on an empty spot add a
// price level / alert / ray at that price, on a level / alert / ray delete it.
// ui.js opens it at the touch point (rect) with its items and runs the picked
// one itself (onPick).
import * as React from 'react';
import { ArrowRight, Bell, Minus, Trash2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const ICONS = { level: Minus, alert: Bell, ray: ArrowRight };

export function ChartTouchMenu({ rect, items, onPick, onClose }) {
  return (
    <DropdownMenu open modal={false} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DropdownMenuTrigger asChild>
        <div aria-hidden style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: 'none' }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="min-w-48">
        {items.map((it) => {
          const Icon = it.danger ? Trash2 : ICONS[it.key];
          return (
            <DropdownMenuItem key={it.key} variant={it.danger ? 'destructive' : 'default'} className="py-2.5"
              onSelect={() => { onClose(); onPick(it.key); }}>
              <Icon /> {it.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
