// TV mode (src/tv.js): the head of each of the six chart slots — ticker, 24h
// change, price — and the exit button. The grid and the charts stay vanilla;
// heads redraw every few seconds from state.coins.
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { state } from '../../state.js';

export function TvHead({ sym }) {
  const [, tick] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => { const t = setInterval(tick, 5000); return () => clearInterval(t); }, []);
  const c = (state.coins || []).find((x) => x.symbol === sym);
  if (!c) return null;
  const ch = c.open_24h > 0 && c.current_price > 0 ? (c.current_price - c.open_24h) / c.open_24h * 100 : (c.price_change_percentage_24h || 0);
  return (
    <div className="jr flex items-baseline gap-2.5 border-b bg-background px-3.5 py-2">
      <span className="text-base font-bold tracking-wide">{sym.toUpperCase()}</span>
      <span className={'text-sm font-medium tabular-nums ' + (ch >= 0 ? 'text-bullish' : 'text-danger')}>{(ch >= 0 ? '+' : '') + ch.toFixed(2)}%</span>
      <span className="ml-auto text-xs font-medium text-muted-foreground tabular-nums">{c.current_price || ''}</span>
    </div>
  );
}

export function TvExit() {
  return (
    <div className="jr">
      <Button size="lg" data-action="close-tv" className="opacity-70 hover:opacity-100">Выйти из TV</Button>
    </div>
  );
}
