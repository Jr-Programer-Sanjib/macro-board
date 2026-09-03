import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, requests to /api/* are proxied to the local backend so the browser
// never needs CORS headers. In production, set VITE_API_BASE to your
// deployed backend URL (see README) and this proxy is unused.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
