// Morning journal (v2, docs/TRADER_EDGE.md): separate state scales, the day's
// plan from the briefing, one if-then rule. Saving opens the trading day.
import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Item, ItemContent, ItemDescription } from '@/components/ui/item';
import { Chips } from '@/shared/chips';
import { Field, SCALE_1_5, dmy } from '@/shared/field';
import { state } from '../../state.js';
import { tzDateStr } from '../../utils.js';
import { saveJournalMorning } from '../../api.js';
import { emit } from '../../events.js';
import { toast } from '../../react-bridge.js';

const CHANNELS = [['closed', 'Закрыты'], ['open', 'Открыты']];

function Static({ children }) {
  return <Item variant="muted" size="sm" className="py-2"><ItemContent><ItemDescription className="line-clamp-none text-foreground">{children}</ItemDescription></ItemContent></Item>;
}

export function MorningDialog({ onClose }) {
  const today = tzDateStr();
  const limits = state.tradingLimits || {};
  const fix = state.journalLastFix;
  const coins = (state.briefing || []).filter((e) => e.date === today).map((e) => e.sym.toUpperCase());
  const [f, setF] = React.useState({ sleepHours: '', sleepQuality: '', energy: '', carryover: '', focus: '', dayPlan: '', ifWhen: '', ifThen: '', channelsClosed: '' });
  const [busy, setBusy] = React.useState(false);
  const [askSkip, setAskSkip] = React.useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? v.target.value : v }));

  const risk = !!((+f.energy && +f.energy <= 2) || (+f.carryover && +f.carryover >= 4) || (+f.sleepQuality && +f.sleepQuality <= 2));
  const ready = f.sleepHours !== '' && f.sleepQuality && f.energy && f.carryover && f.focus
    && f.dayPlan.trim() && f.ifWhen.trim() && f.ifThen.trim() && f.channelsClosed && coins.length > 0;

  const done = (kind) => { emit('journal:saved', { kind }); onClose(); };
  // Filled on another device meanwhile: the server kept that one — close and say so
  const failed = (e) => {
    if (e && e.alreadyFilled) { toast(e.message); done(state.journalToday && state.journalToday.skipped ? 'skip' : 'morning'); return; }
    setBusy(false); toast('Ошибка сети — попробуйте ещё раз');
  };
  const save = () => {
    setBusy(true);
    saveJournalMorning({
      sleepHours: f.sleepHours, sleepQuality: f.sleepQuality, energy: f.energy, carryover: f.carryover, focus: f.focus,
      ifThen: { if: f.ifWhen.trim(), then: f.ifThen.trim() },
      volume: limits.maxVolume != null ? String(limits.maxVolume) : '',
      stopLevel: limits.maxDrawdownPct != null ? limits.maxDrawdownPct + '%' : '',
      maxTrades: limits.maxTrades != null ? limits.maxTrades : '',
      dayPlan: f.dayPlan.trim(),
      plannedCoins: coins.join(', '),
      triggerWatch: '', // replaced by the if-then rule (v2)
      channelsClosed: f.channelsClosed,
    }).then(() => done('morning')).catch(failed);
  };
  const skip = () => {
    setBusy(true);
    saveJournalMorning({ skip: true }).then(() => done('skip')).catch(failed);
  };

  const notSet = 'Не задано — укажите в настройках аккаунта';
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Утренняя карточка</DialogTitle>
          <DialogDescription>{dmy(today)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <Field label="Сон этой ночью, часов">
            <Input type="number" min={0} max={16} step={0.5} inputMode="decimal" placeholder="7" className="w-24" value={f.sleepHours} onChange={set('sleepHours')} />
          </Field>
          <Field label="Качество сна (1 — прерывистый, 5 — глубокий)"><Chips list={SCALE_1_5} value={f.sleepQuality} onChange={set('sleepQuality')} /></Field>
          <Field label="Энергия (1 — без сил, 5 — бодрость)"><Chips list={SCALE_1_5} value={f.energy} onChange={set('energy')} /></Field>
          <Field label="Груз вчерашнего дня (1 — ничего, 5 — тяжело)"><Chips list={SCALE_1_5} value={f.carryover} onChange={set('carryover')} /></Field>
          <Field label="Фокус (1 — рассеянность, 5 — собранность)"><Chips list={SCALE_1_5} value={f.focus} onChange={set('focus')} /></Field>
          {risk && <p className="text-sm text-danger">Зона риска — сегодня торгуйте минимально или просто наблюдайте.</p>}
          <Field label="Макс. объём"><Static>{limits.maxVolume != null ? '$' + limits.maxVolume : notSet}</Static></Field>
          <Field label="Допустимый убыток на сделку"><Static>{limits.maxDrawdownPct != null ? limits.maxDrawdownPct + '%' : notSet}</Static></Field>
          <Field label="Макс. сделок в день"><Static>{limits.maxTrades != null ? limits.maxTrades : notSet}</Static></Field>
          <Field label="План на день">
            <Static>{coins.length ? 'В брифинге сегодня: ' + coins.join(', ') : 'Чтобы сохранить, добавьте в вотчлист хотя бы одну монету.'}</Static>
            <Textarea rows={2} value={f.dayPlan} onChange={set('dayPlan')} />
          </Field>
          <Field label="Правило дня — если … то …">
            {fix && <Static>Вчера вы хотели исправить: «{fix.text}»</Static>}
            <Input placeholder="Если выбило по стопу и тянет сразу перезайти" value={f.ifWhen} onChange={set('ifWhen')} />
            <Input placeholder="то отхожу на 10 минут" value={f.ifThen} onChange={set('ifThen')} />
          </Field>
          <Field label="Другие источники информации (кроме брифинга)"><Chips list={CHANNELS} value={f.channelsClosed} onChange={set('channelsClosed')} /></Field>
          <Field label="Стоп-кран дня"><Static>После 2 стопов подряд — день закрыт. Без исключений.</Static></Field>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" disabled={busy} onClick={() => setAskSkip(true)}>Сегодня не торгую</Button>
          <Button disabled={!ready || busy} onClick={save}>Сохранить и начать торговлю</Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={askSkip} onOpenChange={setAskSkip}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отметить сегодня как день без торговли?</AlertDialogTitle>
            <AlertDialogDescription>Вечерняя карточка будет недоступна.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={skip}>Не торгую</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
