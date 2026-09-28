import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.TIDE_API ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/v1': { target, changeOrigin: true },
      '/socket.io': { target, changeOrigin: true, ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 7000,
  },
});
