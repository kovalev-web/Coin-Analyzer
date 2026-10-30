// Journal header: back, the page's one period (week / month / all / your
// dates), CSV export and the AI summary (week / month only)
import * as React from 'react';
import { ArrowLeft, CalendarIcon, Download, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { ru } from 'react-day-picker/locale';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { exportJournalCsv } from '../../api.js';
import { tzDateStr } from '../../utils.js';
import { JOURNAL_START, EXPORT_RANGES, shortDate, isoDay } from './format.js';
import { AiDialog } from './AiDialog.jsx';

function toDate(iso) { return new Date(iso + 'T00:00:00'); }

function DateRangePicker({ period, onChange }) {
  const [open, setOpen] = React.useState(false);
  const [range, setRange] = React.useState(period.from ? { from: toDate(period.from), to: toDate(period.to) } : undefined);
  const set = period.from && period.to;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={set ? 'secondary' : 'outline'} size="sm">
          <CalendarIcon />
          {set ? shortDate(period.from) + ' — ' + shortDate(period.to) : <span className="max-sm:sr-only">Свои даты</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <Calendar
          mode="range"
          locale={ru}
          numberOfMonths={1}
          startMonth={toDate(JOURNAL_START)}
          endMonth={toDate(tzDateStr())}
          defaultMonth={range?.from || toDate(tzDateStr())}
          selected={range}
          disabled={{ before: toDate(JOURNAL_START), after: toDate(tzDateStr()) }}
          onSelect={(r) => {
            setRange(r);
            if (r?.from && r?.to && r.from.getTime() !== r.to.getTime()) {
              onChange({ from: isoDay(r.from), to: isoDay(r.to) });
              setOpen(false);
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function Header({ period, onPeriod, aiRange }) {
  const [aiOpen, setAiOpen] = React.useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 max-sm:gap-2">
      <Button variant="ghost" size="icon-sm" asChild>
        <a href="/" aria-label="Назад"><ArrowLeft /></a>
      </Button>
      <h1 className="text-lg font-semibold">Журнал</h1>
      {/* Period: next to the title on desktop, its own full-width row on phones */}
      <div className="order-3 flex w-full items-center gap-2 sm:order-2 sm:ml-auto sm:w-auto">
        <ToggleGroup
          type="single"
          variant="segmented"
          size="sm"
          value={period.range || ''}
          onValueChange={(v) => { if (v) onPeriod({ range: v }); }}
          className="max-sm:flex-1"
        >
          <ToggleGroupItem value="week" className="px-3 max-sm:flex-1 max-sm:px-2">Неделя</ToggleGroupItem>
          <ToggleGroupItem value="month" className="px-3 max-sm:flex-1 max-sm:px-2">Месяц</ToggleGroupItem>
          <ToggleGroupItem value="all" className="px-3 max-sm:flex-1 max-sm:px-2">Всё время</ToggleGroupItem>
        </ToggleGroup>
        <DateRangePicker key={period.from || 'none'} period={period} onChange={onPeriod} />
      </div>
      <div className="order-2 ml-auto flex items-center gap-2 sm:order-3 sm:ml-0">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="Экспорт CSV"><Download /></Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Экспорт CSV</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Экспорт CSV</DropdownMenuLabel>
            {EXPORT_RANGES.map(([v, label]) => (
              <DropdownMenuItem key={v} onSelect={() => exportJournalCsv(v)}>{label}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* span keeps the tooltip working while the button is disabled */}
            <span tabIndex={aiRange ? -1 : 0}>
              <Button variant="outline" size="icon-sm" disabled={!aiRange} onClick={() => setAiOpen(true)} aria-label="AI-сводка">
                <Sparkles />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{aiRange ? 'AI-сводка за период' : 'AI-сводка — для периода Неделя или Месяц'}</TooltipContent>
        </Tooltip>
      </div>
      {aiRange && <AiDialog open={aiOpen} onOpenChange={setAiOpen} range={aiRange} />}
    </div>
  );
}
