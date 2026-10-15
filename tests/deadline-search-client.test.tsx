import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_ALERT_SETTINGS, type AlertNotice } from '../src/alerts/types';
import { NOTICES } from '../src/data';
import { CustomNoticesController, browserCustomNoticeRepository, planCustomNoticeSearch, type CustomNoticeQuery } from '../src/live/custom-notice-search';
import { LiveSearch } from '../src/live/LiveSearch';
import { fetchApi } from '../src/live/client';
vi.mock('../src/live/client', async original => ({ ...await original<typeof import('../src/live/client')>(), fetchApi: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const now = Date.parse('2026-10-15T03:00:00Z');
const query = (): CustomNoticeQuery => ({ settings: { ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: false, filter: { ...structuredClone(DEFAULT_ALERT_SETTINGS.filter), keywords: [], categories: [], regions: [], licenses: [], types: ['공사','용역'], useCompanyRegion: false } }, profile: null, basis: 'deadline', from: '2026-04-15', to: '2027-04-15' });
const row = (patch: Partial<AlertNotice> = {}): AlertNotice => ({ ...NOTICES[0], source: 'live', number: 'R1', revision: '000', type: '공사', status: '접수중', deadline: '2026-10-20T18:00:00+09:00', openingAt: '2026-10-21T11:00:00+09:00', biddingStartAt: '2026-10-10T10:00:00+09:00', postedAt: '2020-01-01T00:00:00+09:00', sourceUpdatedAt: '2020-01-01T00:00:00+09:00', regionComplete: true, licenseComplete: true, ...patch });
const page = (items: AlertNotice[]) => ({ items, totalCount: items.length, hasMore: false, page: 1, pageSize: 100, source: '나라장터', fetchedAt: new Date(now).toISOString(), indexCoverage: { complete: false, pending: 3, checked: 6 } });
it('queries only exact deadline index bounds once per business, independent of publication age', async () => {
  const plan = planCustomNoticeSearch(query());
  expect(plan.sources).toHaveLength(2);
  expect(plan.sources).toEqual(['공사','용역'].map(type => expect.objectContaining({ type, from: '2026-04-15', to: '2027-04-15', basis: 'deadline' })));
  vi.mocked(fetchApi).mockResolvedValue(page([]));
  await browserCustomNoticeRepository.notices(plan.sources[0], 2, new AbortController().signal);
  const params = new URL(String(vi.mocked(fetchApi).mock.calls[0][0]), 'https://test.local').searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ mode: 'deadline', page: '2', from: '2026-04-15', to: '2027-04-15' });
});
it('rejects a manually selected 368-day range before making an index request', () => {
  expect(() => planCustomNoticeSearch({ ...query(), to: '2027-04-17' })).toThrow('367일');
  expect(fetchApi).not.toHaveBeenCalled();
});
it('verifies the latest revision and rechecks its actual deadline and opening status before showing it', async () => {
  const original = row(), latest = row({ revision: '001', deadline: '2027-05-01T18:00:00+09:00', sourceUpdatedAt: '2026-10-15T10:00:00+09:00' });
  const lookup = vi.fn(async () => page([latest,original]));
  const controller = new CustomNoticesController({ notices: async source => page(source.type === '공사' ? [original] : []), lookup, detail: vi.fn() }, () => now);
  controller.setUser('a'); await controller.search(query());
  expect(lookup).toHaveBeenCalledOnce(); expect(controller.getSnapshot().items).toEqual([]);
  expect(controller.getSnapshot().indexCoverage).toEqual({ complete: false, pending: 3, checked: 6 });
});
it('does not show a future-deadline notice whose opening is already complete', async () => {
  const original = row({ openingAt: '2026-10-14T11:00:00+09:00' });
  const controller = new CustomNoticesController({ notices: async source => page(source.type === '공사' ? [original] : []), lookup: async () => page([original]), detail: vi.fn() }, () => now);
  controller.setUser('a'); await controller.search(query()); expect(controller.getSnapshot().items).toEqual([]);
});
it('preserves identity-checked region and license enrichment on a verified visible row', async () => {
  const original = row();
  const controller = new CustomNoticesController({ notices: async source => page(source.type === '공사' ? [original] : []), lookup: async () => page([original]), detail: vi.fn() }, () => now);
  controller.setUser('a'); await controller.search(query());
  controller.applyDetail(original.id, { number: original.number, revision: original.revision, regionComplete: true, licenseComplete: true, allowedRegions: ['서울특별시'], licenses: ['철거면허'], fetchedAt: new Date(now).toISOString(), warnings: [] });
  expect(controller.getSnapshot().items[0]).toMatchObject({ allowedRegions: ['서울특별시'], licenses: ['철거면허'] });
  controller.applyDetail(original.id, { number: 'OTHER', revision: original.revision, regionComplete: true, licenseComplete: true, allowedRegions: ['경기도'], licenses: ['다른면허'], fetchedAt: new Date(now).toISOString(), warnings: [] });
  expect(controller.getSnapshot().items[0].allowedRegions).toEqual(['서울특별시']);
});
it('labels the general search with deadline dates, symmetric month buttons and optional keyword', () => {
  const html = renderToStaticMarkup(<LiveSearch query={{ type: '공사·용역', from:'2026-04-15', to:'2027-04-15', keyword:'' }} loading={false} onSearch={() => {}} onRefresh={() => {}} />);
  for (const text of ['입찰서 제출마감', '전후 1개월', '전후 3개월', '전후 6개월']) expect(html).toContain(text);
  expect(html).not.toContain('이전 90일');
  expect(html).toContain('공고명 검색 (비우면 전체)');
  expect(html).not.toContain('공고명·기관 검색');
  expect(html.match(/<input[^>]*name="keyword"[^>]*>/)?.[0]).not.toContain('required');
  expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toContain('disabled');
});
