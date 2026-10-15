import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NOTICES } from '../src/data';
import type { BidNotice } from '../src/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Region scheduling is tested as a guest; session forwarding has its own tests.
vi.mock('../src/member/client', () => ({ getMemberClient: () => null }));

let regions: typeof import('../src/live/notice-regions');
const service = (number: string, changes: Partial<BidNotice> = {}): BidNotice => ({
  ...NOTICES[0], id: `${number}-000`, number, revision: '000', type: '용역', source: 'live',
  province: '', district: '', allowedRegions: null, ...changes,
});
const row = (number: string, changes: Record<string, unknown> = {}) => ({
  number, revision: '000', type: '용역', allowedRegions: ['서울특별시'], complete: true,
  fetchedAt: '2026-10-14T01:00:00Z', ...changes,
});
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-14T01:00:00Z');
  vi.resetModules(); regions = await import('../src/live/notice-regions');
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('automatically targets both businesses on the visible page, and all candidates only for region filtering', () => {
  const bids = Array.from({ length: 62 }, (_, index) => service(`R${index}`, { type: index % 2 ? '공사' : '용역' }));
  const visible = bids.slice(30, 60);
  expect(regions.selectNoticeRegionTargets(bids, visible, false, false)).toEqual(visible);
  const services = bids.filter(bid => bid.type === '용역');
  expect(regions.selectNoticeRegionTargets(bids, visible, true, false)).toEqual(services);
  expect(regions.selectNoticeRegionTargets(bids, visible, true, true)).toEqual(bids);
  const confirm = (bid: BidNotice) => regions.seedNoticeDetailRegions(bid, {
    number: bid.number, revision: bid.revision, allowedRegions: ['서울특별시'], regionComplete: true,
    licenses: [], licenseComplete: false, fetchedAt: '2026-10-14T01:00:00Z', warnings: [], notice: bid,
  });
  services.slice(0, 10).forEach(confirm);
  // As service matches enter the page, the in-flight target identities stay fixed.
  expect(regions.selectNoticeRegionTargets(bids, bids.slice(0, 30), true, false)).toEqual(services);
  services.slice(10).forEach(confirm);
  const settled = regions.selectNoticeRegionTargets(bids, visible, true, false);
  expect(settled.filter(bid => bid.type === '용역')).toHaveLength(31);
  expect(settled.filter(bid => bid.type === '공사')).toHaveLength(15);
});

it('allows visible construction checks after service checks fail, without treating a failure as a match', async () => {
  const construction = service('C1', { type: '공사' }); const bid = service('S1');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [row('S1', { complete: false, allowedRegions: null })] })));
  await regions.loadNoticeRegions([bid], new AbortController().signal);
  expect(regions.selectNoticeRegionTargets([construction, bid], [construction], true, false)).toEqual([construction, bid]);
  expect(regions.mergeNoticeRegions([bid], regions.getCachedNoticeRegions([bid]))[0].allowedRegions).toBeNull();
});

it('retains every region in an active 1001-notice snapshot and reuses it through effect re-registration', async () => {
  const services = Array.from({ length: 1001 }, (_, index) => service(`S${index}`));
  const construction = service('C1', { type: '공사' });
  const candidates = [construction, ...services];
  const release = regions.pinNoticeRegions(candidates);
  const fetcher = vi.fn(async (path: string) => {
    const url = new URL(path, 'https://example.test');
    return Response.json({ items: url.searchParams.get('notices')!.split(',').map(value => row(value.split(':')[0])) });
  });
  vi.stubGlobal('fetch', fetcher);
  await regions.loadNoticeRegions(services, new AbortController().signal);
  expect(regions.getCachedNoticeRegions(services).size).toBe(1001);
  expect(regions.mergeNoticeRegions(services, regions.getCachedNoticeRegions(services))[0].allowedRegions).toEqual(['서울특별시']);
  expect(regions.selectNoticeRegionTargets(candidates, [construction], true, false)[0]).toBe(construction);
  const calls = fetcher.mock.calls.length;
  // React cleans up the previous effect before registering the same search again.
  release(); release();
  const releaseAgain = regions.pinNoticeRegions([...candidates]);
  await Promise.resolve();
  expect(regions.getCachedNoticeRegions(services).size).toBe(1001);
  await regions.loadNoticeRegions(services, new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(calls);
  releaseAgain(); await Promise.resolve();
  expect(regions.getCachedNoticeRegions(services).size).toBe(1000);
});

it('shares exact complete detail regions with later list loads without fetching details or regions again', async () => {
  const bid = service('R1', { type: '공사' });
  const detail = { number: 'R1', revision: '000', allowedRegions: ['서울특별시', '경기도'], regionComplete: true,
    licenses: [], licenseComplete: false, fetchedAt: '2026-10-14T01:00:00Z', warnings: [], notice: bid };
  const listener = vi.fn(); const unsubscribe = regions.subscribeNoticeRegions(listener);
  regions.seedNoticeDetailRegions(bid, { ...detail, revision: '001' });
  regions.seedNoticeDetailRegions(bid, { ...detail, notice: { ...bid, type: '용역' } });
  expect(regions.getCachedNoticeRegions([bid]).size).toBe(0);
  regions.seedNoticeDetailRegions(bid, detail);
  expect(listener).toHaveBeenCalledTimes(1);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const result = await regions.loadNoticeRegions([bid], new AbortController().signal);
  expect(regions.mergeNoticeRegions([bid], result.entries)[0].allowedRegions).toEqual(detail.allowedRegions);
  expect(fetcher).not.toHaveBeenCalled(); unsubscribe();
});

it('does not let an unfinished region request erase regions confirmed by detail', async () => {
  const bid = service('R1'); let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const work = regions.loadNoticeRegions([bid], new AbortController().signal);
  regions.seedNoticeDetailRegions(bid, { number: 'R1', revision: '000', allowedRegions: ['서울특별시'], regionComplete: true,
    licenses: [], licenseComplete: false, fetchedAt: '2026-10-14T01:00:00Z', warnings: [], notice: bid });
  resolve(Response.json({ items: [row('R1', { complete: false, allowedRegions: null })] }));
  const result = await work;
  expect(regions.mergeNoticeRegions([bid], result.entries)[0].allowedRegions).toEqual(['서울특별시']);
});

it('hydrates only unknown live regions, including services with a site address', async () => {
  const bids = [service('R1'), service('R2', { province: '경기도' }), service('R3', { allowedRegions: [] }),
    service('R4', { type: '공사', allowedRegions: ['전국'] }), service('R5', { source: 'demo' }), service('R6', { allowedRegions: ['부산광역시'] })];
  const snapshot = JSON.stringify(bids);
  const urls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const url = new URL(path, 'https://example.test'); urls.push(url);
    return Response.json({ items: [row('R1'), row('R2'), row('R3')] });
  }));
  const result = await regions.loadNoticeRegions(bids, new AbortController().signal);
  const merged = regions.mergeNoticeRegions(bids, result.entries);
  expect(urls).toHaveLength(1);
  expect(urls[0].pathname).toBe('/api/notice-regions');
  expect(urls[0].searchParams.get('type')).toBe('용역');
  expect(urls[0].searchParams.get('notices')).toBe('R1:000,R2:000,R3:000');
  expect(merged.map(bid => bid.allowedRegions)).toEqual([['서울특별시'], ['서울특별시'], ['서울특별시'], ['전국'], null, ['부산광역시']]);
  expect(merged[1].province).toBe('경기도');
  expect(merged[3]).toBe(bids[3]); expect(merged[5]).toBe(bids[5]);
  expect(JSON.stringify(bids)).toBe(snapshot);
});

it('never applies another notice, revision or business response, or ambiguous duplicate rows', async () => {
  const bids = ['R1', 'R2', 'R3', 'R4'].map(number => service(number));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [row('OTHER'), row('R1', { revision: '001' }),
    row('R2', { type: '공사' }), row('R3'), row('R3', { allowedRegions: ['부산광역시'] }), row('R4')] })));
  const result = await regions.loadNoticeRegions(bids, new AbortController().signal);
  expect(regions.mergeNoticeRegions(bids, result.entries).map(bid => bid.allowedRegions)).toEqual([null, null, null, ['서울특별시']]);
  expect([...result.entries.values()].filter(entry => entry.complete)).toHaveLength(1);
  expect(result.entries.size).toBe(4);
});

it('retains unknown regions for incomplete, empty and malformed responses', async () => {
  const bids = Array.from({ length: 7 }, (_, index) => service(`R${index}`));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [
    row('R0', { complete: false }), row('R1', { allowedRegions: [] }), row('R2', { allowedRegions: [''] }),
    row('R3', { allowedRegions: ['-'] }), row('R4', { allowedRegions: '서울특별시' }), row('R5', { fetchedAt: 'bad date' }),
    row('R6', { error: '부분 조회 오류' }),
  ] })));
  const result = await regions.loadNoticeRegions(bids, new AbortController().signal);
  expect(regions.mergeNoticeRegions(bids, result.entries).every(bid => bid.allowedRegions === null)).toBe(true);
  expect(result.entries.size).toBe(7);
  expect([...result.entries.values()].every(entry => !entry.complete && !!entry.error)).toBe(true);
});

it('keeps verified regions already attached to a notice even when a cached result differs', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [row('R1')] })));
  const result = await regions.loadNoticeRegions([service('R1')], new AbortController().signal);
  const known = service('R1', { allowedRegions: ['부산광역시'] });
  expect(regions.mergeNoticeRegions([known], result.entries)[0]).toBe(known);
});

it('preserves a completed lookup without published regions as unknown and lets the user retry it', async () => {
  const fetcher = vi.fn(async () => Response.json({ items: [row('R1', { allowedRegions: null })] }));
  vi.stubGlobal('fetch', fetcher);
  const bids = [service('R1')]; const signal = new AbortController().signal;
  const result = await regions.loadNoticeRegions(bids, signal);
  expect([...result.entries.values()][0]).toMatchObject({ complete: true, allowedRegions: null });
  expect([...result.entries.values()][0].error).toBeUndefined();
  expect(regions.mergeNoticeRegions(bids, result.entries)[0]).toBe(bids[0]);
  await regions.loadNoticeRegions(bids, signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockImplementation(async () => Response.json({ items: [row('R1')] }));
  const retry = await regions.loadNoticeRegions(bids, signal, undefined, { retryFailed: true });
  expect(regions.mergeNoticeRegions(bids, retry.entries)[0].allowedRegions).toEqual(['서울특별시']);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('deduplicates requested identities and processes at most ten notices per batch with two concurrent requests', async () => {
  let active = 0; let peak = 0;
  const batchSizes: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    active++; peak = Math.max(peak, active);
    const identities = new URL(path, 'https://example.test').searchParams.get('notices')!.split(',');
    batchSizes.push(identities.length);
    await new Promise(resolve => setTimeout(resolve, 20)); active--;
    return Response.json({ items: identities.map(identity => row(identity.split(':')[0])) });
  }));
  const bids = Array.from({ length: 25 }, (_, index) => service(`R${index}`));
  const work = regions.loadNoticeRegions([...bids, bids[0]], new AbortController().signal);
  await vi.runAllTimersAsync();
  const result = await work;
  expect(batchSizes).toEqual([10, 10, 5]); expect(peak).toBe(2);
  expect(result.entries.size).toBe(25);
  expect([...result.entries.values()].every(entry => entry.complete)).toBe(true);
});

it('reuses successful public region data for five minutes across calls and revisions have separate cache keys', async () => {
  const fetcher = vi.fn(async (path: string) => {
    const identity = new URL(path, 'https://example.test').searchParams.get('notices')!.split(':');
    return Response.json({ items: [row(identity[0], { revision: identity[1] })] });
  });
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  await regions.loadNoticeRegions([service('R1')], signal);
  await regions.loadNoticeRegions([service('R1')], signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await regions.loadNoticeRegions([service('R1', { revision: '001' })], signal);
  expect(fetcher).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(300_000);
  expect(regions.getCachedNoticeRegions([service('R1')]).size).toBe(0);
  expect(regions.mergeNoticeRegions([service('R1')], regions.getCachedNoticeRegions([service('R1')], true), true)[0].allowedRegions).toEqual(['서울특별시']);
  await regions.loadNoticeRegions([service('R1')], signal);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('does not automatically retry failed regions on another render but permits a deliberate retry', async () => {
  const fetcher = vi.fn(async () => Response.json({ error: { message: '일시 오류' } }, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal; const bids = [service('R1')];
  const failed = await regions.loadNoticeRegions(bids, signal);
  expect([...failed.entries.values()][0]?.complete).toBe(false);
  await regions.loadNoticeRegions(bids, signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockImplementation(async () => Response.json({ items: [row('R1')] }));
  const retried = await regions.loadNoticeRegions(bids, signal, undefined, { retryFailed: true });
  expect(regions.mergeNoticeRegions(bids, retried.entries)[0].allowedRegions).toEqual(['서울특별시']);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('stops queued work on quota exhaustion and lets an immediate manual retry recover', async () => {
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn(async (_path: string, options: RequestInit) => {
    signals.push(options.signal!);
    return Response.json({ error: { code: 'G2B_QUOTA_EXCEEDED', message: '호출 한도' } }, { status: 429 });
  });
  vi.stubGlobal('fetch', fetcher);
  const bids = Array.from({ length: 45 }, (_, index) => service(`R${index}`));
  const signal = new AbortController().signal;
  const result = await regions.loadNoticeRegions(bids, signal);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(signals.every(value => value.aborted)).toBe(true);
  expect(result.entries.size).toBe(45);
  expect(result.retryAt).toBe(0);
  expect([...result.entries.values()].every(entry => !entry.complete && !!entry.error)).toBe(true);
  fetcher.mockImplementation(async () => Response.json({ items: [row('R0')] }));
  const recovered = await regions.loadNoticeRegions([service('R0')], signal, undefined, { retryFailed: true });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(regions.mergeNoticeRegions([service('R0')], recovered.entries)[0].allowedRegions).toEqual(['서울특별시']);
});

it('stops a partial quota batch without a retry deadline and preserves successful rows for the next load', async () => {
  const fetcher = vi.fn(async () => Response.json({ items: [row('R1'), row('R2', { complete: false, allowedRegions: null })], quotaExceeded: true }));
  vi.stubGlobal('fetch', fetcher);
  const bids = Array.from({ length: 25 }, (_, index) => service(`R${index + 1}`));
  const result = await regions.loadNoticeRegions(bids, new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(regions.mergeNoticeRegions(bids, result.entries).slice(0, 2).map(bid => bid.allowedRegions)).toEqual([['서울특별시'], null]);
  expect(result.retryAt).toBe(0);
  fetcher.mockImplementation(async () => Response.json({ items: [row('R2')] }));
  const recovered = await regions.loadNoticeRegions(bids.slice(0, 2), new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(regions.mergeNoticeRegions(bids.slice(0, 2), recovered.entries).map(bid => bid.allowedRegions)).toEqual([['서울특별시'], ['서울특별시']]);
});

it('honors a real retry deadline from a partial region batch without extending it', async () => {
  const fetcher = vi.fn(async () => Response.json({ items: [row('R1'), row('R2', { complete: false, allowedRegions: null })], quotaExceeded: true, retryAfterSeconds: 3 }));
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  const result = await regions.loadNoticeRegions([service('R1'), service('R2')], signal);
  expect(result.retryAt).toBe(Date.now() + 3000);
  await regions.loadNoticeRegions([service('R2')], signal, undefined, { retryFailed: true });
  expect(fetcher).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3000);
  await regions.loadNoticeRegions([service('R2')], signal, undefined, { retryFailed: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('aborts in-flight work without publishing or caching results after the caller changes the query', async () => {
  const abort = new AbortController(); const publish = vi.fn();
  let receivedSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (_path: string, options: RequestInit) => {
    receivedSignal = options.signal!;
    await new Promise(resolve => setTimeout(resolve, 20));
    return Response.json({ items: [row('R1')] });
  }));
  const work = regions.loadNoticeRegions([service('R1')], abort.signal, publish);
  abort.abort(); await vi.runAllTimersAsync();
  const result = await work;
  expect(receivedSignal?.aborted).toBe(true);
  expect(publish).not.toHaveBeenCalled(); expect(result.entries.size).toBe(0);
  expect(regions.getCachedNoticeRegions([service('R1')]).size).toBe(0);
});

it('reports pending service checks immediately while disabled filters leave the source list intact', async () => {
  const { useNoticeRegions } = await import('../src/live/useNoticeRegions');
  const bids = [service('R1'), service('R2', { allowedRegions: ['서울특별시'] }), service('R3', { type: '공사' })];
  let result: ReturnType<typeof useNoticeRegions> | undefined;
  function Probe({ enabled }: { enabled: boolean }) { result = useNoticeRegions(bids, enabled); return null; }
  renderToStaticMarkup(createElement(Probe, { enabled: true }));
  expect(result).toMatchObject({ loading: true, pending: 1, failed: 0, retryAt: 0 });
  renderToStaticMarkup(createElement(Probe, { enabled: false }));
  expect(result).toMatchObject({ loading: false, pending: 0, failed: 0 });
  expect(result?.items).toEqual(bids);
});

it('loads construction participation regions separately from service regions when company filtering needs both', async () => {
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const url = new URL(path, 'https://example.test'); calls.push(url);
    const type = url.searchParams.get('type');
    return Response.json({ items: [row(type === '공사' ? 'C1' : 'S1', { type })] });
  }));
  const bids = [service('C1', { type: '공사', province: '부산광역시' }), service('S1')];
  const result = await regions.loadNoticeRegions(bids, new AbortController().signal);
  expect(calls.map(url => [url.searchParams.get('type'), url.searchParams.get('notices')])).toEqual([['공사', 'C1:000'], ['용역', 'S1:000']]);
  expect(regions.mergeNoticeRegions(bids, result.entries).map(bid => bid.allowedRegions)).toEqual([['서울특별시'], ['서울특별시']]);
  expect(bids[0].province).toBe('부산광역시');
});

it('only includes construction lookups in the hook when the company region filter is requested', async () => {
  const { useNoticeRegions } = await import('../src/live/useNoticeRegions');
  const bids = [service('C1', { type: '공사' }), service('S1')];
  let result: ReturnType<typeof useNoticeRegions> | undefined;
  function Probe({ companyFilter }: { companyFilter: boolean }) { result = useNoticeRegions(bids, true, companyFilter); return null; }
  renderToStaticMarkup(createElement(Probe, { companyFilter: false }));
  expect(result).toMatchObject({ pending: 1 });
  renderToStaticMarkup(createElement(Probe, { companyFilter: true }));
  expect(result).toMatchObject({ pending: 2 });
});
