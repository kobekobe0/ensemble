import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = `http://127.0.0.1:${process.env.PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/ws': { target: target.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 800 },
});
