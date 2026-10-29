// Two bars under the order book's header (React islands from terminal.js):
//  - TermLock: why new entries are closed — the day gate (morning card not
//    filled / evening already done), 2FA not set up for live, or locked (enter
//    the authenticator code; a full code unlocks), or unlocked until HH:MM
//    with Lock. Cancels, kill and reduce-only always work (the trader enforces it).
//  - TermTag: after a trade closes — its setup (required), quality A/B/C and
//    emotion (optional); the row stays until ОК, × skips it.
// State and actions: termLock / termUnlock / termLockNow, termTag / termTagSet /
// termTagDone / termTagSkip in terminal.js; redraws on 'term:lock' / 'term:tag'.
import * as React from 'react';
import { Lock, LockOpen, ShieldAlert, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useEvents } from '@/shared/use-event';
import { termLock, termLockNow, termUnlock, termTag, termTagDone, termTagSet, termTagSkip } from '../../terminal.js';

const hhmm = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

export function TermLock() {
  useEvents(['term:lock']);
  const l = termLock();
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (l.state !== 'locked') setCode(''); }, [l.state]);
  if (l.state === 'none') return null;

  const unlock = (c) => {
    if (busy) return;
    setBusy(true);
    termUnlock(c).then((ok) => { if (!ok) setCode(''); }).finally(() => setBusy(false));
  };

  if (l.state === 'day' || l.state === 'setup') {
    return (
      <div className="jr px-2 pt-1.5">
        <Alert className="border-level/40 bg-level/10 px-3 py-1.5">
          <ShieldAlert className="text-level" />
          <AlertDescription className="text-xs text-foreground">
            {l.state === 'day' ? l.reason : 'Set up 2FA in Account → Integrations to trade live'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (l.state === 'open') {
    return (
      <div className="jr flex items-center gap-2 px-3 pt-1.5 text-xs text-bullish">
        <LockOpen className="size-3.5" /> Unlocked until {hhmm(l.unlockedUntil)}
        <Button variant="outline" size="xs" className="ml-auto" onClick={() => termLockNow()}><Lock /> Lock</Button>
      </div>
    );
  }
  // locked: the code from the authenticator; a full 6 digits (or Enter) unlocks
  return (
    <div className="jr flex flex-wrap items-center gap-2 px-3 pt-1.5 text-xs">
      <span className="flex items-center gap-1 font-medium text-danger"><Lock className="size-3.5" /> Locked</span>
      <InputOTP id="dom-unlock-code" maxLength={6} value={code} disabled={busy} inputMode="numeric" autoComplete="one-time-code"
        onChange={setCode} onComplete={unlock}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); unlock(code); } }}>
        <InputOTPGroup>{[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} className="size-7 text-xs" />)}</InputOTPGroup>
      </InputOTP>
      <Button size="xs" disabled={busy || code.length < 6} onClick={() => unlock(code)}>Unlock</Button>
    </div>
  );
}

function Pick({ list, value, kind, diagrams }) {
  return (
    <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={value || ''} className="flex-wrap"
      onValueChange={(v) => { if (v) termTagSet(kind, v); }}>
      {list.map(([k, label]) => (
        <ToggleGroupItem key={k} value={k} {...(diagrams ? { 'data-setup-diagram': k } : {})}
          className="h-6 px-2 text-2xs data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">{label}</ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function TermTag() {
  useEvents(['term:tag', 'setups:updated']);
  const q = termTag();
  if (!q) return null;
  const coin = q.symbol.replace(/USDT$/, '');
  return (
    <div className="jr grid gap-1.5 border-b px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <b>{coin}</b>
        <span className="text-muted-foreground">{q.pattern ? '— сетап сохранён, дополни и нажми ОК' : 'closed — какой сетап?'}</span>
        <span className="ml-auto flex items-center gap-1">
          {q.pattern && <Button size="xs" onClick={termTagDone}>ОК</Button>}
          <Button variant="ghost" size="icon-xs" aria-label="Skip" onClick={termTagSkip}><X /></Button>
        </span>
      </div>
      <Pick list={q.patterns} value={q.pattern} kind="pattern" diagrams />
      <div className="flex flex-wrap gap-1.5">
        <Pick list={q.setups.map((x) => [x, x])} value={q.setup} kind="setup" />
        <Pick list={q.emotions} value={q.emotion} kind="emotion" />
      </div>
    </div>
  );
}
