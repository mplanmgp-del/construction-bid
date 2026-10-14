import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NOTICES } from '../src/data';
import type { BidNotice } from '../src/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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

it('hydrates only unknown live service regions, including services with a site address', async () => {
  const bids = [service('R1'), service('R2', { province: '경기도' }), service('R3', { allowedRegions: [] }),
    service('R4', { type: '공사' }), service('R5', { source: 'demo' }), service('R6', { allowedRegions: ['부산광역시'] })];
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
  expect(merged.map(bid => bid.allowedRegions)).toEqual([['서울특별시'], ['서울특별시'], ['서울특별시'], null, null, ['부산광역시']]);
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

it('stops queued work on quota exhaustion and preserves the cooldown across a manual retry', async () => {
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn(async (_path: string, options: RequestInit) => {
    signals.push(options.signal!);
    return Response.json({ error: { code: 'G2B_QUOTA_EXCEEDED', message: '호출 한도', retryAfterSeconds: 1800 } }, { status: 429 });
  });
  vi.stubGlobal('fetch', fetcher);
  const bids = Array.from({ length: 45 }, (_, index) => service(`R${index}`));
  const signal = new AbortController().signal;
  const result = await regions.loadNoticeRegions(bids, signal);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(signals.every(value => value.aborted)).toBe(true);
  expect(result.entries.size).toBe(45);
  expect(result.retryAt).toBe(Date.now() + 1800_000);
  await regions.loadNoticeRegions([service('NEW')], signal, undefined, { retryFailed: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1800_000);
  await regions.loadNoticeRegions([service('NEW')], signal, undefined, { retryFailed: true });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('honors a partial batch quota delay while preserving already verified rows', async () => {
  const fetcher = vi.fn(async () => Response.json({ items: [row('R1'), row('R2', { complete: false, allowedRegions: null })], retryAfterSeconds: 1800 }));
  vi.stubGlobal('fetch', fetcher);
  const bids = [service('R1'), service('R2')];
  const result = await regions.loadNoticeRegions(bids, new AbortController().signal);
  expect(regions.mergeNoticeRegions(bids, result.entries).map(bid => bid.allowedRegions)).toEqual([['서울특별시'], null]);
  expect(result.retryAt).toBe(Date.now() + 1800_000);
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
