// Morning / evening journal cards: who may open them (the cards themselves are
// shadcn dialogs, src/react/host/MorningDialog.jsx / EveningDialog.jsx).
// After a save the dialogs emit 'journal:saved' ({ kind: 'morning' | 'skip' | 'evening' }).

import { state } from './state.js';
import { openSurface, toast } from './react-bridge.js';

export function openMorningJournal() {
  if (state.isDemoMode) { window.location.href = '/login'; return; }
  if (state.journalToday && state.journalToday.morningAt) { toast('Morning journal already filled today'); return; }
  openSurface('morning');
}

export function openEveningJournal() {
  if (state.isDemoMode) { window.location.href = '/login'; return; }
  if (!state.journalToday || !state.journalToday.morningAt) { toast('Fill in the morning journal first'); return; }
  if (state.journalToday.skipped) { toast('Today is marked as a no-trading day'); return; }
  openSurface('evening');
}
