// AI analysis of a coin (catalyst, news) from the full-view chart: runs it if
// there's none yet, shows the result or the error, re-analyze
import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverDescription } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useEvents } from '@/shared/use-event';
import { state } from '../../state.js';
import { effectiveTZ } from '../../utils.js';
import { analyzeCoinBySymbol } from '../../api.js';
import { AnchorBox, keepOpenOn } from './anchor.jsx';

export function AnalysisPopover({ sym, rect, onClose }) {
  useEvents(['card:update']);
  React.useEffect(() => {
    const c = state.analysisCache[sym];
    if (!c || (c.status !== 'loading' && c.status !== 'ok' && c.status !== 'error')) analyzeCoinBySymbol(sym);
  }, [sym]);
  const cache = state.analysisCache[sym];
  const rerun = () => { delete state.analysisCache[sym]; analyzeCoinBySymbol(sym); };
  const r = cache && cache.status === 'ok' ? cache.result : null;
  const ts = cache && cache.timestamp ? new Date(cache.timestamp).toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: effectiveTZ() }) : '';
  const realNews = r && r.news_url && r.news_summary && !r.news_summary.toLowerCase().includes('not found');

  return (
    <Popover open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AnchorBox rect={rect} />
      <PopoverContent align="end" className="grid w-sm max-w-[calc(100vw-1rem)] gap-3" onInteractOutside={keepOpenOn('[data-action="open-analysis"], [data-action="analyze"]')}>
        <PopoverHeader>
          <PopoverTitle>{sym.toUpperCase()} — analysis</PopoverTitle>
          {ts && <PopoverDescription>{ts}</PopoverDescription>}
        </PopoverHeader>
        {!cache || cache.status === 'loading' || (!r && cache.status !== 'error')
          ? <div className="grid gap-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-2/3" /></div>
          : cache.status === 'error'
            ? <p className="text-sm text-danger">{cache.error || 'Error'}</p>
            : (
              <div className="grid gap-2 text-sm">
                <p><b>Catalyst:</b> {r.catalyst}</p>
                {r.news_summary && (
                  <p>
                    {realNews && <a href={r.news_url} target="_blank" rel="noopener" className="mr-1 inline-flex items-center gap-0.5 font-semibold text-brand">News <ExternalLink className="size-3" /></a>}
                    {r.news_summary}
                  </p>
                )}
              </div>
            )}
        <Button variant="outline" disabled={!cache || cache.status === 'loading'} onClick={rerun}>Re-analyze</Button>
      </PopoverContent>
    </Popover>
  );
}
