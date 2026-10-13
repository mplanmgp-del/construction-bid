import { createHash } from 'node:crypto';
import { getCache, waitUntil } from '@vercel/functions';
import type { G2bNoticePage } from '../src/g2b-types.ts';

export const SEARCH_CACHE_FRESH_MS = 5 * 60_000;
export const SEARCH_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
export const SEARCH_CACHE_STALE_WARNING = '저장된 공고를 표시하며 최신 자료를 갱신 중입니다.';
const MAX_BYTES = 2_000_000;
const MAX_PENDING = 128;
const SCHEMA = 1;

export interface PublicSearchCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options: { ttl: number }): Promise<unknown>;
}
export interface PublicSearchCacheOptions {
  cache?: PublicSearchCache;
  now?: () => number;
  schedule?: (promise: Promise<unknown>) => void;
  force?: boolean;
}
export interface PublicSearchCacheResult { body: G2bNoticePage; status: 'HIT' | 'MISS' | 'STALE' }

let runtimeCache: PublicSearchCache | undefined;
const pendingByCache = new WeakMap<PublicSearchCache, Map<string, Promise<G2bNoticePage>>>();
const unavailableCache: PublicSearchCache = { get: async () => undefined, set: async () => undefined };
function defaultCache(): PublicSearchCache {
  // Hobby Runtime Cache can be shared by projects. Include the project and schema in the namespace.
  // Preserve the SHA-256 below; the SDK's default hash would reduce it to 32 bits.
  try { return runtimeCache ??= getCache({ namespace: 'construction-bid:public-start-v1', keyHashFunction: key => key }); }
  catch { return unavailableCache; }
}
function completePage(value: unknown): value is G2bNoticePage {
  if (!value || typeof value !== 'object') return false;
  const page = value as G2bNoticePage;
  return page.hasMore === false && Number.isSafeInteger(page.totalCount) && page.totalCount >= 0
    && Array.isArray(page.items) && page.items.length === page.totalCount
    && page.items.every(item => item && typeof item.id === 'string' && item.id.length > 0)
    && new Set(page.items.map(item => item.id)).size === page.items.length
    && typeof page.fetchedAt === 'string' && Number.isFinite(Date.parse(page.fetchedAt))
    && typeof page.source === 'string'
    && (page.warnings === undefined || (Array.isArray(page.warnings) && page.warnings.every(warning => typeof warning === 'string')));
}
function cacheAge(page: G2bNoticePage, now: number) {
  const age = now - Date.parse(page.fetchedAt);
  return age >= 0 ? age : Infinity;
}

/** Cache only complete public notice results. No account, profile, or region-filtered data belongs here. */
export async function loadPublicSearch(key: string, loader: () => Promise<G2bNoticePage>, options: PublicSearchCacheOptions = {}): Promise<PublicSearchCacheResult> {
  const cache = options.cache ?? defaultCache(), now = options.now ?? Date.now;
  const cacheKey = `v${SCHEMA}:${createHash('sha256').update(key).digest('hex')}`;
  let pending = pendingByCache.get(cache);
  if (!pending) { pending = new Map(); pendingByCache.set(cache, pending); }
  const refresh = (): Promise<G2bNoticePage> => {
    const existing = pending.get(cacheKey);
    if (existing) return existing;
    const job = (async () => {
      const body = await loader();
      if (!completePage(body)) throw new Error('전체 공고 조회가 완료되지 않았습니다. 다시 조회해 주세요.');
      const envelope = { schema: SCHEMA, body };
      if (cacheAge(body, now()) < SEARCH_CACHE_MAX_AGE_MS && Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= MAX_BYTES) {
        try { await cache.set(cacheKey, envelope, { ttl: Math.ceil(SEARCH_CACHE_MAX_AGE_MS / 1000) }); }
        catch { /* Cache availability must not block a valid upstream result. */ }
      }
      return body;
    })();
    if (pending.size < MAX_PENDING) {
      const tracked = job.finally(() => pending.delete(cacheKey));
      pending.set(cacheKey, tracked);
      return tracked;
    }
    return job;
  };
  if (!options.force) {
    let stored: unknown;
    try { stored = await cache.get(cacheKey); } catch { /* Fetch directly when the cache is unavailable. */ }
    const envelope = stored as { schema?: number; body?: unknown } | null | undefined;
    if (envelope?.schema === SCHEMA && completePage(envelope.body)) {
      const age = cacheAge(envelope.body, now());
      if (age < SEARCH_CACHE_FRESH_MS) return { body: structuredClone(envelope.body), status: 'HIT' };
      if (age < SEARCH_CACHE_MAX_AGE_MS) {
        const background = refresh().catch(() => undefined);
        try { (options.schedule ?? waitUntil)(background); } catch { /* The promise already handles refresh failure. */ }
        const body = structuredClone(envelope.body);
        body.warnings = [...new Set([...(body.warnings ?? []), SEARCH_CACHE_STALE_WARNING])];
        return { body, status: 'STALE' };
      }
    }
  }
  return { body: structuredClone(await refresh()), status: 'MISS' };
}
