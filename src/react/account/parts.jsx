// Building blocks of the account dialog: a settings row with its action, an
// editor that opens under it, form messages, the account API
import * as React from 'react';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { API_BASE } from '../../api.js';

// POST /api/account { action, … } → JSON (throws with the server's message)
export function accountPost(body) {
  return fetch(API_BASE + '/api/account', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify(body),
  }).then((r) => r.json().catch(() => ({})).then((d) => { if (!r.ok && !d.error) d.error = 'Server error'; return d; }));
}

export function accountGet() {
  return fetch(API_BASE + '/api/account', { credentials: 'include' }).then((r) => r.json());
}

// label / value on the left, action(s) on the right; children open below
export function SettingRow({ label, value, action, open, children }) {
  return (
    <Collapsible open={!!open}>
      <Item size="sm" className="px-0">
        <ItemContent>
          <ItemTitle className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</ItemTitle>
          {value != null && value !== '' && <ItemDescription className="line-clamp-none text-sm text-foreground">{value}</ItemDescription>}
        </ItemContent>
        {action && <ItemActions>{action}</ItemActions>}
      </Item>
      {children && <CollapsibleContent className="grid gap-3 pb-4">{children}</CollapsibleContent>}
    </Collapsible>
  );
}

export function FieldRow({ label, error, children }) {
  return (
    <div className="grid gap-1.5">
      {label && <Label>{label}</Label>}
      {children}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

// { text, ok } → a line under a form
export function Msg({ msg }) {
  if (!msg || !msg.text) return null;
  return <p className={'text-sm ' + (msg.ok ? 'text-bullish' : 'text-danger')}>{msg.text}</p>;
}

// 6-digit codes (email, Telegram, authenticator)
export function Code({ value, onChange, autoFocus }) {
  return (
    <InputOTP maxLength={6} value={value} onChange={onChange} autoFocus={autoFocus} inputMode="numeric" autoComplete="one-time-code">
      <InputOTPGroup>{[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} />)}</InputOTPGroup>
    </InputOTP>
  );
}
