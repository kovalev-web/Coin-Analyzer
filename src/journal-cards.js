// Morning / evening journal cards: who may open them (the cards themselves are
// shadcn dialogs, src/react/host/MorningDialog.jsx / EveningDialog.jsx).
// After a save the dialogs emit 'journal:saved' ({ kind: 'morning' | 'skip' | 'evening' }).
// Today's entry is re-read from the server before each check: the card may have
// been filled on another device while this tab was open.

import { state } from './state.js';
import { openSurface, toast } from './react-bridge.js';
import { fetchJournalToday } from './api.js';
import { emit } from './events.js';

// Fresh entry from the server; if the morning got filled elsewhere, the page
// catches up the same way as after a save here (buttons, today's reminder)
function _freshToday() {
  var had = !!(state.journalToday && state.journalToday.morningAt);
  return fetchJournalToday().then(function () {
    var t = state.journalToday;
    if (!had && t && t.morningAt) emit('journal:saved', { kind: t.skipped ? 'skip' : 'morning' });
  });
}

export function openMorningJournal() {
  if (state.isDemoMode) { window.location.href = '/login'; return; }
  _freshToday().then(function () {
    if (state.journalToday && state.journalToday.morningAt) { toast('Morning journal already filled today'); return; }
    openSurface('morning');
  });
}

export function openEveningJournal() {
  if (state.isDemoMode) { window.location.href = '/login'; return; }
  _freshToday().then(function () {
    if (!state.journalToday || !state.journalToday.morningAt) { toast('Fill in the morning journal first'); return; }
    if (state.journalToday.skipped) { toast('Today is marked as a no-trading day'); return; }
    openSurface('evening');
  });
}
