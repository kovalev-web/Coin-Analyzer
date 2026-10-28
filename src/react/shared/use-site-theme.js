// 'light' | 'dark' — the site's theme: data-theme on <html> wins, else the system one
import * as React from 'react';

function current() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useSiteTheme() {
  const [theme, setTheme] = React.useState(current);
  React.useEffect(() => {
    const update = () => setTheme(current());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    return () => { mo.disconnect(); mq.removeEventListener('change', update); };
  }, []);
  return theme;
}
