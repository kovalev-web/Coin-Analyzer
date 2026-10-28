// Journal page (#/journal) top to bottom: one period for the whole page →
// cumulative PnL with the period's totals → "Мой edge" (execution, setups,
// conclusions) → the day table. The period lives in state.journalPeriod.
import * as React from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { state } from '../state.js';
import { fetchJournalEdge, fetchJournalSummary, fetchJournalToday } from '../api.js';
import { ensureSetups } from '../setups.js';
import { Header } from './Header.jsx';
import { PnlChart } from './PnlChart.jsx';
import { EdgeSummary } from './EdgeSummary.jsx';
import { DayTable } from './DayTable.jsx';
import { JOURNAL_START, shortDate } from './format.js';

function period() { return state.journalPeriod || (state.journalPeriod = { range: 'all' }); }

function Empty({ children }) {
  return <Card><CardContent className="text-sm text-muted-foreground">{children}</CardContent></Card>;
}

export function JournalPage() {
  const [p, setP] = React.useState(period);
  const [summary, setSummary] = React.useState(null);
  const [edge, setEdge] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const refresh = React.useRef(null);

  // The report again (after re-tagging: once you pause; after setup edits: now)
  const loadEdge = React.useCallback(() => {
    return Promise.all([fetchJournalEdge(period()), ensureSetups()]).then(([e]) => setEdge(e));
  }, []);

  React.useEffect(() => {
    if (state.isDemoMode) { setLoading(false); return; }
    let live = true;
    setLoading(true);
    setSummary(null);
    Promise.all([
      fetchJournalSummary(p).then((s) => { if (live) setSummary(s); }),
      Promise.all([fetchJournalEdge(p), ensureSetups()]).then(([e]) => { if (live) setEdge(e); }),
    ]).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [p]);

  React.useEffect(() => { fetchJournalToday(); return () => clearTimeout(refresh.current); }, []);

  const onPeriod = (next) => { state.journalPeriod = next; setP(next); };
  const onRetag = () => { clearTimeout(refresh.current); refresh.current = setTimeout(loadEdge, 2500); };
  const aiRange = p.range === 'week' ? '1w' : p.range === 'month' ? '1m' : null;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="jr mx-auto w-full max-w-6xl space-y-4 px-4 py-6">
        <Header period={p} onPeriod={onPeriod} aiRange={aiRange} />
        {state.isDemoMode
          ? <Empty><a href="/login" className="font-medium text-brand underline-offset-4 hover:underline">Зарегистрируйся</a> и подключи Binance API, чтобы видеть свои сделки.</Empty>
          : <>
              <PnlChart summary={summary} loading={loading && !summary} />
              {loading && !edge
                ? <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-48" /><Skeleton className="h-48" /></div>
                : !edge || !edge.total || !edge.total.n
                  ? <Empty>
                      {edge && edge.period ? 'За ' + shortDate(edge.period.from) + ' — ' + shortDate(edge.period.to) + ' сделок нет. ' : ''}
                      Журнал считается с {shortDate(JOURNAL_START)}. Отмечай сетап в стакане сразу после выхода — что не успел, отметишь в таблице по дням.
                    </Empty>
                  : <>
                      <EdgeSummary e={edge} onChanged={loadEdge} />
                      <DayTable days={edge.byDay} onRetag={onRetag} />
                    </>}
            </>}
      </div>
    </TooltipProvider>
  );
}
