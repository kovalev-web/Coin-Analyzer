// Main screen when there are no cards: loading, an error, waiting for the
// server, or nothing matches the filter (render() in ui.js picks the kind).
// And the demo-mode banner at the bottom (injectDemoBanner), and the 404 page.
import * as React from 'react';
import { CircleAlert, SearchX } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';

export function HomeState({ kind, text }) {
  if (kind === 'error') {
    return (
      <div className="jr px-8 pt-4 max-sm:px-3">
        <Alert variant="destructive"><CircleAlert /><AlertDescription>{text}</AlertDescription></Alert>
      </div>
    );
  }
  return (
    <div className={'jr ' + (kind === 'loading' ? 'flex min-h-[calc(100vh-64px)] items-center' : '')}>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{kind === 'empty' ? <SearchX /> : <Spinner />}</EmptyMedia>
          <EmptyDescription>{text}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

export function DemoBanner() {
  return (
    <div className="jr fixed inset-x-0 bottom-0 z-300 flex h-9 items-center justify-center gap-4 bg-brand px-8 text-xs font-medium text-white animate-in slide-in-from-bottom">
      <span className="max-sm:hidden">Sync watchlist · Price alerts · Track PnL · Journal · AI analysis</span>
      <Button asChild size="xs" variant="secondary"><a href="/login">Sign up free →</a></Button>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="jr flex min-h-[70vh] items-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><SearchX /></EmptyMedia>
          <EmptyTitle>404 — Page not found</EmptyTitle>
          <EmptyDescription>There's nothing at this address.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Button asChild><a href="/">← Back to home</a></Button></EmptyContent>
      </Empty>
    </div>
  );
}
