// Popovers anchored to a vanilla element (a header button, a chart button):
// an invisible box over the element's rect is the Radix anchor.
import * as React from 'react';
import { PopoverAnchor } from '@/components/ui/popover';

export function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function AnchorBox({ rect }) {
  return (
    <PopoverAnchor asChild>
      <div aria-hidden style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: 'none' }} />
    </PopoverAnchor>
  );
}

// A click on the opener itself must not count as "outside" — the opener toggles
export function keepOpenOn(selector) {
  return (e) => { if (selector && e.target.closest && e.target.closest(selector)) e.preventDefault(); };
}
