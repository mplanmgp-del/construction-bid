import { expect, it, vi } from 'vitest';
import type { G2bNoticePage } from '../src/g2b-types';
import { loadPublicSearch, SEARCH_CACHE_FRESH_MS, SEARCH_CACHE_MAX_AGE_MS, SEARCH_CACHE_STALE_WARNING, SEARCH_CACHE_FAILURE_BACKOFF_MS, SEARCH_CACHE_QUOTA_WARNING, SEARCH_CACHE_FAILURE_WARNING, type PublicSearchCache } from '../server/public-search-cache';
import { G2bError } from '../server/g2b';
import { ProviderQuotaError } from '../server/provider-quota';

const now = Date.parse('2026-10-13T03:00:00Z');
const page = (age = 0): G2bNoticePage => ({ items: [], totalCount: 0, page: 1, pageSize: 0, hasMore: false, fetchedAt: new Date(now - age).toISOString(), source: '나라장터', warnings: [] });
function fixture(initial?: G2bNoticePage) {
  const entries = new Map<string, unknown>();
  let seeded = false, stored: unknown;
  const cache: PublicSearchCache = {
    get: vi.fn(async key => {
      if (!key.startsWith('failure:') && !seeded) {
        seeded = true;
        if (initial) { stored = { schema: 1, body: initial }; entries.set(key, stored); }
      }
      return entries.get(key);
    }),
    set: vi.fn(async (key, value) => { entries.set(key, value); if (!key.startsWith('failure:')) stored = value; }),
  };
  const scheduled: Promise<unknown>[] = [];
  return { cache, options: { cache, now: () => now, schedule: (job: Promise<unknown>) => { scheduled.push(job); } }, scheduled, stored: () => stored };
}

it('shares a complete public result and preserves the upstream timestamp on fresh hits', async () => {
  const f = fixture(), data = page(1234), loader = vi.fn(async () => data);
  const miss = await loadPublicSearch('공사:철거:2026-10-07:2026-10-13:0', loader, f.options);
  expect(miss.status).toBe('MISS'); expect(f.cache.set).toHaveBeenCalledOnce();
  const hit = await loadPublicSearch('공사:철거:2026-10-07:2026-10-13:0', loader, f.options);
  expect(hit.status).toBe('HIT'); expect(loader).toHaveBeenCalledOnce(); expect(hit.body.fetchedAt).toBe(data.fetchedAt);
  hit.body.warnings?.push('client mutation'); expect((await loadPublicSearch('공사:철거:2026-10-07:2026-10-13:0', loader, f.options)).body.warnings).toEqual([]);
});

it('returns stale complete data immediately with an explicit warning and refreshes in background', async () => {
  const stale = page(SEARCH_CACHE_FRESH_MS), f = fixture(stale);
  let resolve!: (value: G2bNoticePage) => void;
  const loader = vi.fn(() => new Promise<G2bNoticePage>(done => { resolve = done; }));
  const result = await loadPublicSearch('stale', loader, f.options);
  expect(result.status).toBe('STALE'); expect(result.body.fetchedAt).toBe(stale.fetchedAt);
  expect(result.body.warnings).toContain(SEARCH_CACHE_STALE_WARNING); expect(f.scheduled).toHaveLength(1);
  expect((f.stored() as { body: G2bNoticePage }).body.warnings).toEqual([]);
  resolve(page()); await Promise.all(f.scheduled);
  expect((await loadPublicSearch('stale', loader, f.options)).status).toBe('HIT');
});

it('keeps old complete data when background refresh fails, but propagates failure after 24 hours', async () => {
  const f = fixture(page(SEARCH_CACHE_FRESH_MS)), loader = vi.fn(async () => { throw new Error('upstream unavailable'); });
  expect((await loadPublicSearch('stale-failure', loader, f.options)).status).toBe('STALE');
  await Promise.all(f.scheduled); expect((f.stored() as { body: G2bNoticePage }).body).toEqual(page(SEARCH_CACHE_FRESH_MS));
  await expect(loadPublicSearch('expired', loader, { ...f.options, now: () => now + SEARCH_CACHE_MAX_AGE_MS })).rejects.toThrow('upstream unavailable');
});

it('force refresh waits for new data even when a fresh cache entry exists', async () => {
  const f = fixture(page(1234)), loader = vi.fn(async () => page());
  const result = await loadPublicSearch('forced', loader, { ...f.options, force: true });
  expect(result.status).toBe('MISS'); expect(result.body.fetchedAt).toBe(page().fetchedAt); expect(loader).toHaveBeenCalledOnce(); expect(f.cache.get).toHaveBeenCalled();
});

it('rejects partial and duplicate result sets and never writes them to the cache', async () => {
  for (const invalid of [{ ...page(), hasMore: true }, { ...page(), totalCount: 1 }, { ...page(), totalCount: 2, items: [{ id: 'same' }, { id: 'same' }] }]) {
    const f = fixture();
    await expect(loadPublicSearch('partial', async () => invalid as G2bNoticePage, f.options)).rejects.toThrow('전체 공고 조회');
    expect(vi.mocked(f.cache.set).mock.calls.every(([key]) => key.startsWith('failure:'))).toBe(true);
  }
});

it('fails open on cache read/write errors and skips oversized cache entries', async () => {
  const f = fixture(); vi.mocked(f.cache.get).mockRejectedValue(new Error('cache down')); vi.mocked(f.cache.set).mockRejectedValue(new Error('cache down'));
  expect((await loadPublicSearch('outage', async () => page(), f.options)).body).toEqual(page());
  const large = { ...page(), warnings: ['한'.repeat(700_000)] }, g = fixture();
  expect((await loadPublicSearch('oversized', async () => large, g.options)).body).toEqual(large); expect(g.cache.set).not.toHaveBeenCalled();
});

it('coalesces concurrent fetches for one cache key without merging different queries', async () => {
  const f = fixture(); let resolve!: (value: G2bNoticePage) => void;
  const loader = vi.fn(() => new Promise<G2bNoticePage>(done => { resolve = done; }));
  const first = loadPublicSearch('same', loader, f.options), second = loadPublicSearch('same', loader, f.options);
  await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce()); resolve(page()); await Promise.all([first, second]);
  const other = vi.fn(async () => page()); await loadPublicSearch('other', other, { ...f.options, force: true }); expect(other).toHaveBeenCalledOnce();
});

it('returns a complete fresh cache with its original timestamp when a forced quota refresh fails', async () => {
  const original = { ...page(1234), totalCount: 1, items: [{ id: 'notice-1' }] } as G2bNoticePage;
  const f = fixture(original), loader = vi.fn(async () => { throw new G2bError(429, 'G2B_QUOTA_EXCEEDED', 'quota'); });
  const result = await loadPublicSearch('quota', loader, { ...f.options, force: true });
  expect(result.status).toBe('STALE'); expect(result.body.items).toEqual(original.items);
  expect(result.body.fetchedAt).toBe(original.fetchedAt); expect(result.body.warnings).toContain(SEARCH_CACHE_QUOTA_WARNING);
  expect(result.body.warnings).not.toContain(SEARCH_CACHE_STALE_WARNING);
  expect((f.stored() as { body: G2bNoticePage }).body).toEqual(original);
});

it('does not repeatedly refresh failed background queries across cache clients during the five minute backoff', async () => {
  let time = now;
  const f = fixture(page(SEARCH_CACHE_FRESH_MS)), loader = vi.fn(async () => { throw new G2bError(429, 'G2B_QUOTA_EXCEEDED', 'quota'); });
  const options = { ...f.options, now: () => time };
  await loadPublicSearch('backoff', loader, options); await Promise.all(f.scheduled);
  // A new cache wrapper simulates a second process: the failure marker must be shared in Runtime Cache.
  const otherProcess = { ...f.cache };
  const blocked = await loadPublicSearch('backoff', loader, { ...options, cache: otherProcess, force: true });
  expect(loader).toHaveBeenCalledOnce(); expect(blocked.status).toBe('STALE');
  expect(blocked.body.warnings).toContain(SEARCH_CACHE_QUOTA_WARNING);
  expect(blocked.body.warnings).not.toContain(SEARCH_CACHE_STALE_WARNING);
  time += SEARCH_CACHE_FAILURE_BACKOFF_MS;
  await loadPublicSearch('backoff', loader, { ...options, cache: otherProcess, force: true });
  expect(loader).toHaveBeenCalledTimes(2);
});

it('does not substitute expired data or another query when an upstream lookup fails', async () => {
  const f = fixture(page(SEARCH_CACHE_MAX_AGE_MS)), failure = new G2bError(429, 'G2B_QUOTA_EXCEEDED', 'quota');
  await expect(loadPublicSearch('expired-quota', async () => { throw failure; }, { ...f.options, force: true })).rejects.toBe(failure);
  const g = fixture(page()); await loadPublicSearch('first', async () => page(), g.options);
  await expect(loadPublicSearch('different', async () => { throw failure; }, g.options)).rejects.toBe(failure);
  const retry = vi.fn(async () => page());
  await expect(loadPublicSearch('different', retry, g.options)).rejects.toMatchObject({ code: 'G2B_QUOTA_EXCEEDED' });
  expect(retry).not.toHaveBeenCalled();
});

it('falls back safely on other refresh errors and keeps local backoff if the cache write is unavailable', async () => {
  const f = fixture(page(1234)); vi.mocked(f.cache.set).mockRejectedValue(new Error('cache down'));
  const loader = vi.fn(async () => { throw new Error('network down'); });
  const result = await loadPublicSearch('local-backoff', loader, { ...f.options, force: true });
  expect(result.status).toBe('STALE'); expect(result.body.warnings).toContain(SEARCH_CACHE_FAILURE_WARNING);
  await loadPublicSearch('local-backoff', loader, { ...f.options, force: true }); expect(loader).toHaveBeenCalledOnce();
});

it('rechecks the maximum age after a slow failed forced refresh', async () => {
  let time = now;
  const f = fixture(page(SEARCH_CACHE_MAX_AGE_MS - 1));
  await expect(loadPublicSearch('expires-during-refresh', async () => { time += 1; throw new Error('unavailable'); }, { ...f.options, now: () => time, force: true })).rejects.toThrow('unavailable');
});

it('recognizes provider guard quota errors and preserves Retry-After on suppressed retries', async () => {
  const failure = new ProviderQuotaError(1800), loader = vi.fn(async () => { throw failure; });
  const f = fixture(page(1234));
  const cached = await loadPublicSearch('typed-quota', loader, { ...f.options, force: true });
  expect(cached.status).toBe('STALE'); expect(cached.body.warnings).toContain(SEARCH_CACHE_QUOTA_WARNING);
  expect(cached.body.warnings).not.toContain(SEARCH_CACHE_FAILURE_WARNING);

  const g = fixture(); let time = now;
  const options = { ...g.options, now: () => time };
  await expect(loadPublicSearch('typed-no-cache', loader, options)).rejects.toBe(failure);
  time += 90_000;
  await expect(loadPublicSearch('typed-no-cache', loader, { ...options, cache: { ...g.cache } }))
    .rejects.toMatchObject({ name: 'ProviderQuotaError', code: 'G2B_QUOTA_EXCEEDED', retryAfterSeconds: 210 });
  expect(loader).toHaveBeenCalledTimes(2);
});

it('ignores malformed, future-dated and expired cache entries', async () => {
  for (const stale of [page(SEARCH_CACHE_MAX_AGE_MS), page(-1), { ...page(), totalCount: 1 }, { ...page(), fetchedAt: 'invalid' }]) {
    const f = fixture(stale), loader = vi.fn(async () => page());
    expect((await loadPublicSearch('invalid', loader, f.options)).status).toBe('MISS'); expect(loader).toHaveBeenCalledOnce();
  }
});
