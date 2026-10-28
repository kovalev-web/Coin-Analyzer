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
import { Label } from '@/components/ui/label';
import { changeSetup } from '../setups.js';
import { SETUP_DIAGRAMS } from '../setup-diagrams.js';
import { conclusions } from '../edge-insights.js';
import { state } from '../state.js';
import { BREAK_LABEL, RULES_HELP, plural, rr, rateTone, tone, trades } from './format.js';

// ⓘ with its explanation on hover
export function InfoTip({ children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex align-middle text-muted-foreground hover:text-foreground" aria-label="Пояснение">
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-line text-left">{children}</TooltipContent>
    </Tooltip>
  );
}

// A setup's name; its diagram on hover when it has one
export function SetupName({ setupKey, children }) {
  if (!SETUP_DIAGRAMS[setupKey]) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="cursor-help underline decoration-dotted underline-offset-4">{children}</span></TooltipTrigger>
      <TooltipContent className="w-[560px] max-w-[calc(100vw-32px)] border bg-popover p-2 text-popover-foreground [&_svg]:h-auto [&_svg]:w-full">
        <div dangerouslySetInnerHTML={{ __html: SETUP_DIAGRAMS[setupKey] }} />
      </TooltipContent>
    </Tooltip>
  );
}

export function Breaks({ list }) {
  return (
    <ul className="divide-y text-sm">
      {list.map((b) => (
        <li key={b.key} className="flex items-center justify-between py-1.5">
          <span>{BREAK_LABEL[b.key] || b.label || b.key}</span>
          <b className="tabular-nums text-danger">{b.count}</b>
        </li>
      ))}
    </ul>
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
          ? <p className="text-sm text-muted-foreground">Сделок нет</p>
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
          ? <p className="text-sm text-muted-foreground">Укажи риск на сделку в настройках аккаунта (Trading limits → % per trade) — без него R не посчитать.</p>
          : !rows.length
            ? <p className="text-sm text-muted-foreground">Пока нет сделок по правилам с отмеченным сетапом.</p>
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
          ? <p className="text-sm text-muted-foreground">Пока не из чего: разницы между группами нет или в них меньше 2 сделок. Заполняй утро и пометки — появятся.</p>
          : (
            <ul className="space-y-2 text-sm">
              {list.map((c, i) => (
                <li key={i}>
                  <b>{c.title}:</b> лучше — «{c.best.label}» (<span className={tone(c.best.avgR)}>{rr(c.best.avgR)}</span> на сделку, {trades(c.best.n)}),
                  {' '}хуже — «{c.worst.label}» (<span className={tone(c.worst.avgR)}>{rr(c.worst.avgR)}</span>, {trades(c.worst.n)}).
                  {c.early && <span className="text-muted-foreground"> Предварительно.</span>}
                </li>
              ))}
            </ul>
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
