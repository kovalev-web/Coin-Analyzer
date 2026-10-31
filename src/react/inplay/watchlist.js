// The watchlist star in the /grid cells: today's briefing (the same list as
// the star on the main page). The page holds no copy of the list to save —
// the server adds / removes one coin ('toggle' in /api/briefing), so edits made
// on the main page meanwhile are never overwritten. Reloads on the server's
// 'briefing_updated' (feed.js) and when the tab comes back into view.
import * as React from 'react';
import { API_BASE, onBriefingUpdated } from './feed.js';

const W = { entries: [], today: null, subs: new Set(), snap: { starred: new Set(), notes: {} } };

function apply(d) {
  if (!d || !Array.isArray(d.entries)) return;
  W.entries = d.entries;
  W.today = d.today || W.today;
  const starred = new Set(), notes = {};
  W.entries.forEach((e) => {
    if (e.date !== W.today) return;
    const s = String(e.sym).toUpperCase(); // the briefing keeps 'sol', the grid 'SOL'
    starred.add(s);
    if (e.note && e.note.trim()) notes[s] = true;
  });
  W.snap = { starred, notes };
  W.subs.forEach((f) => f());
}

function call(body) {
  if (!API_BASE) return Promise.resolve(null);
  return fetch(API_BASE + '/api/briefing', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

const load = () => call({ action: 'get' }).then(apply);
let started = false;

export function useWatchlist() {
  React.useEffect(() => {
    if (started) return;
    started = true;
    load();
    onBriefingUpdated(load);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  }, []);
  return React.useSyncExternalStore((f) => { W.subs.add(f); return () => W.subs.delete(f); }, () => W.snap);
}

// sym like 'SOLUSDT'; the briefing keeps 'sol' (the server folds the case)
export function toggleWatch(sym) {
  const base = sym.replace(/USDT$/, '');
  const on = !W.snap.starred.has(base);
  if (!on && W.snap.notes[base] && !confirm('Убрать ' + base + ' из вотчлиста? У монеты есть заметка.')) return;
  // Show it at once, the server's answer settles it
  const starred = new Set(W.snap.starred);
  if (on) starred.add(base); else starred.delete(base);
  W.snap = { ...W.snap, starred };
  W.subs.forEach((f) => f());
  call({ action: 'toggle', sym: base, on }).then((d) => (d ? apply(d) : load()));
}
