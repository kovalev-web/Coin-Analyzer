// Connection indicator in the order book's header: a dot by quality (grade in
// latency-stats.js) and the round trip; on hover / focus the full picture —
// entry point, where your traffic exits, you ↔ server (p50 / p95), jitter,
// lost pings, server ↔ Binance, order book delay, last order click → accepted,
// reconnects. Data: latency.js through terminal.js (termPing, 'term:ping').
import * as React from 'react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Badge } from '@/components/ui/badge';
import { useEvents } from '@/shared/use-event';
import { termPing } from '../../terminal.js';
import { grade } from '../../latency.js';

const ms = (v) => (v == null ? '—' : Math.round(v) + ' ms');
const DOT = { ok: 'bg-bullish', warn: 'bg-level', bad: 'bg-danger', unknown: 'bg-muted-foreground' };

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-4 text-xs">
      <span className="shrink-0 whitespace-nowrap text-muted-foreground">{k}</span>
      <b className="text-right font-medium">{v}</b>
    </div>
  );
}

export function PingBadge() {
  useEvents(['term:ping']);
  const s = termPing();
  const g = s ? grade(s) : 'unknown';
  const main = !s ? '— ms' : s.down ? 'offline' : ms(s.last) + (s.edgeCity ? ' · ' + s.edgeCity : '');
  const ago = s && s.order ? Math.round((Date.now() - s.order.at) / 1000) : null;

  return (
    <HoverCard openDelay={100} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Badge variant="secondary" tabIndex={0} className={'jr h-6 min-w-0 cursor-default gap-1.5 px-2 font-medium ' + (g === 'bad' ? 'text-danger' : '')}>
          <span className={'size-1.5 shrink-0 rounded-full ' + DOT[g]} />
          <span className="truncate">{main}</span>
        </Badge>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="grid w-72 gap-1.5 p-3">
        <b className="text-xs">Connection</b>
        {!s
          ? <p className="text-xs text-muted-foreground">Measuring…</p>
          : <>
              <Row k="Entry point" v={s.route === 'direct' ? 'Tokyo server, direct' : s.edgeCity ? s.edgeCity + ' (Cloudflare ' + s.edge + ')' : '—'} />
              <Row k="Your traffic exits in" v={s.country || '—'} />
              <Row k="You ↔ server" v={ms(s.last) + ' · p50 ' + ms(s.p50) + ' · p95 ' + ms(s.p95)} />
              <Row k="Jitter" v={ms(s.jitter)} />
              <Row k="Lost pings" v={s.samples || s.loss ? Math.round(s.loss * 100) + '%' : '—'} />
              <Row k="Server ↔ Binance" v={s.binance == null ? '—' : s.binance.toFixed(1) + ' ms'} />
              <Row k="Order book delay" v={ms(s.book) + (s.bookP95 != null ? ' · p95 ' + ms(s.bookP95) : '')} />
              <Row k="Last order, click → accepted" v={s.order ? ms(s.order.ms) + ' · ' + (ago < 60 ? ago + ' s' : Math.round(ago / 60) + ' min') + ' ago' : '—'} />
              <Row k="Reconnects" v={String(s.reconnects)} />
              <p className="pt-1 text-xs text-muted-foreground">Last 2 min, ping every 2 s over the order socket.</p>
            </>}
      </HoverCardContent>
    </HoverCard>
  );
}
