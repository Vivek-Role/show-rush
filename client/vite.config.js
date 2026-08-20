import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The ports are pinned rather than left to Vite's fallback behaviour. The
// server's CLIENT_ORIGIN must match this origin exactly, and a dev server that
// silently moves to 5174 because 5173 was busy would break CORS in a way that
// looks like a code bug.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
