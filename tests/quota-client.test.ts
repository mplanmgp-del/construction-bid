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

it('pauses both business types in the result queue and subsequent pages after quota exhaustion, then resumes after cooldown', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-10-13T00:00:00Z');
  vi.resetModules();
  const { loadResultSummaryQueue } = await import('../src/live/useResultSummaries');
  const bids = Array.from({ length: 30 }, (_, i) => ({ number: `R${i}`, revision: '000', type: i < 2 ? '공사' : '용역', openingAt: '2026-10-12T10:00:00+09:00' }) as BidNotice);
  const fetcher = vi.fn(async () => Response.json({ error: { code: 'G2B_QUOTA_EXCEEDED', message: '사용 한도', retryAfterSeconds: 1800 } }, { status: 429 }));
  vi.stubGlobal('fetch', fetcher);
  const publish = vi.fn();
  await loadResultSummaryQueue(bids, new AbortController().signal, publish);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([path]: unknown[]) => new URL(String(path), 'https://example.test').searchParams.get('type') === '공사')).toBe(true);
  expect(publish).toHaveBeenCalledTimes(30);
  expect(publish.mock.calls.every(([, entry]) => entry.error && !entry.data && entry.until === Date.now() + 1800_000)).toBe(true);
  await loadResultSummaryQueue(bids, new AbortController().signal, vi.fn());
  expect(fetcher).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1800_000);
  await loadResultSummaryQueue(bids.slice(0, 1), new AbortController().signal, vi.fn());
  expect(fetcher).toHaveBeenCalledTimes(3);
});
