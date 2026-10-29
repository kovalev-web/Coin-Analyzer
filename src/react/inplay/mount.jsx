// Entry of grid.html (/grid): the "in play" screener, signed-in users only
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import '../shadcn.css';
import { TooltipProvider } from '@/components/ui/tooltip';
import { checkAuth } from './feed.js';
import { InplayPage } from './InplayPage.jsx';

checkAuth().then(() => {
  createRoot(document.getElementById('root')).render(
    <TooltipProvider delayDuration={300}><InplayPage /></TooltipProvider>,
  );
});
