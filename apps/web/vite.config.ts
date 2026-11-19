import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The API is same-origin in every environment. In development, Vite proxies /api to the
// local FastAPI service so the browser never needs CORS.
const apiTarget = process.env.ASTRA_API_PROXY_TARGET ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      output: {
        // Long-lived vendor chunks cache well across app deploys.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'tanstack', test: /node_modules[\\/]@tanstack[\\/]/ },
            {
              name: 'ui-vendor',
              test: /node_modules[\\/](@radix-ui|cmdk|sonner|lucide-react)[\\/]/,
            },
            { name: 'oidc', test: /node_modules[\\/]oidc-client-ts[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
    restoreMocks: true,
    // Screen flows type and click through whole forms in jsdom; with every worker busy the 5 s default
    // times out flows that take 1-2 s alone.
    testTimeout: 30_000,
  },
});
