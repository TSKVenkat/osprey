import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API and the web app are separate origins in development. Proxying keeps
    // the session cookie same-origin, which avoids fighting SameSite rules locally.
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: true },
      '/files': { target: apiTarget, changeOrigin: true },
    },
  },
});
