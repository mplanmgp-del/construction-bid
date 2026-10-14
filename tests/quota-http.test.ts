import { afterEach, expect, it, vi } from 'vitest';
import { createG2bClient } from '../server/g2b';
import { handleG2bRequest, nodeApiHandler } from '../server/http';
import { ProviderQuotaError } from '../server/provider-quota';

vi.mock('@vercel/functions', () => {
  const entries = new Map<string, unknown>();
  return { getCache: () => ({ get: async (key: string) => entries.get(key), set: async (key: string, value: unknown) => { entries.set(key, value); } }), waitUntil: () => undefined };
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('rejects a blank full-search keyword before reading any provider data', async () => {
  const api = createG2bClient({ serviceKey: 'unused' });
  const start = vi.spyOn(api, 'startNotices');
  const result = await handleG2bRequest('/api/notices-start', new URLSearchParams({ type: '공사', from: '2026-10-07', to: '2026-10-13', window: '0', keyword: '  ' }), api);
  expect(result).toMatchObject({ status: 400, body: { error: { code: 'KEYWORD_REQUIRED' } } });
  expect(start).not.toHaveBeenCalled();
});

it('keeps service quota status and retry delay across the HTTP boundary', async () => {
  const api = createG2bClient({ serviceKey: 'unused' });
  vi.spyOn(api, 'notices').mockRejectedValue(new ProviderQuotaError(123));
  const result = await handleG2bRequest('/api/notices', new URLSearchParams({ type: '공사', from: '2026-10-07', to: '2026-10-13' }), api);
  expect(result).toMatchObject({ status: 429, retryAfterSeconds: 123, body: { error: { code: 'G2B_QUOTA_EXCEEDED', retryAfterSeconds: 123 } } });
});

it('does not invent a retry deadline when the provider has supplied none', async () => {
  const api = createG2bClient({ serviceKey: 'quota-http', fetcher: async () => new Response('serviceKey=SECRET', { status: 429 }) });
  const result = await handleG2bRequest('/api/notices', new URLSearchParams({ type: '공사', from: '2026-10-07', to: '2026-10-13' }), api);
  expect(result).toMatchObject({ status: 429, body: { error: { code: 'G2B_QUOTA_EXCEEDED' } } });
  expect(result).not.toHaveProperty('retryAfterSeconds');
  expect(result.body).not.toHaveProperty('error.retryAfterSeconds');
  expect(JSON.stringify(result)).not.toContain('SECRET');
});

it.each([undefined, '120'])('preserves quota status and only real Retry-After on a cached 200 search fallback: %s', async retryAfter => {
  vi.stubEnv('G2B_SERVICE_KEY', `cached-http-${retryAfter}`);
  let quota = false;
  vi.stubGlobal('fetch', async () => quota
    ? new Response('serviceKey=SECRET', { status: 429, ...(retryAfter ? { headers: { 'Retry-After': retryAfter } } : {}) })
    : Response.json({ response: { header: { resultCode: '00' }, body: { totalCount: 0, items: [] } } }));
  const params = new URLSearchParams({ type: '공사', from: '2026-10-07', to: '2026-10-13', keyword: `http-${retryAfter}`, window: '0', refresh: '1' });
  const request = async () => {
    const headers = new Map<string, string>();
    let body = '';
    const res = { statusCode: 0, setHeader: (key: string, value: string) => { headers.set(key, value); }, end: (value?: string) => { body = value ?? ''; } };
    await nodeApiHandler({ method: 'GET', url: `/api/notices-start?${params}`, headers: { 'x-forwarded-for': `cached-http-${retryAfter}` } }, res);
    return { status: res.statusCode, headers, body: JSON.parse(body) };
  };
  expect((await request()).headers.get('X-Search-Cache')).toBe('MISS');
  quota = true;
  const stale = await request();
  expect(stale.status).toBe(200);
  expect(stale.headers.get('X-Search-Cache')).toBe('STALE');
  expect(stale.headers.get('Vercel-CDN-Cache-Control')).toBeUndefined();
  expect(stale.body.quotaExceeded).toBe(true);
  expect(stale.body.retryAfterSeconds).toBe(retryAfter ? 120 : undefined);
  expect(stale.headers.get('Retry-After')).toBe(retryAfter);
  expect(JSON.stringify(stale.body)).not.toContain('SECRET');
  quota = false;
  const recovered = await request();
  expect(recovered.headers.get('X-Search-Cache')).toBe('MISS');
  expect(recovered.body.quotaExceeded).toBeUndefined();
  expect(recovered.headers.get('Retry-After')).toBeUndefined();
});
