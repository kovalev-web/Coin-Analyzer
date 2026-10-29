// Liquidity of the full-view coin, under the Orderbook button: spread, bid /
// ask depth, aggression (buy vs sell share of recent trades, trades per
// second) and the latest trades ≥ $50, big ones (3× the coin's median)
// colored by side. Data from ui.js (liquidityData), redrawn on 'liq:update'.
import * as React from 'react';
import { Popover, PopoverContent, PopoverHeader, PopoverTitle } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { useEvents } from '@/shared/use-event';
import { fmtPrice } from '../../utils.js';
import { liquidityData } from '../../ui.js';
import { AnchorBox, keepOpenOn } from './anchor.jsx';

const depth = (n) => (n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + n.toFixed(0));
const qty = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n >= 1 ? n.toFixed(2) : n.toFixed(4));

function Metric({ label, value, className, children }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        <span>{label}</span>
        <span className={'text-xs font-semibold tracking-normal normal-case tabular-nums ' + (className || 'text-foreground')}>{value}</span>
      </div>
      {children}
    </div>
  );
}

export function LiquidityPopover({ rect, onClose }) {
  useEvents(['liq:update']);
  const { metrics: m, tape } = liquidityData();
  const max = m ? Math.max(m.depthBid, m.depthAsk, 1) : 1;
  const spreadCls = !m || m.spread == null ? '' : m.spread < 10 ? 'text-bullish' : m.spread > 30 ? 'text-danger' : '';

  return (
    <Popover open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AnchorBox rect={rect} />
      <PopoverContent align="start" className="grid w-60 gap-4 p-4" onInteractOutside={keepOpenOn('[data-action="toggle-liq-panel"]')}>
        <PopoverHeader><PopoverTitle>Orderbook</PopoverTitle></PopoverHeader>
        <Metric label="Spread" value={m && m.spread != null ? m.spread.toFixed(1) + ' bps' : '—'} className={spreadCls} />
        <Metric label="Bid depth" value={m ? depth(m.depthBid) : '—'}>
          <Progress value={m ? m.depthBid / max * 100 : 0} className="h-1.5 bg-muted *:data-[slot=progress-indicator]:bg-muted-foreground" />
        </Metric>
        <Metric label="Ask depth" value={m ? depth(m.depthAsk) : '—'}>
          <Progress value={m ? m.depthAsk / max * 100 : 0} className="h-1.5 bg-muted *:data-[slot=progress-indicator]:bg-muted-foreground" />
        </Metric>
        <Metric label="Aggression" value={m ? m.aggression.tradesPerSec.toFixed(1) + ' tps' : '—'}>
          <Progress value={m ? m.aggression.ratio * 100 : 50} aria-label="Buy share" className="h-1.5 bg-danger *:data-[slot=progress-indicator]:bg-bullish" />
        </Metric>
        <Separator />
        <div className="-my-1 grid text-xs tabular-nums">
          {tape.length === 0 && <span className="py-1 text-muted-foreground">Waiting for trades…</span>}
          {tape.map((t) => (
            <div key={t.id} className={'flex justify-between gap-2 py-1 ' + (t.large ? (t.buy ? 'text-bullish' : 'text-danger') : 'text-muted-foreground')}>
              <span>{fmtPrice(t.price).replace('$', '')}</span>
              <span>{qty(t.qty)}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
