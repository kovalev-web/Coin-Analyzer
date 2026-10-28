// Security: change email (identity → new email → code), password (change, or
// a reset link when the account has none), sign out other devices, delete account
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { API_BASE } from '../../../api.js';
import { getUserEmail, setUserEmail } from '../../../ui.js';
import { Code, FieldRow, Msg, SettingRow, accountPost } from './parts.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function EmailRow({ account, tgConnected }) {
  const [email, setEmail] = React.useState(getUserEmail() || '');
  // 0 closed, 1 verify identity, 2 new email, 3 code from the new address
  const [step, setStep] = React.useState(account.pendingEmailChange ? 3 : 0);
  const [pending, setPending] = React.useState(account.pendingEmailChange || null);
  const [f, setF] = React.useState({ password: '', tgCode: '', e1: '', e2: '', code: '' });
  const [tgSent, setTgSent] = React.useState(false);
  const [err, setErr] = React.useState({});
  const [msg, setMsg] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? v.target.value : v }));
  const go = (n) => { setStep(n); setErr({}); };
  const call = (body, ok, errKey) => {
    setBusy(true); setErr({});
    accountPost(body).then((d) => { if (d.ok) ok(d); else setErr({ [errKey]: d.error || 'Error' }); })
      .catch(() => setErr({ [errKey]: 'Network error' })).finally(() => setBusy(false));
  };

  const sendTg = () => call({ action: 'email-change-send-tg-code' }, () => setTgSent(true), 's1');
  const verify = () => {
    if (!f.password && !f.tgCode.trim()) { setErr({ s1: 'Enter password or code' }); return; }
    const body = { action: 'email-change-verify-identity' };
    if (f.password) body.password = f.password;
    if (f.tgCode.trim()) body.tgCode = f.tgCode.trim();
    call(body, () => go(2), 's1');
  };
  const request = () => {
    const e1 = f.e1.trim().toLowerCase(), e2 = f.e2.trim().toLowerCase();
    if (!e1 || !EMAIL_RE.test(e1)) { setErr({ e1: 'Enter a valid email' }); return; }
    if (e1 !== e2) { setErr({ e2: 'Emails do not match' }); return; }
    if (e1 === email.toLowerCase()) { setErr({ e1: 'This is already your email' }); return; }
    call({ action: 'email-change-request', newEmail: e1 }, () => { setPending(e1); go(3); }, 'e2');
  };
  const confirm = () => {
    if (f.code.trim().length < 6) { setErr({ s3: 'Enter the 6-digit code' }); return; }
    call({ action: 'email-change-confirm', code: f.code.trim() }, (d) => {
      setUserEmail(d.newEmail); setEmail(d.newEmail); go(0); setMsg({ text: 'Email changed successfully', ok: true });
    }, 's3');
  };

  return (
    <SettingRow label="Email" value={email} open={step > 0}
      action={<Button variant="ghost" size="sm" onClick={() => { setMsg(null); if (step) go(0); else { setF({ password: '', tgCode: '', e1: '', e2: '', code: '' }); setTgSent(false); go(1); } }}>{step ? 'Cancel' : 'Change'}</Button>}>
      {step === 1 && (account.hasPassword
        ? <>
            <FieldRow error={err.s1}><Input type="password" placeholder="Current password" autoComplete="current-password" value={f.password} onChange={set('password')} /></FieldRow>
            <div><Button disabled={busy} onClick={verify}>Continue</Button></div>
          </>
        : tgConnected
          ? <>
              <div><Button variant="outline" disabled={busy} onClick={sendTg}>{tgSent ? 'Send again' : 'Get code via Telegram'}</Button></div>
              {tgSent && <FieldRow label="Telegram code"><Code value={f.tgCode} onChange={set('tgCode')} autoFocus /></FieldRow>}
              <Msg msg={err.s1 && { text: err.s1 }} />
              {tgSent && <div><Button disabled={busy} onClick={verify}>Continue</Button></div>}
            </>
          : <p className="text-sm text-muted-foreground">To change email, connect Telegram in the Integrations tab</p>)}
      {step === 2 && <>
        <FieldRow error={err.e1}><Input type="email" placeholder="New email" autoComplete="off" value={f.e1} onChange={set('e1')} autoFocus /></FieldRow>
        <FieldRow error={err.e2}><Input type="email" placeholder="Confirm new email" autoComplete="off" value={f.e2} onChange={set('e2')} onPaste={(e) => e.preventDefault()} /></FieldRow>
        <div><Button disabled={busy} onClick={request}>Send code</Button></div>
      </>}
      {step === 3 && <>
        <p className="text-sm text-muted-foreground">Code sent to {pending}. A cancellation link was sent to {email || 'your old address'}.</p>
        <FieldRow error={err.s3}><Code value={f.code} onChange={set('code')} autoFocus /></FieldRow>
        <div><Button disabled={busy} onClick={confirm}>Confirm</Button></div>
      </>}
      <Msg msg={msg} />
    </SettingRow>
  );
}

function PasswordRow({ account }) {
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState({ cur: '', nw: '', cfm: '' });
  const [err, setErr] = React.useState({});
  const [msg, setMsg] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [cooldown, setCooldown] = React.useState(0);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  React.useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (!account.hasPassword) {
    const email = getUserEmail();
    const send = () => {
      setBusy(true); setMsg(null);
      fetch(API_BASE + '/auth/request-password-reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ email, redirectTo: 'https://questtick.com/reset-password' }),
      }).then((r) => {
        if (r.ok) { setMsg({ text: 'If this address is registered, we sent a link to ' + email, ok: true }); setCooldown(60); }
        else setMsg({ text: 'Error, please try again' });
      }).catch(() => setMsg({ text: 'Network error' })).finally(() => setBusy(false));
    };
    return (
      <div className="grid gap-2 py-2">
        <div><Button variant="outline" disabled={busy || cooldown > 0} onClick={send}>{cooldown ? 'Resend in ' + cooldown + 's' : 'Send password reset link'}</Button></div>
        <Msg msg={msg} />
      </div>
    );
  }

  const submit = () => {
    if (!f.cur) { setErr({ cur: 'Enter current password' }); return; }
    if (f.nw.length < 8) { setErr({ nw: 'New password must be at least 8 characters' }); return; }
    if (f.nw !== f.cfm) { setErr({ cfm: 'Passwords do not match' }); return; }
    setErr({}); setBusy(true);
    fetch(API_BASE + '/auth/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ currentPassword: f.cur, newPassword: f.nw, revokeOtherSessions: false }),
    }).then((r) => r.json().catch(() => ({})).then((d) => {
      if (r.ok) { setOpen(false); setF({ cur: '', nw: '', cfm: '' }); setMsg({ text: 'Password changed', ok: true }); }
      else setErr({ cur: (d && d.message) || 'Error' });
    })).catch(() => setErr({ cur: 'Network error' })).finally(() => setBusy(false));
  };
  return (
    <>
      <SettingRow label="Password" value="••••••••" open={open}
        action={<Button variant="ghost" size="sm" onClick={() => { setOpen(!open); setErr({}); setMsg(null); }}>{open ? 'Cancel' : 'Change'}</Button>}>
        <FieldRow error={err.cur}><Input type="password" placeholder="Current password" autoComplete="current-password" value={f.cur} onChange={set('cur')} /></FieldRow>
        <FieldRow error={err.nw}><Input type="password" placeholder="New password (min. 8 characters)" autoComplete="new-password" value={f.nw} onChange={set('nw')} /></FieldRow>
        <FieldRow error={err.cfm}><Input type="password" placeholder="Confirm new password" autoComplete="new-password" value={f.cfm} onChange={set('cfm')} /></FieldRow>
        <div><Button disabled={busy} onClick={submit}>Save</Button></div>
      </SettingRow>
      <Msg msg={msg} />
    </>
  );
}

function OtherDevices() {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const revoke = () => {
    setBusy(true); setMsg(null);
    fetch(API_BASE + '/auth/revoke-other-sessions', { method: 'POST', credentials: 'include' })
      .then((r) => { if (!r.ok) throw new Error(); setMsg({ text: 'Done — all other devices signed out', ok: true }); })
      .catch(() => setMsg({ text: 'Error, please try again' })).finally(() => setBusy(false));
  };
  return (
    <div className="grid gap-2">
      <Button variant="outline" disabled={busy} onClick={revoke}>Sign out other devices</Button>
      <Msg msg={msg} />
    </div>
  );
}

// Type "delete account" to confirm
function DeleteAccount() {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const del = () => {
    setBusy(true);
    fetch(API_BASE + '/auth/delete-user', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => { if (r.ok) window.location.replace('/login'); else setBusy(false); })
      .catch(() => setBusy(false));
  };
  return (
    <>
      <Button variant="ghost" className="text-danger" onClick={() => { setText(''); setOpen(true); }}>Delete account</Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete account?</AlertDialogTitle>
            <AlertDialogDescription>This can't be undone. Type "delete account" to confirm:</AlertDialogDescription>
          </AlertDialogHeader>
          <Input placeholder="delete account" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={busy || text.toLowerCase() !== 'delete account'} onClick={del}>Delete account</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function SecurityTab({ account, tgConnected }) {
  return (
    <div className="grid gap-1">
      <EmailRow account={account} tgConnected={tgConnected} />
      <PasswordRow account={account} />
      <Separator className="my-3" />
      <OtherDevices />
      <Separator className="my-3" />
      <DeleteAccount />
    </div>
  );
}
