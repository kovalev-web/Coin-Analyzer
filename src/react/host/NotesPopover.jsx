// Notes on a coin from the full-view chart: write one (Enter saves at the
// current price, Shift+Enter — new line), all of the coin's notes newest first
// with delete, and whether the bubbles show on the chart. A first note also
// puts the coin into today's briefing (openFVNote passes addToBriefing).
import * as React from 'react';
import { X } from 'lucide-react';
import { Popover, PopoverContent } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useEvents } from '@/shared/use-event';
import { state } from '../../state.js';
import { tzDateStr, tzTimeStr } from '../../utils.js';
import { addCoinNote, deleteCoinNote } from '../../api.js';
import { ensureCoinNotes, notesFor, notesOnChart, setNotesOnChart } from '../../coin-notes.js';
import { isInBriefing, toggleBriefing } from '../../ui.js';
import { toast } from '../../react-bridge.js';
import { AnchorBox, keepOpenOn } from './anchor.jsx';

function currentPrice(sym) {
  try {
    const last = window.__fvSeries && window.__fvSeries.dataByIndex(1e9, -1);
    if (last && last.close > 0) return last.close;
  } catch (e) {}
  const coin = (state.coins || []).find((c) => c.symbol === sym);
  return coin && coin.current_price > 0 ? coin.current_price : null;
}

export function NotesPopover({ sym, rect, addToBriefing, onClose }) {
  useEvents(['coin-notes:updated']);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [show, setShow] = React.useState(notesOnChart);
  React.useEffect(() => { ensureCoinNotes(sym); }, [sym]);
  const list = notesFor(sym).slice().reverse();

  const save = () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    addCoinNote(sym, t, currentPrice(sym)).then(() => {
      setText('');
      if (addToBriefing && !isInBriefing(sym)) toggleBriefing(sym);
    }).catch((err) => toast(err.message)).finally(() => setBusy(false));
  };

  return (
    <Popover open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AnchorBox rect={rect} />
      <PopoverContent align="center" className="grid w-sm max-w-[calc(100vw-1rem)] gap-3" onInteractOutside={keepOpenOn('[data-action="fv-note"]')}>
        <div className="flex items-center justify-between">
          <Label htmlFor="notes-on-chart" className="text-xs font-normal text-muted-foreground">Show notes on chart</Label>
          <Switch id="notes-on-chart" checked={show} onCheckedChange={(v) => { setShow(v); setNotesOnChart(v); }} />
        </div>
        <Textarea autoFocus rows={2} value={text} disabled={busy} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } }}
          placeholder="What do you see? Enter saves, Shift+Enter new line" />
        {list.length > 0 && (
          <>
            <Separator />
            <div className="grid max-h-60 gap-1 overflow-y-auto overscroll-contain">
              {list.map((n) => {
                const d = new Date(n.ts);
                const day = tzDateStr(d) === tzDateStr() ? '' : tzDateStr(d).slice(5).replace('-', '.') + ' ';
                return (
                  <div key={n.id} className="group flex items-start gap-2 text-xs">
                    <span className="shrink-0 pt-0.5 text-muted-foreground tabular-nums">{day + tzTimeStr(d)}</span>
                    <span className="flex-1 pt-0.5 whitespace-pre-wrap">{n.text}</span>
                    <Button variant="ghost" size="icon-xs" className="text-muted-foreground opacity-0 group-hover:opacity-100 max-sm:opacity-100" aria-label="Delete"
                      onClick={() => deleteCoinNote(sym, Number(n.id)).catch(() => {})}><X /></Button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
