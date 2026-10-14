import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, fetchApi } from '../src/live/client';
import { fetchStartedNotices } from '../src/live/notice-search';
import type { BidNotice } from '../src/types';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const query = { type: '공사·용역' as const, from: '2026-10-07', to: '2026-10-13', keyword: '철거' };

it('preserves the quota code, HTTP status and longest retry delay without forwarding the response body', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'G2B_QUOTA_EXCEEDED', message: '사용 한도에 도달했습니다.', retryAfterSeconds: 1800 }, provider: 'never expose this' }, { status: 429, headers: { 'Retry-After': '60' } })));
  const error = await fetchApi('/api/notices-start').catch(value => value);
  expect(error).toBeInstanceOf(ApiError);
  if (!(error instanceof ApiError)) throw new Error('Expected a typed API error');
  expect(error).toMatchObject({ code: 'G2B_QUOTA_EXCEEDED', status: 429, retryAfterSeconds: 1800 });
  expect(error.message).toBe('사용 한도에 도달했습니다.');
  expect(error.message).not.toContain('never expose');
});

it('understands HTTP-date retry headers and does not mistake generic 429 for provider quota', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-13T00:00:00Z');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'RATE_LIMITED', message: '요청이 많습니다.' } }, { status: 429, headers: { 'Retry-After': 'Tue, 13 Oct 2026 00:01:00 GMT' } })));
  await expect(fetchApi('/api/notices-start')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 60 });
});

it('never starts a broad 90-day search with an empty or whitespace-only keyword', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const keyword of ['', '  ', '\t']) {
    await expect(fetchStartedNotices({ ...query, keyword }, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'KEYWORD_REQUIRED' });
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it('stops scheduling later search windows once a provider quota error occurs', async () => {
  const fetcher = vi.fn(async () => Response.json({ error: { code: 'G2B_QUOTA_EXCEEDED', message: '사용 한도' } }, { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(fetchStartedNotices(query, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'G2B_QUOTA_EXCEEDED', status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.calls.every(([, options]: unknown[]) => (options as RequestInit)?.signal?.aborted)).toBe(true);
});

it('does not schedule more windows or publish partial counts when an HTTP 200 fallback signals quota exhaustion', async () => {
  const fetcher = vi.fn(async () => Response.json({
    items: [], totalCount: 0, page: 1, pageSize: 0, hasMore: false,
    fetchedAt: '2026-10-13T00:00:00Z', source: '나라장터',
    warnings: ['저장된 공고입니다.'], quotaExceeded: true,
  }));
  vi.stubGlobal('fetch', fetcher);
  const progress = vi.fn();
  const error = await fetchStartedNotices(query, new AbortController().signal, progress, { force: true }).catch(value => value);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: 'G2B_QUOTA_EXCEEDED', status: 429 });
  expect(error.retryAfterSeconds).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(progress).not.toHaveBeenCalledWith(8, 8);
  expect(fetcher.mock.calls.every(([, options]: unknown[]) => (options as RequestInit)?.signal?.aborted)).toBe(true);

  fetcher.mockImplementation(async () => Response.json({
    items: [], totalCount: 0, page: 1, pageSize: 0, hasMore: false,
    fetchedAt: '2026-10-13T00:01:00Z', source: '나라장터', warnings: [],
  }));
  const recovered = await fetchStartedNotices(query, new AbortController().signal, vi.fn(), { force: true });
  expect(recovered).toMatchObject({ totalCount: 0, hasMore: false, fetchedAt: '2026-10-13T00:01:00Z' });
  expect(fetcher).toHaveBeenCalledTimes(12);
});

it('preserves an explicit Retry-After from a successful cached fallback as a typed search quota error', async () => {
  const fetcher = vi.fn(async () => Response.json({
    items: [], totalCount: 0, page: 1, pageSize: 0, hasMore: false,
    fetchedAt: '2026-10-13T00:00:00Z', source: '나라장터',
    warnings: ['저장된 공고입니다.'], quotaExceeded: true, retryAfterSeconds: 7,
  }, { headers: { 'Retry-After': '7' } }));
  vi.stubGlobal('fetch', fetcher);
  await expect(fetchStartedNotices(query, new AbortController().signal, vi.fn(), { force: true }))
    .rejects.toMatchObject({ code: 'G2B_QUOTA_EXCEEDED', status: 429, retryAfterSeconds: 7 });
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('accepts a complete cached snapshot without starting a second forced refresh', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    calls.push(path);
    return Response.json({ items: [], totalCount: 0, hasMore: false, fetchedAt: '2026-10-13T00:00:00Z', warnings: ['저장된 공고를 표시하며 최신 자료를 갱신 중입니다.'] });
  }));
  await fetchStartedNotices(query, new AbortController().signal, vi.fn());
  expect(calls).toHaveLength(8);
  expect(calls.every(path => !new URL(path, 'https://example.test').searchParams.has('refresh'))).toBe(true);
});

it('stops the current result queue on quota but retries immediately when the caller starts another load', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-13T00:00:00Z');
  vi.resetModules();
  const { loadResultSummaryQueue } = await import('../src/live/useResultSummaries');
  const bids = Array.from({ length: 30 }, (_, i) => ({ number: `R${i}`, revision: '000', type: i < 2 ? '공사' : '용역', openingAt: '2026-10-12T10:00:00+09:00' }) as BidNotice);
  const fetcher = vi.fn(async () => Response.json({ error: { code: 'G2B_QUOTA_EXCEEDED', message: '사용 한도' } }, { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  const publish = vi.fn();
  await loadResultSummaryQueue(bids, new AbortController().signal, publish);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([path]: unknown[]) => new URL(String(path), 'https://example.test').searchParams.get('type') === '공사')).toBe(true);
  expect(publish).toHaveBeenCalledTimes(30);
  expect(publish.mock.calls.every(([, entry]) => entry.error && !entry.data && entry.until <= Date.now())).toBe(true);
  fetcher.mockImplementation(async () => Response.json({ number: 'R2', revision: '000', type: '용역', result: '개찰 완료', firstCompanies: ['정상 업체'], winnerCompanies: [], complete: true, fetchedAt: '2026-10-13T00:00:00Z' }));
  const recovered = vi.fn();
  await loadResultSummaryQueue(bids.slice(2, 3), new AbortController().signal, recovered);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(recovered).toHaveBeenCalledWith(bids[2], expect.objectContaining({ data: expect.objectContaining({ firstCompanies: ['정상 업체'] }) }));
});

it('honors an explicit provider Retry-After in the result queue without extending it to thirty minutes', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-13T00:00:00Z');
  vi.resetModules();
  const { loadResultSummaryQueue } = await import('../src/live/useResultSummaries');
  const bids = [{ number: 'R1', revision: '000', type: '공사', openingAt: '2026-10-12T10:00:00+09:00' } as BidNotice];
  const fetcher = vi.fn(async () => Response.json({ error: { code: 'G2B_QUOTA_EXCEEDED', message: '사용 한도', retryAfterSeconds: 3 } }, { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  await loadResultSummaryQueue(bids, new AbortController().signal, vi.fn());
  await loadResultSummaryQueue(bids, new AbortController().signal, vi.fn());
  expect(fetcher).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3000);
  await loadResultSummaryQueue(bids, new AbortController().signal, vi.fn());
  expect(fetcher).toHaveBeenCalledTimes(2);
});
