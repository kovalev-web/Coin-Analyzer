// "In play" screener (/grid): what moves right now. The viewer picks the
// period (5m…3h), the sort (move, volume or trades against the coin's norm,
// volume / trades growth 15m against 3h, closest to the day's high / low),
// the candles and the number of cells; the server sends the coins for that
// choice (inplay/rank.js), the cells fill in order with no gaps. Pinned coins
// (pin in a cell or the search) take the first cells; the star puts a coin
// into today's watchlist (watchlist.js). While the mouse is on a chart the
// order is frozen ("Freeze", like ScalpStation): the server keeps the same
// coins in the same cells until it leaves. Charts are vanilla Lightweight
// Charts (CoinChart).
import * as React from 'react';
import { ArrowLeft, Check, Pin, PinOff, Search, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useInplay } from './feed.js';
import { useWatchlist, toggleWatch } from './watchlist.js';
import { CoinChart } from './CoinChart.jsx';

const VIEW_KEY = 'qt_inplay_view';
const PINS_KEY = 'qt_inplay_pins';
const DEFAULT_VIEW = { win: '5m', sort: 'move', tf: '1m', n: 6 };

const WINDOWS = ['5m', '15m', '1h', '3h'];
const SORTS = [
  { value: 'move', label: 'Move', tip: 'Размах за период: хай − лой, % — насколько монету носит' },
  { value: 'rvol', label: 'RVOL', tip: 'Относительный объём: объём за период против того же времени суток в среднем за прошлые 5 дней. Выше 2× — монета в игре, от 5× — сильно в игре' },
  { value: 'vol', label: 'Volume', tip: 'Объём в USDT за минуту периода против обычной минуты монеты за 24 ч. 14× — торгуют в 14 раз больше обычного' },
  { value: 'trades', label: 'Trades', tip: 'Сделок за минуту периода против обычной минуты монеты за 24 ч' },
  { value: 'gvol', label: 'Vol ↑', tip: 'Рост объёма: за минуту последних 15 мин против последних 3 ч. От периода не зависит' },
  { value: 'gtrades', label: 'Trades ↑', tip: 'Рост числа сделок: за минуту последних 15 мин против последних 3 ч. От периода не зависит' },
  { value: 'ext', label: 'Day H/L', tip: 'Ближе всех к хаю или лою дня (последние 24 ч). От периода не зависит' },
];
const TIP = Object.fromEntries(SORTS.map((s) => [s.value, s.tip]));
const TFS = ['1m', '5m', '15m'];
const CELLS = [4, 6, 9];

const base = (sym) => sym.replace(/USDT$/, '');
const x = (v) => (v == null ? '—' : (v >= 10 ? Math.round(v) : v.toFixed(1)) + '×');
const pct = (v, signed) => (v == null ? '—' : (signed && v > 0 ? '+' : '') + v.toFixed(2) + '%');
const usd = (v) => (v == null ? '—' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + Math.round(v / 1e3) + 'K');

function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

function useStored(key, fallback) {
  const [v, setV] = React.useState(() => load(key, fallback));
  React.useEffect(() => save(key, v), [key, v]);
  return [v, setV];
}

// Cells → columns: 1 → 1, 2…4 → 2, more → 3
const colsFor = (k) => (k <= 1 ? 1 : k <= 4 ? 2 : 3);

function Segmented({ value, onChange, items, label }) {
  return (
    <ToggleGroup type="single" variant="segmented" size="sm" value={String(value)} aria-label={label}
      onValueChange={(v) => { if (v) onChange(v); }}>
      {items.map((it) => {
        const item = <ToggleGroupItem key={it.value} value={String(it.value)} className="px-2.5">{it.label}</ToggleGroupItem>;
        return it.tip ? (
          <Tooltip key={it.value}>
            <TooltipTrigger asChild>{item}</TooltipTrigger>
            <TooltipContent className="max-w-64">{it.tip}</TooltipContent>
          </Tooltip>
        ) : item;
      })}
    </ToggleGroup>
  );
}

function CoinSearch({ syms, pins, onToggle }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const q = query.trim().toUpperCase().replace(/USDT$/, '');
  const list = (q ? syms.filter((s) => base(s).includes(q)).sort((a, b) => base(b).startsWith(q) - base(a).startsWith(q)) : syms).slice(0, 80);
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm"><Search />Pin coin</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command shouldFilter={false}>
          <CommandInput autoFocus placeholder="SOL, PEPE…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-80">
            <CommandEmpty>Nothing found</CommandEmpty>
            <CommandGroup>
              {list.map((s) => (
                <CommandItem key={s} value={s} onSelect={() => { onToggle(s); setOpen(false); setQuery(''); }}>
                  {base(s)}
                  {pins.includes(s) && <Check className="ml-auto" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Stat({ tip, strong, className, children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('cursor-default text-xs whitespace-nowrap tabular-nums', strong ? 'font-semibold text-foreground' : 'text-muted-foreground', className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{tip}</TooltipContent>
    </Tooltip>
  );
}

// The one number the grid is sorted by (Move — the range, seen on the chart; volume then)
function SortStat({ coin, w, sort }) {
  if (sort === 'gvol') return <Stat tip={TIP.gvol} strong>vol ↑{x(coin.gv)}</Stat>;
  if (sort === 'gtrades') return <Stat tip={TIP.gtrades} strong>trades ↑{x(coin.gt)}</Stat>;
  if (sort === 'ext') {
    return coin.ext
      ? <Stat tip={TIP.ext} strong className={coin.ext.side === 'high' ? 'text-bullish' : 'text-danger'}>{pct(coin.ext.pct)} to {coin.ext.side}</Stat>
      : <Stat tip={TIP.ext}>—</Stat>;
  }
  if (sort === 'rvol') return <Stat tip={TIP.rvol} strong>rvol {x(w && w.rvol)}</Stat>;
  if (sort === 'trades') return <Stat tip={TIP.trades} strong>trades {x(w && w.trades)}</Stat>;
  return <Stat tip={TIP.vol} strong={sort === 'vol'}>vol {x(w && w.vol)}</Stat>;
}

function Cell({ coin, win, sort, tf, delay, starred, onPin, onHover }) {
  const w = coin.w[win];
  return (
    <div className="flex min-h-64 min-w-0 flex-col overflow-hidden rounded-lg border bg-card md:min-h-0">
      <div className="flex h-9 shrink-0 items-center gap-2.5 overflow-hidden border-b pr-1 pl-3">
        <span className="text-sm font-semibold tracking-wide">{base(coin.s)}</span>
        {w && <Stat tip={'Изменение цены за ' + win} strong className={w.chg < 0 ? 'text-danger' : w.chg > 0 ? 'text-bullish' : ''}>{pct(w.chg, true)}</Stat>}
        {coin.natr != null && <Stat tip="NATR 5m/14: средний истинный диапазон 14 последних пятиминутных свечей, % цены — насколько крупные свечи">natr {pct(coin.natr)}</Stat>}
        <SortStat coin={coin} w={w} sort={sort} />
        {w && <Stat tip={'Объём в USDT за ' + win} className="max-xl:hidden">{usd(w.usd)}</Stat>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" className={cn('ml-auto', starred ? 'text-level [&_svg]:fill-current' : 'text-muted-foreground')}
              aria-label={starred ? 'Remove from watchlist' : 'Add to watchlist'} onClick={() => toggleWatch(coin.s)}>
              <Star />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{starred ? 'Убрать из вотчлиста' : 'В вотчлист на сегодня'}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" className={cn(coin.pinned ? 'text-foreground' : 'text-muted-foreground')}
              aria-label={coin.pinned ? 'Unpin' : 'Pin'} onClick={onPin}>
              {coin.pinned ? <PinOff /> : <Pin />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{coin.pinned ? 'Открепить' : 'Закрепить: монета всегда в первых ячейках'}</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col" onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
        <CoinChart sym={coin.s} tf={tf} delay={delay} />
      </div>
    </div>
  );
}

export function InplayPage() {
  const [view, setView] = useStored(VIEW_KEY, DEFAULT_VIEW);
  const [pins, setPins] = useStored(PINS_KEY, []);
  const v = { ...DEFAULT_VIEW, ...view };
  const set = (patch) => setView({ ...v, ...patch });
  const pinList = Array.isArray(pins) ? pins.filter((p) => typeof p === 'string') : [];
  const togglePin = (sym) => setPins(pinList.includes(sym) ? pinList.filter((p) => p !== sym) : pinList.concat(sym).slice(-v.n));

  const { starred } = useWatchlist();
  const [freeze, setFreeze] = React.useState(false);
  const { status, data, syms } = useInplay({ win: v.win, sort: v.sort, n: v.n, pins: pinList, freeze });
  // Only coins in the current format (an older server sends no windows)
  const coins = data && Array.isArray(data.coins) ? data.coins.filter((c) => c && c.w).slice(0, v.n) : [];
  const warming = data && data.ready < data.total;
  const cols = colsFor(coins.length);

  return (
    <div className="jr flex h-dvh flex-col bg-background text-foreground max-md:h-auto max-md:min-h-dvh">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button asChild variant="ghost" size="icon-sm" aria-label="Back"><a href="/"><ArrowLeft /></a></Button>
        <h1 className="mr-2 text-base font-semibold">In play</h1>
        <Segmented label="Period" value={v.win} onChange={(win) => set({ win })} items={WINDOWS.map((w) => ({ value: w, label: w }))} />
        <Segmented label="Sort" value={v.sort} onChange={(sort) => set({ sort })} items={SORTS} />
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Candles</span>
          <Segmented label="Candles" value={v.tf} onChange={(tf) => set({ tf })} items={TFS.map((t) => ({ value: t, label: t }))} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Cells</span>
          <Segmented label="Cells" value={v.n} onChange={(n) => set({ n: +n })} items={CELLS.map((c) => ({ value: c, label: String(c) }))} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {freeze && <Badge className="bg-level text-background">Freeze</Badge>}
          <CoinSearch syms={syms} pins={pinList} onToggle={togglePin} />
          {status !== 'live' ? <Badge variant="outline">{status === 'offline' ? 'Reconnecting…' : 'Connecting…'}</Badge>
            : warming ? <Badge variant="outline"><Spinner />History {data.ready}/{data.total}</Badge>
            : null}
        </div>
      </header>
      {coins.length ? (
        <main className="grid min-h-0 flex-1 gap-1.5 p-1.5 max-md:!grid-cols-1 max-md:!grid-rows-none"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(coins.length / cols)}, minmax(0, 1fr))` }}>
          {coins.map((c, i) => (
            <Cell key={c.s} coin={c} win={v.win} sort={v.sort} tf={v.tf} delay={i * 150} starred={starred.has(base(c.s))} onPin={() => togglePin(c.s)} onHover={setFreeze} />
          ))}
        </main>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{!data ? 'Loading…' : 'Nothing to show yet'}</EmptyTitle>
            <EmptyDescription>
              {!data ? 'Connecting to the screener.' : warming ? 'Loading candle history, the grid fills in a minute.' : 'No liquid coin has data for this period yet.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
