// «Откуда ход» under its button on the full-view chart: the coin on every venue
// over the last 15 / 30 / 60 / 120 min, each against its own norm (2 h before):
// who left the norm first and how much later Binance futures followed, whose
// volume it is, buys, crowd or big player; open interest, funding and
// liquidations on the futures. Server: origin/ (GET /api/move-origin); refresh 15 s.
import * as React from 'react';
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle } from '@/components/ui/popover';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchMoveOrigin } from '../../api.js';
import { tzTimeStr } from '../../utils.js';
import { AnchorBox, keepOpenOn } from './anchor.jsx';

const WINDOWS = [15, 30, 60, 120];
const REFRESH_MS = 15000;

const x = (v) => (v == null ? '—' : '×' + (v >= 10 ? Math.round(v) : v.toFixed(1)));
const pct = (v, d = 1) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(d) + '%');
const usd = (v) => (v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + Math.round(v / 1e3) + 'K' : '$' + Math.round(v));
const lag = (ms) => (ms == null ? '—' : ms === 0 ? 'первая' : '+' + Math.round(ms / 60000) + ' мин');
const hot = (v) => (v != null && v >= 3 ? 'font-semibold text-foreground' : '');

export function OriginPopover({ sym, rect, onClose }) {
  const [min, setMin] = React.useState(30);
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    let alive = true;
    const load = () => fetchMoveOrigin(sym, min)
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); });
    setData(null);
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, [sym, min]);

  const rows = data ? data.rows.slice().sort((a, b) => (a.start == null) - (b.start == null) || (a.start || 0) - (b.start || 0) || (b.shareNow || 0) - (a.shareNow || 0)) : [];
  const futures = data ? Object.keys(Object.assign({}, data.oi, data.funding)) : [];

  return (
    <Popover open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AnchorBox rect={rect} />
      <PopoverContent align="end" className="grid w-[46rem] max-w-[calc(100vw-1rem)] gap-3" onInteractOutside={keepOpenOn('[data-action="open-origin"]')}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <PopoverHeader>
            <PopoverTitle>Откуда ход · {sym.toUpperCase()}</PopoverTitle>
            <PopoverDescription>
              {data ? tzTimeStr(new Date(data.from)) + '–' + tzTimeStr(new Date(data.to)) + ' против нормы за 2 ч до этого' : 'Все биржи против своей нормы'}
            </PopoverDescription>
          </PopoverHeader>
          <ToggleGroup type="single" variant="segmented" size="sm" value={String(min)} onValueChange={(v) => { if (v) setMin(Number(v)); }}>
            {WINDOWS.map((w) => <ToggleGroupItem key={w} value={String(w)} className="px-2.5">{w < 60 ? w + 'м' : w / 60 + 'ч'}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>

        {error && !data && <p className="text-sm text-danger">{error}</p>}
        {!data && !error && <div className="grid gap-2"><Skeleton className="h-5 w-3/4" /><Skeleton className="h-32 w-full" /></div>}

        {data && (
          <>
            <p className={'text-sm font-medium ' + (data.leader ? 'text-foreground' : 'text-muted-foreground')}>{data.verdict}</p>

            <Table className="text-xs tabular-nums">
              <TableHeader>
                <TableRow>
                  <TableHead>Площадка</TableHead>
                  <TableHead title="Первая минута, с которой 3 минуты подряд объём ≥ 3× нормы">Старт</TableHead>
                  <TableHead>Лаг</TableHead>
                  <TableHead className="text-right" title="Средняя минута окна против обычной">Объём</TableHead>
                  <TableHead className="text-right">Сделки</TableHead>
                  <TableHead className="text-right" title="Доля рыночных покупок (есть у Binance)">Покупки</TableHead>
                  <TableHead title="Средний размер сделки против обычного">Кто</TableHead>
                  <TableHead className="text-right">Цена</TableHead>
                  <TableHead className="text-right" title="Доля объёма монеты сейчас / обычно">Доля</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className={r.id === data.leader ? 'bg-accent' : ''}>
                    <TableCell className="font-medium">
                      {r.name}{r.id === data.leader && <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-2xs">триггер</Badge>}
                    </TableCell>
                    <TableCell>{r.start ? tzTimeStr(new Date(r.start)) : '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{lag(r.lag)}</TableCell>
                    <TableCell className={'text-right ' + hot(r.volX)}>{x(r.volX)}</TableCell>
                    <TableCell className={'text-right ' + hot(r.tradesX)}>{x(r.tradesX)}</TableCell>
                    <TableCell className={'text-right ' + (r.buyPct == null ? '' : r.buyPct >= 55 ? 'text-bullish' : r.buyPct <= 45 ? 'text-danger' : '')}>{r.buyPct == null ? '—' : Math.round(r.buyPct) + '%'}</TableCell>
                    <TableCell className="text-muted-foreground">{r.size || '—'}</TableCell>
                    <TableCell className={'text-right ' + (r.change > 0 ? 'text-bullish' : r.change < 0 ? 'text-danger' : '')}>{pct(r.change, 2)}</TableCell>
                    <TableCell className="text-right">{r.shareNow == null ? '—' : Math.round(r.shareNow) + '% / ' + Math.round(r.shareUsual) + '%'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="grid gap-1 text-xs text-muted-foreground">
              {futures.length > 0 && (
                <p>
                  <span className="text-foreground">Фьючерсы за окно:</span>{' '}
                  {futures.map((k) => k + ' — OI ' + pct(data.oi[k]) + (data.funding[k] != null ? ', фандинг ' + data.funding[k].toFixed(4) + '%' : '')).join(' · ')}
                </p>
              )}
              <p>
                <span className="text-foreground">Ликвидации Binance:</span>{' '}
                лонги {usd(data.liq.longUsd)} · шорты {usd(data.liq.shortUsd)}
                {data.liq.since && data.liq.since > data.from ? ' (считаем с ' + tzTimeStr(new Date(data.liq.since)) + ')' : ''}
              </p>
              {data.missing.length > 0 && <p>Нет монеты или данных: {data.missing.map((m) => m.name).join(', ')}</p>}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
