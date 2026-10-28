// Chart interactions: what each mouse / key combination does
import * as React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';

const GROUPS = [
  ['Level', [['Add', ['Right-click']], ['Remove', ['Right-click on line']], ['Move', ['Drag line']]]],
  ['Alert', [['Add', ['Shift', 'Right-click']], ['Remove', ['Shift', 'Right-click on line']], ['Move', ['Shift', 'Right-drag']], ['Move (trackpad)', ['Shift', 'Alt', 'Left-drag']]]],
  ['Ray', [['Add', ['Ctrl', 'Left-click']], ['Move', ['Ctrl', 'Left-drag on ray']], ['Remove', ['Ctrl', 'Right-click']]]],
  ['Ruler', [['Measure', ['Alt', 'Left-drag']]]],
];

export function HintsDialog({ onClose }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Chart interactions</DialogTitle>
          <DialogDescription>Mouse and keys on the full-view chart</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {GROUPS.map(([title, rows]) => (
            <div key={title} className="space-y-1">
              <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
              <ItemGroup>
                {rows.map(([label, keys]) => (
                  <Item key={label} size="sm" className="px-0 py-1">
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
