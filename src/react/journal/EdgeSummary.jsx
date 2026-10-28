// "Мой edge" for the period: execution (share of trades by your rules and the
// breaks), setups by total R (trades by the rules), conclusions.
// Numbers: journal/edge.js (GET /api/journal/edge).
import * as React from 'react';
import { Info } from 'lucide-react';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemSeparator, ItemTitle } from '@/components/ui/item';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { changeSetup } from '../../setups.js';
import { SETUP_DIAGRAMS } from '../../setup-diagrams.js';
import { conclusions } from '../../edge-insights.js';
import { state } from '../../state.js';
import { BREAK_LABEL, RULES_HELP, plural, rr, rateTone, tone, trades } from './format.js';

// ⓘ with its explanation on hover
export function InfoTip({ children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Пояснение">
          <Info />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-line text-left">{children}</TooltipContent>
    </Tooltip>
  );
}

// A setup's name; its diagram on hover when it has one
export function SetupName({ setupKey, children }) {
  if (!SETUP_DIAGRAMS[setupKey]) return children;
  return (
    <HoverCard openDelay={150} closeDelay={50}>
      <HoverCardTrigger asChild><span className="cursor-help underline decoration-dotted underline-offset-4">{children}</span></HoverCardTrigger>
      <HoverCardContent className="w-xl max-w-screen p-2 [&_svg]:h-auto [&_svg]:w-full">
        <div dangerouslySetInnerHTML={{ __html: SETUP_DIAGRAMS[setupKey] }} />
      </HoverCardContent>
    </HoverCard>
  );
}

// "Nothing here yet" inside a card
export function EmptyNote({ children }) {
  return (
    <Empty className="p-4 md:p-6">
      <EmptyHeader><EmptyDescription>{children}</EmptyDescription></EmptyHeader>
    </Empty>
  );
}

export function Breaks({ list }) {
  return (
    <ItemGroup>
      {list.map((b, i) => (
        <React.Fragment key={b.key}>
          {i > 0 && <ItemSeparator />}
          <Item size="sm" className="px-0 py-1.5">
            <ItemContent><ItemTitle className="font-normal">{BREAK_LABEL[b.key] || b.label || b.key}</ItemTitle></ItemContent>
            <ItemActions className="font-semibold tabular-nums text-danger">{b.count}</ItemActions>
          </Item>
        </React.Fragment>
      ))}
    </ItemGroup>
  );
}

function Execution({ x }) {
  const broken = x && x.n ? x.rules.filter((r) => r.broken).sort((a, b) => b.broken - a.broken) : [];
  const errs = broken.reduce((s, r) => s + r.broken, 0);
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">Исполнение <InfoTip>{RULES_HELP}</InfoTip></CardTitle>
        <CardDescription>Сделки по твоим правилам</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!x || !x.n
          ? <EmptyNote>Сделок нет</EmptyNote>
          : <>
              <div className="flex items-baseline gap-2">
                <span className={'text-3xl font-semibold tabular-nums ' + rateTone(x.rate)}>{x.rate}%</span>
                <span className="text-sm text-muted-foreground">по правилам · {errs ? errs + ' ' + plural(errs, 'ошибка', 'ошибки', 'ошибок') : 'ошибок нет'}</span>
              </div>
              {broken.length > 0 && <Breaks list={broken.map((r) => ({ key: r.key, label: r.label, count: r.broken }))} />}
            </>}
      </CardContent>
    </Card>
  );
}

// Your setup list: rename in place, leave out of the report, hide from the buttons, add
function SetupEditor({ onChanged }) {
  const [name, setName] = React.useState('');
  const list = state.setups || [];
  const apply = (change) => changeSetup(change).then(onChanged);
  const add = () => { if (name.trim()) apply({ action: 'add', name: name.trim() }).then(() => setName('')); };
  return (
    <div className="space-y-2 rounded-md border bg-muted/50 p-3">
      {list.map((x) => (
        <div key={x.key} className={'flex items-center gap-3 ' + (x.archived ? 'opacity-50' : '')}>
          <Input className="h-8" defaultValue={x.name} maxLength={40}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== x.name) apply({ action: 'rename', key: x.key, name: v }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          <Label className="shrink-0 text-xs font-normal">
            <Checkbox checked={!!x.exclude} onCheckedChange={(v) => apply({ action: 'exclude', key: x.key, exclude: !!v })} /> не считать
          </Label>
          <Button variant="ghost" size="sm" onClick={() => apply({ action: 'archive', key: x.key, archived: !x.archived })}>{x.archived ? 'Вернуть' : 'Скрыть'}</Button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Input className="h-8" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder="Новый сетап, например «Мисклик»" maxLength={40} />
        <Button variant="secondary" size="sm" onClick={add}>Добавить</Button>
      </div>
      <p className="text-xs text-muted-foreground">«Не считать» — сделки с этим сетапом не попадают в отчёт (мисклики, тесты). «Скрыть» — убрать из кнопок, статистика остаётся.</p>
    </div>
  );
}

function Setups({ e, onChanged }) {
  const [editing, setEditing] = React.useState(false);
  const rows = (e.setups || []).filter((s) => s.n > 0).sort((a, b) => b.totalR - a.totalR);
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          Сетапы
          <InfoTip>{'Только сделки по правилам — сколько сетап даёт, если делать его правильно. R: 1R = ' + (e.oneR != null ? e.oneR.toFixed(2) + ' USDT, ' : '') + (e.riskPct || '?') + '% от рабочего объёма. Надёжно от ' + e.minN + ' сделок.'}</InfoTip>
        </CardTitle>
        <CardDescription>Итог в R, только сделки по правилам</CardDescription>
        <CardAction><Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>{editing ? 'Готово' : 'Настроить'}</Button></CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {editing && <SetupEditor onChanged={onChanged} />}
        {!e.riskPct
          ? <EmptyNote>Укажи риск на сделку в настройках аккаунта (Trading limits → % per trade) — без него R не посчитать.</EmptyNote>
          : !rows.length
            ? <EmptyNote>Пока нет сделок по правилам с отмеченным сетапом.</EmptyNote>
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Сетап</TableHead>
                    <TableHead className="text-right">Сделок</TableHead>
                    <TableHead className="text-right">В плюс</TableHead>
                    <TableHead className="text-right">Итог</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((s) => (
                    <TableRow key={s.key} className={s.enough ? '' : 'text-muted-foreground'}>
                      <TableCell><SetupName setupKey={s.key}>{s.name || s.key}</SetupName></TableCell>
                      <TableCell className="text-right tabular-nums">{s.n}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.winRate}%</TableCell>
                      <TableCell className={'text-right font-semibold tabular-nums ' + tone(s.totalR)}>{rr(s.totalR)}</TableCell>
                    </TableRow>
                  ))}
                  {e.allTrades && e.allTrades.n > 0 && (
                    <TableRow className="bg-muted/50">
                      <TableCell className="text-muted-foreground">Все сделки, с ошибками</TableCell>
                      <TableCell className="text-right tabular-nums">{e.allTrades.n}</TableCell>
                      <TableCell className="text-right tabular-nums">{e.allTrades.winRate}%</TableCell>
                      <TableCell className={'text-right font-semibold tabular-nums ' + tone(e.allTrades.totalR)}>{rr(e.allTrades.totalR)}</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
      </CardContent>
    </Card>
  );
}

function Conclusions({ e }) {
  const list = conclusions(e.groups, e.oneR, e.minN, 4);
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          Выводы
          <InfoTip>Где ты торгуешь лучше и хуже — по времени, качеству сетапа, эмоции, брифингу, уровням и утреннему состоянию, в R на сделку. Появляются, когда в группах есть разница.</InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!list.length
          ? <EmptyNote>Пока не из чего: разницы между группами нет или в них меньше 2 сделок. Заполняй утро и пометки — появятся.</EmptyNote>
          : (
            <ItemGroup className="gap-2">
              {list.map((c, i) => (
                <Item key={i} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>{c.title}{c.early && <Badge variant="outline">предварительно</Badge>}</ItemTitle>
                    <ItemDescription className="line-clamp-none text-foreground">
                      лучше — «{c.best.label}» (<span className={tone(c.best.avgR)}>{rr(c.best.avgR)}</span> на сделку, {trades(c.best.n)}),
                      {' '}хуже — «{c.worst.label}» (<span className={tone(c.worst.avgR)}>{rr(c.worst.avgR)}</span>, {trades(c.worst.n)})
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          )}
      </CardContent>
    </Card>
  );
}

export function EdgeSummary({ e, onChanged }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Execution x={e.execution} />
        <Setups e={e} onChanged={onChanged} />
      </div>
      <Conclusions e={e} />
    </div>
  );
}
