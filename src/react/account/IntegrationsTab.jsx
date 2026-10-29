// Integrations: the read-only Binance key (journal PnL), trading keys + 2FA
// (trading account only), Telegram
import * as React from 'react';
import { CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Item, ItemContent, ItemDescription } from '@/components/ui/item';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { FieldRow, Msg, SettingRow, accountGet, accountPost } from './parts.jsx';
import { TradingKeys } from './TradingKeys.jsx';

function BinanceRow({ account }) {
  const [connected, setConnected] = React.useState(!!account.binanceConnected);
  const [apiKey, setApiKey] = React.useState(account.binanceKey || '');
  const [editing, setEditing] = React.useState(false);
  const [key, setKey] = React.useState('');
  const [sec, setSec] = React.useState('');
  const [err, setErr] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const [askDelete, setAskDelete] = React.useState(false);
  const open = !connected || editing;

  const save = () => {
    const k = key.trim(), s = sec.trim();
    if (!k) { setErr({ key: 'Enter API key' }); return; }
    if (!s) { setErr({ sec: 'Enter Secret key' }); return; }
    setErr({}); setBusy(true);
    accountPost({ action: 'save-binance', apiKey: k, apiSecret: s }).then((d) => {
      if (d.error) { setErr({ form: d.error }); return; }
      setKey(''); setSec(''); setEditing(false); setConnected(true);
      accountGet().then((a) => setApiKey(a.binanceKey || '')).catch(() => {});
    }).catch(() => setErr({ form: 'Network error' })).finally(() => setBusy(false));
  };
  const remove = () => {
    setBusy(true);
    accountPost({ action: 'delete-binance' }).then((d) => {
      if (d.error) throw new Error(d.error);
      setConnected(false); setApiKey(''); setEditing(false);
    }).catch(() => {}).finally(() => setBusy(false));
  };

  return (
    <SettingRow label="Binance API" open={open}
      value={connected ? '••••••' + (apiKey ? apiKey.slice(0, 4) + '...' + apiKey.slice(-4) : '') : ''}
      action={connected && <Button variant="ghost" size="sm" onClick={() => { setEditing(!editing); setKey(''); setSec(''); setErr({}); }}>{editing ? 'Cancel' : 'Change'}</Button>}>
      <Item variant="muted" size="sm">
        <ItemContent><ItemDescription className="line-clamp-none text-xs"><b className="text-foreground">Read-only keys only.</b> We only accept keys with no trading or withdrawal permissions. Your funds stay safe — the key is used solely to display your PnL on the watchlist.</ItemDescription></ItemContent>
      </Item>
      <FieldRow label="API Key" error={err.key}><Input placeholder="Paste API key..." autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} aria-invalid={!!err.key} /></FieldRow>
      <FieldRow label="Secret Key" error={err.sec}><Input type="password" placeholder="Paste Secret key..." autoComplete="off" value={sec} onChange={(e) => setSec(e.target.value)} aria-invalid={!!err.sec} /></FieldRow>
      <Msg msg={err.form && { text: err.form }} />
      <div className="flex gap-2">
        <Button disabled={busy} onClick={save}>Save</Button>
        {connected && editing && <Button variant="ghost" className="text-danger" disabled={busy} onClick={() => setAskDelete(true)}>Delete</Button>}
      </div>
      <AlertDialog open={askDelete} onOpenChange={setAskDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Binance API?</AlertDialogTitle>
            <AlertDialogDescription>The journal and briefing stop getting your trades from this key.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingRow>
  );
}

function TelegramRow({ account, onConnected }) {
  const [connected, setConnected] = React.useState(!!account.tgConnected);
  const [link, setLink] = React.useState(null);   // bot URL while waiting for /start
  const [busy, setBusy] = React.useState(false);
  const poll = React.useRef(null);
  React.useEffect(() => () => clearInterval(poll.current), []);

  const connect = () => {
    setBusy(true);
    accountPost({ action: 'tg-link-start' }).then((d) => {
      if (!d.url) return;
      setLink(d.url);
      let n = 0;
      poll.current = setInterval(() => {
        if (++n > 150) { clearInterval(poll.current); return; }
        accountGet().then((a) => {
          if (a.tgConnected) { clearInterval(poll.current); setLink(null); setConnected(true); onConnected(true); }
        }).catch(() => {});
      }, 2000);
    }).catch(() => {}).finally(() => setBusy(false));
  };
  const disconnect = () => {
    setBusy(true);
    accountPost({ action: 'tg-disconnect' }).then(() => { setConnected(false); onConnected(false); }).catch(() => {}).finally(() => setBusy(false));
  };

  return (
    <SettingRow label="Telegram" open={!!link}
      value={connected && <Badge variant="secondary" className="text-bullish"><CircleCheck /> Connected</Badge>}
      action={connected
        ? <Button variant="ghost" size="sm" className="text-danger" disabled={busy} onClick={disconnect}>Disconnect</Button>
        : !link && <Button size="sm" disabled={busy} onClick={connect}>Connect</Button>}>
      <p className="text-sm text-muted-foreground">Open the bot and click Start:</p>
      <div><Button asChild><a href={link || '#'} target="_blank" rel="noopener">Open bot →</a></Button></div>
      <p className="text-sm text-muted-foreground">Waiting for connection…</p>
    </SettingRow>
  );
}

export function IntegrationsTab({ account, onTelegram }) {
  return (
    <div className="grid gap-1">
      <BinanceRow account={account} />
      <TradingKeys />
      <Separator className="my-2" />
      <TelegramRow account={account} onConnected={onTelegram} />
    </div>
  );
}
