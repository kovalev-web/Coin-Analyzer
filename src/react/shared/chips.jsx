// One-of-many chips (setup tags, 1–5 scales): shadcn ToggleGroup, the chosen one filled
import * as React from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

// list: [[value, label]]; a click on the chosen one keeps it (no "nothing")
export function Chips({ list, value, onChange, className }) {
  return (
    <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={value || ''} onValueChange={(v) => { if (v) onChange(v); }} className={'flex-wrap ' + (className || '')}>
      {list.map(([k, label]) => (
        <ToggleGroupItem key={k} value={k} className="h-7 px-2.5 text-xs data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">{label}</ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
