import { expect, it, vi } from 'vitest';
import { IndexedNoticesController, planIndexedNoticeSearch, type IndexedNoticeRepository } from '../src/live/indexed-notice-search';
import type { BidNotice } from '../src/types';
import type { G2bNoticePage } from '../src/g2b-types';
import { NOTICES } from '../src/data';
const now = Date.parse('2026-10-15T03:00:00Z');
const query = { type: '공사·용역' as const, from: '2026-04-15', to: '2027-04-15', keyword: '' };
const notice = (number = 'R1', patch: Partial<BidNotice> = {}): BidNotice => ({ ...NOTICES[0], id: number, number, revision: '000', type: '공사', source: 'live', title: '철거 공사', status: '접수중', biddingStartAt: '2026-10-01T10:00:00+09:00', deadline: '2026-10-20T10:00:00+09:00', openingAt: '2026-10-20T11:00:00+09:00', postedAt: '2000-01-01T10:00:00+09:00', ...patch });
const page = (items: BidNotice[], hasMore = false): G2bNoticePage => ({ items, totalCount: items.length, hasMore, page: 1, pageSize: 100, fetchedAt: new Date(now).toISOString(), source: '나라장터' });
function controller(rows: BidNotice[], lookup: IndexedNoticeRepository['lookup'] = async row => page(rows.filter(item => item.number === row.number))) {
  const store: IndexedNoticeRepository = { notices: async source => page(source.type === '공사' ? rows : []), lookup };
  const instance = new IndexedNoticesController(store, () => now); instance.setUser('public'); return instance;
}
it('plans only exact indexed deadline bounds per business without private settings or historical date axes', () => {
  expect(planIndexedNoticeSearch(query).sources).toEqual(['공사','용역'].map(type => ({ type, from: query.from, to: query.to, keyword: '' })));
  expect(() => planIndexedNoticeSearch({ ...query, to: '2027-04-17' })).toThrow('367일');
});
it('publishes an old posting only after the entire current revision history is verified', async () => {
  const row = notice(); let resolve!: (value: G2bNoticePage) => void;
  const lookup = vi.fn(() => new Promise<G2bNoticePage>(yes => { resolve = yes; })); const instance = controller([row], lookup);
  const pending = instance.search(query); await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
  expect(instance.getSnapshot().items).toEqual([]); resolve(page([row])); await pending;
  expect(instance.getSnapshot().items).toEqual([row]);
});
it.each([{ revision: '001', status: '취소' as const }, { revision: '001', deadline: '2027-05-01T10:00:00+09:00' }, { revision: '001', openingCompleted: true }])('uses the latest cancellation, deadline and completion facts: %o', async patch => {
  const row = notice(); const instance = controller([row], async () => page([row, notice('R1', patch)])); await instance.search(query); expect(instance.getSnapshot().items).toEqual([]);
});
it('keeps an incomplete exact lookup pending for retry instead of showing an unchecked original', async () => {
  const row = notice(); const lookup = vi.fn().mockResolvedValueOnce({ ...page([row]), totalCount: 2 }).mockResolvedValueOnce(page([row]));
  const instance = controller([row], lookup); await instance.search(query);
  expect(instance.getSnapshot()).toMatchObject({ items: [], hasMore: true }); expect(instance.getSnapshot().error).toBeTruthy();
  await instance.loadMore(); expect(instance.getSnapshot()).toMatchObject({ items: [row], hasMore: false, error: '' });
});
it('preserves verified index region and license facts only for the exact same revision and source clock', async () => {
  const sourceUpdatedAt = '2026-10-15T10:00:00+09:00';
  const row = { ...notice('R1', { sourceUpdatedAt, allowedRegions: ['전국'], licenses: ['철거면허'] }), regionComplete: true, licenseComplete: true };
  const exact = notice('R1', { sourceUpdatedAt, allowedRegions: null, licenses: [] });
  const instance = controller([row], async () => page([exact])); await instance.search(query);
  expect(instance.getSnapshot().items[0]).toMatchObject({ allowedRegions: ['전국'], licenses: ['철거면허'], regionComplete: true, licenseComplete: true });
  for (const patch of [{ revision: '001' }, { sourceUpdatedAt: '2026-10-15T11:00:00+09:00' }]) {
    const latest = { ...exact, ...patch };
    const changed = controller([row], async () => page(latest.revision === exact.revision ? [latest] : [exact, latest]));
    await changed.search(query); expect(changed.getSnapshot().items[0]).toMatchObject({ allowedRegions: null, licenses: [] });
  }
});
it('checks a bounded number of candidates and continues without repeating already verified identities', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => notice(`R${index}`)); const lookup = vi.fn(async (row: BidNotice) => page(rows.filter(item => item.number === row.number)));
  const instance = controller(rows, lookup); await instance.search(query);
  expect(instance.getSnapshot()).toMatchObject({ checkedCount: 20, hasMore: true }); await instance.loadMore();
  expect(instance.getSnapshot()).toMatchObject({ checkedCount: 25, hasMore: false }); expect(lookup).toHaveBeenCalledTimes(25);
});
it('ignores a late response after the search owner changes', async () => {
  let resolve!: (value: G2bNoticePage) => void; const row = notice();
  const instance = controller([row], () => new Promise(yes => { resolve = yes; })); const pending = instance.search(query);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function')); instance.setUser('other'); resolve(page([row])); await pending;
  expect(instance.getSnapshot()).toMatchObject({ userId: 'other', items: [] });
});
