import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createG2bClient } from '../server/g2b';
import { handleG2bRequest, nodeApiHandler, type NodeResponse } from '../server/http';

const cacheEntries = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@vercel/functions', () => ({
  getCache: () => ({
    get: async (key: string) => cacheEntries.get(key),
    set: async (key: string, value: unknown) => { cacheEntries.set(key, value); },
  }),
  waitUntil: vi.fn(),
}));
const started = Date.parse('2026-10-14T05:00:00Z');
const query = () => new URLSearchParams({ businessNumber: '8488802470', type: '공사', from: '2026-10-01', to: '2026-10-14' });
const winner = { bidNtceNo: 'R26BK01731386', bidNtceOrd: '000', bidClsfcNo: '0', rbidNo: '0',
  bidwinnrBizno: '8488802470', bidNtceNm: '테스트 공고', rlOpengDt: '2026-10-14 10:00:00', sucsfbidAmt: '100000' };
const provider = (items: object[]) => Response.json({ response: { header: { resultCode: '00' }, body: { totalCount: items.length, items } } });
let sequence = 0;
beforeEach(() => {
  cacheEntries.clear();
  vi.spyOn(Date, 'now').mockReturnValue(started);
  vi.stubEnv('G2B_SERVICE_KEY', `award-http-test-${++sequence}`);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function request(params = query()) {
  const headers: Record<string, string> = {};
  let body = '';
  const res: NodeResponse = { statusCode: 0, setHeader: (name, value) => { headers[name] = value; }, end: value => { body = value || ''; } };
  await nodeApiHandler({ method: 'GET', url: `/api/company-awards?${params}`, headers: { 'x-forwarded-for': `award-http-${sequence}` } }, res);
  return { status: res.statusCode, headers, body: JSON.parse(body) };
}

it('reads the provider after a current-month snapshot expires instead of stamping old raw data as fresh', async () => {
  let published = false;
  const fetcher = vi.fn(async () => provider(published ? [winner] : []));
  vi.stubGlobal('fetch', fetcher);
  expect((await request()).body.totalCount).toBe(0);
  vi.mocked(Date.now).mockReturnValue(started + 120_000);
  expect((await request()).body.totalCount).toBe(0);
  expect(fetcher).toHaveBeenCalledOnce();
  published = true;
  vi.mocked(Date.now).mockReturnValue(started + 181_000);
  const refreshed = await request();
  expect(refreshed.body.totalCount).toBe(1);
  expect(refreshed.body.items[0].businessNumber).toBe('8488802470');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([
  ['2026-10-01', '2026-10-14', 180],
  ['2026-09-01', '2026-09-30', 86400],
])('does not extend the original freshness deadline for a cached %s..%s result', async (from, to, ttl) => {
  vi.stubGlobal('fetch', async () => provider([]));
  const params = query(); params.set('from', from); params.set('to', to);
  expect((await request(params)).headers['Vercel-CDN-Cache-Control']).toBe(`public, max-age=${ttl}`);
  vi.mocked(Date.now).mockReturnValue(started + 120_500);
  const cached = await request(params);
  expect(cached.headers['X-Search-Cache']).toBe('HIT');
  expect(cached.headers['Vercel-CDN-Cache-Control']).toBe(`public, max-age=${ttl - 121}`);
});

it('preserves injected clients and validates date ranges before provider work', async () => {
  const fetcher = vi.fn(async () => provider([]));
  const api = createG2bClient({ serviceKey: 'injected-test-key', fetcher });
  expect((await handleG2bRequest('/api/company-awards', query(), api)).status).toBe(200);
  expect(fetcher).toHaveBeenCalledOnce();
  const invalid = query(); invalid.set('from', '2026-09-01');
  expect((await handleG2bRequest('/api/company-awards', invalid, api)).status).toBe(400);
  expect(fetcher).toHaveBeenCalledOnce();
});
