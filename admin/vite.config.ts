import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/admin/api': {
        target: 'http://localhost:7331',
        changeOrigin: true,
      },
      '/admin/login': {
        target: 'http://localhost:7331',
        changeOrigin: true,
      },
    },
  },
});
