import { afterEach, expect, it, vi } from 'vitest';
import { createG2bClient, type SearchQuery } from '../server/g2b';
import { startSearchWindows } from '../src/live/start-range';
import { fetchStartedNotices } from '../src/live/notice-search';
const query: SearchQuery = { type: '공사', from: '2026-10-07', to: '2026-10-13', keyword: '철거', page: 1, pageSize: 100 };
const response = (items: unknown[], totalCount = items.length) => Response.json({ response: { header: { resultCode: '00' }, body: { items, totalCount } } });
afterEach(() => vi.unstubAllGlobals());
it('covers every posting day from 90 days before the start, once, within 31-day windows', () => {
  const windows = startSearchWindows(query.from, query.to);
  expect(windows).toHaveLength(4);
  expect(windows[0].to).toBe('2026-10-13'); expect(windows.at(-1)?.from).toBe('2026-07-09');
  const dates: number[] = [];
  for (const window of windows) { expect(Date.parse(window.to) - Date.parse(window.from)).toBeLessThan(31 * 86400000); for (let d = Date.parse(window.from); d <= Date.parse(window.to); d += 86400000) dates.push(d); }
  expect(new Set(dates).size).toBe(97); expect(dates).toHaveLength(97);
});
it('includes older postings by Korean bidding start date, includes both day boundaries, excludes missing or out-of-range starts', async () => {
  const starts = ['2026-10-07 00:00:00', '2026-10-13 23:59:59', '2026-10-06 23:59:59', '2026-10-14 00:00:00', ''];
  const fetcher = vi.fn(async (url: URL | Request | string) => String(url).includes('PrtcptPsblRgn') ? response([]) : response(starts.map((bidBeginDt, i) => ({ bidNtceNo: `R${i}`, bidNtceOrd: '000', bidNtceNm: '철거', bidNtceDt: '2026-09-28 14:22:09', bidBeginDt }))));
  const result = await createG2bClient({ serviceKey: 'test', fetcher: fetcher as typeof fetch }).startNotices(query, 0);
  expect(result.totalCount).toBe(2); expect(result.items.map(x => x.number)).toEqual(['R0', 'R1']);
  expect(result.items[0].postedAt).toContain('2026-09-28'); expect(result.items[0].biddingStartAt).toBe('2026-10-07T00:00:00+09:00');
});
it('reads the final provider page automatically instead of returning only the first 100 rows', async () => {
  const fetcher = vi.fn(async (input: URL | Request | string) => {
    const url = new URL(String(input));
    if (url.pathname.includes('PrtcptPsblRgn')) return response([]);
    const second = url.searchParams.get('pageNo') === '2';
    return response(Array.from({ length: second ? 1 : 100 }, (_, i) => ({ bidNtceNo: `R${second ? 100 : i}`, bidNtceOrd: '000', bidBeginDt: '2026-10-07 09:00:00' })), 101);
  });
  const result = await createG2bClient({ serviceKey: 'test', fetcher: fetcher as typeof fetch }).startNotices(query, 0);
  expect(result.items).toHaveLength(101); expect(result.hasMore).toBe(false);
});
it('rejects truncated or duplicate pages instead of claiming complete search', async () => {
  const fetcher = vi.fn(async () => response([{ bidNtceNo: 'R1', bidNtceOrd: '000' }], 3));
  await expect(createG2bClient({ serviceKey: 'test', fetcher: fetcher as typeof fetch }).startNotices(query, 0)).rejects.toThrow('전체 공고 수집');
});
it('automatically completes all business and posting windows in one search', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const url = new URL(path, 'https://example.test'); const id = `${url.searchParams.get('type')}:${url.searchParams.get('window')}`; calls.push(id);
    return Response.json({ items: [{ id }], totalCount: 1, hasMore: false, fetchedAt: '2026-10-13T00:00:00Z' });
  }));
  const progress = vi.fn();
  const result = await fetchStartedNotices({ ...query, type: '공사·용역' }, new AbortController().signal, progress);
  expect(calls).toHaveLength(8); expect(new Set(calls).size).toBe(8);
  expect(result.totalCount).toBe(8); expect(result.hasMore).toBe(false); expect(progress).toHaveBeenLastCalledWith(8, 8);
});
it('fails the whole search if one automatic window fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: '조회 실패' } }, { status: 503 })));
  await expect(fetchStartedNotices(query, new AbortController().signal, () => {})).rejects.toThrow('조회 실패');
});
