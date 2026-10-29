// Day table: a day opens into its own execution and its trades grouped by
// setup — notes on the coin, re-tag chips, "На графике" (the coin's own chart
// in review mode). Data: byDay from computeEdge.
import * as React from 'react';
import { ChevronRight, LineChart } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Chips } from '@/shared/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia } from '@/components/ui/item';
import { saveTradeTag } from '../../api.js';
import { setupButtons } from '../../setups.js';
import { ensureCoinNotes, notesOnDay } from '../../coin-notes.js';
import { tzDateStr, tzTimeStr } from '../../utils.js';
import { openTradeInChart } from '../../ui.js';
import { on, off } from '../../events.js';
import { BREAK_LABEL, EMOTIONS, QUALITY, money, rr, rateTone, shortDate, tone, trades } from './format.js';
import { Breaks, EmptyNote, InfoTip, SetupName } from './EdgeSummary.jsx';

// One trade: time, coin, side, R, rule breaks, chart; tag chips under it
function Trade({ t, notes, onRetag }) {
  const [tag, setTag] = React.useState(t.tag || {});
  const d = new Date(t.closeTime), coin = t.symbol.replace(/USDT$/, '');
  const breaks = (t.broken || []).map((k) => BREAK_LABEL[k] || k);
  const retag = (kind, val) => {
    const body = { symbol: t.symbol, closeTime: t.closeTime, [kind]: val };
    saveTradeTag(body).then(() => { setTag((x) => ({ ...x, [kind]: val })); onRetag(); });
  };
  const result = t.r != null ? t.r : t.pnlNet;
  return (
    <div className="space-y-2 py-3">
      {notes.length > 0 && (
        <ItemGroup className="gap-1">
          {notes.map((n) => (
            <Item key={n.id || n.ts} variant="muted" size="sm" className="py-2">
              <ItemMedia className="text-xs text-muted-foreground tabular-nums">{tzTimeStr(new Date(n.ts))}</ItemMedia>
              <ItemContent><ItemDescription className="line-clamp-none text-xs text-foreground">{n.text}</ItemDescription></ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-muted-foreground tabular-nums">{tzTimeStr(d)}</span>
        <b>{coin} {t.side === 'long' ? 'лонг' : 'шорт'}</b>
        <span className={'font-semibold tabular-nums ' + tone(result)}>{t.r != null ? rr(t.r) : money(t.pnlNet) + ' USDT'}</span>
        {t.excluded
          ? <Badge variant="outline">не считается</Badge>
          : breaks.length
            ? breaks.map((b) => <Badge key={b} variant="destructive">{b}</Badge>)
            : <Badge variant="secondary">по правилам</Badge>}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => openTradeInChart(coin.toLowerCase(), t)}>
          <LineChart /> На графике
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Chips list={setupButtons()} value={tag.pattern} onChange={(v) => retag('pattern', v)} />
        <Chips list={QUALITY} value={tag.setup} onChange={(v) => retag('setup', v)} />
        <Chips list={EMOTIONS} value={tag.emotion} onChange={(v) => retag('emotion', v)} />
      </div>
    </div>
  );
}

// A setup group inside the day; trades without a setup start open — they're waiting for a click
function Group({ g, onRetag, notesSeen }) {
  const [open, setOpen] = React.useState(g.key === 'none');
  const name = g.key === 'none' ? 'Без сетапа' : g.key === 'excluded' ? 'Не считаются' : g.name || g.key;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50">
        <ChevronRight className={'size-4 shrink-0 transition-transform ' + (open ? 'rotate-90' : '')} />
        <span className="font-medium"><SetupName setupKey={g.key}>{name}</SetupName></span>
        <span className="text-muted-foreground">{trades(g.trades.length)}</span>
        {g.key !== 'excluded' && <span className={'ml-auto font-semibold tabular-nums ' + tone(g.totalR || 0)}>{rr(g.totalR)}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="divide-y border-t px-3">
        {g.trades.map((t) => {
          // Your notes on the coin that day, once (under its first trade)
          const coin = t.symbol.replace(/USDT$/, ''), day = tzDateStr(new Date(t.closeTime));
          const first = !notesSeen.has(coin + day);
          notesSeen.add(coin + day);
          return <Trade key={t.symbol + t.closeTime} t={t} notes={first ? notesOnDay(coin, day) : []} onRetag={onRetag} />;
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}

function DayBody({ d, onRetag }) {
  const [, redraw] = React.useReducer((x) => x + 1, 0);
  // Notes for the day's coins; redraw when they arrive
  React.useEffect(() => {
    on('coin-notes:updated', redraw);
    d.setups.forEach((g) => g.trades.forEach((t) => ensureCoinNotes(t.symbol.replace(/USDT$/, ''))));
    return () => off('coin-notes:updated', redraw);
  }, [d]);
  const notesSeen = new Set();
  return (
    <div className="grid grid-cols-1 gap-6 p-4 max-sm:gap-4 max-sm:p-3 lg:grid-cols-4 [&>*]:min-w-0">
      <div className="space-y-3">
        <h4 className="text-sm font-medium">Исполнение</h4>
        {!d.breaks.length
          ? d.n ? <p className="text-sm text-bullish">100% — все сделки по правилам</p> : <EmptyNote>Сделок в отчёте нет</EmptyNote>
          : <>
              <div className="flex items-baseline gap-2">
                <span className={'text-2xl font-semibold tabular-nums ' + rateTone(d.rate)}>{d.rate}%</span>
                <span className="text-sm text-muted-foreground">по правилам — {d.clean} из {d.n}</span>
              </div>
              <Breaks list={d.breaks} />
            </>}
      </div>
      <div className="space-y-3 lg:col-span-3">
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          Сделки <InfoTip>Все сделки дня по сетапам, как они были; ошибки отмечены у сделки. Клик по сетапу — сделки, заметки и смена пометок.</InfoTip>
        </h4>
        {d.setups.length
          ? d.setups.map((g) => <Group key={g.key} g={g} onRetag={onRetag} notesSeen={notesSeen} />)
          : <EmptyNote>Сделок нет</EmptyNote>}
      </div>
    </div>
  );
}

function DayRow({ d, onRetag }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <TableRow className="cursor-pointer" data-state={open ? 'selected' : undefined} onClick={() => setOpen(!open)}>
        <TableCell className="font-medium">
          <span className="inline-flex items-center gap-1.5">
            <ChevronRight className={'size-4 text-muted-foreground transition-transform ' + (open ? 'rotate-90' : '')} />
            {shortDate(d.date)}
          </span>
          {d.untagged > 0 && <span className="block pl-5.5 text-2xs font-normal text-muted-foreground sm:hidden">{d.untagged} без сетапа</span>}
        </TableCell>
        <TableCell className="text-right tabular-nums">{d.n}</TableCell>
        <TableCell className={'text-right tabular-nums ' + (d.rate === 100 ? 'text-bullish' : d.rate != null && d.rate < 50 ? 'text-danger' : '')}>{d.rate != null ? d.rate + '%' : '—'}</TableCell>
        <TableCell className={'text-right tabular-nums ' + tone(d.pnl)}>{money(d.pnl)}</TableCell>
        <TableCell className="text-right max-sm:hidden">{d.untagged > 0 && <Badge variant="outline">{d.untagged} без сетапа</Badge>}</TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="whitespace-normal bg-muted/30 p-0"><DayBody d={d} onRetag={onRetag} /></TableCell>
        </TableRow>
      )}
    </>
  );
}

export function DayTable({ days, onRetag }) {
  if (!days || !days.length) return null;
  return (
    <Card className="gap-2">
      <CardHeader><CardTitle>По дням</CardTitle></CardHeader>
      <CardContent className="px-2 sm:px-6">
        <Table className="max-sm:[&_td]:px-1.5 max-sm:[&_th]:px-1.5">
          <TableHeader>
            <TableRow>
              <TableHead>Дата</TableHead>
              <TableHead className="text-right">Сделок</TableHead>
              <TableHead className="text-right">По <span className="max-sm:hidden">правилам</span><span className="sm:hidden">прав.</span></TableHead>
              <TableHead className="text-right">PnL<span className="max-sm:hidden">, USDT</span></TableHead>
              <TableHead className="max-sm:hidden" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {days.map((d) => <DayRow key={d.date} d={d} onRetag={onRetag} />)}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
