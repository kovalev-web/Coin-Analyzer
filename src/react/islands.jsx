// React islands inside the vanilla pages (header, filter bar…): rendered
// synchronously into a placeholder so the layout is there before the charts
// measure it. render() in ui.js unmounts the old ones before it replaces #app.
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import './shadcn.css';
import { TooltipProvider } from '@/components/ui/tooltip';

const roots = new Map(); // element → root

export function mountIsland(el, Component, props) {
  if (!el) return;
  let root = roots.get(el);
  if (!root) { root = createRoot(el); roots.set(el, root); }
  flushSync(() => root.render(<TooltipProvider delayDuration={300}><Component {...(props || {})} /></TooltipProvider>));
}

// Unmount islands inside `container` (or already detached ones)
export function unmountIslands(container) {
  roots.forEach((root, el) => {
    if (!el.isConnected || (container && container.contains(el))) { root.unmount(); roots.delete(el); }
  });
}
