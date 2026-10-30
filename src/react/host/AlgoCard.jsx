// Card of an algorithm found in the coin's tape (a mark on the full-view chart):
// P "Таймер · покупка — ~$82K каждые ~33 с": prints, total, price over the
// series, average price, share of the venue's turnover; C "Давление · покупка —
// покупки 86% · объём ×49.8 к обычному": market orders, turnover, price; when it started,
// when it could first be seen (and how far the price had gone by then), when
// it ended or that it's still running. Data: server algos/ via ui.js.
import * as React from 'react';
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { tzTimeStr } from '../../utils.js';
import { ALGO_VENUES } from '../../algo-label.js';
import { AnchorBox } from './anchor.jsx';

const usd = (v) => (v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'K' : '$' + Math.round(v));
const pct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
const sec = (t) => tzTimeStr(new Date(t)) + ':' + String(new Date(t).getSeconds()).padStart(2, '0');

function Stat({ label, children, className }) {
  return (
    <div className="rounded-md border bg-muted/40 px-2.5 py-1.5">
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className={'text-sm font-semibold tabular-nums ' + (className || '')}>{children}</div>
    </div>
  );
}

export function AlgoCard({ algo: a, rect, onClose }) {
  const pressure = a.kind === 'pressure';
  // Still running: timer — the next beat isn't overdue (two periods of grace);
  // pressure — its last minute is the current or the previous one
  const running = pressure ? Date.now() - a.end < 60000 : Date.now() - a.end < a.periodSec * 1000 * 2.5;
  const mins = Math.max(1, Math.round((a.end - a.start) / 60000));
  const byNotice = a.firstPrice > 0 ? (a.noticedPrice - a.firstPrice) / a.firstPrice * 100 : 0;
  const venue = ALGO_VENUES[a.venue] || a.venue;
  return (
    <Popover open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AnchorBox rect={rect} />
      <PopoverContent align="start" className="grid w-80 gap-3">
        <PopoverHeader>
          <PopoverTitle className={'flex items-center gap-2 ' + (a.buy ? 'text-bullish' : 'text-danger')}>
            {pressure ? 'Давление' : 'Таймер'} · {a.buy ? 'покупка' : 'продажа'}
            <Badge variant="secondary" className="ml-auto font-normal">{venue}</Badge>
          </PopoverTitle>
          <PopoverDescription>
            {pressure
              ? (a.buy ? 'покупки ' : 'продажи ') + Math.round(a.sidePct) + '% · объём ×' + a.volX.toFixed(1) + ' к обычному'
              : '~' + usd(a.sizeUsd) + ' каждые ~' + a.periodSec.toFixed(1) + ' с'}
          </PopoverDescription>
        </PopoverHeader>
        <div className="grid grid-cols-3 gap-1.5">
          <Stat label="Сделок">{a.count}</Stat>
          <Stat label={pressure ? 'Оборот' : 'Всего'}>{usd(a.totalUsd)}</Stat>
          <Stat label={pressure ? 'Цена за время' : 'Цена за серию'} className={a.change >= 0 ? 'text-bullish' : 'text-danger'}>{pct(a.change)}</Stat>
          {!pressure && <Stat label="Средняя цена">{+a.avgPrice.toPrecision(6)}</Stat>}
          {!pressure && <Stat label="Доля в обороте">{a.share == null ? '—' : Math.round(a.share) + '%'}</Stat>}
        </div>
        <div className="grid grid-cols-[auto_auto_1fr] items-baseline gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">Начало</span><span className="font-medium tabular-nums">{sec(a.start)}</span><span />
          <span className="text-muted-foreground">Замечено</span><span className="font-medium tabular-nums">{sec(a.noticed)}</span>
          <span className="text-level">цена уже {pct(byNotice)}</span>
          <span className="text-muted-foreground">Конец</span><span className="font-medium tabular-nums">{running ? 'идёт' : sec(a.end)}</span>
          <span className="text-level">{running ? 'работает ' + mins + ' мин' : 'длился ' + mins + ' мин'}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
