import { afterEach, expect, it, vi } from 'vitest';
import { fetchNoticePage } from '../src/live/notice-search';

afterEach(() => vi.unstubAllGlobals());
const query = { type: '공사·용역' as const, from: '2026-10-07', to: '2026-10-13', keyword: '철거' };
it('searches both businesses with the same dates and keyword, summing total independently of page length', async () => {
  const urls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const url = new URL(path, 'https://example.test'); urls.push(url);
    const construction = url.searchParams.get('type') === '공사';
    return Response.json({ items: [{ id: construction ? 'A' : 'B' }], totalCount: construction ? 130 : 22, page: 1, pageSize: 100, hasMore: construction, fetchedAt: '2026-10-13T01:00:00Z', source: '나라장터', warnings: construction ? ['지역 미확인'] : [] });
  }));
  const result = await fetchNoticePage(query, 1);
  expect(result.totalCount).toBe(152); expect(result.items).toHaveLength(2); expect(result.hasMore).toBe(true);
  expect(result.warnings).toEqual(['공사: 지역 미확인']);
  expect(urls.map(url => url.searchParams.get('type'))).toEqual(['공사', '용역']);
  for (const url of urls) for (const key of ['from', 'to', 'keyword'] as const) expect(url.searchParams.get(key)).toBe(query[key]);
});
it('does not hide a failed business behind a successful partial count', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new URL(path, 'https://example.test').searchParams.get('type') === '용역'
    ? Response.json({ error: { message: '일시 오류' } }, { status: 503 })
    : Response.json({ items: [], totalCount: 30 })));
  await expect(fetchNoticePage(query, 1)).rejects.toThrow('용역 조회 실패');
});
it('retains single-business search and forwards later pages', async () => {
  const fetcher = vi.fn(async (path: string) => {
    const url = new URL(path, 'https://example.test');
    expect(url.searchParams.get('type')).toBe('용역'); expect(url.searchParams.get('page')).toBe('2');
    return Response.json({ items: [], totalCount: 101, hasMore: false, fetchedAt: '2026-10-13T01:00:00Z', source: '나라장터' });
  });
  vi.stubGlobal('fetch', fetcher);
  expect((await fetchNoticePage({ ...query, type: '용역' }, 2)).hasMore).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
