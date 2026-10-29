// The account settings page (/settings) is a React island like the journal.
// The router calls mountAccount on /settings; leaving the page unmounts it.
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import '../shadcn.css';
import { AccountPage } from './AccountPage.jsx';

let root = null;

export function unmountAccount() {
  if (root) { root.unmount(); root = null; }
}

export function mountAccount(app) {
  unmountAccount();
  app.innerHTML = '';
  const host = document.createElement('div');
  app.appendChild(host);
  root = createRoot(host);
  root.render(<AccountPage />);
}
