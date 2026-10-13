import { beforeEach, expect, it, vi } from 'vitest';
import { G2bError, createG2bClient } from '../server/g2b';
import { handleG2bRequest, nodeApiHandler, type NodeResponse } from '../server/http';
import { loadPublicSearch } from '../server/public-search-cache';
import type { G2bNoticePage } from '../src/g2b-types';

vi.mock('../server/public-search-cache', () => ({ loadPublicSearch: vi.fn() }));
const data: G2bNoticePage = { items: [], totalCount: 0, page: 1, pageSize: 0, hasMore: false, fetchedAt: '2026-10-13T03:00:00Z', source: '나라장터', warnings: [] };
const params = () => new URLSearchParams({ type: '공사', from: '2026-10-07', to: '2026-10-13', keyword: '  철거  ', window: '0' });
const url = () => `/api/notices-start?${params()}`;
function response() {
  const headers: Record<string, string> = {};
  let body = '';
  const res: NodeResponse = { statusCode: 0, setHeader: (key, value) => { headers[key.toLowerCase()] = value; }, end: value => { body = value ?? ''; } };
  return { res, headers, body: () => JSON.parse(body) };
}
beforeEach(() => { vi.mocked(loadPublicSearch).mockReset(); });

it('keys shared public results by normalized type, dates, keyword and window only', async () => {
  const api = createG2bClient({ serviceKey: 'unused' });
  const start = vi.spyOn(api, 'startNotices').mockResolvedValue(data);
  vi.mocked(loadPublicSearch).mockImplementation(async (_key, loader) => ({ body: await loader(), status: 'MISS' }));
  const query = params(); query.set('page', '9'); query.set('pageSize', '1'); query.set('company', 'not-a-cache-key');
  const result = await handleG2bRequest('/api/notices-start', query, api);
  expect(result.body).toEqual(data);
  expect(vi.mocked(loadPublicSearch).mock.calls[0][0]).toBe(JSON.stringify(['공사', '2026-10-07', '2026-10-13', '철거', 0]));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ keyword: '철거' }), 0);
});

it('allows short CDN caching only for successful fresh public results', async () => {
  for (const status of ['HIT', 'MISS'] as const) {
    vi.mocked(loadPublicSearch).mockResolvedValue({ body: data, status });
    const r = response(); await nodeApiHandler({ method: 'GET', url: url(), headers: {} }, r.res);
    expect(r.res.statusCode).toBe(200); expect(r.headers['x-search-cache']).toBe(status);
    expect(r.headers['cache-control']).toBe('no-store'); expect(r.headers['vercel-cdn-cache-control']).toBe('public, max-age=60');
    expect(r.body().fetchedAt).toBe(data.fetchedAt);
  }
});

it('never puts stale snapshots or explicit refresh responses in CDN cache', async () => {
  vi.mocked(loadPublicSearch).mockResolvedValue({ body: data, status: 'STALE' });
  const stale = response(); await nodeApiHandler({ method: 'GET', url: url(), headers: {} }, stale.res);
  expect(stale.headers['vercel-cdn-cache-control']).toBeUndefined(); expect(stale.headers['cache-control']).toBe('no-store');
  vi.mocked(loadPublicSearch).mockResolvedValue({ body: data, status: 'MISS' });
  const forced = response(); await nodeApiHandler({ method: 'GET', url: `${url()}&refresh=1`, headers: {} }, forced.res);
  expect(forced.headers['vercel-cdn-cache-control']).toBeUndefined();
  expect(vi.mocked(loadPublicSearch).mock.calls.at(-1)?.[2]).toEqual({ force: true });
});

it('does not cache upstream failures or invalid search requests', async () => {
  vi.mocked(loadPublicSearch).mockRejectedValue(new G2bError(504, 'SEARCH_INCOMPLETE', '전체 공고 조회 실패'));
  const failed = response(); await nodeApiHandler({ method: 'GET', url: url(), headers: {} }, failed.res);
  expect(failed.res.statusCode).toBe(504); expect(failed.headers['vercel-cdn-cache-control']).toBeUndefined(); expect(failed.body().error.code).toBe('SEARCH_INCOMPLETE');
  vi.mocked(loadPublicSearch).mockClear();
  const invalid = response(); await nodeApiHandler({ method: 'GET', url: `${url().replace('window=0', 'window=9')}`, headers: {} }, invalid.res);
  expect(invalid.res.statusCode).toBe(400); expect(loadPublicSearch).not.toHaveBeenCalled(); expect(invalid.headers['vercel-cdn-cache-control']).toBeUndefined();
});
