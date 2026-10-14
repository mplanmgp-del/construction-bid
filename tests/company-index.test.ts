import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyHistory } from '../src/company-types';
import { ApiError } from '../src/live/client';
import { collectedCount, collectedWinningAmount, companyHistoryPath, historyRefreshDelay, mergeCompanyProfile, watchCompanyHistory } from '../src/company/company-index';

const coverage: CompanyHistory['coverage'] = { status: 'collecting', from: '2020-01-01', to: '2026-10-14', updatedAt: '2026-10-14T00:00:00Z', message: '수집 중' };
const history = (changes: Partial<CompanyHistory> = {}): CompanyHistory => ({
  company: null, items: [], totalCount: 0, page: 1, pageSize: 30,
  summary: { participationCount: 0, winCount: 0, pendingCount: 0, winningAmount: null, bidAmount: null, averageBidRate: null },
  monthly: [], agencies: [], coverage, ...changes,
});
const filter = { from: '', to: '', outcome: 'all' as const, page: 1, awardsPage: 1, contractsPage: 1 };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); });

describe('indexed company history client', () => {
  it('requests all indexed history without arbitrary dates and keeps source pages independent', () => {
    const url = new URL(companyHistoryPath('8488802470', filter), 'https://test.local');
    expect(url.pathname).toBe('/api/company-history');
    expect(url.searchParams.has('from')).toBe(false); expect(url.searchParams.has('to')).toBe(false);
    const ranged = new URL(companyHistoryPath('8488802470', { ...filter, from: '1990-01-01', to: '2026-10-14', page: 11, awardsPage: 4, contractsPage: 8 }), url);
    expect(Object.fromEntries(ranged.searchParams)).toEqual({ businessNumber: '8488802470', from: '1990-01-01', to: '2026-10-14', page: '11', awardsPage: '4', contractsPage: '8', outcome: 'all' });
  });
  it('does not equate incomplete or unavailable history with zero records', () => {
    expect(collectedCount(0, coverage)).toBeNull();
    expect(collectedCount(3, coverage)).toBe(3);
    expect(collectedCount(0, { ...coverage, status: 'ready' })).toBe(0);
    expect(collectedCount(3, { ...coverage, status: 'unavailable' })).toBeNull();
  });
  it('does not display zero winning amount while outcomes or collection remain incomplete', () => {
    const summary = { ...history().summary, participationCount: 17, winningAmount: 0 };
    const ready = { ...coverage, status: 'ready' as const };
    expect(collectedWinningAmount(summary, coverage)).toBeNull();
    expect(collectedWinningAmount({ ...summary, pendingCount: 17 }, ready)).toBeNull();
    expect(collectedWinningAmount(summary, ready)).toBe(0);
    expect(collectedWinningAmount({ ...summary, winCount: 1, winningAmount: 100 }, coverage)).toBe(100);
  });
  it('refreshes stored profiles without erasing official details or crossing companies', () => {
    const selected = { businessNumber: '8488802470', name: '기존 이름', representative: '대표', phone: '02-123', address: '', registrationDate: '2023-06-12', companyType: '', licenses: ['등록 면허'], products: [], updatedAt: '2026-10-14T01:00:00Z' };
    const stored = { ...selected, name: '새 이름', representative: '', phone: '', registrationDate: '', licenses: [], address: '서울특별시', updatedAt: '2026-10-14T02:00:00Z' };
    expect(mergeCompanyProfile(selected, stored)).toEqual({ ...selected, name: '새 이름', address: '서울특별시', updatedAt: stored.updatedAt });
    expect(mergeCompanyProfile(selected, { ...stored, businessNumber: '1234567890' })).toBe(selected);
    expect(mergeCompanyProfile(selected, { ...stored, updatedAt: '2026-10-13T01:00:00Z' })?.name).toBe('기존 이름');
  });
  it('makes one indexed request then refreshes in the background without hiding old rows', async () => {
    vi.useFakeTimers();
    const initial = history({ totalCount: 17 }), next = history({ totalCount: 18 });
    const load = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(next);
    const update = vi.fn();
    const watcher = watchCompanyHistory({ path: companyHistoryPath('8488802470', filter), businessNumber: '8488802470', load, onUpdate: update });
    await flush();
    expect(load).toHaveBeenCalledTimes(1); expect(update.mock.lastCall?.[0].history.totalCount).toBe(17);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.some(([value]) => value.refreshing && value.history === initial)).toBe(true);
    expect(update.mock.lastCall?.[0].history.totalCount).toBe(18);
    expect(load.mock.calls.every(([path]) => path.startsWith('/api/company-history?'))).toBe(true);
    watcher.stop();
  });
  it('pauses hidden-tab refreshes and catches up once visible without parallel requests', async () => {
    vi.useFakeTimers(); let visible = true;
    const load = vi.fn().mockResolvedValue(history());
    const watcher = watchCompanyHistory({ path: '/api/company-history', businessNumber: '8488802470', load, onUpdate: vi.fn(), visible: () => visible });
    await flush(); visible = false;
    await vi.advanceTimersByTimeAsync(180_000); expect(load).toHaveBeenCalledTimes(1);
    visible = true; watcher.visibilityChanged(); watcher.visibilityChanged(); await flush();
    expect(load).toHaveBeenCalledTimes(2); watcher.stop();
  });
  it('aborts old-company requests and ignores responses that arrive after a company switch', async () => {
    let resolve!: (value: CompanyHistory) => void;
    const load = vi.fn((_path: string, _signal: AbortSignal) => new Promise<CompanyHistory>(done => { resolve = done; }));
    const update = vi.fn();
    const watcher = watchCompanyHistory({ path: '/api/company-history', businessNumber: '8488802470', load, onUpdate: update });
    watcher.stop(); resolve(history({ totalCount: 99 })); await flush();
    expect(load.mock.calls[0][1].aborted).toBe(true);
    expect(update).toHaveBeenCalledTimes(1); expect(update.mock.lastCall?.[0].history).toBeNull();
  });
  it('preserves existing results on failure and respects quota retry-after', async () => {
    vi.useFakeTimers(); const initial = history({ totalCount: 17 });
    const quota = new ApiError('잠시 후 조회', 'RATE_LIMIT', 429, 600);
    const load = vi.fn().mockRejectedValue(quota), update = vi.fn();
    const watcher = watchCompanyHistory({ path: '/api/company-history', businessNumber: '8488802470', initial, load, onUpdate: update });
    await flush();
    expect(update.mock.lastCall?.[0]).toEqual({ history: initial, refreshing: false, error: '잠시 후 조회' });
    await vi.advanceTimersByTimeAsync(599_999); expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(2); watcher.stop();
  });
  it('rejects another company response instead of replacing the selected company history', async () => {
    vi.useFakeTimers(); const update = vi.fn();
    const load = vi.fn().mockResolvedValue(history({ company: { businessNumber: '1234567890' } as CompanyHistory['company'] }));
    const watcher = watchCompanyHistory({ path: '/api/company-history', businessNumber: '8488802470', load, onUpdate: update });
    await flush(); expect(update.mock.lastCall?.[0].history).toBeNull();
    expect(update.mock.lastCall?.[0].error).toContain('업체가 일치하지'); watcher.stop();
  });
  it('refreshes completed sources less often while continuing partial contracts', () => {
    const ready = { ...coverage, status: 'ready' as const };
    const complete = history({ coverage: ready, awards: { items: [], page: 1, pageSize: 30, totalCount: 0, coverage: ready }, contracts: { items: [], page: 1, pageSize: 30, totalCount: 0, coverage: ready } });
    expect(historyRefreshDelay(complete)).toBe(180_000);
    expect(historyRefreshDelay({ ...complete, contracts: { ...complete.contracts!, coverage } })).toBe(60_000);
  });
});
