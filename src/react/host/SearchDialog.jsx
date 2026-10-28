// Coin search (⌘K): BTC / ETH pinned, the rest by 24h change; picks open the coin's full view
import * as React from 'react';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { state } from '../../state.js';
import { fmt } from '../../utils.js';
import { openCoinFullView } from '../../ui.js';
import { fetchNATR } from '../../api.js';

const PINNED = ['btc', 'eth'];
const byChange = (a, b) => (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0);

function Row({ c, onPick }) {
  const ch = c.price_change_percentage_24h || 0;
  return (
    <CommandItem value={c.symbol} onSelect={() => onPick(c.symbol)}>
      <span className="w-20 font-medium">{c.symbol.toUpperCase()}</span>
      <span className="text-muted-foreground tabular-nums">{fmt(c.total_volume || 0).replace('$', '')}</span>
      <span className={'ml-auto tabular-nums ' + (ch >= 0 ? 'text-bullish' : 'text-danger')}>{(ch >= 0 ? '+' : '') + ch.toFixed(2)}%</span>
    </CommandItem>
  );
}

export function SearchDialog({ onClose }) {
  const [query, setQuery] = React.useState('');
  const coins = state.coins || [];
  const raw = query.trim().toLowerCase();
  const q = raw.replace(/usdt$|usdc$|busd$|usd$|us$|u$/, '') || raw;

  const pick = (sym) => {
    onClose();
    openCoinFullView(sym);
    if (!state.natrData[sym] || state.natrData[sym] === 'error') fetchNATR(sym);
  };

  let pinned = [], rest;
  if (q) {
    rest = coins.filter((c) => c.symbol.toLowerCase().includes(q) || (c.name && c.name.toLowerCase().includes(q)))
      .sort((a, b) => {
        const as = a.symbol.toLowerCase().startsWith(q) ? 0 : 1, bs = b.symbol.toLowerCase().startsWith(q) ? 0 : 1;
        return as !== bs ? as - bs : byChange(a, b);
      });
  } else {
    pinned = PINNED.map((s) => coins.find((c) => c.symbol === s)).filter(Boolean);
    rest = coins.filter((c) => !PINNED.includes(c.symbol)).sort(byChange);
  }

  return (
    <CommandDialog open onOpenChange={(o) => { if (!o) onClose(); }} title="Search coin" description="Find a coin by ticker or name" shouldFilter={false} className="sm:max-w-md">
      <CommandInput placeholder="BTC, Ethereum..." value={query} onValueChange={setQuery} />
      <CommandList className="max-h-96">
        <CommandEmpty>Nothing found</CommandEmpty>
        {pinned.length > 0 && <CommandGroup>{pinned.map((c) => <Row key={c.symbol} c={c} onPick={pick} />)}</CommandGroup>}
        {pinned.length > 0 && rest.length > 0 && <CommandSeparator />}
        {rest.length > 0 && <CommandGroup>{rest.map((c) => <Row key={c.symbol} c={c} onPick={pick} />)}</CommandGroup>}
      </CommandList>
    </CommandDialog>
  );
}
