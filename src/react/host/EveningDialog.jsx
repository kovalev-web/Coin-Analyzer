// Evening review (v2): numbers and rule checks come from the trades (facts);
// the questions cover only what the data can't know. Untagged trades can be
// tagged right in the facts. Closing keeps the answers as a draft.
import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Chips } from '@/shared/chips';
import { Field, SCALE_1_5, dmy } from '@/shared/field';
import { state } from '../../state.js';
import { tzDateStr, tzTimeStr } from '../../utils.js';
import { fetchJournalFacts, saveJournalEvening, saveTradeTag } from '../../api.js';
import { ensureSetups, setupButtons, setupName } from '../../setups.js';
import { emit } from '../../events.js';
import { toast } from '../../react-bridge.js';

const SELF_TALK = [['harsh', 'Harshly'], ['neutral', 'Neutrally'], ['kind', 'Supportively']];
const QUALITY = [['A', 'A'], ['B', 'B'], ['C', 'C']];
const EMOTIONS = [['plan', 'By plan'], ['fomo', 'FOMO'], ['revenge', 'Revenge'], ['boredom', 'Boredom'], ['fear', 'Fear']];
const TEXT_FIELDS = ['whyBreaks', 'didWell', 'fixTomorrow', 'missedScreening', 'freeConclusion'];

function hold(sec) {
  if (sec == null) return '—';
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), r = sec % 60;
  return m < 60 ? m + 'm' + (r ? ' ' + r + 's' : '') : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

// Rule breaks found in the day's trades (journal/facts.js)
function flags(f) {
  const v = f.violations, out = [];
  if (v.craneBrokenAt) out.push('Stop-crane broken at ' + tzTimeStr(new Date(v.craneBrokenAt)) + ' — ' + plural(v.tradesAfterCrane, 'trade') + ' after 2 losses in a row');
  if (v.overMaxTrades) out.push('Over max trades per day (' + f.limits.maxTrades + ')');
  if (v.oversize) out.push(v.oversize + ' over the volume limit ($' + f.limits.maxVolume + ')');
  if (v.revenge) out.push(v.revenge + ' entr' + (v.revenge === 1 ? 'y' : 'ies') + ' within 5 min after a loss');
  if (v.sizeUpAfterLosses) out.push(v.sizeUpAfterLosses + ' size-up after losses');
  if (v.sizeUpAfterWins) out.push(v.sizeUpAfterWins + ' size-up after wins');
  if (v.offPlan) out.push(plural(v.offPlan, 'trade') + ' on coins outside the briefing');
  return out;
}

function FactTrade({ t }) {
  const [tag, setTag] = React.useState(t.tag || {});
  const retag = (kind, val) => saveTradeTag({ symbol: t.symbol, closeTime: t.closeTime, [kind]: val })
    .then(() => setTag((x) => ({ ...x, [kind]: val }))).catch((err) => toast(err.message));
  const labels = [];
  if (tag.pattern) labels.push(setupName(tag.pattern));
  if (tag.setup) labels.push(tag.setup + ' setup');
  labels.push(t.planned ? 'plan' : 'off-plan');
  if (t.atLevel === true) labels.push('at level');
  if (t.revenge) labels.push('revenge');
  if (t.sizeUp) labels.push('size-up');
  if (t.oversize) labels.push('oversize');
  if (t.afterCrane) labels.push('after crane');
  if (tag.emotion) labels.push(tag.emotion);
  const res = t.result === 'open' ? 'open' : (t.pnlNet >= 0 ? '+' : '') + t.pnlNet.toFixed(2);
  return (
    <Item variant="outline" size="sm" className="items-start">
      <ItemContent className="gap-2">
        <ItemTitle className="w-full flex-wrap">
          <span className="text-muted-foreground tabular-nums">{tzTimeStr(new Date(t.openTime))}</span>
          <span>{t.symbol.replace(/USDT$/, '')} {t.side}</span>
          <span className={'tabular-nums ' + (t.result === 'win' ? 'text-bullish' : t.result === 'loss' ? 'text-danger' : '')}>{res}</span>
        </ItemTitle>
        <ItemDescription className="text-xs">{labels.join(' · ')}</ItemDescription>
        {t.closeTime && (
          <div className="flex flex-wrap gap-2">
            <Chips list={setupButtons()} value={tag.pattern} onChange={(v) => retag('pattern', v)} />
            <Chips list={QUALITY} value={tag.setup} onChange={(v) => retag('setup', v)} />
            <Chips list={EMOTIONS} value={tag.emotion} onChange={(v) => retag('emotion', v)} />
          </div>
        )}
      </ItemContent>
    </Item>
  );
}

function Facts({ facts }) {
  if (facts === undefined) return <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-16 w-full" /></div>;
  if (!facts) return <p className="text-sm text-muted-foreground">Connect Binance API (Account → Integrations) to get facts from your trades.</p>;
  const s = facts.summary, list = flags(facts);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {s.trades
          ? <>{plural(s.trades, 'trade')} · {s.wins}W / {s.losses}L{s.winRate != null && ' · ' + s.winRate + '%'} · <span className={s.pnlNet >= 0 ? 'text-bullish' : 'text-danger'}>{(s.pnlNet >= 0 ? '+' : '') + s.pnlNet.toFixed(2)} USDT</span> · fees {s.fees.toFixed(2)} · avg hold {hold(s.avgHoldSec)}</>
          : 'No closed trades'}
        {s.open > 0 && <b> · {s.open} still open</b>}
      </p>
      {list.length
        ? <div className="flex flex-wrap gap-1.5">{list.map((x) => <Badge key={x} variant="destructive" className="whitespace-normal">{x}</Badge>)}</div>
        : s.trades ? <Badge variant="secondary">No rule breaks found in the data</Badge> : null}
      {facts.trades.length > 0 && <ItemGroup className="gap-2">{facts.trades.map((t) => <FactTrade key={t.symbol + (t.closeTime || t.openTime)} t={t} />)}</ItemGroup>}
    </div>
  );
}

export function EveningDialog({ onClose }) {
  const today = tzDateStr();
  const entry = state.journalToday || {};
  const [f, setF] = React.useState(() => Object.fromEntries([...TEXT_FIELDS, 'selfTalk', 'eveningState'].map((k) => [k, entry[k] || ''])));
  const [facts, setFacts] = React.useState(undefined);
  const [busy, setBusy] = React.useState(false);
  const draft = React.useRef(f);
  draft.current = f;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? v.target.value : v }));

  React.useEffect(() => {
    Promise.all([fetchJournalFacts(), ensureSetups()]).then(([x]) => setFacts(x || null));
  }, []);

  // Closing (X / Esc / outside) keeps the answers as a local draft
  const close = () => {
    const d = draft.current;
    state.journalToday = { ...(state.journalToday || {}), ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])) };
    onClose();
  };

  const v = facts && facts.violations;
  const anyBreak = !!(v && (v.craneBrokenAt || v.overMaxTrades || v.oversize || v.revenge || v.sizeUpAfterLosses || v.sizeUpAfterWins || v.offPlan));
  const hadLosses = !!(facts && facts.summary.losses);
  const ready = facts !== undefined && f.didWell.trim() && f.fixTomorrow.trim() && f.eveningState
    && (!anyBreak || f.whyBreaks.trim()) && (!hadLosses || f.selfTalk);

  const save = () => {
    setBusy(true);
    saveJournalEvening({
      // v2: trade count / PnL / rule checks come from facts on the server
      tradeCount: facts ? facts.summary.trades || 0 : 0,
      whyBreaks: f.whyBreaks.trim(), didWell: f.didWell.trim(), fixTomorrow: f.fixTomorrow.trim(),
      selfTalk: f.selfTalk, missedScreening: f.missedScreening.trim(), eveningState: f.eveningState,
      freeConclusion: f.freeConclusion.trim(),
      pnl: facts ? facts.summary.pnlNet : null,
    }).then(() => {
      toast('Review saved');
      emit('journal:saved', { kind: 'evening' });
      onClose();
    }).catch((err) => {
      setBusy(false);
      toast(err && err.message && err.message !== 'Failed to fetch' ? err.message : 'Network error — please try again');
    });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Evening review</DialogTitle>
          <DialogDescription>{dmy(today)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <Field label="Day facts — from your trades"><Facts facts={facts} /></Field>
          {anyBreak && <Field label="What was going on behind the rule breaks above?"><Textarea rows={2} value={f.whyBreaks} onChange={set('whyBreaks')} /></Field>}
          <Field label="One thing I did well today"><Textarea rows={2} value={f.didWell} onChange={set('didWell')} /></Field>
          <Field label="One thing to fix tomorrow (becomes tomorrow's if-then)"><Textarea rows={2} value={f.fixTomorrow} onChange={set('fixTomorrow')} /></Field>
          {hadLosses && <Field label="After losses, I talked to myself…"><Chips list={SELF_TALK} value={f.selfTalk} onChange={set('selfTalk')} /></Field>}
          <Field label="Missed in screening (coin / why I didn't flag it) — optional"><Textarea rows={2} value={f.missedScreening} onChange={set('missedScreening')} /></Field>
          <Field label="End-of-day state (1 = drained, 5 = calm)"><Chips list={SCALE_1_5} value={f.eveningState} onChange={set('eveningState')} /></Field>
          <Field label="Free-form notes — optional"><Textarea rows={2} value={f.freeConclusion} onChange={set('freeConclusion')} /></Field>
        </div>
        <DialogFooter>
          <Button disabled={!ready || busy} onClick={save}>Save review</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
