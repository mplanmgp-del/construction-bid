import { expect, it, vi } from 'vitest';
import type { G2bNoticePage } from '../src/g2b-types';
import { loadPublicSearch, SEARCH_CACHE_FRESH_MS, SEARCH_CACHE_MAX_AGE_MS, SEARCH_CACHE_STALE_WARNING, type PublicSearchCache } from '../server/public-search-cache';

const now = Date.parse('2026-10-13T03:00:00Z');
const page = (age = 0): G2bNoticePage => ({ items: [], totalCount: 0, page: 1, pageSize: 0, hasMore: false, fetchedAt: new Date(now - age).toISOString(), source: '나라장터', warnings: [] });
function fixture(initial?: G2bNoticePage) {
  let stored: unknown = initial ? { schema: 1, body: initial } : undefined;
  const cache: PublicSearchCache = { get: vi.fn(async () => stored), set: vi.fn(async (_key, value) => { stored = value; }) };
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
  await Promise.all(f.scheduled); expect(f.cache.set).not.toHaveBeenCalled();
  await expect(loadPublicSearch('expired', loader, { ...f.options, now: () => now + SEARCH_CACHE_MAX_AGE_MS })).rejects.toThrow('upstream unavailable');
});

it('force refresh waits for new data even when a fresh cache entry exists', async () => {
  const f = fixture(page(1234)), loader = vi.fn(async () => page());
  const result = await loadPublicSearch('forced', loader, { ...f.options, force: true });
  expect(result.status).toBe('MISS'); expect(result.body.fetchedAt).toBe(page().fetchedAt); expect(loader).toHaveBeenCalledOnce(); expect(f.cache.get).not.toHaveBeenCalled();
});

it('rejects partial and duplicate result sets and never writes them to the cache', async () => {
  for (const invalid of [{ ...page(), hasMore: true }, { ...page(), totalCount: 1 }, { ...page(), totalCount: 2, items: [{ id: 'same' }, { id: 'same' }] }]) {
    const f = fixture();
    await expect(loadPublicSearch('partial', async () => invalid as G2bNoticePage, f.options)).rejects.toThrow('전체 공고 조회');
    expect(f.cache.set).not.toHaveBeenCalled();
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
  await Promise.resolve(); expect(loader).toHaveBeenCalledOnce(); resolve(page()); await Promise.all([first, second]);
  const other = vi.fn(async () => page()); await loadPublicSearch('other', other, { ...f.options, force: true }); expect(other).toHaveBeenCalledOnce();
});

it('ignores malformed, future-dated and expired cache entries', async () => {
  for (const stale of [page(SEARCH_CACHE_MAX_AGE_MS), page(-1), { ...page(), totalCount: 1 }, { ...page(), fetchedAt: 'invalid' }]) {
    const f = fixture(stale), loader = vi.fn(async () => page());
    expect((await loadPublicSearch('invalid', loader, f.options)).status).toBe('MISS'); expect(loader).toHaveBeenCalledOnce();
  }
});
