// Profile: avatar, timezone, trading limits, levels & alerts, sign out
import * as React from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Separator } from '@/components/ui/separator';
import { state } from '../../state.js';
import { tzDateStr } from '../../utils.js';
import { API_BASE } from '../../api.js';
import { AVATAR_PRESETS, LOGO_SVG, accLevelsSyms, clearLevels, clearAlerts, clearRays, getUserAvatar, getUserEmail, renderBriefingPanel, setUserAvatar } from '../../ui.js';
import { toast } from '../../react-bridge.js';
import { FieldRow, Msg, SettingRow, accountPost } from './parts.jsx';

const TZ_LIST = [
  ['Pacific/Honolulu', 'UTC−10  Hawaii'],
  ['America/Anchorage', 'UTC−9   Alaska'],
  ['America/Los_Angeles', 'UTC−8/−7  Los Angeles, Vancouver'],
  ['America/Denver', 'UTC−7/−6  Denver'],
  ['America/Chicago', 'UTC−6/−5  Chicago, Mexico City'],
  ['America/New_York', 'UTC−5/−4  New York, Toronto'],
  ['America/Sao_Paulo', 'UTC−3     São Paulo'],
  ['Atlantic/Reykjavik', 'UTC+0     Reykjavik'],
  ['Europe/London', 'UTC+0/+1  London'],
  ['Europe/Paris', 'UTC+1/+2  Berlin, Paris, Warsaw'],
  ['Europe/Athens', 'UTC+2/+3  Athens, Helsinki, Riga'],
  ['Europe/Moscow', 'UTC+3     Moscow, Minsk'],
  ['Asia/Dubai', 'UTC+4     Dubai, Tbilisi'],
  ['Asia/Karachi', 'UTC+5     Karachi, Tashkent'],
  ['Asia/Kolkata', 'UTC+5:30  Mumbai, Delhi'],
  ['Asia/Almaty', 'UTC+6     Almaty'],
  ['Asia/Bangkok', 'UTC+7     Bangkok, Jakarta'],
  ['Asia/Singapore', 'UTC+8     Singapore, Hong Kong, Beijing'],
  ['Asia/Seoul', 'UTC+9     Seoul, Tokyo'],
  ['Australia/Sydney', 'UTC+10/+11  Sydney'],
  ['Pacific/Auckland', 'UTC+12/+13  Auckland'],
];
const AUTO_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function Logo({ className }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: LOGO_SVG }} />;
}

function AvatarRow() {
  const [open, setOpen] = React.useState(false);
  const [avatar, setAvatar] = React.useState(getUserAvatar() || '');
  const pick = (v) => {
    if ((v || null) === (getUserAvatar() || null)) return;
    setAvatar(v);
    setUserAvatar(v);
    accountPost({ action: 'save-avatar', avatar: v }).catch(() => {});
  };
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <Avatar className="size-12 text-3xl">
          <AvatarFallback className="bg-muted text-2xl">{avatar || <Logo className="size-7" />}</AvatarFallback>
        </Avatar>
        <div className="grid">
          <span className="font-medium">{(getUserEmail() || '').split('@')[0] || 'Profile'}</span>
          <Button variant="link" size="sm" className="h-auto justify-start p-0 text-muted-foreground" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Change'}</Button>
        </div>
      </div>
      {open && (
        <ToggleGroup type="single" variant="outline" spacing={1} value={avatar} onValueChange={(v) => pick(v)} className="flex-wrap">
          <ToggleGroupItem value="" aria-label="Default" className="size-10 p-0 data-[state=on]:border-primary"><Logo className="size-5" /></ToggleGroupItem>
          {AVATAR_PRESETS.map((p) => <ToggleGroupItem key={p} value={p} className="size-10 p-0 text-xl data-[state=on]:border-primary">{p}</ToggleGroupItem>)}
        </ToggleGroup>
      )}
    </div>
  );
}

function TimezoneRow({ account }) {
  const [open, setOpen] = React.useState(false);
  const [saved, setSaved] = React.useState(account.timezone || null);
  const [value, setValue] = React.useState(account.timezone || AUTO_TZ || TZ_LIST[0][0]);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const options = AUTO_TZ && !TZ_LIST.some((t) => t[0] === AUTO_TZ) ? [[AUTO_TZ, AUTO_TZ], ...TZ_LIST] : TZ_LIST;

  const apply = (tz) => {
    const oldToday = tzDateStr();
    state.timezone = tz;
    setSaved(tz);
    setOpen(false);
    renderBriefingPanel();
    if (tzDateStr() !== oldToday) toast('Timezone updated — note that "today" may now point to a different date for the journal/briefing.');
  };
  const save = (body, tz) => {
    setBusy(true); setMsg(null);
    accountPost(body).then((d) => {
      if (d.ok) { if (tz == null) setValue(AUTO_TZ); apply(tz); } else setMsg({ text: d.error || 'Error' });
    }).catch(() => setMsg({ text: 'Network error' })).finally(() => setBusy(false));
  };

  return (
    <SettingRow label="Timezone" value={(saved || AUTO_TZ) + ' · ' + (saved ? 'saved' : 'auto-detect')} open={open}
      action={<Button variant="ghost" size="sm" onClick={() => { setOpen(!open); setMsg(null); }}>{open ? 'Cancel' : 'Change'}</Button>}>
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
      </Select>
      <Msg msg={msg} />
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => save({ action: 'save-timezone', timezone: value }, value)}>Save</Button>
        <Button variant="ghost" disabled={busy} onClick={() => save({ action: 'save-timezone', clear: true }, null)}>Use auto-detected</Button>
      </div>
    </SettingRow>
  );
}

function LimitsRow({ account }) {
  const init = account.tradingLimits || state.tradingLimits || null;
  const [open, setOpen] = React.useState(false);
  const [limits, setLimits] = React.useState(init && init.maxVolume != null ? init : null);
  const [f, setF] = React.useState({ maxVolume: init ? init.maxVolume ?? '' : '', maxDrawdownPct: init ? init.maxDrawdownPct ?? '' : '', maxTrades: init ? init.maxTrades ?? '' : '' });
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = () => {
    const body = { action: 'save-trading-limits', maxVolume: Number(f.maxVolume), maxDrawdownPct: Number(f.maxDrawdownPct), maxTrades: Number(f.maxTrades) };
    setBusy(true); setMsg(null);
    accountPost(body).then((d) => {
      if (!d.ok) { setMsg({ text: d.error || 'Error' }); return; }
      state.tradingLimits = { maxVolume: body.maxVolume, maxDrawdownPct: body.maxDrawdownPct, maxTrades: body.maxTrades };
      setLimits(state.tradingLimits);
      setOpen(false);
    }).catch(() => setMsg({ text: 'Network error' })).finally(() => setBusy(false));
  };
  return (
    <SettingRow label="Trading limits" open={open}
      value={limits ? '$' + limits.maxVolume + ' · ' + limits.maxDrawdownPct + '% per trade · ' + limits.maxTrades + ' trades/day' : 'Not set'}
      action={<Button variant="ghost" size="sm" onClick={() => { setOpen(!open); setMsg(null); }}>{open ? 'Cancel' : 'Change'}</Button>}>
      <FieldRow label="Daily working volume ($)"><Input type="number" min={0} step={1} placeholder="50" value={f.maxVolume} onChange={set('maxVolume')} /></FieldRow>
      <FieldRow label="Allowed drawdown per trade (%)"><Input type="number" min={0} step={0.1} placeholder="0.5" value={f.maxDrawdownPct} onChange={set('maxDrawdownPct')} /></FieldRow>
      <FieldRow label="Max trades per day"><Input type="number" min={0} step={1} placeholder="3" value={f.maxTrades} onChange={set('maxTrades')} /></FieldRow>
      <Msg msg={msg} />
      <div><Button disabled={busy} onClick={save}>Save</Button></div>
    </SettingRow>
  );
}

function LevelsRow() {
  const [open, setOpen] = React.useState(false);
  const [syms, setSyms] = React.useState(accLevelsSyms);
  const clear = (s) => { clearLevels(s); clearAlerts(s); clearRays(s); setSyms(accLevelsSyms()); };
  return (
    <SettingRow label="Levels & Alerts" open={open}
      value={syms.length ? syms.length + ' coin' + (syms.length === 1 ? '' : 's') : 'No levels or alerts set'}
      action={syms.length > 0 && <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</Button>}>
      <div className="grid">
        {syms.map((s) => (
          <div key={s} className="flex items-center justify-between py-1">
            <span className="text-sm">{s.toUpperCase()}</span>
            <Button variant="ghost" size="sm" onClick={() => clear(s)}>Clear</Button>
          </div>
        ))}
      </div>
    </SettingRow>
  );
}

export function ProfileTab({ account }) {
  const signOut = () => fetch(API_BASE + '/auth/sign-out', { method: 'POST', credentials: 'include' }).finally(() => window.location.replace('/login'));
  return (
    <div className="grid gap-1">
      <AvatarRow />
      <Separator className="my-3" />
      <TimezoneRow account={account} />
      <LimitsRow account={account} />
      <LevelsRow />
      <Separator className="my-3" />
      <Button variant="destructive" onClick={signOut}>Sign out</Button>
    </div>
  );
}
