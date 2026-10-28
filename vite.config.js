import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: '.',
  // React + Tailwind + shadcn only for the journal page (src/journal-app)
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/journal-app', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main:         'index.html',
        grid:         'grid.html',
        login:        'login.html',
        verifyEmail:         'verify-email.html',
        resetPassword:       'reset-password.html',
        confirmEmailChange:  'confirm-email-change.html',
        design:              'design.html',
        faq:                 'faq.html',
        privacy:             'privacy.html',
        terms:               'terms.html',
      },
    },
  },
});
