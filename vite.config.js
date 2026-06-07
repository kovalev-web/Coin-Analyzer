import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
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
        phase:        'inplay-phase.html',
        login:        'login.html',
        verifyEmail:         'verify-email.html',
        resetPassword:       'reset-password.html',
        confirmEmailChange:  'confirm-email-change.html',
        design:              'design.html',
      },
    },
  },
});
