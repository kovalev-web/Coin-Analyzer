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

const CHANNELS = [['closed', 'Closed'], ['open', 'Open']];

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
    }).then(() => done('morning')).catch(() => { setBusy(false); toast('Network error — please try again'); });
  };
  const skip = () => {
    setBusy(true);
    saveJournalMorning({ skip: true }).then(() => done('skip')).catch(() => { setBusy(false); toast('Network error — please try again'); });
  };

  const notSet = 'Not set — configure in Account settings';
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Morning journal</DialogTitle>
          <DialogDescription>{dmy(today)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <Field label="Sleep last night, hours">
            <Input type="number" min={0} max={16} step={0.5} inputMode="decimal" placeholder="7" className="w-24" value={f.sleepHours} onChange={set('sleepHours')} />
          </Field>
          <Field label="Sleep quality (1 = broken, 5 = deep)"><Chips list={SCALE_1_5} value={f.sleepQuality} onChange={set('sleepQuality')} /></Field>
          <Field label="Energy (1 = drained, 5 = fresh)"><Chips list={SCALE_1_5} value={f.energy} onChange={set('energy')} /></Field>
          <Field label="Carrying yesterday (1 = nothing, 5 = heavy)"><Chips list={SCALE_1_5} value={f.carryover} onChange={set('carryover')} /></Field>
          <Field label="Focus (1 = scattered, 5 = sharp)"><Chips list={SCALE_1_5} value={f.focus} onChange={set('focus')} /></Field>
          {risk && <p className="text-sm text-danger">Risk zone — trade minimally or just observe today.</p>}
          <Field label="Max volume"><Static>{limits.maxVolume != null ? '$' + limits.maxVolume : notSet}</Static></Field>
          <Field label="Allowed loss per trade"><Static>{limits.maxDrawdownPct != null ? limits.maxDrawdownPct + '%' : notSet}</Static></Field>
          <Field label="Max trades per day"><Static>{limits.maxTrades != null ? limits.maxTrades : notSet}</Static></Field>
          <Field label="Plan for the day">
            <Static>{coins.length ? 'In briefing today: ' + coins.join(', ') : 'Add at least one coin to the watchlist before saving.'}</Static>
            <Textarea rows={2} value={f.dayPlan} onChange={set('dayPlan')} />
          </Field>
          <Field label="Today's rule — if … then …">
            {fix && <Static>Yesterday you wanted to fix: “{fix.text}”</Static>}
            <Input placeholder="If I take a stop and want to re-enter at once" value={f.ifWhen} onChange={set('ifWhen')} />
            <Input placeholder="then I step away for 10 minutes" value={f.ifThen} onChange={set('ifThen')} />
          </Field>
          <Field label="Other info channels (besides your briefing)"><Chips list={CHANNELS} value={f.channelsClosed} onChange={set('channelsClosed')} /></Field>
          <Field label="Daily stop-crane"><Static>After 2 stops in a row — the day is closed. No exceptions.</Static></Field>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" disabled={busy} onClick={() => setAskSkip(true)}>Not trading today</Button>
          <Button disabled={!ready || busy} onClick={save}>Save and start trading</Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={askSkip} onOpenChange={setAskSkip}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark today as a no-trading day?</AlertDialogTitle>
            <AlertDialogDescription>The evening journal will be unavailable.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={skip}>Not trading today</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
