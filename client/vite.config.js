import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The ports are pinned rather than left to Vite's fallback behaviour. The
// server's CLIENT_ORIGIN must match this origin exactly, and a dev server that
// silently moves to 5174 because 5173 was busy would break CORS in a way that
// looks like a code bug.
// Module 3.5's measurement build. React's production build strips the
// profiling hooks, so React DevTools cannot attach and "re-renders per seat
// click" cannot be measured at all. react-dom/profiling is the same production
// build with those hooks kept.
//
// Gated on an environment variable so an ordinary `npm run build:client` is
// completely unaffected — the deployed bundle never carries profiling. The
// measurement is reproducible with:
//
//   PROFILE=1 npm run build:client
const profiling = process.env.PROFILE === '1';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  ...(profiling
    ? { resolve: { alias: { 'react-dom/client': 'react-dom/profiling' } } }
    : {}),
});
