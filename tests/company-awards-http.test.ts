import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createG2bClient } from '../server/g2b';
import { handleG2bRequest, nodeApiHandler, type NodeResponse } from '../server/http';

const cacheAccess = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@vercel/functions', () => ({
  getCache: () => cacheAccess,
  waitUntil: vi.fn(),
}));
const started = Date.parse('2026-10-14T05:00:00Z');
const query = () => new URLSearchParams({ businessNumber: '8488802470', type: '공사', from: '2026-10-01', to: '2026-10-14' });
const winner = { bidNtceNo: 'R26BK01731386', bidNtceOrd: '000', bidClsfcNo: '0', rbidNo: '0',
  bidwinnrBizno: '8488802470', bidNtceNm: '테스트 공고', rlOpengDt: '2026-10-14 10:00:00', sucsfbidAmt: '100000' };
const provider = (items: object[]) => Response.json({ response: { header: { resultCode: '00' }, body: { totalCount: items.length, items } } });
let sequence = 0;
beforeEach(() => {
  cacheAccess.get.mockReset(); cacheAccess.set.mockReset();
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

it('reads current provider data on every request without serving a saved or raw cached snapshot', async () => {
  let published = false;
  const fetcher = vi.fn(async () => provider(published ? [winner] : []));
  vi.stubGlobal('fetch', fetcher);
  expect((await request()).body.totalCount).toBe(0);
  vi.mocked(Date.now).mockReturnValue(started + 1000);
  expect((await request()).body.totalCount).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  published = true;
  vi.mocked(Date.now).mockReturnValue(started + 2000);
  const refreshed = await request();
  expect(refreshed.body.totalCount).toBe(1);
  expect(refreshed.body.items[0].businessNumber).toBe('8488802470');
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(cacheAccess.get).not.toHaveBeenCalled();
  expect(cacheAccess.set).not.toHaveBeenCalled();
});

it.each([
  ['2026-10-01', '2026-10-14'],
  ['2026-09-01', '2026-09-30'],
])('does not cache direct responses for either current or historical periods: %s..%s', async (from, to) => {
  vi.stubGlobal('fetch', async () => provider([]));
  const params = query(); params.set('from', from); params.set('to', to);
  const first = await request(params);
  expect(first.headers['Cache-Control']).toBe('no-store');
  expect(first.headers['Vercel-CDN-Cache-Control']).toBeUndefined();
  expect(first.headers['X-Search-Cache']).toBeUndefined();
  vi.mocked(Date.now).mockReturnValue(started + 120_500);
  const next = await request(params);
  expect(next.headers['Cache-Control']).toBe('no-store');
  expect(next.headers['X-Search-Cache']).toBeUndefined();
  expect(next.headers['Vercel-CDN-Cache-Control']).toBeUndefined();
  expect(cacheAccess.get).not.toHaveBeenCalled();
  expect(cacheAccess.set).not.toHaveBeenCalled();
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
