// Static pages (FAQ, Privacy Policy, Terms of Service): their own HTML entry
// each (faq.html, privacy.html, terms.html) with a React root. Layout: back
// to the site, title, intro, then titled sections; text styled by PROSE.
import '../shadcn.css';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Paragraphs, lists and links inside a section
export const PROSE = 'text-sm leading-relaxed text-muted-foreground [&_a]:text-brand [&_a]:hover:underline [&_li]:mt-1 [&_p]:mb-3 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-6';

export function Section({ title, className, children }) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="mb-3 text-base font-normal">{title}</h2>
      <div className={className}>{children}</div>
    </section>
  );
}

export function StaticPage({ title, sub, children }) {
  return (
    <div className="jr mx-auto max-w-180 px-8 pt-12 pb-16 text-foreground max-sm:px-4 max-sm:pt-6">
      <div className="mb-1.5 flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" aria-label="Back"><a href="/"><ArrowLeft /></a></Button>
        <h1 className="text-3xl font-normal tracking-tight">{title}</h1>
      </div>
      <p className="mb-8 text-sm text-muted-foreground">{sub}</p>
      {children}
    </div>
  );
}

export function mountStaticPage(Page) {
  createRoot(document.getElementById('root')).render(<Page />);
}
