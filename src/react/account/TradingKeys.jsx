// Trading API keys (trading account only — shown when the trader status check
// succeeds). Separate from the read-only journal key: these keys can trade.
// They go to the trader process (encrypted at rest) and never come back — the
// page sees a masked key. Saving / deleting needs the account password (+ the
// 2FA code when 2FA is on). Key management goes over HTTP, never the socket.
import * as React from 'react';
import qrcode from 'qrcode-generator';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Item, ItemContent, ItemDescription } from '@/components/ui/item';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { tradeRequest } from '../../api.js';
import { checkAccess } from '../../terminal.js';
import { Code, FieldRow, Msg, SettingRow } from './parts.jsx';

const ENV_LABEL = { testnet: 'Testnet', mainnet: 'Live' };
const post = (action, body) => tradeRequest('POST_HTTP', action, body);
const SIX = /^\d{6}$/;

function Note({ children }) {
  return <Item variant="muted" size="sm"><ItemContent><ItemDescription className="line-clamp-none text-xs">{children}</ItemDescription></ItemContent></Item>;
}

// Add / change a key
function KeyForm({ env: env0, twoFA, publicIp, onSaved, onCancel }) {
  const [f, setF] = React.useState({ env: env0, apiKey: '', apiSecret: '', password: '', code: '' });
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? v.target.value : v }));
  const save = () => {
    const body = { env: f.env, apiKey: f.apiKey.trim(), apiSecret: f.apiSecret.trim(), password: f.password, code: f.code.trim() };
    if (!body.apiKey || !body.apiSecret) { setErr('Enter API key and Secret key'); return; }
    if (!body.password) { setErr('Enter your account password'); return; }
    if (twoFA && !SIX.test(body.code)) { setErr('Enter the 6-digit code from your authenticator'); return; }
    setErr(''); setBusy(true);
    post('keys', body).then(onSaved).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="grid gap-3 pb-4">
      <Note>
        <b className="text-foreground">Trade-enabled key</b> from your Tiger.com Broker cabinet (Binance tab): Read + Trade, no withdrawals.{' '}
        {publicIp ? 'For Live, restrict the key to IP ' + publicIp + '.' : 'For Live, restrict the key to the trading server IP.'}{' '}
        The key is encrypted on the trading server and is never shown again.
      </Note>
      <FieldRow label="Environment">
        <Select value={f.env} onValueChange={set('env')}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="testnet">Testnet</SelectItem><SelectItem value="mainnet">Live</SelectItem></SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label="API Key"><Input placeholder="Paste API key..." autoComplete="off" value={f.apiKey} onChange={set('apiKey')} /></FieldRow>
      <FieldRow label="Secret Key"><Input type="password" placeholder="Paste Secret key..." autoComplete="off" value={f.apiSecret} onChange={set('apiSecret')} /></FieldRow>
      <FieldRow label="Account password"><Input type="password" placeholder="Your QuestTick password" autoComplete="current-password" value={f.password} onChange={set('password')} /></FieldRow>
      {twoFA && <FieldRow label="2FA code"><Code value={f.code} onChange={set('code')} /></FieldRow>}
      <Msg msg={err && { text: err }} />
      <div className="flex gap-2">
        <Button disabled={busy} onClick={save}>Check and save</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// Delete a key: password (+ code) in a dialog
function DeleteKey({ env, twoFA, onDeleted, onClose }) {
  const [pw, setPw] = React.useState('');
  const [code, setCode] = React.useState('');
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const go = () => {
    if (!pw) { setErr('Enter your account password'); return; }
    if (twoFA && !SIX.test(code)) { setErr('Enter the 6-digit 2FA code'); return; }
    setBusy(true); setErr('');
    post('keys/delete', { env, password: pw, code: twoFA ? code : undefined })
      .then((d) => { onDeleted(d); onClose(); }).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete the {ENV_LABEL[env]} trading key?</DialogTitle>
          <DialogDescription>Enter your account password to confirm.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <FieldRow label="Account password"><Input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></FieldRow>
          {twoFA && <FieldRow label="2FA code"><Code value={code} onChange={setCode} /></FieldRow>}
          <Msg msg={err && { text: err }} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={go}>Delete key</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 2FA: set up (password → QR + code) or turn off (password + code)
function TwoFA({ st, onChange }) {
  const [step, setStep] = React.useState(null); // 'pw' | 'qr' | 'off'
  const [pw, setPw] = React.useState('');
  const [code, setCode] = React.useState('');
  const [setup, setSetup] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const reset = (s) => { setStep(s); setPw(''); setCode(''); setErr(''); setSetup(null); };
  const run = (p, then) => { setBusy(true); setErr(''); p.then(then).catch((e) => setErr(e.message)).finally(() => setBusy(false)); };

  const qrSvg = React.useMemo(() => {
    if (!setup) return '';
    const qr = qrcode(0, 'M'); qr.addData(setup.uri); qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [setup]);

  return (
    <SettingRow label="2FA for trading" open={!!step}
      value={st.enabled ? 'On' : st.required ? 'Off — required for live trading' : 'Off'}
      action={step
        ? <Button variant="ghost" size="sm" onClick={() => reset(null)}>Cancel</Button>
        : <Button variant="ghost" size="sm" onClick={() => reset(st.enabled ? 'off' : 'pw')}>{st.enabled ? 'Turn off' : 'Set up'}</Button>}>
      {step === 'pw' && <>
        <FieldRow label="Account password"><Input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></FieldRow>
        <Msg msg={err && { text: err }} />
        <div><Button disabled={busy} onClick={() => { if (!pw) { setErr('Enter your account password'); return; } run(post('2fa/setup', { password: pw }), (s) => { setSetup(s); setStep('qr'); }); }}>Continue</Button></div>
      </>}
      {step === 'qr' && setup && <>
        <Note>Scan with Google Authenticator (or any TOTP app), then enter the 6-digit code it shows.</Note>
        <div className="w-44 rounded-md bg-white p-2" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        <p className="text-xs text-muted-foreground">Can't scan? Enter this key: <code className="font-mono text-foreground">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code></p>
        <FieldRow label="Code"><Code value={code} onChange={setCode} autoFocus /></FieldRow>
        <Msg msg={err && { text: err }} />
        <div><Button disabled={busy} onClick={() => { if (!SIX.test(code)) { setErr('Enter the 6-digit code'); return; } run(post('2fa/confirm', { code }), (s) => { reset(null); onChange(s); }); }}>Turn on</Button></div>
      </>}
      {step === 'off' && <>
        <Note>Turning 2FA off removes the code check before trading. Live trading stays blocked without it.</Note>
        <FieldRow label="Account password"><Input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></FieldRow>
        <FieldRow label="2FA code"><Code value={code} onChange={setCode} /></FieldRow>
        <Msg msg={err && { text: err }} />
        <div><Button variant="destructive" disabled={busy} onClick={() => { if (!pw || !SIX.test(code)) { setErr('Enter your password and the 6-digit code'); return; } run(post('2fa/disable', { password: pw, code }), (s) => { reset(null); onChange(s); }); }}>Turn off</Button></div>
      </>}
    </SettingRow>
  );
}

export function TradingKeys() {
  const [status, setStatus] = React.useState(null);
  const [keys, setKeys] = React.useState(null);
  const [keysErr, setKeysErr] = React.useState('');
  const [twoFA, setTwoFA] = React.useState({ enabled: false });
  const [form, setForm] = React.useState(null);     // env being edited
  const [deleting, setDeleting] = React.useState(null);

  React.useEffect(() => {
    let live = true;
    checkAccess().then((s) => {
      if (!s || !live) return;
      setStatus(s);
      tradeRequest('GET', 'keys').then((d) => live && setKeys(d)).catch((e) => live && setKeysErr(e.message));
      tradeRequest('GET', '2fa').then((d) => live && setTwoFA(d || { enabled: false })).catch(() => {});
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!status) return null;
  return (
    <>
      <Separator className="my-2" />
      <SettingRow label="Trading API" value={keys ? 'Active: ' + ENV_LABEL[keys.activeEnv] : ''} />
      {keysErr && <Msg msg={{ text: keysErr }} />}
      {keys && ['testnet', 'mainnet'].map((env) => {
        const k = keys.keys[env];
        return (
          <SettingRow key={env} label={ENV_LABEL[env] + (env === keys.activeEnv ? ' · active' : '')} open={form === env}
            value={k
              ? <span className="grid gap-1">
                  <span>{k.apiKey}{k.savedAt ? ' · ' + new Date(k.savedAt).toLocaleDateString() : ''}{k.source === 'config' ? ' · server config' : ''}</span>
                  {k.checks && k.checks.warning && <Badge variant="destructive" className="whitespace-normal">{k.checks.warning}</Badge>}
                </span>
              : 'Not set'}
            action={form !== env && <>
              <Button variant="ghost" size="sm" onClick={() => setForm(env)}>{k ? 'Change' : 'Add'}</Button>
              {k && k.source !== 'config' && <Button variant="ghost" size="sm" className="text-danger" onClick={() => setDeleting(env)}>Delete</Button>}
            </>}>
            <KeyForm key={form} env={env} twoFA={twoFA.enabled} publicIp={status.publicIp} onSaved={(d) => { setKeys(d); setForm(null); }} onCancel={() => setForm(null)} />
          </SettingRow>
        );
      })}
      <TwoFA st={twoFA} onChange={(s) => setTwoFA(s || { enabled: false })} />
      {deleting && <DeleteKey env={deleting} twoFA={twoFA.enabled} onDeleted={setKeys} onClose={() => setDeleting(null)} />}
    </>
  );
}
