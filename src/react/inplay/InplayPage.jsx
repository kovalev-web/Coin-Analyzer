// "In play" screener (/grid): 9 cells with the coins most active right now
// against their own norm (score from the server, inplay/metrics.js) and the
// candidates list. Who sits in a cell — src/inplay-grid.js (hysteresis,
// minimum hold, pins). Charts are vanilla Lightweight Charts (CoinChart).
import * as React from 'react';
import { ArrowLeft, Pin, PinOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { selectGrid, pinCoin, unpinCell } from '../../inplay-grid.js';
import { useInplay } from './feed.js';
import { CoinChart } from './CoinChart.jsx';

const CELLS = 9;
const PINS_KEY = 'qt_inplay_pins';

const TIPS = {
  score: 'Activity against the coin\'s own norm (last 4 h): 0 = as usual, 1 ≈ twice, 2 ≈ four times. Volume, trades and range weigh most.',
  rv: 'USDT volume per minute (last 5 min) against the coin\'s usual minute',
  tr: 'Trades per minute (last 5 min) against the coin\'s usual minute',
  natr: 'Average 1-minute range now, % (high − low)',
  chg: 'Price change over the last 5 minutes',
  usd: 'USDT volume per minute now',
};

const base = (sym) => sym.replace(/USDT$/, '');
const x = (v) => (v == null ? '—' : (v >= 10 ? Math.round(v) : v.toFixed(1)) + '×');
const pct = (v, signed) => (v == null ? '—' : (signed && v > 0 ? '+' : '') + v.toFixed(2) + '%');
const usd = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v / 1e3) + 'K');

function loadPins() {
  try {
    const saved = JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
    return Array.from({ length: CELLS }, (_, i) => (saved[i] ? { sym: saved[i], since: Date.now(), below: null, pinned: true } : null));
  } catch (e) { return Array(CELLS).fill(null); }
}
function savePins(slots) {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(slots.map((s) => (s && s.pinned ? s.sym : null)))); } catch (e) {}
}

function Stat({ tip, className, children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className={cn('cursor-default text-xs whitespace-nowrap tabular-nums', className)}>{children}</span></TooltipTrigger>
      <TooltipContent className="max-w-64">{tip}</TooltipContent>
    </Tooltip>
  );
}

function Cell({ slot, coin, onPin, onUnpin }) {
  if (!slot) {
    return (
      <div className="flex min-h-0 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground max-md:hidden">
        Waiting for activity
      </div>
    );
  }
  return (
    <div className="flex min-h-64 flex-col overflow-hidden rounded-lg border bg-card md:min-h-0">
      <div className="flex h-9 shrink-0 items-center gap-2.5 overflow-hidden border-b pr-1 pl-3">
        <span className="text-sm font-semibold tracking-wide">{base(slot.sym)}</span>
        {coin ? (
          <>
            <Stat tip={TIPS.score}><Badge variant="secondary" className="tabular-nums">{coin.score.toFixed(1)}</Badge></Stat>
            <Stat tip={TIPS.chg} className={coin.chg < 0 ? 'text-danger' : 'text-muted-foreground'}>{pct(coin.chg, true)}</Stat>
            <Stat tip={TIPS.rv} className="hidden text-muted-foreground max-md:inline 2xl:inline">vol {x(coin.rv)}</Stat>
            <Stat tip={TIPS.tr} className="hidden text-muted-foreground max-md:inline 2xl:inline">trades {x(coin.tr)}</Stat>
            <Stat tip={TIPS.natr} className="text-muted-foreground">{pct(coin.natr)}</Stat>
          </>
        ) : <span className="text-xs text-muted-foreground">cooling down</span>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" className={cn('ml-auto', slot.pinned ? 'text-foreground' : 'text-muted-foreground')}
              aria-label={slot.pinned ? 'Unpin' : 'Pin'} onClick={slot.pinned ? onUnpin : onPin}>
              {slot.pinned ? <PinOff /> : <Pin />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{slot.pinned ? 'Unpin: the coin leaves when it cools down' : 'Pin: keep this coin here'}</TooltipContent>
        </Tooltip>
      </div>
      <CoinChart sym={slot.sym} />
    </div>
  );
}

function HeadTip({ tip, className, children }) {
  return (
    <TableHead className={className}>
      <Tooltip>
        <TooltipTrigger asChild><span className="cursor-default">{children}</span></TooltipTrigger>
        <TooltipContent className="max-w-64">{tip}</TooltipContent>
      </Tooltip>
    </TableHead>
  );
}

function Candidates({ coins, onGrid, onPick }) {
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          <TableHead>Coin</TableHead>
          <HeadTip tip={TIPS.score} className="text-right">Score</HeadTip>
          <HeadTip tip={TIPS.rv} className="text-right">Vol</HeadTip>
          <HeadTip tip={TIPS.tr} className="text-right">Trades</HeadTip>
          <HeadTip tip={TIPS.natr} className="text-right">Range</HeadTip>
          <HeadTip tip={TIPS.usd} className="text-right">$/min</HeadTip>
        </TableRow>
      </TableHeader>
      <TableBody>
        {coins.map((c) => (
          <TableRow key={c.s} onClick={() => onPick(c.s)} className={cn('cursor-pointer tabular-nums', !c.ok && 'text-muted-foreground')}
            data-state={onGrid.has(c.s) ? 'selected' : undefined}>
            <TableCell className="font-medium">{base(c.s)}</TableCell>
            <TableCell className="text-right">{c.score.toFixed(1)}</TableCell>
            <TableCell className="text-right">{x(c.rv)}</TableCell>
            <TableCell className="text-right">{x(c.tr)}</TableCell>
            <TableCell className="text-right">{pct(c.natr)}</TableCell>
            <TableCell className="text-right">{usd(c.usd)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function InplayPage() {
  const { status, data } = useInplay();
  const [slots, setSlots] = React.useState(loadPins);
  const coins = React.useMemo(() => {
    const map = {};
    if (data) data.coins.forEach((c) => { map[c.s] = c; });
    return map;
  }, [data]);

  // Every server update decides who sits in the cells
  React.useEffect(() => { if (data) setSlots((s) => selectGrid(s, coins, Date.now())); }, [data, coins]);
  React.useEffect(() => savePins(slots), [slots]);

  const onGrid = new Set(slots.filter(Boolean).map((s) => s.sym));
  const warming = data && data.ready < data.total;

  return (
    <div className="jr flex h-dvh flex-col bg-background text-foreground max-md:h-auto max-md:min-h-dvh">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button asChild variant="ghost" size="icon-sm" aria-label="Back"><a href="/"><ArrowLeft /></a></Button>
        <h1 className="text-base font-semibold">In play</h1>
        <span className="text-xs text-muted-foreground max-sm:hidden">coins far above their usual volume, trades and range</span>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {status !== 'live' ? <Badge variant="outline">{status === 'offline' ? 'Reconnecting…' : 'Connecting…'}</Badge>
            : !data ? <Badge variant="outline"><Spinner />Starting…</Badge>
            : warming ? <Badge variant="outline"><Spinner />Loading history {data.ready}/{data.total}</Badge>
            : <Badge variant="outline">{data.total} coins</Badge>}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <main className="grid min-h-0 flex-1 grid-cols-3 grid-rows-3 gap-1.5 p-1.5 max-md:grid-cols-1 max-md:grid-rows-none">
          {slots.map((slot, i) => (
            <Cell key={slot ? slot.sym : 'empty-' + i} slot={slot} coin={slot && coins[slot.sym]}
              onPin={() => setSlots((s) => pinCoin(s, slot.sym, coins, Date.now()))}
              onUnpin={() => setSlots((s) => unpinCell(s, i, Date.now()))} />
          ))}
        </main>
        <aside className="w-80 shrink-0 xl:w-96 overflow-y-auto border-l max-md:w-full max-md:border-t max-md:border-l-0">
          <Candidates coins={data ? data.coins : []} onGrid={onGrid} onPick={(sym) => setSlots((s) => pinCoin(s, sym, coins, Date.now()))} />
        </aside>
      </div>
    </div>
  );
}
