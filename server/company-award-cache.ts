import { createHash } from 'node:crypto';
import { getCache } from '@vercel/functions';
import type { CompanyAwardPage } from '../src/company-award-types.ts';

type Query = Pick<CompanyAwardPage, 'businessNumber' | 'type' | 'from' | 'to'>;
export interface AwardCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options: { ttl: number }): Promise<unknown>;
}
const MAX_AGE = 7 * 24 * 60 * 60_000;
const pending = new WeakMap<AwardCache, Map<string, Promise<CompanyAwardPage>>>();
const unavailable: AwardCache = { get: async () => undefined, set: async () => undefined };
let runtimeCache: AwardCache | undefined;
function cacheForRuntime() {
  try { return runtimeCache ??= getCache({ namespace: 'construction-bid:company-awards-v1', keyHashFunction: key => key }); }
  catch { return unavailable; }
}
function matches(value: unknown, query: Query): value is CompanyAwardPage {
  if (!value || typeof value !== 'object') return false;
  const body = value as CompanyAwardPage;
  return body.businessNumber === query.businessNumber && body.type === query.type && body.from === query.from && body.to === query.to
    && Array.isArray(body.items) && Array.isArray(body.warnings) && typeof body.complete === 'boolean'
    && Number.isSafeInteger(body.totalCount) && body.totalCount >= 0 && Number.isFinite(Date.parse(body.fetchedAt));
}
function reusable(body: CompanyAwardPage) {
  return body.complete && !body.warnings.length && body.items.length === body.totalCount
    && body.items.every(row => typeof row.id === 'string' && row.id.length > 0)
    && new Set(body.items.map(row => row.id)).size === body.items.length;
}
/** Public, exact-company period snapshots only. Never caches member profiles or incomplete pages. */
export async function loadCompanyAwards(query: Query, loader: () => Promise<CompanyAwardPage>, options: {
  cache?: AwardCache; now?: () => number; force?: boolean;
} = {}): Promise<{ body: CompanyAwardPage; status: 'HIT' | 'MISS' | 'STALE' }> {
  const cache = options.cache ?? cacheForRuntime(), now = options.now ?? Date.now;
  const key = createHash('sha256').update(JSON.stringify([query.businessNumber, query.type, query.from, query.to])).digest('hex');
  let stored: unknown;
  try { stored = await cache.get(key); } catch { /* An unavailable cache must not block the provider. */ }
  const age = matches(stored, query) ? now() - Date.parse(stored.fetchedAt) : Infinity;
  const previous = matches(stored, query) && reusable(stored) && age >= 0 && age < MAX_AGE ? stored : undefined;
  const recent = query.to >= new Date(now() + 9 * 3600_000 - 7 * 86400_000).toISOString().slice(0, 10);
  if (!options.force && previous && age < (recent ? 180_000 : 86400_000)) return { body: structuredClone(previous), status: 'HIT' };
  let jobs = pending.get(cache);
  if (!jobs) { jobs = new Map(); pending.set(cache, jobs); }
  try {
    let job = jobs.get(key);
    if (!job) {
      job = (async () => {
        const body = await loader();
        if (!matches(body, query)) throw new Error('요청한 업체와 기간의 낙찰 이력을 확인하지 못했습니다.');
        if (reusable(body) && Buffer.byteLength(JSON.stringify(body)) <= 2_000_000) {
          try { await cache.set(key, body, { ttl: MAX_AGE / 1000 }); } catch { /* Return valid upstream data. */ }
        }
        return body;
      })();
      if (jobs.size < 128) {
        job = job.finally(() => jobs!.delete(key));
        jobs.set(key, job);
      }
    }
    return { body: structuredClone(await job), status: 'MISS' };
  } catch (error) {
    // Preserve rate-limit signals so the client stops its remaining month jobs.
    if (error && typeof error === 'object' && 'status' in error && error.status === 429) throw error;
    if (!previous || now() - Date.parse(previous.fetchedAt) >= MAX_AGE) throw error;
    return { body: { ...structuredClone(previous), warnings: ['최신 조회에 실패해 저장된 낙찰 이력을 표시합니다. 조회 시각을 확인해 주세요.'] }, status: 'STALE' };
  }
}
