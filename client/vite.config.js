import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// În dev, Vite rulează pe :5173 și proxy-ază WebSocket-ul /ws către backend (:8787).
// În producție, backend-ul servește direct build-ul din dist/ — un singur proces.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
