import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  // VITE_BASE_URL is set during Docker build for subpath deployment.
  // e.g. VITE_BASE_URL=/news-comparer/ means the app lives at
  // https://domain.com/news-comparer/ behind a reverse proxy.
  const base = process.env.VITE_BASE_URL || "/";

  return {
    base,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        // Ignore .env changes to prevent unnecessary dev-server restarts
        // (dotenv reads the file on each config() call which can trigger watches).
        ignored: ['**/.env', '**/.env.*'],
      },
    },
  };
});
