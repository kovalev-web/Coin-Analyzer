// Briefing (watchlist of the day) on shadcn. Two places, one list:
//  - BriefingPopover: under the bookmark button — today's coins, "Watchlist mode"
//  - BriefingDrawer: beside the full-view chart — this week by day, the journal
//    cards' buttons, the coin on the chart highlighted; a row opens its coin
// A row: ticker, change since it was added, status (or the trade's PnL), notes,
// remove. Opening a row: status (click cycles watching → traded → skip →
// missed; locked to Traded once there are trades), the day's notes on the coin
// and, for today, a field to add one (Enter — saved by coin-notes.js).
// Data and saving stay in ui.js; the list redraws on 'briefing:render'.
import * as React from 'react';
import { Ban, CheckCheck, ChevronRight, Clock, CloudOff, Eye, StickyNote, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverHeader, PopoverTitle } from '@/components/ui/popover';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useEvents } from '@/shared/use-event';
import { state } from '../../state.js';
import { tzDateStr, tzTimeStr } from '../../utils.js';
import { fetchNATR, fetchAllBriefingTrades } from '../../api.js';
import { ensureCoinNotes, notesOnDay } from '../../coin-notes.js';
import { briefingCycleStatus, briefingRemove, briefingThisWeekEntries, closeBriefingPanel, openCoinFullView, openFVBriefingDrawer } from '../../ui.js';
import { AnchorBox, keepOpenOn } from '../host/anchor.jsx';

const STATUS = {
  watching: { icon: Eye, text: 'Watching', cls: 'text-muted-foreground' },
  traded: { icon: CheckCheck, text: 'Traded', cls: 'text-bullish' },
  skip: { icon: Ban, text: 'Skipped', cls: 'text-danger' },
  missed: { icon: Clock, text: 'Missed', cls: 'text-level' },
};

const coinOf = (sym) => (state.coins || []).find((c) => c.symbol === sym);
const tradeOf = (e) => state.trades[e.sym + ':' + e.date];
const pnlOf = (e) => { const t = tradeOf(e); return t && t.status === 'ok' && t.count > 0 ? t.pnl : null; };
const money = (n) => (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toFixed(2);

function openCoin(sym) {
  openCoinFullView(sym);
  if (!state.natrData[sym] || state.natrData[sym] === 'error') fetchNATR(sym);
}

// Live list: redraw on briefing / trades / notes changes and every half second for prices
function useBriefing() {
  useEvents(['briefing:render', 'briefing:changed', 'coin-notes:updated', 'journal:saved']);
  const [, tick] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => { const t = setInterval(tick, 500); return () => clearInterval(t); }, []);
}

function Status({ e, withText }) {
  const s = STATUS[e.status] || STATUS.watching;
  const Icon = s.icon;
  return <span className={'inline-flex items-center gap-1 text-xs ' + s.cls}><Icon className="size-4" />{withText && s.text}</span>;
}

function Row({ e, open, onToggle, onOpen, current }) {
  const [askRemove, setAskRemove] = React.useState(false);
  const coin = coinOf(e.sym);
  const delta = e.addedPrice && coin && coin.current_price > 0 ? (coin.current_price - e.addedPrice) / e.addedPrice * 100 : null;
  const pnl = pnlOf(e);
  const locked = !!(tradeOf(e) && tradeOf(e).count > 0);
  React.useEffect(() => { ensureCoinNotes(e.sym); }, [e.sym]);
  const notes = notesOnDay(e.sym, e.date);
  const remove = () => { if (e.note && e.note.trim()) setAskRemove(true); else briefingRemove(e.sym, e.date, true); };

  return (
    <div className={'rounded-md ' + (open ? 'bg-muted/60' : '')}>
      <div className={'group flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-accent ' + (current ? 'bg-accent' : '')} onClick={onToggle}>
        <ChevronRight className={'size-3.5 shrink-0 text-muted-foreground transition-transform ' + (open ? 'rotate-90' : '')} />
        <button type="button" className="w-16 truncate text-left text-sm font-semibold hover:underline" onClick={(ev) => { ev.stopPropagation(); onOpen(e.sym); }}>{e.sym.toUpperCase()}</button>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="w-16 text-xs tabular-nums text-muted-foreground">{delta == null ? '—' : (delta >= 0 ? '+' : '') + delta.toFixed(2) + '%'}</span>
          </TooltipTrigger>
          <TooltipContent>Change since added</TooltipContent>
        </Tooltip>
        {pnl != null
          ? <span className={'text-xs font-medium tabular-nums ' + (pnl >= 0 ? 'text-bullish' : 'text-danger')}>{money(pnl)}</span>
          : <Status e={locked ? { ...e, status: 'traded' } : e} />}
        <span className="ml-auto flex items-center">
          <StickyNote className={'mr-1 size-4 ' + (notes.length ? 'text-level' : 'text-muted-foreground/40')} aria-label={notes.length ? 'Has notes' : 'No notes'} />
          {e.date === tzDateStr() && (
            <Button variant="ghost" size="icon-xs" className="text-muted-foreground opacity-0 group-hover:opacity-100 max-sm:opacity-100" aria-label="Remove"
              onClick={(ev) => { ev.stopPropagation(); remove(); }}>
              <Trash2 />
            </Button>
          )}
        </span>
      </div>
      {open && (
        <div className="grid gap-2 px-2 pt-1 pb-3">
          <div>
            {locked
              ? <Badge variant="secondary" className="gap-1 text-bullish"><CheckCheck /> Traded{pnl != null && <span className="ml-1 tabular-nums">{money(pnl)}</span>}</Badge>
              : (
                <Button variant="outline" size="xs" onClick={() => briefingCycleStatus(e.sym, e.date)}>
                  <Status e={e} withText />
                </Button>
              )}
          </div>
          {notes.length > 0 && (
            <div className="grid gap-1">
              {notes.map((n) => (
                <div key={n.id || n.ts} className="flex gap-2 text-xs">
                  <span className="shrink-0 text-muted-foreground tabular-nums">{tzTimeStr(new Date(n.ts))}</span>
                  <span className="whitespace-pre-wrap">{n.text}</span>
                </div>
              ))}
            </div>
          )}
          {e.date === tzDateStr() && (
            // Enter saves it (coin-notes.js listens to [data-cn-sym]); same notes as on the chart
            <Input data-cn-sym={e.sym} className="h-8 text-xs" maxLength={2000} placeholder={'Заметка по ' + e.sym.toUpperCase() + ' — Enter, сохранится и на графике'} />
          )}
        </div>
      )}
      <AlertDialog open={askRemove} onOpenChange={setAskRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {e.sym.toUpperCase()} from watchlist?</AlertDialogTitle>
            <AlertDialogDescription>It has a note for this day.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => briefingRemove(e.sym, e.date, true)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function List({ entries, current, onOpen }) {
  const [open, setOpen] = React.useState(null);
  return entries.map((e) => {
    const key = e.sym + ':' + e.date;
    return <Row key={key} e={e} open={open === key} current={current === e.sym} onOpen={onOpen}
      onToggle={() => { setOpen(open === key ? null : key); if (current !== undefined && current !== e.sym) onOpen(e.sym); }} />;
  });
}

// Under the bookmark button: today's coins
export function BriefingPopover({ rect, onClose }) {
  useBriefing();
  const today = tzDateStr();
  const entries = (state.briefing || []).filter((e) => e.date === (state.briefingViewDate || today));
  const open = (sym) => {
    closeBriefingPanel();
    openCoin(sym);
    setTimeout(() => { openFVBriefingDrawer(); fetchAllBriefingTrades(); }, 50);
  };
  return (
    <Popover open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AnchorBox rect={rect} />
      <PopoverContent align="end" className="flex max-h-[75vh] w-md max-w-[calc(100vw-1rem)] flex-col gap-0 p-0" onInteractOutside={keepOpenOn('[data-action="open-briefing"]')}>
        <PopoverHeader className="px-4 py-3"><PopoverTitle>Watchlist</PopoverTitle></PopoverHeader>
        <Separator />
        <div className="overflow-y-auto overscroll-contain p-1">
          {entries.length
            ? <List entries={entries} onOpen={open} />
            : <Empty className="p-6"><EmptyHeader><EmptyDescription>No coins for today — star them on the dashboard</EmptyDescription></EmptyHeader></Empty>}
        </div>
        {(briefingThisWeekEntries().length > 0 || state.isDemoMode) && (
          <>
            <Separator />
            <div className="grid gap-2 p-3">
              {briefingThisWeekEntries().length > 0 && <Button data-action="go-briefing" className="w-full">Watchlist mode</Button>}
              {state.isDemoMode && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CloudOff className="size-3.5" /> Saves locally — <a href="/login" className="text-brand underline-offset-4 hover:underline">sign up to sync</a>
                </p>
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function fmtDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()] + ', ' + String(d).padStart(2, '0') + '.' + String(m).padStart(2, '0');
}

// Beside the full-view chart: this week by day, newest first
export function BriefingDrawer() {
  useBriefing();
  const today = tzDateStr();
  const week = briefingThisWeekEntries();
  const dates = [...new Set(week.map((e) => e.date))].sort().reverse();
  const current = window.__fvSymbol || null;
  const jt = state.journalToday;
  const morningDone = !!(jt && jt.morningAt);
  const eveningOff = !jt || !jt.morningAt || !!jt.skipped;
  return (
    <div className="jr flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="text-sm font-semibold">Watchlist</span>
      </div>
      {!state.isDemoMode && (
        <div className="grid grid-cols-2 gap-2 px-3 pb-2">
          <Button size="sm" variant={morningDone ? 'secondary' : 'default'} data-action="open-morning-journal" disabled={morningDone}>
            Morning{morningDone && <CheckCheck />}
          </Button>
          <Button size="sm" variant="outline" data-action="open-evening-journal" disabled={eveningOff}>Evening</Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-3">
        {!dates.length
          ? <Empty className="p-6"><EmptyHeader><EmptyDescription>Watchlist is empty</EmptyDescription></EmptyHeader></Empty>
          : dates.map((date, i) => (
            <div key={date}>
              {i > 0 && <Separator className="my-2" />}
              {date !== today && <div className="px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground">{fmtDay(date)}</div>}
              <List entries={week.filter((e) => e.date === date)} current={current} onOpen={(sym) => { if (sym !== window.__fvSymbol) openCoin(sym); }} />
            </div>
          ))}
      </div>
    </div>
  );
}
