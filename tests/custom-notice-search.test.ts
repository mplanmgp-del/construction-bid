import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTICES } from '../src/data';
import { DEFAULT_ALERT_SETTINGS, type AlertNotice, type AlertSettings } from '../src/alerts/types';
import type { G2bNoticeDetail, G2bNoticePage } from '../src/g2b-types';
import {
  CustomNoticesController, browserCustomNoticeRepository, planCustomNoticeSearch,
  visibleCustomNotices, CUSTOM_ACTIVE_MAX_DAYS, type CustomNoticeQuery, type CustomNoticeRepository,
} from '../src/live/custom-notice-search';
import { fetchApi } from '../src/live/client';

vi.mock('../src/live/client', async original => ({ ...await original<typeof import('../src/live/client')>(), fetchApi: vi.fn() }));
const now = Date.parse('2026-10-15T03:00:00Z');
function settings(filter: Partial<AlertSettings['filter']> = {}): AlertSettings {
  return { ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: false,
    filter: { ...structuredClone(DEFAULT_ALERT_SETTINGS.filter), keywords: [], types: ['공사'], ...filter } };
}
function query(filter: Partial<AlertSettings['filter']> = {}): CustomNoticeQuery {
  return { settings: settings(filter), profile: null, from: '2026-10-09', to: '2026-10-15' };
}
function notice(number = 'R26TEST001', overrides: Partial<AlertNotice> = {}): AlertNotice {
  return { ...NOTICES[0], id: `g2b:공사:${number}:000`, number, revision: '000', source: 'live', type: '공사',
    title: '학교 철거 공사', agency: '서울특별시', demandAgency: '교육청', deadline: '2026-11-01T18:00:00+09:00',
    postedAt: '2026-10-15T09:00:00+09:00', sourceUpdatedAt: '2026-10-15T09:00:00+09:00',
    allowedRegions: null, licenses: [], regionComplete: false, licenseComplete: false, ...overrides };
}
function page(items: AlertNotice[], hasMore = false, number = 1): G2bNoticePage {
  return { items, hasMore, page: number, pageSize: 100, totalCount: items.length + (hasMore ? 100 : 0),
    fetchedAt: '2026-10-15T03:00:00Z', source: '나라장터' };
}
function repository(load: CustomNoticeRepository['notices'], detail?: CustomNoticeRepository['detail']): CustomNoticeRepository {
  return { notices: load, detail: detail ?? (async bid => ({ number: bid.number, revision: bid.revision, regionComplete: true,
    licenseComplete: true, allowedRegions: ['전국'], licenses: ['구조물해체·비계공사업'], fetchedAt: '2026-10-15T03:00:00Z', warnings: [] })) };
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('custom notice request planning', () => {
  it('queries each keyword through title, announcement agency and demand agency as a union', () => {
    const plan = planCustomNoticeSearch(query({ keywords: ['철거', '해체'], types: ['공사', '용역'] }));
    expect(plan.sources).toHaveLength(12);
    expect(plan.sources.slice(0, 4).every(source => !!source.keyword)).toBe(true);
    expect(plan.sources).toContainEqual(expect.objectContaining({ type: '공사', agency: '철거', keyword: '' }));
    expect(plan.sources).toContainEqual(expect.objectContaining({ type: '용역', demandAgency: '해체', keyword: '' }));
    expect(plan.query.settings.filter.keywords).toEqual(['철거', '해체']);
    expect(plan.query.settings.enabled).toBe(false);
  });
  it('pushes one safe OR axis rather than intersecting multiple agencies or licenses', () => {
    const plan = planCustomNoticeSearch(query({ includeUnknown: false, agencies: ['서울시', '교육청'], licenses: ['철거', '석면'], keywords: ['해체'] }));
    expect(plan.sources).toHaveLength(4);
    expect(plan.sources.every(source => !source.license && !source.keyword)).toBe(true);
    expect(plan.sources.map(source => source.agency || source.demandAgency)).toEqual(['서울시', '교육청', '서울시', '교육청']);
  });
  it('does not push agency, license, amount or deadline constraints when missing fields should be included', () => {
    const plan = planCustomNoticeSearch(query({ includeUnknown: true, agencies: ['서울시'], licenses: ['철거'], minAmount: 0, maxAmount: 100 }));
    expect(plan.sources).toHaveLength(1);
    expect(plan.sources[0]).toMatchObject({ keyword: '' });
    expect(plan.sources[0].agency).toBeUndefined(); expect(plan.sources[0].license).toBeUndefined();
    expect(plan.sources[0].minAmount).toBeUndefined(); expect(plan.sources[0].excludeClosed).toBeUndefined();
  });
  it('uses explicit or company licenses as a union only when unknown information is excluded', () => {
    const input = query({ includeUnknown: false, useCompanyLicenses: true });
    input.profile = { id: 'a', companyName: 'A', province: '', district: '', address: '', contactName: '', email: '', licenses: ['철거', '석면'] };
    expect(planCustomNoticeSearch(input).sources.map(source => source.license)).toEqual(['철거', '석면']);
    input.settings.filter.licenses = ['비계'];
    expect(planCustomNoticeSearch(input).sources.map(source => source.license)).toEqual(['비계']);
  });
  it.each(['구조물해체ㆍ비계공사업', '구조물해체·비계공사업/1234', '건설폐기물 수집·운반업'])(
    'falls back from normalized license input %s without dropping its OR branch', license => {
      const plan = planCustomNoticeSearch(query({ includeUnknown: false, licenses: ['안전한면허', license], keywords: ['철거'] }));
      expect(plan.sources).toHaveLength(3);
      expect(plan.sources.every(source => !source.license)).toBe(true);
      expect(plan.sources.map(source => source.keyword || source.agency || source.demandAgency)).toEqual(['철거', '철거', '철거']);
    });
  it('falls back to a complete type scope when company licenses contain a normalized alternative', () => {
    const input = query({ includeUnknown: false, useCompanyLicenses: true });
    input.profile = { id: 'a', companyName: 'A', province: '', district: '', address: '', contactName: '', email: '', licenses: ['철거', '석면/0123'] };
    const plan = planCustomNoticeSearch(input);
    expect(plan.sources).toHaveLength(1); expect(plan.sources[0].license).toBeUndefined();
    expect(plan.sources[0].keyword).toBe('');
  });
  it('can use a safe company-license axis when an independent explicit license axis needs normalization', () => {
    const input = query({ includeUnknown: false, useCompanyLicenses: true, licenses: ['건설폐기물 수집·운반업'], keywords: ['철거'] });
    input.profile = { id: 'a', companyName: 'A', province: '', district: '', address: '', contactName: '', email: '', licenses: ['철거', '석면'] };
    expect(planCustomNoticeSearch(input).sources.map(source => source.license)).toEqual(['철거', '석면']);
  });
  it('keeps a legacy 7-day publication period unchanged and validates the requested order', () => {
    expect(planCustomNoticeSearch(query()).sources[0]).toMatchObject({ from: '2026-10-09', to: '2026-10-15' });
    expect(() => planCustomNoticeSearch({ ...query(), from: '2026-10-16' })).toThrow('종료일');
  });
  it('covers exactly 90 publication days with non-overlapping provider windows of at most 31 days, newest first', () => {
    const plan = planCustomNoticeSearch({ ...query(), from: '2026-07-18' });
    expect(plan.query).toMatchObject({ from: '2026-07-18', to: '2026-10-15' });
    expect(plan.sources.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: '2026-09-15', to: '2026-10-15' },
      { from: '2026-08-15', to: '2026-09-14' },
      { from: '2026-07-18', to: '2026-08-14' },
    ]);
    const days = plan.sources.flatMap(source => Array.from({ length: (Date.parse(source.to) - Date.parse(source.from)) / 86_400_000 + 1 },
      (_, index) => new Date(Date.parse(source.from) + index * 86_400_000).toISOString().slice(0, 10)));
    expect(days).toHaveLength(90); expect(new Set(days).size).toBe(90);
    expect([...days].sort()[0]).toBe('2026-07-18'); expect([...days].sort().at(-1)).toBe('2026-10-15');
  });
  it('repeats the complete keyword and business-type union for every date window', () => {
    const plan = planCustomNoticeSearch({ ...query({ keywords: ['철거'], types: ['공사', '용역'] }), from: '2026-07-18' });
    expect(plan.sources).toHaveLength(18);
    for (let index = 0; index < 3; index++) {
      const window = plan.sources.slice(index * 6, (index + 1) * 6);
      expect(new Set(window.map(source => `${source.from}/${source.to}`)).size).toBe(1);
      expect(window.map(source => `${source.type}:${source.keyword ? 'title' : source.agency ? 'agency' : 'demand'}`))
        .toEqual(['공사:title', '용역:title', '공사:agency', '용역:agency', '공사:demand', '용역:demand']);
    }
  });
  it('accepts a 31-day window unchanged and splits a 32-day window without overlap', () => {
    expect(planCustomNoticeSearch({ ...query(), from: '2026-09-15' }).sources).toHaveLength(1);
    expect(planCustomNoticeSearch({ ...query(), from: '2026-09-14' }).sources.map(({ from, to }) => ({ from, to })))
      .toEqual([{ from: '2026-09-15', to: '2026-10-15' }, { from: '2026-09-14', to: '2026-09-14' }]);
  });
  it('keeps date boundaries exact across a leap day and rejects the 91st day', () => {
    expect(planCustomNoticeSearch({ ...query(), from: '2024-01-01', to: '2024-03-30' }).sources.map(({ from, to }) => ({ from, to })))
      .toEqual([{ from: '2024-02-29', to: '2024-03-30' }, { from: '2024-01-29', to: '2024-02-28' }, { from: '2024-01-01', to: '2024-01-28' }]);
    expect(() => planCustomNoticeSearch({ ...query(), from: '2026-07-17' })).toThrow('90일');
  });
  it('sends only public API fields and explicit page parameters to /api/notices', async () => {
    vi.mocked(fetchApi).mockResolvedValueOnce(page([]));
    const source = planCustomNoticeSearch(query({ includeUnknown: false, agencies: ['교육청'], minAmount: 0, maxAmount: 999 })).sources[0];
    await browserCustomNoticeRepository.notices(source, 2, new AbortController().signal);
    const path = String(vi.mocked(fetchApi).mock.calls[0][0]);
    expect(path.startsWith('/api/notices?')).toBe(true);
    const params = new URL(path, 'https://test.local').searchParams;
    expect(Object.fromEntries(params)).toMatchObject({ type: '공사', from: '2026-10-09', to: '2026-10-15', page: '2', pageSize: '100', agency: '교육청', minAmount: '0', maxAmount: '999', excludeClosed: '1' });
    expect(params.has('profile')).toBe(false); expect(params.has('userId')).toBe(false); expect(params.has('window')).toBe(false);
  });
});

describe('active notices use opening dates and verify every latest revision', () => {
  const activeQuery = (filter: Partial<AlertSettings['filter']> = {}): CustomNoticeQuery => ({
    ...query(filter), basis: 'opening', from: '2027-03-01', to: '2027-03-31',
  });
  const oldOpen = (number = 'R26BK01359594', overrides: Partial<AlertNotice> = {}) => notice(number, {
    postedAt: '2026-02-26T17:23:00+09:00', sourceUpdatedAt: '2026-02-26T17:23:00+09:00',
    openingAt: '2027-03-05T11:00:00+09:00', deadline: '2027-03-05T10:00:00+09:00', status: '접수중', ...overrides,
  });
  it('covers 366 inclusive opening days in provider windows and preserves old posting limits', () => {
    const yearQuery = { ...activeQuery(), from: '2026-10-15', to: '2027-10-15' };
    const plan = planCustomNoticeSearch(yearQuery);
    expect(CUSTOM_ACTIVE_MAX_DAYS).toBe(366); expect(plan.query.basis).toBe('opening');
    expect(plan.sources).toHaveLength(13);
    expect(plan.sources.every(source => source.basis === 'opening' && Date.parse(source.to) - Date.parse(source.from) <= 30 * 86_400_000)).toBe(true);
    expect(plan.sources[0].from).toBe('2026-10-15'); expect(plan.sources.at(-1)?.to).toBe('2027-10-15');
    expect(() => planCustomNoticeSearch({ ...yearQuery, to: '2027-10-16' })).toThrow('366일');
    expect(() => planCustomNoticeSearch({ ...query(), to: '2027-10-15' })).toThrow('90일');
  });
  it('keeps opening windows within calendar months because a 31-day February-crossing range is rejected upstream', () => {
    const plan = planCustomNoticeSearch({ ...activeQuery(), from: '2027-02-09', to: '2027-03-11' });
    expect(plan.sources.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: '2027-02-09', to: '2027-02-28' }, { from: '2027-03-01', to: '2027-03-11' },
    ]);
    expect(plan.sources.every(source => source.from.slice(0, 7) === source.to.slice(0, 7))).toBe(true);
  });
  it('covers leap February and adjacent opening months without missing or duplicating a boundary day', () => {
    const plan = planCustomNoticeSearch({ ...activeQuery(), from: '2028-01-31', to: '2028-03-01' });
    expect(plan.sources.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: '2028-01-31', to: '2028-01-31' }, { from: '2028-02-01', to: '2028-02-29' }, { from: '2028-03-01', to: '2028-03-01' },
    ]);
    const days = plan.sources.flatMap(source => Array.from({ length: (Date.parse(source.to) - Date.parse(source.from)) / 86_400_000 + 1 },
      (_, index) => new Date(Date.parse(source.from) + index * 86_400_000).toISOString().slice(0, 10)));
    expect(days).toHaveLength(31); expect(new Set(days).size).toBe(31);
  });
  it('propagates opening dates and sends an all-revision number lookup without the original order', async () => {
    vi.mocked(fetchApi).mockResolvedValue(page([]));
    const source = planCustomNoticeSearch(activeQuery()).sources[0];
    await browserCustomNoticeRepository.notices(source, 1, new AbortController().signal);
    expect(new URL(String(vi.mocked(fetchApi).mock.calls[0][0]), 'https://test.local').searchParams.get('basis')).toBe('opening');
    await browserCustomNoticeRepository.lookup!(oldOpen(), new AbortController().signal);
    const params = new URL(String(vi.mocked(fetchApi).mock.calls[1][0]), 'https://test.local').searchParams;
    expect(Object.fromEntries(params)).toEqual({ mode: 'number', type: '공사', number: 'R26BK01359594' });
  });
  it('discovers a February posting with a future opening date and publishes it only after complete latest verification', async () => {
    let finish!: (value: G2bNoticePage) => void;
    const lookup = vi.fn<NonNullable<CustomNoticeRepository['lookup']>>(() => new Promise(resolve => { finish = resolve; }));
    const detail = vi.fn<CustomNoticeRepository['detail']>();
    const controller = new CustomNoticesController({ ...repository(async () => page([oldOpen()]), detail), lookup }, () => now);
    controller.setUser('a'); const pending = controller.search(activeQuery());
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(controller.getSnapshot().items).toEqual([]);
    finish(page([oldOpen()])); await pending;
    expect(controller.getSnapshot()).toMatchObject({ items: [expect.objectContaining({ postedAt: '2026-02-26T17:23:00+09:00' })], checkedCount: 1, hasMore: false });
    expect(detail).not.toHaveBeenCalled(); expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('never publishes original 000 when the complete latest revision is a cancellation, even without requested details', async () => {
    const cancel = oldOpen('R26BK01359594', { revision: '001', status: '취소', sourceUpdatedAt: '2026-02-27T10:00:00+09:00' });
    const detail = vi.fn<CustomNoticeRepository['detail']>();
    const controller = new CustomNoticesController({ ...repository(async () => page([oldOpen()]), detail), lookup: async () => page([cancel, oldOpen()]) }, () => now);
    controller.setUser('a'); await controller.search(activeQuery({ includeUnknown: true }));
    expect(controller.getSnapshot()).toMatchObject({ items: [], excludedItems: [expect.objectContaining({ revision: '001', status: '취소' })], checkedCount: 1, hasMore: false });
    expect(detail).not.toHaveBeenCalled();
  });
  it.each(['missing', 'failure', 'partial', 'count', 'wrong-number', 'wrong-type', 'invalid-revision', 'duplicate'])(
    'keeps unverified originals hidden when latest lookup is %s and exposes a retry', async mode => {
      const bid = oldOpen();
      const lookup = mode === 'missing' ? undefined : async () => {
        if (mode === 'failure') throw new Error('최신 차수 조회 실패');
        const result = page(mode === 'duplicate' ? [bid, { ...bid }] : [{ ...bid,
          ...(mode === 'wrong-number' ? { number: 'OTHER' } : {}), ...(mode === 'wrong-type' ? { type: '용역' as const } : {}),
          ...(mode === 'invalid-revision' ? { revision: 'abc' } : {}) }], mode === 'partial');
        if (mode === 'count') result.totalCount++;
        return result;
      };
      const controller = new CustomNoticesController({ ...repository(async () => page([bid])), lookup }, () => now);
      controller.setUser('a'); await controller.search(activeQuery({ includeUnknown: true }));
      expect(controller.getSnapshot()).toMatchObject({ items: [], excludedItems: [], checkedCount: 0, hasMore: true });
      expect(controller.getSnapshot().error).not.toBe('');
    });
  it('retries latest verification and applies required details to the changed revision, never the obsolete original', async () => {
    let failed = true;
    const changed = oldOpen('R26BK01359594', { revision: '002', id: 'g2b:공사:R26BK01359594:002', sourceUpdatedAt: '2026-10-01T11:00:00+09:00' });
    const detail = vi.fn<CustomNoticeRepository['detail']>(async bid => ({ number: bid.number, revision: bid.revision,
      regionComplete: true, licenseComplete: true, allowedRegions: ['전국'], licenses: ['철거'], fetchedAt: '2026-10-15T03:00:00Z', warnings: [] }));
    const controller = new CustomNoticesController({ ...repository(async () => page([oldOpen()]), detail), lookup: async () => {
      if (failed) throw new Error('연결 실패'); return page([oldOpen(), changed]);
    } }, () => now);
    controller.setUser('a'); await controller.search(activeQuery({ licenses: ['철거'], includeUnknown: true }));
    expect(controller.getSnapshot().items).toEqual([]); expect(detail).not.toHaveBeenCalled();
    failed = false; await controller.loadMore();
    expect(detail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ revision: '002' }), expect.any(AbortSignal));
    expect(controller.getSnapshot()).toMatchObject({ items: [expect.objectContaining({ revision: '002', sourceUpdatedAt: '2026-10-01T11:00:00+09:00', licenseComplete: true })], error: '', hasMore: false });
  });
  it('removes latest closed results and skips details for known latest mismatches', async () => {
    const bids = [oldOpen('CLOSED'), oldOpen('MISMATCH')];
    const detail = vi.fn<CustomNoticeRepository['detail']>();
    const controller = new CustomNoticesController({ ...repository(async () => page(bids), detail), lookup: async bid => page([
      oldOpen(bid.number, bid.number === 'CLOSED' ? { revision: '001', deadline: '2026-10-14T10:00:00+09:00' } : { revision: '001', title: '다른 공사' }),
    ]) }, () => now);
    controller.setUser('a'); await controller.search(activeQuery({ keywords: ['철거'], licenses: ['철거'] }));
    expect(controller.getSnapshot()).toMatchObject({ items: [], excludedItems: [expect.objectContaining({ number: 'CLOSED' })], checkedCount: 2 });
    expect(detail).not.toHaveBeenCalled();
  });
  it('caps complete latest validation at 20 candidates per batch and continues without repeating verified candidates', async () => {
    const bids = Array.from({ length: 25 }, (_, index) => oldOpen(`ACTIVE${index}`));
    const lookup = vi.fn<NonNullable<CustomNoticeRepository['lookup']>>(async bid => page([bids.find(item => item.number === bid.number)!]));
    const controller = new CustomNoticesController({ ...repository(async () => page(bids)), lookup }, () => now);
    controller.setUser('a'); await controller.search(activeQuery());
    expect(lookup).toHaveBeenCalledTimes(20); expect(controller.getSnapshot()).toMatchObject({ items: expect.any(Array), checkedCount: 20, hasMore: true });
    await controller.loadMore(); expect(lookup).toHaveBeenCalledTimes(25);
    expect(controller.getSnapshot()).toMatchObject({ items: expect.any(Array), checkedCount: 25, hasMore: false });
    expect(controller.getSnapshot().items).toHaveLength(25);
  });
  it('withholds an unknown latest opening date, then rechecks the latest revision before applying the date range', async () => {
    let openingAt = '';
    const controller = new CustomNoticesController({ ...repository(async () => page([oldOpen()])),
      lookup: async () => page([oldOpen('R26BK01359594', { revision: '001', openingAt })]) }, () => now);
    controller.setUser('a'); await controller.search(activeQuery({ includeUnknown: true }));
    expect(controller.getSnapshot()).toMatchObject({ items: [], checkedCount: 0, hasMore: true });
    expect(controller.getSnapshot().error).toContain('개찰일');
    openingAt = '2028-03-01T10:00:00+09:00'; await controller.loadMore();
    expect(controller.getSnapshot()).toMatchObject({ items: [], excludedItems: [], checkedCount: 1, hasMore: false, error: '' });
  });
  it('does not let a late original lookup overwrite a newer cancellation discovered while it was in flight', async () => {
    const original = oldOpen('R26BK01359594', { openingAt: '2026-10-20T10:00:00+09:00' });
    const cancelled = { ...original, revision: '001', status: '취소' as const, sourceUpdatedAt: '2026-10-16T10:00:00+09:00' };
    let finish!: (value: G2bNoticePage) => void;
    const lookup = vi.fn<NonNullable<CustomNoticeRepository['lookup']>>((bid) => (bid as AlertNotice).revision === '000'
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(page([cancelled, original])));
    const controller = new CustomNoticesController({ ...repository(async (_source, currentPage) => page([currentPage === 1 ? original : cancelled], currentPage === 1, currentPage)), lookup }, () => now);
    controller.setUser('a'); const pending = controller.search({ ...activeQuery(), from: '2026-10-15', to: '2026-10-31' });
    await vi.waitFor(() => expect(controller.getSnapshot().excludedItems).toHaveLength(1));
    expect(controller.getSnapshot().items).toEqual([]);
    finish(page([original])); await pending;
    expect(controller.getSnapshot()).toMatchObject({ items: [], excludedItems: [expect.objectContaining({ revision: '001' })], checkedCount: 1, error: '' });
  });
  it('revalidates a changed status at the same revision and removes its previous active match', async () => {
    const original = oldOpen('R26BK01359594', { openingAt: '2026-10-20T10:00:00+09:00' });
    const cancelled = { ...original, status: '취소' as const };
    let lastPage = 0;
    const controller = new CustomNoticesController({ ...repository(async (_source, currentPage) => {
      lastPage = currentPage; return page([currentPage < 13 ? original : cancelled], currentPage < 13, currentPage);
    }), lookup: async () => page([lastPage < 13 ? original : cancelled]) }, () => now);
    controller.setUser('a'); await controller.search({ ...activeQuery(), from: '2026-10-15', to: '2026-10-31' });
    expect(controller.getSnapshot()).toMatchObject({ items: [expect.any(Object)], hasMore: true });
    await controller.loadMore();
    expect(controller.getSnapshot()).toMatchObject({ items: [], excludedItems: [expect.objectContaining({ revision: '000', status: '취소' })], hasMore: false });
  });
  it('ignores an old-account latest lookup that resolves after account change', async () => {
    let finish!: (value: G2bNoticePage) => void; let signal!: AbortSignal;
    const controller = new CustomNoticesController({ ...repository(async () => page([oldOpen()])), lookup: async (_bid, abort) => {
      signal = abort; return new Promise(resolve => { finish = resolve; });
    } }, () => now);
    controller.setUser('a'); const pending = controller.search(activeQuery());
    await vi.waitFor(() => expect(signal).toBeDefined()); controller.setUser('b');
    expect(signal.aborted).toBe(true); expect(visibleCustomNotices(controller.getSnapshot(), 'b')).toMatchObject({ items: [], excludedItems: [] });
    finish(page([oldOpen()])); await pending;
    expect(controller.getSnapshot()).toMatchObject({ userId: 'b', items: [], excludedItems: [], apiRequests: 0, loading: false });
  });
  it('keeps mandatory version validation and subsequent details within four concurrent candidate checks', async () => {
    let inFlight = 0, maximum = 0;
    const pause = async () => { maximum = Math.max(maximum, ++inFlight); await new Promise(resolve => setTimeout(resolve, 1)); inFlight--; };
    const bids = Array.from({ length: 8 }, (_, index) => oldOpen(`ACTIVE${index}`));
    const controller = new CustomNoticesController({ ...repository(async () => page(bids), async bid => {
      await pause(); return { number: bid.number, revision: bid.revision, regionComplete: true, licenseComplete: true,
        allowedRegions: ['전국'], licenses: ['철거'], fetchedAt: '2026-10-15T03:00:00Z', warnings: [] };
    }), lookup: async bid => { await pause(); return page([bids.find(item => item.number === bid.number)!]); } }, () => now);
    controller.setUser('a'); await controller.search(activeQuery({ licenses: ['철거'], includeUnknown: true }));
    expect(maximum).toBe(4); expect(controller.getSnapshot().items).toHaveLength(8);
  });
  it('checks likely active matches before known closed or category mismatches without discarding their potentially updated latest revision', async () => {
    const closed = Array.from({ length: 20 }, (_, index) => oldOpen(`CLOSED${index}`, { deadline: '2026-10-01T10:00:00+09:00', status: '마감' }));
    const mismatches = Array.from({ length: 3 }, (_, index) => oldOpen(`OTHER${index}`, { category: '조경' }));
    const likely = oldOpen('LIKELY', { category: '철거·해체' });
    const calls: string[] = [];
    const controller = new CustomNoticesController({ ...repository(async () => page([...closed, ...mismatches, likely])), lookup: async bid => {
      calls.push(bid.number);
      return page([bid.number === 'OTHER0' ? oldOpen('OTHER0', { revision: '001', category: '철거·해체' }) : [...closed, ...mismatches, likely].find(item => item.number === bid.number)!]);
    } }, () => now);
    controller.setUser('a'); await controller.search(activeQuery({ categories: ['철거·해체'] }));
    expect(calls[0]).toBe('LIKELY'); expect(controller.getSnapshot().items.map(item => item.number)).toContain('LIKELY');
    expect(controller.getSnapshot().hasMore).toBe(true);
    await controller.loadMore();
    expect(new Set(calls).size).toBe(24); expect(calls).toHaveLength(24);
    expect(controller.getSnapshot().items.map(item => item.number).sort()).toEqual(['LIKELY', 'OTHER0']);
    expect(controller.getSnapshot().excludedItems).toHaveLength(20);
    expect(controller.getSnapshot().hasMore).toBe(false);
  });
  it('prioritizes a slower closest-opening source after it arrives ahead of remaining faster far-opening candidates', async () => {
    const near = oldOpen('NEAR', { openingAt: '2026-10-20T11:00:00+09:00' });
    const far = Array.from({ length: 25 }, (_, index) => oldOpen(`FAR${index}`, { openingAt: '2026-11-10T11:00:00+09:00' }));
    let finishNear!: (value: G2bNoticePage) => void;
    const nearPage = new Promise<G2bNoticePage>(resolve => { finishNear = resolve; });
    const releaseFar: (() => void)[] = [];
    const calls: string[] = [];
    const controller = new CustomNoticesController({ ...repository(async source => source.from === '2026-10-15' ? nearPage : page(far)), lookup: async bid => {
      calls.push(bid.number);
      if (calls.length <= 4) await new Promise<void>(resolve => { releaseFar.push(resolve); });
      return page([bid.number === 'NEAR' ? near : far.find(item => item.number === bid.number)!]);
    } }, () => now);
    controller.setUser('a'); const pending = controller.search({ ...activeQuery(), from: '2026-10-15', to: '2026-11-30' });
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    finishNear(page([near]));
    await vi.waitFor(() => expect(controller.getSnapshot().candidateCount).toBe(26));
    releaseFar.forEach(release => release()); await pending;
    expect(calls[4]).toBe('NEAR'); expect(calls).toHaveLength(20);
    expect(controller.getSnapshot().items.map(item => item.number)).toContain('NEAR');
    await controller.loadMore(); expect(calls).toHaveLength(26); expect(new Set(calls).size).toBe(26);
  });
  it('orders otherwise equal-priority candidates by known opening date, keeps ties stable and places unknown openings later', async () => {
    const bids = [oldOpen('FAR', { openingAt: '2027-03-20T11:00:00+09:00' }), oldOpen('TIE1', { openingAt: '2027-03-10T11:00:00+09:00' }),
      oldOpen('UNKNOWN', { openingAt: '' }), oldOpen('NEAR', { openingAt: '2027-03-02T11:00:00+09:00' }), oldOpen('TIE2', { openingAt: '2027-03-10T11:00:00+09:00' })];
    const calls: string[] = [];
    const controller = new CustomNoticesController({ ...repository(async () => page(bids)), lookup: async bid => {
      calls.push(bid.number); return page([oldOpen(bid.number, { openingAt: bids.find(item => item.number === bid.number)?.openingAt || '2027-03-30T11:00:00+09:00' })]);
    } }, () => now);
    controller.setUser('a'); await controller.search(activeQuery());
    expect(calls).toEqual(['NEAR', 'TIE1', 'TIE2', 'FAR', 'UNKNOWN']); expect(controller.getSnapshot().items).toHaveLength(5);
  });
});

describe('custom notice incremental loading and account boundaries', () => {
  it('finds an agency-only keyword match without requiring alerts to be enabled and deduplicates OR results', async () => {
    const bid = notice('R26TEST001', { title: '교실 보수 공사', agency: '철거관리센터' });
    const loader = vi.fn<CustomNoticeRepository['notices']>(async () => page([bid]));
    const detail = vi.fn<CustomNoticeRepository['detail']>();
    const controller = new CustomNoticesController(repository(loader, detail), () => now); controller.setUser('a');
    await controller.search(query({ keywords: ['철거', '해체'] }));
    expect(controller.getSnapshot()).toMatchObject({ items: [expect.objectContaining({ title: '교실 보수 공사' })], candidateCount: 1, checkedCount: 1, hasMore: false, loading: false, apiRequests: 6 });
    expect(detail).not.toHaveBeenCalled();
  });
  it('publishes a completed result while another source is still pending', async () => {
    let finish!: (value: G2bNoticePage) => void;
    const waiting = new Promise<G2bNoticePage>(resolve => { finish = resolve; });
    const controller = new CustomNoticesController(repository(async source => source.keyword ? page([notice()]) : waiting), () => now);
    controller.setUser('a'); const search = controller.search(query({ keywords: ['철거'] }));
    await vi.waitFor(() => expect(controller.getSnapshot().items).toHaveLength(1));
    expect(controller.getSnapshot().loading).toBe(true);
    finish(page([])); await search;
  });
  it('starts necessary detail checks as soon as a title page arrives while other list sources are pending', async () => {
    let finish!: (value: G2bNoticePage) => void;
    const waiting = new Promise<G2bNoticePage>(resolve => { finish = resolve; });
    const controller = new CustomNoticesController(repository(async source => source.keyword ? page([notice()]) : waiting), () => now);
    controller.setUser('a'); const search = controller.search(query({ keywords: ['철거'], licenses: ['구조물해체·비계공사업'] }));
    try {
      await vi.waitFor(() => expect(controller.getSnapshot().items).toHaveLength(1), { timeout: 150 });
      expect(controller.getSnapshot().items[0].licenseComplete).toBe(true);
      expect(controller.getSnapshot().loading).toBe(true);
    } finally { finish(page([])); await search; }
  });
  it('checks participation regions and licenses only after known cheap conditions match', async () => {
    const detail = vi.fn<CustomNoticeRepository['detail']>(async bid => ({ number: bid.number, revision: bid.revision,
      regionComplete: true, licenseComplete: true, allowedRegions: ['전국'], licenses: ['구조물해체·비계공사업'], fetchedAt: '2026-10-15T03:00:00Z', warnings: [] }));
    const controller = new CustomNoticesController(repository(async () => page([notice('R26TEST001'), notice('R26TEST002', { title: '설계 공사' })]), detail), () => now);
    controller.setUser('a'); await controller.search(query({ keywords: ['철거'], regions: ['서울특별시'], regionBasis: 'participation', licenses: ['구조물해체·비계공사업'], includeUnknown: false }));
    expect(detail).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().items).toHaveLength(1);
    expect(controller.getSnapshot().checkedCount).toBe(2);
    expect(controller.getSnapshot().items[0]).toMatchObject({ regionComplete: true, licenseComplete: true });
  });
  it('honors exact saved regional basis, company licenses, agencies, methods, price and remaining days', async () => {
    const bid = notice('R26TEST001', { province: '경기도', district: '수원시', agency: '서울특별시 교육청', estimatedPrice: 200, contractMethod: '제한경쟁' });
    const controller = new CustomNoticesController(repository(async () => page([bid])), () => now);
    controller.setUser('a'); const input = query({ regions: ['서울특별시'], regionBasis: 'both', agencies: ['교육청'], contractMethods: ['제한경쟁'], minAmount: 100, maxAmount: 300, minDaysUntilDeadline: 2, useCompanyLicenses: true, includeUnknown: false });
    input.profile = { id: 'a', companyName: 'A', province: '서울특별시', district: '강남구', address: '', contactName: '', email: '', licenses: ['구조물해체·비계공사업'] };
    await controller.search(input); expect(controller.getSnapshot().items).toHaveLength(0);
    input.settings.filter.regionBasis = 'either';
    await controller.search(input); expect(controller.getSnapshot().items).toHaveLength(1);
    input.settings.filter.minDaysUntilDeadline = 100;
    await controller.search(input); expect(controller.getSnapshot().items).toHaveLength(0);
  });
  it('matches either company-held license and unions results instead of requiring every held license', async () => {
    const requested: string[] = [];
    const controller = new CustomNoticesController(repository(async source => {
      requested.push(source.license || '');
      return page([notice(source.license === '철거' ? 'R26DEMO001' : 'R26DEMO002')]);
    }, async bid => ({ number: bid.number, revision: bid.revision, regionComplete: true, licenseComplete: true,
      allowedRegions: ['전국'], licenses: [bid.number === 'R26DEMO001' ? '철거' : '석면'], fetchedAt: '2026-10-15T03:00:00Z', warnings: [] })), () => now);
    controller.setUser('a'); const input = query({ useCompanyLicenses: true, includeUnknown: false });
    input.profile = { id: 'a', companyName: 'A', province: '', district: '', address: '', contactName: '', email: '', licenses: ['철거', '석면'] };
    await controller.search(input);
    expect(requested.sort()).toEqual(['석면', '철거']);
    expect(controller.getSnapshot().items.map(item => item.number).sort()).toEqual(['R26DEMO001', 'R26DEMO002']);
  });
  it.each([true, false])('keeps failed detail fields unknown with includeUnknown=%s and exposes a retry', async includeUnknown => {
    const controller = new CustomNoticesController(repository(async () => page([notice()]), async () => { throw new Error('상세 연결 실패'); }), () => now);
    controller.setUser('a'); await controller.search(query({ licenses: ['철거'], includeUnknown }));
    expect(controller.getSnapshot().items).toHaveLength(includeUnknown ? 1 : 0);
    expect(controller.getSnapshot().error).toContain('상세'); expect(controller.getSnapshot().hasMore).toBe(true);
    if (includeUnknown) expect(controller.getSnapshot().items[0].licenseComplete).toBe(false);
  });
  it('limits a source batch to 12 requests and continues pages in order without duplicate concurrent batches', async () => {
    const requested: number[] = [];
    const controller = new CustomNoticesController(repository(async (_source, number) => {
      requested.push(number); return page([notice(`R26TEST${number}`)], number < 14, number);
    }), () => now);
    controller.setUser('a'); await controller.search(query());
    expect(requested).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(controller.getSnapshot()).toMatchObject({ hasMore: true, candidateCount: 12, apiRequests: 12 });
    await Promise.all([controller.loadMore(), controller.loadMore()]);
    expect(requested).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
    expect(controller.getSnapshot()).toMatchObject({ hasMore: false, items: expect.any(Array), candidateCount: 14, apiRequests: 14 });
  });
  it('continues every 90-day window and its pages across batches without merging cursors or repeating notices', async () => {
    const requests: string[] = [];
    const controller = new CustomNoticesController(repository(async (source, number) => {
      requests.push(`${source.from}/${source.to}/${source.keyword ? 'title' : source.agency ? 'agency' : 'demand'}/${source.type}/${number}`);
      return page([notice('R26SHARED001')], number === 1, number);
    }), () => now);
    controller.setUser('a'); await controller.search({ ...query({ keywords: ['철거'], types: ['공사', '용역'] }), from: '2026-07-18' });
    expect(requests).toHaveLength(12); expect(controller.getSnapshot()).toMatchObject({ hasMore: true, apiRequests: 12, candidateCount: 1 });
    expect(requests.slice(0, 6).every(request => request.startsWith('2026-09-15/2026-10-15/'))).toBe(true);
    await controller.loadMore(); expect(requests).toHaveLength(24); expect(controller.getSnapshot().hasMore).toBe(true);
    await controller.loadMore(); expect(requests).toHaveLength(36);
    expect(new Set(requests).size).toBe(36);
    for (const start of ['2026-09-15', '2026-08-15', '2026-07-18']) {
      const range = requests.filter(request => request.startsWith(start));
      expect(range).toHaveLength(12); expect(range.filter(request => request.endsWith('/1'))).toHaveLength(6);
      expect(range.filter(request => request.endsWith('/2'))).toHaveLength(6);
    }
    expect(controller.getSnapshot()).toMatchObject({ hasMore: false, apiRequests: 36, candidateCount: 1, checkedCount: 1 });
    expect(controller.getSnapshot().items).toHaveLength(1);
    await controller.loadMore(); expect(requests).toHaveLength(36);
  });
  it('verifies at most 20 candidates per batch and leaves remaining candidates for more', async () => {
    const detail = vi.fn<CustomNoticeRepository['detail']>(async bid => ({ number: bid.number, revision: bid.revision, regionComplete: true, licenseComplete: true, allowedRegions: ['전국'], licenses: ['철거'], fetchedAt: '2026-10-15T03:00:00Z', warnings: [] }));
    const controller = new CustomNoticesController(repository(async () => page(Array.from({ length: 25 }, (_, index) => notice(`R26TEST${index}`))), detail), () => now);
    controller.setUser('a'); await controller.search(query({ licenses: ['철거'] }));
    expect(detail).toHaveBeenCalledTimes(20); expect(controller.getSnapshot()).toMatchObject({ candidateCount: 25, checkedCount: 20, hasMore: true });
    await controller.loadMore(); expect(detail).toHaveBeenCalledTimes(25); expect(controller.getSnapshot().hasMore).toBe(false);
  });
  it('preserves successful results and retries the failed source page without pretending the partial search is complete', async () => {
    let failed = true;
    const controller = new CustomNoticesController(repository(async source => {
      if (source.agency && failed) throw new Error('기관 조회 실패');
      return page([notice()]);
    }), () => now);
    controller.setUser('a'); await controller.search(query({ keywords: ['철거'] }));
    expect(controller.getSnapshot()).toMatchObject({ items: [expect.any(Object)], hasMore: true });
    expect(controller.getSnapshot().error).toContain('일부');
    failed = false; await controller.loadMore(); expect(controller.getSnapshot()).toMatchObject({ hasMore: false, error: '' });
  });
  it('replaces a provisional unknown match when a later detail retry proves the license is different', async () => {
    let failed = true;
    const controller = new CustomNoticesController(repository(async () => page([notice()]), async bid => {
      if (failed) throw new Error('면허 일시 실패');
      return { number: bid.number, revision: bid.revision, regionComplete: true, licenseComplete: true,
        allowedRegions: ['전국'], licenses: ['다른 면허'], fetchedAt: '2026-10-15T03:00:00Z', warnings: [] };
    }), () => now);
    controller.setUser('a'); await controller.search(query({ licenses: ['철거'], includeUnknown: true }));
    expect(controller.getSnapshot().items).toHaveLength(1);
    failed = false; await controller.loadMore();
    expect(controller.getSnapshot()).toMatchObject({ items: [], hasMore: false, checkedCount: 1, error: '' });
  });
  it('caps both independent request pools at four concurrent calls', async () => {
    let sources = 0, details = 0, maxSources = 0, maxDetails = 0;
    const pause = () => new Promise(resolve => setTimeout(resolve, 1));
    const controller = new CustomNoticesController(repository(async () => {
      maxSources = Math.max(maxSources, ++sources); await pause(); sources--;
      return page(Array.from({ length: 8 }, (_, index) => notice(`R26TEST${index}`)));
    }, async bid => {
      maxDetails = Math.max(maxDetails, ++details); await pause(); details--;
      return { number: bid.number, revision: bid.revision, regionComplete: true, licenseComplete: true,
        allowedRegions: ['전국'], licenses: ['철거'], fetchedAt: '2026-10-15T03:00:00Z', warnings: [] };
    }), () => now);
    controller.setUser('a'); await controller.search(query({ keywords: ['철거', '해체'], licenses: ['철거'] }));
    expect(maxSources).toBe(4); expect(maxDetails).toBe(4); expect(controller.getSnapshot().items).toHaveLength(8);
  });
  it('aborts and immediately hides an old account or superseded query even if its transport resolves late', async () => {
    let finish!: (value: G2bNoticePage) => void; let signal!: AbortSignal;
    const controller = new CustomNoticesController(repository(async (_source, _page, abort) => {
      signal = abort; return new Promise(resolve => { finish = resolve; });
    }), () => now);
    controller.setUser('a'); const loading = controller.search(query());
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(visibleCustomNotices(controller.getSnapshot(), 'b').items).toEqual([]);
    controller.setUser('b'); expect(signal.aborted).toBe(true);
    finish(page([notice()])); await loading;
    expect(controller.getSnapshot()).toMatchObject({ userId: 'b', items: [], loading: false, apiRequests: 0 });
    controller.dispose(); expect(controller.getSnapshot().userId).toBeNull();
  });
  it('discards a superseded search and clears the current results independently of account ownership', async () => {
    let finish!: (value: G2bNoticePage) => void; let oldSignal!: AbortSignal;
    const controller = new CustomNoticesController(repository(async (source, _number, signal) => {
      if (source.from === '2026-10-09') { oldSignal = signal; return new Promise(resolve => { finish = resolve; }); }
      return page([notice('R26NEW001')]);
    }), () => now);
    controller.setUser('a'); const oldSearch = controller.search(query());
    await controller.search({ ...query(), from: '2026-10-10' });
    expect(oldSignal.aborted).toBe(true);
    finish(page([notice('R26OLD001')])); await oldSearch;
    expect(controller.getSnapshot().items.map(item => item.number)).toEqual(['R26NEW001']);
    controller.clear(); expect(controller.getSnapshot()).toMatchObject({ userId: 'a', items: [], apiRequests: 0, hasMore: false });
  });
  it('makes no provider call for an invalid date range and snapshots input against later edits', async () => {
    const load = vi.fn<CustomNoticeRepository['notices']>(async () => page([notice()]));
    const controller = new CustomNoticesController(repository(load), () => now); controller.setUser('a');
    await controller.search({ ...query(), from: '2026-07-17' });
    expect(load).not.toHaveBeenCalled(); expect(controller.getSnapshot().error).toContain('90일');
    const input = query({ keywords: ['철거'] }); const pending = controller.search(input);
    input.settings.filter.keywords[0] = '없는 검색어'; await pending;
    expect(controller.getSnapshot().items).toHaveLength(1);
  });
});
