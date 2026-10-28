// One React root for everything that floats over the vanilla pages: dialogs,
// popovers, the command palette, toasts. Vanilla code talks to it through
// src/react-bridge.js (open / close / toast); this file is loaded lazily.
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { toast as sonner } from 'sonner';
import '../shadcn.css';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SURFACES } from './surfaces.jsx';
import { _surfaceClosed } from '../../react-bridge.js';

let setOpen = null;     // React state setter, once mounted
let pending = {};       // surfaces asked for before the root rendered

function Host() {
  const [open, set] = React.useState(pending);
  React.useEffect(() => { setOpen = set; pending = null; }, []);
  return (
    <TooltipProvider delayDuration={150}>
      {Object.entries(open).map(([name, props]) => {
        const Surface = SURFACES[name];
        return Surface ? <Surface key={name} {...props} onClose={() => close(name)} /> : null;
      })}
      <Toaster position="bottom-center" />
    </TooltipProvider>
  );
}

export function init() {
  const el = document.createElement('div');
  el.className = 'jr-host';
  document.body.appendChild(el);
  createRoot(el).render(<Host />);
}

// props are replaced on every open (re-opening an open surface updates it)
export function open(name, props) {
  const p = { ...(props || {}), _v: Date.now() };
  if (setOpen) setOpen((o) => ({ ...o, [name]: p })); else pending[name] = p;
}

export function close(name) {
  _surfaceClosed(name);
  if (setOpen) setOpen((o) => { if (!(name in o)) return o; const n = { ...o }; delete n[name]; return n; });
  else if (pending) delete pending[name];
}

export function toast(message, opts) { sonner(message, opts); }
