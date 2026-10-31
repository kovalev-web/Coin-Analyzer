// Entry of grid.html (/grid): the "in play" screener, signed-in users only
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import '../shadcn.css';
import { TooltipProvider } from '@/components/ui/tooltip';
import { checkAuth } from './feed.js';
import { InplayPage } from './InplayPage.jsx';

// 12+ hours on a TV: after a long time in the background (sleep, another
// app) the page reloads, like the main site (src/api.js) — cheaper than
// patching every socket and chart; and a fresh start every RELOAD_MS anyway,
// so a TV browser never piles up memory.
const HIDDEN_RELOAD_MS = 2 * 60000;
const RELOAD_MS = 6 * 3600000;
let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt !== null && Date.now() - hiddenAt > HIDDEN_RELOAD_MS) location.reload();
  else hiddenAt = null;
});
setTimeout(() => location.reload(), RELOAD_MS);

checkAuth().then(() => {
  createRoot(document.getElementById('root')).render(
    <TooltipProvider delayDuration={300}><InplayPage /></TooltipProvider>,
  );
});
