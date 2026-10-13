import { createHash } from 'node:crypto';
import { getCache, waitUntil } from '@vercel/functions';
import type { G2bNoticePage } from '../src/g2b-types.ts';
import { G2bError } from './g2b.ts';
import { ProviderQuotaError } from './provider-quota.ts';

export const SEARCH_CACHE_FRESH_MS = 5 * 60_000;
export const SEARCH_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
export const SEARCH_CACHE_STALE_WARNING = '저장된 조회 결과입니다. 최신 정보는 새로고침으로 확인해 주세요.';
export const SEARCH_CACHE_FAILURE_BACKOFF_MS = 5 * 60_000;
export const SEARCH_CACHE_QUOTA_WARNING = '저장된 공고를 표시합니다. 공공데이터 API 호출 한도로 최신 자료 갱신을 잠시 중단했습니다.';
export const SEARCH_CACHE_FAILURE_WARNING = '최신 자료 갱신에 실패하여 저장된 공고를 표시합니다. 잠시 후 새로고침으로 확인해 주세요.';
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
interface FailureMarker { schema: number; retryAt: number; quota: boolean }
const failuresByCache = new WeakMap<PublicSearchCache, Map<string, FailureMarker>>();
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
function activeFailure(value: unknown, now: number): value is FailureMarker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as FailureMarker;
  return marker.schema === SCHEMA && typeof marker.quota === 'boolean'
    && Number.isFinite(marker.retryAt) && marker.retryAt > now && marker.retryAt <= now + SEARCH_CACHE_FAILURE_BACKOFF_MS;
}
function stalePage(page: G2bNoticePage, warning: string): PublicSearchCacheResult {
  const body = structuredClone(page);
  body.warnings = [...new Set([...(body.warnings ?? []).filter(value => value !== SEARCH_CACHE_STALE_WARNING), warning])];
  return { body, status: 'STALE' };
}
function isQuotaError(error: unknown): boolean {
  return error instanceof ProviderQuotaError || (error instanceof G2bError && error.code === 'G2B_QUOTA_EXCEEDED');
}
function retryError(marker: FailureMarker, now: number): Error {
  return marker.quota
    ? new ProviderQuotaError((marker.retryAt - now) / 1000)
    : new G2bError(503, 'SEARCH_RETRY_PAUSED', '공공데이터 조회에 실패하여 재시도를 잠시 중단했습니다. 잠시 후 다시 조회해 주세요.');
}

/** Cache only complete public notice results. No account, profile, or region-filtered data belongs here. */
export async function loadPublicSearch(key: string, loader: () => Promise<G2bNoticePage>, options: PublicSearchCacheOptions = {}): Promise<PublicSearchCacheResult> {
  const cache = options.cache ?? defaultCache(), now = options.now ?? Date.now;
  const cacheKey = `v${SCHEMA}:${createHash('sha256').update(key).digest('hex')}`;
  const failureKey = `failure:${cacheKey}`;
  let pending = pendingByCache.get(cache);
  if (!pending) { pending = new Map(); pendingByCache.set(cache, pending); }
  let failures = failuresByCache.get(cache);
  if (!failures) { failures = new Map(); failuresByCache.set(cache, failures); }
  const read = async (key: string) => { try { return await cache.get(key); } catch { return undefined; } };
  // A forced refresh still needs the last complete result as a fallback when the provider is unavailable.
  const [stored, storedFailure] = await Promise.all([read(cacheKey), read(failureKey)]);
  const envelope = stored as { schema?: number; body?: unknown } | null | undefined;
  const previous = envelope?.schema === SCHEMA && completePage(envelope.body)
    && cacheAge(envelope.body, now()) < SEARCH_CACHE_MAX_AGE_MS ? envelope.body : undefined;
  const localFailure = failures.get(cacheKey);
  const failure = activeFailure(storedFailure, now()) ? storedFailure : activeFailure(localFailure, now()) ? localFailure : undefined;
  if (!failure) failures.delete(cacheKey);
  if (failure) {
    if (previous) return stalePage(previous, failure.quota ? SEARCH_CACHE_QUOTA_WARNING : SEARCH_CACHE_FAILURE_WARNING);
    throw retryError(failure, now());
  }
  const refresh = (): Promise<G2bNoticePage> => {
    const existing = pending.get(cacheKey);
    if (existing) return existing;
    const job = (async () => {
      let body: G2bNoticePage;
      try {
        body = await loader();
        if (!completePage(body)) throw new Error('전체 공고 조회가 완료되지 않았습니다. 다시 조회해 주세요.');
      } catch (error) {
        const marker: FailureMarker = { schema: SCHEMA, retryAt: now() + SEARCH_CACHE_FAILURE_BACKOFF_MS,
          quota: isQuotaError(error) };
        failures.set(cacheKey, marker);
        while (failures.size > MAX_PENDING) failures.delete(failures.keys().next().value!);
        try { await cache.set(failureKey, marker, { ttl: Math.ceil(SEARCH_CACHE_FAILURE_BACKOFF_MS / 1000) }); }
        catch { /* The bounded local marker also avoids retries while Runtime Cache is unavailable. */ }
        throw error;
      }
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
  if (!options.force && previous) {
    const age = cacheAge(previous, now());
    if (age < SEARCH_CACHE_FRESH_MS) return { body: structuredClone(previous), status: 'HIT' };
    const background = refresh().catch(() => undefined);
    try { (options.schedule ?? waitUntil)(background); } catch { /* The promise already handles refresh failure. */ }
    return stalePage(previous, SEARCH_CACHE_STALE_WARNING);
  }
  try { return { body: structuredClone(await refresh()), status: 'MISS' }; }
  catch (error) {
    // Recheck the age after a slow failed request; never extend the lifetime of old data.
    if (previous && cacheAge(previous, now()) < SEARCH_CACHE_MAX_AGE_MS) {
      return stalePage(previous, isQuotaError(error) ? SEARCH_CACHE_QUOTA_WARNING : SEARCH_CACHE_FAILURE_WARNING);
    }
    throw error;
  }
}
