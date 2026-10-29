// Order book settings (per coin): order size slots, the volume bar's full
// scale, where coloring starts, the trades tape and its minimum, other venues,
// frames on them, the clusters period, and the hotkeys list. Every change
// applies at once through setTermSetting (terminal.js); text fields apply on
// blur or Enter (Enter also closes), and closing applies what was typed.
import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Kbd } from '@/components/ui/kbd';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Chips } from '@/shared/chips';
import { termSettings, setTermSetting } from '../../terminal.js';
import { formatUsdShort } from '../../ladder-scale.js';

const FULL_CHIPS = [[0, 'Auto'], [250e3, '250K'], [500e3, '500K'], [1e6, '1M'], [2e6, '2M'], [5e6, '5M']];
const HL_CHIPS = [[50, '50%'], [60, '60%'], [65, '65%'], [70, '70%'], [80, '80%'], [90, '90%']];
const HIT_CHIPS = [[0, 'Auto'], [1e3, '1K'], [5e3, '5K'], [1e4, '10K'], [5e4, '50K']];
const tapeChips = (auto) => [[auto, 'Auto'], [0, 'All'], [100, '100'], [500, '500'], [1e3, '1K'], [5e3, '5K']];
// Chips work with strings; the values are numbers
const chipList = (list) => list.map(([v, l]) => [String(v), l]);

function Row({ label, note, children }) {
  return (
    <div className="grid gap-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function SwitchRow({ id, label, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="font-normal">{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function TermSettingsDialog({ sym, onClose }) {
  const [s, setS] = React.useState(termSettings);
  const slots = (list) => Array.from({ length: s.sizeSlots }, (_, i) => (list[i] != null ? String(list[i]) : ''));
  const [sizes, setSizes] = React.useState(() => slots(s.sizes));
  const [full, setFull] = React.useState(() => formatUsdShort(s.fullScale));
  const [tmin, setTmin] = React.useState(() => (s.tapeMin > 0 ? formatUsdShort(s.tapeMin) : ''));
  const dirty = React.useRef({});

  const apply = (key, value) => {
    const next = setTermSetting(key, value);
    setS(next);
    if (key === 'sizes') setSizes(slots(next.sizes));
    if (key === 'fullScale') setFull(formatUsdShort(next.fullScale));
    if (key === 'tapeMin') setTmin(next.tapeMin > 0 ? formatUsdShort(next.tapeMin) : '');
    delete dirty.current[key];
  };
  // Typed but not applied yet (no blur before Done / Esc) — apply on close
  const close = () => {
    if (dirty.current.sizes) apply('sizes', sizes);
    if (dirty.current.fullScale) apply('fullScale', full);
    if (dirty.current.tapeMin) apply('tapeMin', tmin);
    onClose();
  };
  const onEnter = (key, value) => (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(key, value); close(); } };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Order book settings · {(sym || s.sym || '').replace(/USDT$/, '')}</DialogTitle>
          <DialogDescription>For this coin; applies at once</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <Row label="Order sizes, USDT" note={'Order sizes ' + s.sizeMin + '–' + s.sizeMax + ' USDT, an empty slot hides it.'}>
            <div className="grid grid-cols-6 gap-1.5">
              {sizes.map((v, i) => (
                <Input key={i} type="number" inputMode="decimal" min={s.sizeMin} max={s.sizeMax} className="h-8 px-2 text-center tabular-nums" value={v}
                  onChange={(e) => { const n = sizes.slice(); n[i] = e.target.value; setSizes(n); dirty.current.sizes = true; }}
                  onBlur={() => { if (dirty.current.sizes) apply('sizes', sizes); }}
                  onKeyDown={onEnter('sizes', sizes)} />
              ))}
            </div>
          </Row>

          <Row label="Volume bar is full at, $" note="Type 2M, 500K or 1.5M. Empty or Auto — set from the levels on screen.">
            <Input autoComplete="off" className="h-8" value={full} placeholder={'Auto' + (s.autoFull ? ' · now ≈ ' + formatUsdShort(s.autoFull) : '')}
              onChange={(e) => { setFull(e.target.value); dirty.current.fullScale = true; }}
              onBlur={() => { if (dirty.current.fullScale) apply('fullScale', full); }}
              onKeyDown={onEnter('fullScale', full)} />
            <Chips list={chipList(FULL_CHIPS)} value={String(s.fullScale)} onChange={(v) => apply('fullScale', Number(v))} />
          </Row>

          <Row label="Colored from, % of a full bar" note="Smaller levels stay grey. In Auto a level is also colored only if it's ≥ 3× the typical one — a flat book stays grey.">
            <Chips list={chipList(HL_CHIPS)} value={String(s.highlight)} onChange={(v) => apply('highlight', Number(v))} />
          </Row>

          <Separator />
          <SwitchRow id="ts-tape" label="Trades tape" checked={s.tape} onChange={(v) => apply('tape', v)} />
          <Row label="Tape: hide trades under, $" note="Auto — bigger than most trades on that venue lately.">
            <Input autoComplete="off" className="h-8" value={tmin}
              placeholder={s.tapeMin === s.tapeAuto ? 'Auto · now ≈ ' + (formatUsdShort(s.autoTapeMin) || '10') : 'Show all'}
              onChange={(e) => { setTmin(e.target.value); dirty.current.tapeMin = true; }}
              onBlur={() => { if (dirty.current.tapeMin) apply('tapeMin', tmin); }}
              onKeyDown={onEnter('tapeMin', tmin)} />
            <Chips list={chipList(tapeChips(s.tapeAuto))} value={String(s.tapeMin)} onChange={(v) => apply('tapeMin', Number(v))} />
          </Row>

          <Separator />
          <SwitchRow id="ts-venues" label="Other venues: books and their trades on the tape" checked={s.venues} onChange={(v) => apply('venues', v)} />
          <SwitchRow id="ts-venue-full" label="Other venues as full books (bars like ours)" checked={s.venueFull} onChange={(v) => apply('venueFull', v)} />
          <Row label="Frames on other venues from, $" note="Auto — a hit bigger than 90% of that venue's recent trades, or one that ate 20%+ of the level.">
            <Chips list={chipList(HIT_CHIPS)} value={String(s.hitMin)} onChange={(v) => apply('hitMin', Number(v))} />
          </Row>

          <Separator />
          <Row label="Clusters period">
            <Select value={s.clusterTf} onValueChange={(v) => apply('clusterTf', v)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{s.clusterTfs.map((k) => <SelectItem key={k} value={k}>{k === 'off' ? 'Off' : k}</SelectItem>)}</SelectContent>
            </Select>
          </Row>

          <Separator />
          <Row label="Hotkeys · all coins">
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
              {s.hotkeys.map(([k, what]) => (
                <React.Fragment key={k}>
                  <Kbd className="justify-self-start">{k}</Kbd>
                  <span>{what}</span>
                </React.Fragment>
              ))}
            </div>
          </Row>
        </div>

        <DialogFooter>
          <Button onClick={close}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
