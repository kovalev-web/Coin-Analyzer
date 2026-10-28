// AI summary for the week / month: shows the saved text at once, refreshes
// quietly (the server skips the model when trades haven't changed)
import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { state } from '../../state.js';
import { generateJournalAiSummary, loadJournalAiSummaryCache, deleteJournalAiSummary } from '../../api.js';
import { effectiveTZ } from '../../utils.js';

// The summary's markdown subset: **bold**, "# " headings, "* " / "- " bullets
function inline(s) {
  return s.split(/(\*\*.+?\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
}
function Markdown({ text }) {
  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push(<ul key={out.length} className="ml-5 list-disc space-y-1">{list}</ul>); list = null; } };
  (text || '').replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t) { flush(); return; }
    const h = t.match(/^#{1,6}\s+(.*)/);
    if (h) { flush(); out.push(<h3 key={'h' + i} className="mt-4 font-semibold">{inline(h[1])}</h3>); return; }
    const b = line.match(/^(\s*)[*-]\s+(.*)/);
    if (b) { (list = list || []).push(<li key={i} className={b[1].length >= 2 ? 'ml-4' : ''}>{inline(b[2])}</li>); return; }
    flush();
    out.push(<p key={'p' + i}>{inline(t)}</p>);
  });
  flush();
  return <div className="space-y-2 text-sm leading-relaxed">{out}</div>;
}

function current(range) {
  return state.aiSummary && state.aiSummaryRange === range ? { text: state.aiSummary, date: state.aiSummaryDate } : null;
}

export function AiDialog({ open, onOpenChange, range }) {
  const [data, setData] = React.useState(() => current(range));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const run = React.useCallback((force) => {
    setBusy(true); setError('');
    generateJournalAiSummary(range, force)
      .then(() => setData(current(range)))
      .catch(() => setError('Не получилось сделать сводку — попробуй ещё раз'))
      .finally(() => setBusy(false));
  }, [range]);

  React.useEffect(() => {
    if (!open) return;
    if (!current(range)) loadJournalAiSummaryCache(range);
    setData(current(range));
    run(false);
  }, [open, range, run]);

  const date = data && data.date ? new Date(data.date).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: effectiveTZ() }) : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI-сводка — {range === '1w' ? 'неделя' : 'месяц'}</DialogTitle>
          <DialogDescription>{date ? 'Обновлено ' + date : 'Разбор сделок за период'}</DialogDescription>
        </DialogHeader>
        {data && data.text
          ? <Markdown text={data.text} />
          : busy
            ? <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
            : <p className="text-sm text-muted-foreground">{error || 'Сводки пока нет'}</p>}
        {data && error && <p className="text-sm text-danger">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={!data} onClick={() => { deleteJournalAiSummary(range); setData(null); onOpenChange(false); }}>Удалить</Button>
          <Button disabled={busy} onClick={() => run(true)}>{busy ? 'Готовлю…' : 'Сделать заново'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
