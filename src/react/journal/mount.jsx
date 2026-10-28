// The journal page is a React island (shadcn/ui); the rest of the site stays vanilla.
// The router calls mountJournal on /journal; leaving the page unmounts it.
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import '../shadcn.css';
import { JournalPage } from './JournalPage.jsx';

let root = null;

export function unmountJournal() {
  if (root) { root.unmount(); root = null; }
}

export function mountJournal(app) {
  unmountJournal();
  app.innerHTML = '';
  const host = document.createElement('div');
  app.appendChild(host);
  root = createRoot(host);
  root.render(<JournalPage />);
}
