// Notifications under the bell: newest first, open the coin / the weekly
// report / the morning card, enable desktop alerts, clear all
import * as React from 'react';
import { ArrowRight, Bell, FileText, TrendingUp } from 'lucide-react';
import { Popover, PopoverContent, PopoverHeader, PopoverTitle } from '@/components/ui/popover';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useEvents } from '@/shared/use-event';
import { state } from '../../state.js';
import { tzDateStr } from '../../utils.js';
import { markNotificationAsRead, clearNotifications, requestDesktopNotifPermission, openCoinFullView } from '../../ui.js';
import { fetchNATR } from '../../api.js';
import { openSurface } from '../../react-bridge.js';
import { openMorningJournal } from '../../journal-cards.js';
import { AnchorBox, keepOpenOn } from './anchor.jsx';

function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
}

const ICON = { listing: TrendingUp, alert: Bell };

export function NotificationsPopover({ rect, onClose }) {
  useEvents(['notifications:updated', 'journal:saved']);
  const [, redraw] = React.useReducer((x) => x + 1, 0);
  const items = state.notifications || [];
  const canEnable = window.Notification && Notification.permission === 'default';

  // What the arrow on a row opens (nothing → no arrow)
  const actionFor = (n) => {
    if (n.sym) return () => { openCoinFullView(n.sym); if (!state.natrData[n.sym] || state.natrData[n.sym] === 'error') fetchNATR(n.sym); };
    if (n.type === 'weekly_report' && n.report) return () => openSurface('weekly', { report: n.report });
    if (n.type === 'journal_reminder' && tzDateStr(new Date(n.createdAt)) === tzDateStr()
      && !(state.journalToday && (state.journalToday.morningAt || state.journalToday.skipped))) return () => openMorningJournal();
    return null;
  };

  return (
    <Popover open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AnchorBox rect={rect} />
      <PopoverContent align="end" className="flex max-h-[70vh] w-sm max-w-screen flex-col gap-0 p-0" onInteractOutside={keepOpenOn('[data-action="toggle-notif"]')}>
        <PopoverHeader className="px-4 py-3"><PopoverTitle>Notifications</PopoverTitle></PopoverHeader>
        {canEnable && (
          <Item variant="muted" size="sm" className="mx-3 mb-2">
            <ItemContent><ItemDescription className="text-foreground">Get alerts even when this tab isn't active</ItemDescription></ItemContent>
            <ItemActions><Button size="sm" variant="outline" onClick={() => requestDesktopNotifPermission().then(redraw)}>Enable</Button></ItemActions>
          </Item>
        )}
        <Separator />
        {!items.length
          ? <Empty className="p-6"><EmptyHeader><EmptyDescription>No notifications yet</EmptyDescription></EmptyHeader></Empty>
          : (
            <ItemGroup className="overflow-y-auto overscroll-contain p-1">
              {items.map((n) => {
                const Icon = ICON[n.type] || FileText;
                const act = actionFor(n);
                return (
                  <Item key={n.id} size="sm" className="px-3 py-2">
                    <ItemMedia variant="icon"><Icon /></ItemMedia>
                    <ItemContent>
                      <ItemTitle className="font-normal">
                        {n.message}
                        {!n.read && <span className="size-2 shrink-0 rounded-full bg-danger" aria-label="unread" />}
                      </ItemTitle>
                      <ItemDescription className="text-xs">{ago(n.createdAt)}</ItemDescription>
                    </ItemContent>
                    {act && (
                      <ItemActions>
                        <Button variant="ghost" size="icon-sm" aria-label="Open" onClick={() => { markNotificationAsRead(n.id); onClose(); act(); }}><ArrowRight /></Button>
                      </ItemActions>
                    )}
                  </Item>
                );
              })}
            </ItemGroup>
          )}
        {items.length > 0 && (
          <>
            <Separator />
            <div className="p-2"><Button variant="ghost" size="sm" className="w-full" onClick={clearNotifications}>Clear all</Button></div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
