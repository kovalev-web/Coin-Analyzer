// Cumulative PnL over the period (every trade) and the period's totals
import * as React from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { tzDateStr } from '../../utils.js';
import { money, tone } from './format.js';

const config = { total: { label: 'PnL', color: 'var(--ink-deep)' } };

// Every day from the first trade to today (or the period's end), running total
function series(daily, to) {
  if (!daily || !daily.length) return [];
  const byDate = Object.fromEntries(daily.map((d) => [d.date, d]));
  const end = new Date((to && to < tzDateStr() ? to : tzDateStr()) + 'T00:00:00Z');
  const out = [];
  let total = 0;
  for (let d = new Date(daily[0].date + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10), row = byDate[iso];
    if (row) total += row.pnl || 0;
    out.push({ date: iso, total: +total.toFixed(2), pnl: row ? row.pnl || 0 : 0, n: row ? row.tradeCount || 0 : 0 });
  }
  return out;
}

function label(iso, opts) { return new Date(iso + 'T00:00:00Z').toLocaleDateString('ru-RU', { timeZone: 'UTC', ...opts }); }

// Rows of the chart's tooltip: the day, its trades, the running total
function dayRows(value, name, item) {
  const p = item.payload;
  const row = (title, v, cls) => (
    <div key={title} className="flex w-full justify-between gap-4"><span className="text-muted-foreground">{title}</span><span className={'font-medium tabular-nums ' + (cls || '')}>{v}</span></div>
  );
  return [row('PnL за день', money(p.pnl), tone(p.pnl)), row('Сделок', p.n), row('Итог', money(p.total), tone(p.total))];
}

function Stat({ title, value, className }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4"><CardDescription>{title}</CardDescription></CardHeader>
      <CardContent className={'px-4 text-xl font-semibold tabular-nums ' + (className || '')}>{value}</CardContent>
    </Card>
  );
}

export function PnlChart({ summary, loading }) {
  const data = React.useMemo(() => series(summary && summary.daily, summary && summary.to), [summary]);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {loading
          ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)
          : <>
              <Stat title="PnL" value={summary ? money(summary.pnl) + ' $' : '—'} className={summary ? tone(summary.pnl) : ''} />
              <Stat title="Сделок" value={summary ? summary.tradeCount : '—'} />
              <Stat title="В плюс" value={summary ? summary.winRate + '%' : '—'} />
              <Stat title="Прибыльных" value={summary ? summary.winCount + ' / ' + summary.tradeCount : '—'} />
            </>}
      </div>
      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardTitle>PnL, USDT</CardTitle>
          <CardDescription>Все сделки за период, нарастающим итогом</CardDescription>
        </CardHeader>
        <CardContent className="px-2">
          {loading
            ? <Skeleton className="h-64 w-full" />
            : !data.length
              ? <Empty className="h-64"><EmptyHeader><EmptyDescription>Сделок за период пока нет</EmptyDescription></EmptyHeader></Empty>
              : (
                <ChartContainer config={config} className="aspect-auto h-64 w-full">
                  <AreaChart data={data} margin={{ left: 4, right: 4, top: 8 }}>
                    <defs>
                      <linearGradient id="jr-pnl" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-total)" stopOpacity={0.18} />
                        <stop offset="95%" stopColor="var(--color-total)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} tickFormatter={(v) => label(v, { day: 'numeric', month: 'short' })} />
                    <YAxis orientation="right" tickLine={false} axisLine={false} width={56} tickFormatter={(v) => v.toFixed(2)} />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent className="min-w-44" labelFormatter={(_, p) => label(p[0].payload.date, { day: 'numeric', month: 'short', year: 'numeric' })} formatter={dayRows} />} />
                    <Area dataKey="total" type="monotone" stroke="var(--color-total)" strokeWidth={2} fill="url(#jr-pnl)" />
                  </AreaChart>
                </ChartContainer>
              )}
        </CardContent>
      </Card>
    </div>
  );
}
