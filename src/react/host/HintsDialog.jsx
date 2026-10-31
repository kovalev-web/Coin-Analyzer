// Chart interactions: what each mouse / key combination does
import * as React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';

// Every line moves the same way: grab it and drag (the cursor changes over it)
const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const OPT = MAC ? 'Option' : 'Alt';
const GROUPS = [
  ['Level', [['Add', ['Right-click']], ['Remove', ['Right-click on line']], ['Move', ['Drag line or price label']]]],
  ['Alert', [['Add', ['Shift', 'Right-click']], ['Remove', ['Shift', 'Right-click on line']], ['Move', ['Drag line']]]],
  ['Ray', [['Add', ['Ctrl', 'Click']], ['Remove', ['Ctrl', 'Click on ray']], ['Move', ['Drag ray']]]],
  ['Ruler', [['Measure', [OPT, 'Drag']], ['Measure', ['Middle-button drag']]]],
  ['Trades', [['Show / hide entries and exits', ['T']]]],
];

export function HintsDialog({ onClose }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Chart interactions</DialogTitle>
          <DialogDescription>Mouse and keys on the charts: the main page and the full view</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {GROUPS.map(([title, rows]) => (
            <div key={title} className="space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
              <ItemGroup>
                {rows.map(([label, keys]) => (
                  <Item key={label + keys.join()} size="sm" className="px-0 py-1">
                    <ItemContent><ItemTitle className="font-normal">{label}</ItemTitle></ItemContent>
                    <ItemActions><KbdGroup>{keys.map((k, i) => <React.Fragment key={k}>{i > 0 && <span className="text-muted-foreground">+</span>}<Kbd>{k}</Kbd></React.Fragment>)}</KbdGroup></ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
