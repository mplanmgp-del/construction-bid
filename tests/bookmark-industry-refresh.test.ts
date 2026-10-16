import { describe, expect, it, vi } from 'vitest';
import { NOTICES, DEFAULT_FILTERS, DEMO_PROFILES } from '../src/data';
import { filterNotices } from '../src/domain';
import { emptyMemberWorkspace } from '../src/member/workspace';
import { bookmarkIndustryKey, browserBookmarkIndustryRepository, loadBookmarkIndustryBatch,
  mergeBookmarkIndustryBatch, needsBookmarkIndustryRefresh, withSavedIndustryFacts } from '../src/live/bookmark-industry-refresh';
import type { BidNotice } from '../src/types';
import type { G2bNoticeDetail } from '../src/g2b-types';

vi.mock('../src/member/client', () => ({ getMemberClient: () => null }));
const notice = (index = 0): BidNotice => ({ ...NOTICES[0], source: 'live', id: `saved-${index}`, number: `R26BK${String(index).padStart(8, '0')}`,
  licenses: ['구조물해체·비계공사업'], licenseCodes: undefined, status: '접수중', deadline: '2026-11-20T10:00:00+09:00', openingAt: '2026-11-20T11:00:00+09:00' });
const detail = (bid: BidNotice, codes: string[] = ['4995']): G2bNoticeDetail => ({ number: bid.number, revision: bid.revision,
  licenses: ['구조물해체ㆍ비계공사업/4995'], licenseCodes: codes, allowedRegions: null, regionComplete: false, licenseComplete: true, fetchedAt: '', warnings: [] });

describe('bounded saved notice industry refresh', () => {
  it('checks all legacy live facts, including coded primary labels, while leaving demos and confirmed empty code arrays settled', () => {
    expect(needsBookmarkIndustryRefresh(notice())).toBe(true);
    expect(needsBookmarkIndustryRefresh({ ...notice(), source: 'demo' })).toBe(false);
    expect(needsBookmarkIndustryRefresh({ ...notice(), licenseCodes: [] })).toBe(false);
    expect(needsBookmarkIndustryRefresh({ ...notice(), licenses: ['구조물해체ㆍ비계공사업/4995'] })).toBe(true);
  });

  it('fetches at most ten records with two concurrent lanes and returns a complete batch', async () => {
    let running = 0, maximum = 0;
    const repository = vi.fn(async (bid: BidNotice) => {
      maximum = Math.max(maximum, ++running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running--; return detail(bid);
    });
    const result = await loadBookmarkIndustryBatch(Array.from({ length: 25 }, (_, index) => notice(index)), new AbortController().signal, repository);
    expect(repository).toHaveBeenCalledTimes(10);
    expect(maximum).toBe(2); expect(result.results).toHaveLength(10); expect(result.failed).toEqual([]);
  });

  it('aborts a partially completed batch without returning a write, and can resume that snapshot later', async () => {
    const abort = new AbortController();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const bids = [notice(0), notice(1), notice(2)];
    const repository = vi.fn(async (bid: BidNotice) => { await pending; return detail(bid); });
    const work = loadBookmarkIndustryBatch(bids, abort.signal, repository);
    abort.abort(); finish();
    expect(await work).toEqual({ results: [], failed: [] });
    expect(repository).toHaveBeenCalledTimes(2);
    const resumed = await loadBookmarkIndustryBatch(bids, new AbortController().signal, async bid => detail(bid));
    expect(resumed.results).toHaveLength(3);
  });

  it('keeps failed and wrong-identity responses retryable but treats successful missing codes as settled unknown', async () => {
    const bids = [notice(0), notice(1), notice(2)];
    const result = await loadBookmarkIndustryBatch(bids, new AbortController().signal, async bid => {
      if (bid.id === bids[0].id) throw new Error('offline');
      if (bid.id === bids[1].id) return { ...detail(bid), revision: '999' };
      return { ...detail(bid), licenses: [], licenseCodes: undefined };
    });
    expect(new Set(result.failed)).toEqual(new Set(bids.slice(0, 2).map(bookmarkIndustryKey)));
    expect(result.results[0].detail.licenseCodes).toEqual([]);
  });

  it('updates only still-bookmarked exact records in the captured account and makes the code filter match', () => {
    const bid = notice();
    const workspace = { ...emptyMemberWorkspace('owner'), bookmarks: [bid.id], noticeSnapshots: { [bid.id]: bid } };
    const results = [{ notice: bid, detail: detail(bid) }];
    expect(mergeBookmarkIndustryBatch(workspace, 'another', results)).toBe(workspace);
    const removed = { ...workspace, bookmarks: [] };
    expect(mergeBookmarkIndustryBatch(removed, 'owner', results)).toBe(removed);
    const changed = { ...workspace, noticeSnapshots: { [bid.id]: { ...bid, revision: '999' } } };
    expect(mergeBookmarkIndustryBatch(changed, 'owner', results)).toBe(changed);
    const filtered = { ...DEFAULT_FILTERS, category: '전체' as const, status: '전체' as const, license: '4995', autoRegion: false };
    const now = Date.parse('2026-10-16T12:00:00+09:00');
    expect(filterNotices([bid], filtered, DEMO_PROFILES[0], now)).toHaveLength(0);
    const saved = mergeBookmarkIndustryBatch(workspace, 'owner', results);
    const visible = withSavedIndustryFacts(bid, saved.noticeSnapshots[bid.id]);
    expect(visible.licenseCodes).toEqual(['4995']);
    expect(filterNotices([visible], filtered, DEMO_PROFILES[0], now)).toHaveLength(1);
    expect(withSavedIndustryFacts({ ...bid, sourceUpdatedAt: 'new' }, { ...visible, sourceUpdatedAt: 'old' }).licenseCodes).toBeUndefined();
  });

  it('uses the existing authenticated detail endpoint for each exact type, number and revision', async () => {
    const bid = notice(); const fetcher = vi.fn(async (_path: string) => Response.json(detail(bid)));
    vi.stubGlobal('fetch', fetcher);
    try {
      await browserBookmarkIndustryRepository(bid, new AbortController().signal);
      const path = new URL(String(fetcher.mock.calls[0][0]), 'https://example.test');
      expect(path.pathname).toBe('/api/detail');
      expect(Object.fromEntries(path.searchParams)).toEqual({ number: bid.number, revision: bid.revision, type: bid.type });
    } finally { vi.unstubAllGlobals(); }
  });
  it('refreshes a legacy coded primary label so a permitted alternative code enters the actual bookmark filter', async () => {
    const bid = { ...notice(), licenses: ['구조물해체ㆍ비계공사업/4995'] };
    const workspace = { ...emptyMemberWorkspace('owner'), bookmarks: [bid.id], noticeSnapshots: { [bid.id]: bid } };
    const filter = { ...DEFAULT_FILTERS, category: '전체' as const, status: '전체' as const, license: '0002', autoRegion: false };
    const now = Date.parse('2026-10-16T12:00:00+09:00');
    expect(filterNotices([bid], filter, DEMO_PROFILES[0], now)).toHaveLength(0);
    const repository = vi.fn(async (target: BidNotice) => detail(target, ['4995', '0002']));
    const { results } = await loadBookmarkIndustryBatch([bid], new AbortController().signal, repository);
    expect(repository).toHaveBeenCalledOnce();
    const saved = mergeBookmarkIndustryBatch(workspace, 'owner', results);
    const visible = withSavedIndustryFacts(bid, saved.noticeSnapshots[bid.id]);
    expect(visible.licenseCodes).toEqual(['4995', '0002']);
    expect(filterNotices([visible], filter, DEMO_PROFILES[0], now)).toHaveLength(1);
    expect(needsBookmarkIndustryRefresh(visible)).toBe(false);
  });
  it('never overlays saved codes across a missing/known clock boundary and requires exact fresh detail to upgrade a missing saved clock', () => {
    const legacy = notice(), known = { ...notice(), sourceUpdatedAt: '2026-10-16T10:00:00+09:00' };
    for (const [current, captured] of [[legacy, known], [known, legacy]]) {
      const coded = { ...captured, licenseCodes: ['4995'] };
      expect(withSavedIndustryFacts(current, coded)).toBe(current);
      const workspace = { ...emptyMemberWorkspace('owner'), bookmarks: [current.id], noticeSnapshots: { [current.id]: current } };
      const result = { notice: captured, detail: detail(captured) };
      expect(mergeBookmarkIndustryBatch(workspace, 'owner', [result])).toBe(workspace);
    }
  });
  it('rejects a cached older detail, a newer detail, or a missing response clock against a known captured generation', async () => {
    const bid = { ...notice(), sourceUpdatedAt: '2026-10-16T10:00:00+09:00' };
    for (const responseClock of ['2026-10-16T09:00:00+09:00', '2026-10-16T11:00:00+09:00', undefined]) {
      const response = { ...detail(bid), notice: { ...bid, sourceUpdatedAt: responseClock } };
      const result = await loadBookmarkIndustryBatch([bid], new AbortController().signal, async () => response);
      expect(result).toEqual({ results: [], failed: [bookmarkIndustryKey(bid)] });
      const workspace = { ...emptyMemberWorkspace('owner'), bookmarks: [bid.id], noticeSnapshots: { [bid.id]: bid } };
      expect(mergeBookmarkIndustryBatch(workspace, 'owner', [{ notice: bid, detail: response }])).toBe(workspace);
    }
    const matching = await loadBookmarkIndustryBatch([bid], new AbortController().signal, async () => ({ ...detail(bid), notice: bid }));
    expect(matching.results).toHaveLength(1);
  });
  it('establishes the detail source clock alongside codes when upgrading a legacy unclocked snapshot', async () => {
    const bid = notice(), fetched = { ...bid, title: '공식 최신 공고명', sourceUpdatedAt: '2026-10-16T10:00:00+09:00' };
    const workspace = { ...emptyMemberWorkspace('owner'), bookmarks: [bid.id], noticeSnapshots: { [bid.id]: bid } };
    const { results } = await loadBookmarkIndustryBatch([bid], new AbortController().signal, async () => ({ ...detail(bid), notice: fetched }));
    const saved = mergeBookmarkIndustryBatch(workspace, 'owner', results);
    expect(saved.noticeSnapshots[bid.id]).toMatchObject({ title: fetched.title, licenseCodes: ['4995'], sourceUpdatedAt: fetched.sourceUpdatedAt });
    expect(withSavedIndustryFacts(fetched, saved.noticeSnapshots[bid.id]).licenseCodes).toEqual(['4995']);
    expect(withSavedIndustryFacts(bid, saved.noticeSnapshots[bid.id]).licenseCodes).toBeUndefined();
  });
  it.each([undefined, '2026-10-16T09:00:00+09:00'])('upgrades an older saved snapshot (%s) through the actual newer available-list path', async oldClock => {
    const savedBid = { ...notice(), title: '기존 공고명', sourceUpdatedAt: oldClock };
    const available = { ...notice(), title: '변경된 공고명', sourceUpdatedAt: '2026-10-16T10:00:00+09:00' };
    const workspace = { ...emptyMemberWorkspace('owner'), bookmarks: [savedBid.id], noticeSnapshots: { [savedBid.id]: savedBid } };
    // App merges saved first, available second, then adds saved facts only when
    // clocks agree. Its fresh target must still be able to upgrade old storage.
    const raw = withSavedIndustryFacts(available, savedBid);
    const filter = { ...DEFAULT_FILTERS, category: '전체' as const, status: '전체' as const, license: '0002', autoRegion: false };
    const now = Date.parse('2026-10-16T12:00:00+09:00');
    expect(filterNotices([raw], filter, DEMO_PROFILES[0], now)).toHaveLength(0);
    const fetched = { ...detail(raw, ['4995', '0002']), notice: { ...available, documents: [{ name: '현재 공고문.pdf', size: '' }] } };
    const { results } = await loadBookmarkIndustryBatch([raw], new AbortController().signal, async () => fetched);
    const updated = mergeBookmarkIndustryBatch(workspace, 'owner', results);
    expect(updated.noticeSnapshots[savedBid.id]).toMatchObject({ title: available.title, sourceUpdatedAt: available.sourceUpdatedAt,
      licenseCodes: ['4995', '0002'], documents: [{ name: '현재 공고문.pdf' }] });
    const visible = withSavedIndustryFacts(available, updated.noticeSnapshots[savedBid.id]);
    expect(filterNotices([visible], filter, DEMO_PROFILES[0], now)).toHaveLength(1);
    const newer = { ...workspace, noticeSnapshots: { [savedBid.id]: { ...savedBid, sourceUpdatedAt: '2026-10-16T11:00:00+09:00' } } };
    expect(mergeBookmarkIndustryBatch(newer, 'owner', results)).toBe(newer);
  });
});
