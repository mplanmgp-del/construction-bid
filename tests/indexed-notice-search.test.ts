import { afterEach, expect, it, vi } from 'vitest';
import { IndexedNoticesController, browserIndexedNoticeRepository, normalizeIndexedSearch, type IndexedNoticeRepository } from '../src/live/indexed-notice-search';
import type { VerifiedNoticeSearchPage } from '../src/live/active-catalog-types';
import { DEFAULT_FILTERS, NOTICES } from '../src/data';
import { ApiError, fetchApi } from '../src/live/client';
vi.mock('../src/live/client', async original => ({ ...await original<typeof import('../src/live/client')>(), fetchApi: vi.fn() }));
const query = () => ({ type: '공사·용역' as const, from: '1995-10-01', to: '2100-12-31', keyword: '철거', filters: { ...DEFAULT_FILTERS, category: '전체' as const, status: '전체' as const }, profile: { province: '서울특별시', district: '강남구' } });
const page = (patch: Partial<VerifiedNoticeSearchPage> = {}): VerifiedNoticeSearchPage => ({ items: [NOTICES[0]], totalCount: 501, page: 1, pageSize: 50, hasMore: true, nextCursor: 'next-1', snapshotVersion: 'epoch1', asOf: '2026-10-15T03:00:00Z', fetchedAt: '2026-10-15T03:00:00Z', source: '검증된 색인', indexCoverage: { complete: true, pending: 0, checked: 746 }, sourceSyncedThrough: '2026-10-15T02:58:00Z', verifiedCount: 510, pendingCount: 9, conditionPendingCount: 3, storage: { bytes: 100, ceiling: 1000, full: false }, ...patch });
function controller(search: IndexedNoticeRepository['search']) { const instance = new IndexedNoticesController({ search }); instance.setUser('public'); return instance; }
afterEach(() => vi.useRealTimers());
it('gets both businesses, full filters and only minimal company geography in one 50-item request', async () => {
  const input = { ...query(), profile: { ...query().profile, companyName: 'DO NOT SEND', email: 'secret@example.test', licenses: ['PRIVATE'] }, filters: { ...query().filters, license: '철거면허', minAmount: '100', maxAmount: '200', contractMethod: '제한경쟁', excludeKeyword: '설계', regions: [{ province: '경기', district: '성남시' }], statuses: ['예정' as const], sort: 'amountDesc' as const, autoRegion: true } };
  vi.mocked(fetchApi).mockResolvedValueOnce(page()); await browserIndexedNoticeRepository.search(normalizeIndexedSearch(input), new AbortController().signal);
  expect(fetchApi).toHaveBeenCalledTimes(1); const path = vi.mocked(fetchApi).mock.calls[0][0]; const params = new URL(path, 'https://example.test').searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ mode: 'search', type: '공사·용역', from: '1995-10-01', to: '2100-12-31', limit: '50' });
  expect(JSON.parse(params.get('filters')!)).toMatchObject({ license: '철거면허', minAmount: '100', maxAmount: '200', contractMethod: '제한경쟁', excludeKeyword: '설계', sort: 'amountDesc', autoRegion: true, statuses: ['예정'], regions: [{ province: '경기도', district: '성남시' }] });
  expect(JSON.parse(params.get('companyRegion')!)).toEqual(query().profile); expect(path).not.toMatch(/DO NOT SEND|secret|PRIVATE|mode=number/);
});
it('keeps public searches stable while an unrelated member profile loads and keys company-region filtering by geography only', () => {
  const plain = normalizeIndexedSearch(query());
  expect(plain.profile).toBeUndefined();
  expect(normalizeIndexedSearch({ ...query(), profile: { province: '부산광역시', district: '중구' } })).toEqual(plain);
  const filtered = normalizeIndexedSearch({ ...query(), filters: { ...query().filters, autoRegion: true } });
  expect(filtered.profile).toEqual(query().profile);
  expect(normalizeIndexedSearch({ ...query(), filters: { ...query().filters, regionView: 'excluded' } }).profile).toEqual(query().profile);
});
it('publishes the globally sorted server page immediately without per-notice lookups or client resorting', async () => {
  const items = [NOTICES[2], NOTICES[0]], search = vi.fn(async () => page({ items })); const instance = controller(search);
  await instance.search(query()); expect(search).toHaveBeenCalledOnce(); expect(instance.getSnapshot()).toMatchObject({ items, totalCount: 501, pageNumber: 1, hasMore: true });
});
it('requests exactly one next cursor page and supports previous navigation without losing the global total', async () => {
  const search = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page({ items: [NOTICES[1]], nextCursor: null, hasMore: false })); const instance = controller(search);
  await instance.search(query()); await instance.next(); expect(search).toHaveBeenCalledTimes(2); expect(search.mock.calls[1][0].cursor).toBe('next-1');
  expect(instance.getSnapshot()).toMatchObject({ items: [NOTICES[1]], pageNumber: 2, totalCount: 501, hasPrevious: true });
  await instance.previous(); expect(instance.getSnapshot()).toMatchObject({ items: [NOTICES[0]], pageNumber: 1 }); expect(search).toHaveBeenCalledTimes(2);
});
it('keeps old results visibly stale after SEARCH_CHANGED without automatically restarting or combining snapshots', async () => {
  const search = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new ApiError('공고 변경', 'SEARCH_CHANGED', 409)); const instance = controller(search);
  await instance.search(query()); await instance.next(); expect(search).toHaveBeenCalledTimes(2);
  expect(instance.getSnapshot()).toMatchObject({ items: [NOTICES[0]], stale: true, pageNumber: 1 }); await instance.next(); expect(search).toHaveBeenCalledTimes(2);
  search.mockResolvedValueOnce(page({ snapshotVersion: 'epoch2' })); await instance.search(query()); expect(instance.getSnapshot().stale).toBe(false);
});
it('does not combine pages evaluated at different status cutoffs even under the same index version', async () => {
  const search = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(page({ asOf: '2026-10-15T03:01:00Z' }));
  const instance = controller(search); await instance.search(query()); await instance.next();
  expect(instance.getSnapshot()).toMatchObject({ stale: true, pageNumber: 1, items: [NOTICES[0]] });
});
it('rejects a server page whose status cutoff has already expired', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-15T03:01:00Z');
  const search = vi.fn(async () => page({ validUntil: '2026-10-15T03:01:00Z' })), instance = controller(search);
  await instance.search(query());
  expect(instance.getSnapshot()).toMatchObject({ items: [], stale: true, loading: false });
  expect(instance.getSnapshot().error).toContain('다시 검색'); await instance.next(); expect(search).toHaveBeenCalledOnce(); instance.dispose();
});
it('marks an idle page stale exactly at the returned boundary and blocks cursor navigation', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-15T03:00:00Z');
  const search = vi.fn(async () => page({ validUntil: '2026-10-15T03:01:00Z' })), instance = controller(search);
  await instance.search(query()); vi.advanceTimersByTime(59_999); expect(instance.getSnapshot().stale).toBe(false);
  vi.advanceTimersByTime(1); expect(instance.getSnapshot()).toMatchObject({ items: [NOTICES[0]], stale: true, loading: false });
  await instance.next(); await instance.previous(); expect(search).toHaveBeenCalledOnce(); instance.dispose();
});
it('does not resurrect an expired cached previous page when browser timers have been suspended', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-15T03:00:00Z');
  const search = vi.fn().mockResolvedValueOnce(page({ validUntil: '2026-10-15T03:01:00Z' }))
    .mockResolvedValueOnce(page({ items: [NOTICES[1]], validUntil: '2026-10-15T03:02:00Z' }));
  const instance = controller(search); await instance.search(query()); await instance.next();
  vi.setSystemTime('2026-10-15T03:01:01Z'); await instance.previous();
  expect(instance.getSnapshot()).toMatchObject({ pageNumber: 2, items: [NOTICES[1]], stale: true });
  expect(search).toHaveBeenCalledTimes(2); instance.dispose();
});
it('pins the first page and bounds other cached pages while preserving cursor navigation', async () => {
  const search = vi.fn(async (input: Parameters<IndexedNoticeRepository['search']>[0]) => {
    const index = input.cursor ? Number(input.cursor.replace('next-', '')) : 1;
    return page({ items: [{ ...NOTICES[0], id: `notice-${index}` }], totalCount: 1000, nextCursor: `next-${index + 1}` });
  });
  const instance = controller(search); await instance.search(query());
  for (let i = 0; i < 11; i++) await instance.next();
  expect(search).toHaveBeenCalledTimes(12);
  for (let i = 0; i < 11; i++) await instance.previous();
  expect(instance.getSnapshot()).toMatchObject({ pageNumber: 1, items: [{ ...NOTICES[0], id: 'notice-1' }] });
  expect(search.mock.calls.filter(([input]) => !input.cursor)).toHaveLength(1);
  expect(search.mock.calls.length).toBeGreaterThan(12); instance.dispose();
});
it('aborts an old filter request and ignores its late response', async () => {
  let resolve!: (value: VerifiedNoticeSearchPage) => void;
  const search = vi.fn().mockImplementationOnce(() => new Promise<VerifiedNoticeSearchPage>(yes => { resolve = yes; })).mockResolvedValueOnce(page({ items: [NOTICES[1]] })); const instance = controller(search);
  const pending = instance.search(query()); const oldSignal = search.mock.calls[0][1]; await instance.search({ ...query(), filters: { ...query().filters, license: '다른면허' } });
  resolve(page()); await pending; expect(oldSignal.aborted).toBe(true); expect(instance.getSnapshot().items).toEqual([NOTICES[1]]);
});
it('does not claim empty search completion when the server request fails', async () => {
  const instance = controller(async () => { throw new Error('연결 실패'); }); await instance.search(query());
  expect(instance.getSnapshot()).toMatchObject({ items: [], error: '연결 실패', loading: false }); expect(instance.getSnapshot().meta).toBeNull();
});
it('changes the selection key for every filter search and page change', async () => {
  const instance = controller(async () => page()); await instance.search(query()); const first = instance.getSnapshot().selectionKey;
  await instance.next(); expect(instance.getSnapshot().selectionKey).not.toBe(first); const second = instance.getSnapshot().selectionKey;
  await instance.search({ ...query(), filters: { ...query().filters, sort: 'newest' } }); expect(instance.getSnapshot().selectionKey).not.toBe(second);
});
