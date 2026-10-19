import { afterEach, expect, it, vi } from 'vitest';
import { IndexedNoticesController, browserIndexedNoticeRepository, normalizeIndexedSearch, type IndexedNoticeRepository } from '../src/live/indexed-notice-search';
import type { VerifiedNoticeSearchPage, VerifiedNoticeSearchResults, VerifiedNoticeSearchStatus } from '../src/live/active-catalog-types';
import { DEFAULT_FILTERS, NOTICES } from '../src/data';
import { ApiError, fetchApi } from '../src/live/client';
vi.mock('../src/live/client', async original => ({ ...await original<typeof import('../src/live/client')>(), fetchApi: vi.fn() }));
const query = () => ({ type: '공사·용역' as const, from: '1995-10-01', to: '2100-12-31', keyword: '철거', filters: { ...DEFAULT_FILTERS, category: '전체' as const, status: '전체' as const }, profile: { province: '서울특별시', district: '강남구' } });
const page = (patch: Partial<VerifiedNoticeSearchPage> = {}): VerifiedNoticeSearchPage => ({ items: [NOTICES[0]], totalCount: 501, page: 1, pageSize: 50, hasMore: true, nextCursor: 'next-1', snapshotVersion: 'epoch1', asOf: '2026-10-15T03:00:00Z', fetchedAt: '2026-10-15T03:00:00Z', source: '검증된 색인', indexCoverage: { complete: true, pending: 0, checked: 746 }, sourceSyncedThrough: '2026-10-15T02:58:00Z', verifiedCount: 510, pendingCount: 9, conditionPendingCount: 3, storage: { bytes: 100, ceiling: 1000, full: false }, ...patch });
function controller(search: IndexedNoticeRepository['search']) { const instance = new IndexedNoticesController({ search }); instance.setUser('public'); return instance; }
afterEach(() => vi.useRealTimers());
it('sends saved official codes in both result and status requests, and omits them when off', async () => {
  vi.mocked(fetchApi).mockClear(); vi.mocked(fetchApi).mockResolvedValue(page());
  const input = normalizeIndexedSearch({ ...query(), filters: { ...query().filters, autoRegion: true },
    profile: { ...query().profile, licenseCodes: ['4995', '0002', '4995'] } });
  await browserIndexedNoticeRepository.search(input, new AbortController().signal);
  await browserIndexedNoticeRepository.status!({ ...input, asOf: page().asOf, snapshotVersion: '123' }, new AbortController().signal);
  for (const [path] of vi.mocked(fetchApi).mock.calls) {
    const params = new URL(path, 'https://example.test').searchParams;
    expect(JSON.parse(params.get('companyRegion')!)).toEqual({ ...query().profile, licenseCodes: ['0002', '4995'] });
  }
  vi.mocked(fetchApi).mockClear();
  await browserIndexedNoticeRepository.search(normalizeIndexedSearch({ ...query(), filters: { ...query().filters, regionView: 'excluded' },
    profile: { ...query().profile, licenseCodes: ['4995'] } }), new AbortController().signal);
  expect(JSON.parse(new URL(vi.mocked(fetchApi).mock.calls[0][0], 'https://example.test').searchParams.get('companyRegion')!)).toEqual(query().profile);
  vi.mocked(fetchApi).mockClear();
});
it('gets both businesses, full filters and only minimal company geography in one 50-item request', async () => {
  const input = { ...query(), profile: { ...query().profile, companyName: 'DO NOT SEND', email: 'secret@example.test', licenses: ['PRIVATE'] }, filters: { ...query().filters, license: '철거면허', minAmount: '100', maxAmount: '200', contractMethod: '제한경쟁', excludeKeyword: '설계', regions: [{ province: '경기', district: '성남시' }], statuses: ['예정' as const], sort: 'amountDesc' as const, autoRegion: true } };
  vi.mocked(fetchApi).mockResolvedValueOnce(page()); await browserIndexedNoticeRepository.search(normalizeIndexedSearch(input), new AbortController().signal);
  expect(fetchApi).toHaveBeenCalledTimes(1); const path = vi.mocked(fetchApi).mock.calls[0][0]; const params = new URL(path, 'https://example.test').searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ mode: 'search-results', type: '공사·용역', from: '1995-10-01', to: '2100-12-31', limit: '50' });
  expect(JSON.parse(params.get('filters')!)).toMatchObject({ license: '철거면허', minAmount: '100', maxAmount: '200', contractMethod: '제한경쟁', excludeKeyword: '설계', sort: 'amountDesc', autoRegion: true, statuses: ['예정'], regions: [{ province: '경기도', district: '성남시' }] });
  expect(JSON.parse(params.get('companyRegion')!)).toEqual(query().profile); expect(path).not.toMatch(/DO NOT SEND|secret|PRIVATE|mode=number/);
});
const results = (patch: Partial<VerifiedNoticeSearchResults> = {}): VerifiedNoticeSearchResults => {
  const value = page();
  return { items: value.items, totalCount: value.totalCount, page: value.page, pageSize: value.pageSize, hasMore: value.hasMore,
    nextCursor: value.nextCursor, snapshotVersion: value.snapshotVersion, asOf: value.asOf, fetchedAt: value.fetchedAt, source: value.source, ...patch };
};
const status = (patch: Partial<VerifiedNoticeSearchStatus> = {}): VerifiedNoticeSearchStatus => {
  const value = page();
  return { snapshotVersion: value.snapshotVersion, asOf: value.asOf, indexCoverage: value.indexCoverage, sourceSyncedThrough: value.sourceSyncedThrough,
    verifiedCount: value.verifiedCount, pendingCount: value.pendingCount, conditionPendingCount: value.conditionPendingCount, storage: value.storage, ...patch };
};
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
async function settleMetadata() { for (let tick = 0; tick < 8; tick++) await Promise.resolve(); }
it('requests status separately with the first fast result anchor and never a pagination cursor', async () => {
  vi.mocked(fetchApi).mockClear(); vi.mocked(fetchApi).mockResolvedValueOnce(status());
  await browserIndexedNoticeRepository.status!({ ...normalizeIndexedSearch(query()), asOf: page().asOf, snapshotVersion: '123' }, new AbortController().signal);
  const params = new URL(vi.mocked(fetchApi).mock.calls[0][0], 'https://example.test').searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ mode: 'search-status', asOf: page().asOf, snapshotVersion: '123', keyword: '철거' });
  expect(params.has('cursor')).toBe(false);
});
it('shows fast results while aggregate status is pending and requests status only once across pagination', async () => {
  const pending = deferred<VerifiedNoticeSearchStatus>();
  const search = vi.fn().mockResolvedValueOnce(results()).mockResolvedValueOnce(results({ items: [NOTICES[1]], nextCursor: null }));
  const metadata = vi.fn(() => pending.promise), instance = new IndexedNoticesController({ search, status: metadata }); instance.setUser('public');
  await instance.search(query());
  expect(instance.getSnapshot()).toMatchObject({ loading: false, items: [NOTICES[0]], totalCount: 501, meta: { status: null, statusLoading: true } });
  expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ asOf: page().asOf, snapshotVersion: 'epoch1' }), expect.any(AbortSignal));
  await instance.next(); expect(search).toHaveBeenCalledTimes(2); expect(metadata).toHaveBeenCalledOnce();
  const selectionKey = instance.getSnapshot().selectionKey;
  pending.resolve(status()); await settleMetadata();
  expect(instance.getSnapshot()).toMatchObject({ pageNumber: 2, items: [NOTICES[1]], meta: { statusLoading: false, status: { pendingCount: 9 } } });
  expect(instance.getSnapshot().selectionKey).toBe(selectionKey); instance.dispose();
});
it('keeps successful results when aggregate status fails instead of reporting a completed empty search', async () => {
  const instance = new IndexedNoticesController({ search: async () => results(), status: async () => { throw new Error('상태 연결 실패'); } }); instance.setUser('public');
  await instance.search(query()); await settleMetadata();
  expect(instance.getSnapshot()).toMatchObject({ loading: false, error: '', items: [NOTICES[0]], totalCount: 501,
    meta: { status: null, statusLoading: false, statusError: '상태 연결 실패' } }); instance.dispose();
});
it('aborts obsolete aggregate requests and cannot attach their late completion to a new filter query', async () => {
  const old = deferred<VerifiedNoticeSearchStatus>(), current = deferred<VerifiedNoticeSearchStatus>();
  const metadata = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
  const instance = new IndexedNoticesController({ search: vi.fn().mockResolvedValueOnce(results()).mockResolvedValueOnce(results({ items: [NOTICES[1]], snapshotVersion: 'epoch2' })), status: metadata }); instance.setUser('public');
  await instance.search(query()); const oldSignal = metadata.mock.calls[0][1];
  await instance.search({ ...query(), keyword: '석면' }); expect(oldSignal.aborted).toBe(true);
  current.resolve(status({ snapshotVersion: 'epoch2', pendingCount: 4 })); await settleMetadata();
  old.resolve(status({ pendingCount: 0, indexCoverage: { complete: true, checked: 746, pending: 0 } })); await settleMetadata();
  expect(instance.getSnapshot()).toMatchObject({ items: [NOTICES[1]], meta: { snapshotVersion: 'epoch2', status: { pendingCount: 4 } } }); instance.dispose();
});
it('keeps results visible but fences pagination when the status endpoint reports a changed result generation', async () => {
  const search = vi.fn(async () => results()), instance = new IndexedNoticesController({ search, status: async () => { throw new ApiError('공고 변경', 'SEARCH_CHANGED', 409); } }); instance.setUser('public');
  await instance.search(query()); await settleMetadata();
  expect(instance.getSnapshot()).toMatchObject({ items: [NOTICES[0]], stale: true, loading: false, meta: { status: null } });
  await instance.next(); expect(search).toHaveBeenCalledOnce(); instance.dispose();
});
it('expires visible results even while aggregate metadata is pending and ignores its late completion', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-15T03:00:00Z');
  const pending = deferred<VerifiedNoticeSearchStatus>(), metadata = vi.fn<NonNullable<IndexedNoticeRepository['status']>>(() => pending.promise);
  const instance = new IndexedNoticesController({ search: async () => results({ validUntil: '2026-10-15T03:01:00Z' }), status: metadata }); instance.setUser('public');
  await instance.search(query()); vi.advanceTimersByTime(60_000);
  expect(metadata.mock.calls[0][1].aborted).toBe(true);
  pending.resolve(status({ pendingCount: 0 })); await settleMetadata();
  expect(instance.getSnapshot()).toMatchObject({ items: [NOTICES[0]], stale: true, meta: { status: null, statusLoading: false } }); instance.dispose();
});
it('rejects aggregate metadata from a different phase cutoff without replacing a valid result page', async () => {
  const instance = new IndexedNoticesController({ search: async () => results(), status: async () => status({ asOf: '2026-10-15T03:01:00Z' }) }); instance.setUser('public');
  await instance.search(query()); await settleMetadata();
  expect(instance.getSnapshot()).toMatchObject({ items: [NOTICES[0]], stale: false, meta: { status: null, statusLoading: false } });
  expect(instance.getSnapshot().meta?.statusError).toContain('조회 기준이 달라'); instance.dispose();
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
