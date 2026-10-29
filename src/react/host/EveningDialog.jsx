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

const SELF_TALK = [['harsh', 'Жёстко'], ['neutral', 'Нейтрально'], ['kind', 'Поддерживающе']];
const QUALITY = [['A', 'A'], ['B', 'B'], ['C', 'C']];
const EMOTIONS = [['plan', 'По плану'], ['fomo', 'FOMO'], ['revenge', 'Отыгрыш'], ['boredom', 'Скука'], ['fear', 'Страх']];
const TEXT_FIELDS = ['whyBreaks', 'didWell', 'fixTomorrow', 'missedScreening', 'freeConclusion'];

function hold(sec) {
  if (sec == null) return '—';
  if (sec < 60) return sec + ' с';
  const m = Math.floor(sec / 60), r = sec % 60;
  return m < 60 ? m + ' мин' + (r ? ' ' + r + ' с' : '') : Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
}
// plural(5, ['сделка', 'сделки', 'сделок']) → '5 сделок'
const plural = (n, [one, few, many]) => {
  const d = n % 10, h = n % 100;
  return n + ' ' + (d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many);
};
const TRADES = ['сделка', 'сделки', 'сделок'];

// Rule breaks found in the day's trades (journal/facts.js)
function flags(f) {
  const v = f.violations, out = [];
  if (v.craneBrokenAt) out.push('Стоп-кран нарушен в ' + tzTimeStr(new Date(v.craneBrokenAt)) + ' — ' + plural(v.tradesAfterCrane, TRADES) + ' после 2 убытков подряд');
  if (v.overMaxTrades) out.push('Превышен лимит сделок в день (' + f.limits.maxTrades + ')');
  if (v.oversize) out.push(plural(v.oversize, TRADES) + ' сверх лимита объёма ($' + f.limits.maxVolume + ')');
  if (v.revenge) out.push(plural(v.revenge, ['вход', 'входа', 'входов']) + ' в течение 5 мин после убытка');
  if (v.sizeUpAfterLosses) out.push('Увеличение объёма после убытков: ' + v.sizeUpAfterLosses);
  if (v.sizeUpAfterWins) out.push('Увеличение объёма после прибыльных: ' + v.sizeUpAfterWins);
  if (v.offPlan) out.push(plural(v.offPlan, TRADES) + ' по монетам вне брифинга');
  return out;
}

function FactTrade({ t }) {
  const [tag, setTag] = React.useState(t.tag || {});
  const retag = (kind, val) => saveTradeTag({ symbol: t.symbol, closeTime: t.closeTime, [kind]: val })
    .then(() => setTag((x) => ({ ...x, [kind]: val }))).catch((err) => toast(err.message));
  const labels = [];
  if (tag.pattern) labels.push(setupName(tag.pattern));
  if (tag.setup) labels.push('сетап ' + tag.setup);
  labels.push(t.planned ? 'по плану' : 'вне плана');
  if (t.atLevel === true) labels.push('от уровня');
  if (t.revenge) labels.push('отыгрыш');
  if (t.sizeUp) labels.push('увеличение объёма');
  if (t.oversize) labels.push('сверх объёма');
  if (t.afterCrane) labels.push('после стоп-крана');
  if (tag.emotion) labels.push((EMOTIONS.find((e) => e[0] === tag.emotion) || [, tag.emotion])[1]);
  const res = t.result === 'open' ? 'открыта' : (t.pnlNet >= 0 ? '+' : '') + t.pnlNet.toFixed(2);
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
  if (!facts) return <p className="text-sm text-muted-foreground">Подключите Binance API (Account → Integrations), чтобы видеть факты по сделкам.</p>;
  const s = facts.summary, list = flags(facts);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {s.trades
          ? <>{plural(s.trades, TRADES)} · {s.wins} в плюс / {s.losses} в минус{s.winRate != null && ' · ' + s.winRate + '%'} · <span className={s.pnlNet >= 0 ? 'text-bullish' : 'text-danger'}>{(s.pnlNet >= 0 ? '+' : '') + s.pnlNet.toFixed(2)} USDT</span> · комиссии {s.fees.toFixed(2)} · в среднем в сделке {hold(s.avgHoldSec)}</>
          : 'Закрытых сделок нет'}
        {s.open > 0 && <b> · ещё открыто: {s.open}</b>}
      </p>
      {list.length
        ? <div className="flex flex-wrap gap-1.5">{list.map((x) => <Badge key={x} variant="destructive" className="whitespace-normal">{x}</Badge>)}</div>
        : s.trades ? <Badge variant="secondary">По данным нарушений нет</Badge> : null}
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
      toast('Разбор сохранён');
      emit('journal:saved', { kind: 'evening' });
      onClose();
    }).catch((err) => {
      setBusy(false);
      toast(err && err.message && err.message !== 'Failed to fetch' ? err.message : 'Ошибка сети — попробуйте ещё раз');
    });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Вечерний разбор</DialogTitle>
          <DialogDescription>{dmy(today)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <Field label="Факты дня — по вашим сделкам"><Facts facts={facts} /></Field>
          {anyBreak && <Field label="Что стояло за нарушениями выше?"><Textarea rows={2} value={f.whyBreaks} onChange={set('whyBreaks')} /></Field>}
          <Field label="Одно, что сегодня получилось хорошо"><Textarea rows={2} value={f.didWell} onChange={set('didWell')} /></Field>
          <Field label="Одно, что исправить завтра (станет завтрашним правилом «если … то …»)"><Textarea rows={2} value={f.fixTomorrow} onChange={set('fixTomorrow')} /></Field>
          {hadLosses && <Field label="После убытков мой внутренний голос звучал…"><Chips list={SELF_TALK} value={f.selfTalk} onChange={set('selfTalk')} /></Field>}
          <Field label="Упущено в скрининге (монета / почему не отмечена) — необязательно"><Textarea rows={2} value={f.missedScreening} onChange={set('missedScreening')} /></Field>
          <Field label="Состояние в конце дня (1 — без сил, 5 — спокойствие)"><Chips list={SCALE_1_5} value={f.eveningState} onChange={set('eveningState')} /></Field>
          <Field label="Свободные заметки — необязательно"><Textarea rows={2} value={f.freeConclusion} onChange={set('freeConclusion')} /></Field>
        </div>
        <DialogFooter>
          <Button disabled={!ready || busy} onClick={save}>Сохранить разбор</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
