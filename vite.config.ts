import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { nodeApiHandler } from './server/http.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (env.G2B_SERVICE_KEY) process.env.G2B_SERVICE_KEY = env.G2B_SERVICE_KEY;
  return {
    build: { rolldownOptions: { input: { main: 'index.html', detailDesign: 'detail-design.html', noticeDetail: 'notice-detail.html' } } },
    plugins: [react(), {
      name: 'local-bid-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = req.url?.split('?')[0];
          if (!['/api/notices', '/api/detail', '/api/results', '/api/related'].includes(pathname ?? '')) return next();
          void nodeApiHandler(req, res);
        });
      },
    }],
    test: { environment: 'node', include: ['tests/**/*.test.{ts,tsx}'] },
  };
});
