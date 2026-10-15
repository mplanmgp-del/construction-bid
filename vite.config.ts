import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { nodeApiHandler } from './server/http.ts';
import { alertApiHandler } from './server/alert-http.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (env.G2B_SERVICE_KEY) process.env.G2B_SERVICE_KEY = env.G2B_SERVICE_KEY;
  for (const name of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_ANON_KEY', 'ALERT_WORKER_TOKEN', 'ALERT_VAPID_PUBLIC_KEY', 'ALERT_VAPID_PRIVATE_KEY', 'ALERT_VAPID_SUBJECT', 'ALERT_APP_ORIGIN']) if (env[name]) process.env[name] = env[name];
  return {
    build: { rolldownOptions: { input: { main: 'index.html', detailDesign: 'detail-design.html', noticeDetail: 'notice-detail.html' } } },
    plugins: [react(), {
      name: 'local-bid-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = req.url?.split('?')[0];
          if (pathname === '/api/alerts') { void alertApiHandler(req,res); return; }
          if (!['/api/notices', '/api/notices-start', '/api/detail', '/api/results', '/api/related', '/api/result-summary', '/api/notice-regions', '/api/companies', '/api/company-history', '/api/company-awards', '/api/company-participation', '/api/company-contracts', '/api/company-data', '/api/archive-page', '/api/opening-results'].includes(pathname ?? '')) return next();
          void nodeApiHandler(req, res);
        });
      },
    }],
    test: { environment: 'node', include: ['tests/**/*.test.{ts,tsx}'] },
  };
});
