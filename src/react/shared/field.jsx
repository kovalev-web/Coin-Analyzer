// A labelled form row for the journal cards
import * as React from 'react';
import { Label } from '@/components/ui/label';

export function Field({ label, hint, children }) {
  return (
    <div className="grid gap-2">
      {label && <Label className="leading-snug">{label}</Label>}
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export const SCALE_1_5 = [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']];

export function dmy(iso) { const p = iso.split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0].slice(2) : iso; }
