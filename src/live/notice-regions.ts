import type { BidNotice } from '../types';
import type { G2bNoticeDetail } from '../g2b-types';
import { ApiError, fetchApi } from './client';

export type NoticeRegionTarget = Pick<BidNotice, 'number' | 'revision' | 'type' | 'source' | 'allowedRegions' | 'procurementSource'>;
export interface NoticeRegionEntry {
  allowedRegions: string[] | null;
  complete: boolean;
  fetchedAt: string;
  error?: string;
  until: number;
}
const CACHE_MS = 300_000;
const cache = new Map<string, NoticeRegionEntry>();
const listeners = new Set<() => void>();
const pins = new Map<string, number>();
let cacheVersion = 0;
export const getNoticeRegionsVersion = () => cacheVersion;
export function subscribeNoticeRegions(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function trimNoticeRegionCache() {
  let removed = false;
  for (const key of cache.keys()) {
    if (cache.size <= 1000) break;
    if (!pins.has(key)) { cache.delete(key); removed = true; }
  }
  return removed;
}

/** Keep active result snapshots intact even when they exceed the idle cache cap. */
export function pinNoticeRegions(notices: NoticeRegionTarget[]): () => void {
  const keys = new Set(notices.filter(bid => bid.source === 'live').map(noticeRegionKey));
  for (const key of keys) pins.set(key, (pins.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const remaining = (pins.get(key) ?? 1) - 1;
      if (remaining) pins.set(key, remaining); else pins.delete(key);
    }
    // Effect cleanup precedes replacement registration. Wait until both have
    // run so an unchanged search does not lose its first cached rows.
    queueMicrotask(() => {
      if (trimNoticeRegionCache()) { cacheVersion++; listeners.forEach(listener => listener()); }
    });
  };
}
function storeRegion(key: string, entry: NoticeRegionEntry, cacheable = true) {
  const previous = cache.get(key);
  // A late failed/empty request must not erase a region just confirmed by detail.
  if (previous?.complete && previous.allowedRegions?.length
    && (!entry.complete || (!entry.allowedRegions?.length && Date.parse(previous.fetchedAt) >= Date.parse(entry.fetchedAt))
      || Date.parse(previous.fetchedAt) > Date.parse(entry.fetchedAt))) return previous;
  if (previous === entry) return entry;
  cache.delete(key);
  if (cacheable) cache.set(key, entry);
  trimNoticeRegionCache();
  cacheVersion++; listeners.forEach(listener => listener());
  return entry;
}

/** One request plan: visible rows by default; all filter candidates only when needed. */
export function selectNoticeRegionTargets(candidates: BidNotice[], visible: BidNotice[], filterEnabled: boolean, companyFilter: boolean) {
  const unknown = candidates.filter(needsNoticeRegions);
  const filterTargets = filterEnabled ? unknown.filter(bid => companyFilter || bid.type === '용역') : [];
  const settled = getCachedNoticeRegions(filterTargets);
  // Resolve filter membership first. Visible construction rows can move as
  // service matches arrive; mixing them in now would restart active batches.
  if (filterTargets.some(bid => !settled.has(noticeRegionKey(bid)))) return filterTargets;
  const visibleKeys = new Set(visible.map(noticeRegionKey));
  return unknown.filter(bid => visibleKeys.has(noticeRegionKey(bid)) || (filterEnabled && (companyFilter || bid.type === '용역')));
}

export function seedNoticeDetailRegions(bid: NoticeRegionTarget, detail: G2bNoticeDetail) {
  if (bid.source !== 'live' || bid.number !== detail.number || bid.revision !== detail.revision || !detail.regionComplete
    || (detail.notice && (detail.notice.type !== bid.type || detail.notice.number !== bid.number || detail.notice.revision !== bid.revision
      || (detail.notice.procurementSource ?? 'public') !== (bid.procurementSource ?? 'public')))) return;
  const entry = verifiedEntry({ complete: detail.regionComplete, fetchedAt: detail.fetchedAt, allowedRegions: detail.allowedRegions });
  if (entry.complete) storeRegion(noticeRegionKey(bid), entry);
}
// Only an explicit server/provider Retry-After may hold a later user request.
let blockedUntil = 0;
const unknownMessage = '참가 가능 지역을 확인하지 못했습니다. 공고 원문을 확인해 주세요.';
const quotaMessage = '지역 조회 호출 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.';

export function noticeRegionKey(bid: Pick<BidNotice, 'number' | 'revision' | 'type' | 'procurementSource'>) {
  return `${bid.procurementSource === 'private' ? 'private:' : ''}${bid.type}:${bid.number}:${bid.revision}`;
}
export function needsNoticeRegions(bid: NoticeRegionTarget) {
  return bid.source === 'live' && !bid.allowedRegions?.some(region => region.trim());
}
export function getCachedNoticeRegions(bids: NoticeRegionTarget[], includeConfirmedExpired = false): Map<string, NoticeRegionEntry> {
  return new Map(bids.filter(needsNoticeRegions).flatMap(bid => {
    const key = noticeRegionKey(bid); const entry = cache.get(key);
    return entry && (entry.until > Date.now() || (includeConfirmedExpired && entry.complete && !!entry.allowedRegions?.length)) ? [[key, entry] as const] : [];
  }));
}
export function mergeNoticeRegions(bids: BidNotice[], entries: ReadonlyMap<string, NoticeRegionEntry>, includeConfirmedExpired = false): BidNotice[] {
  return bids.map(bid => {
    if (!needsNoticeRegions(bid)) return bid;
    const entry = entries.get(noticeRegionKey(bid));
    return entry?.complete && entry.allowedRegions?.length && (includeConfirmedExpired || entry.until > Date.now())
      ? { ...bid, allowedRegions: [...entry.allowedRegions] } : bid;
  });
}
export function getNoticeRegionsRetryAt() { return blockedUntil > Date.now() ? blockedUntil : 0; }

function unconfirmed(quota = false): NoticeRegionEntry {
  const retryAt = getNoticeRegionsRetryAt();
  return { allowedRegions: null, complete: false, fetchedAt: '', error: quota || retryAt ? quotaMessage : unknownMessage, until: retryAt || Date.now() + CACHE_MS };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function verifiedEntry(value: Record<string, unknown> | undefined): NoticeRegionEntry {
  if (!value || value.complete !== true || value.error
    || typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt))) return unconfirmed();
  // A successful endpoint response can still have no published restriction.
  // It is unknown to the filter, but is not a transport/validation failure.
  if (value.allowedRegions === null) return { allowedRegions: null, complete: true, fetchedAt: value.fetchedAt, until: Date.now() + CACHE_MS };
  if (!Array.isArray(value.allowedRegions)
    || !value.allowedRegions.length || value.allowedRegions.some(region => typeof region !== 'string' || !region.trim() || ['-', '미제공', '확인 필요'].includes(region.trim()))
  ) return unconfirmed();
  return { allowedRegions: [...new Set((value.allowedRegions as string[]).map(region => region.trim()))], complete: true, fetchedAt: value.fetchedAt, until: Date.now() + CACHE_MS };
}
function rememberRetryAfter(seconds: unknown) {
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    blockedUntil = Math.max(blockedUntil, Date.now() + Math.ceil(seconds) * 1000);
  }
}

/** Hydrates exact identities from their procurement service; missing rows remain unknown. */
export async function loadNoticeRegions(
  bids: NoticeRegionTarget[], signal: AbortSignal,
  publish?: (key: string, entry: NoticeRegionEntry) => void,
  options: { retryFailed?: boolean } = {},
): Promise<{ entries: Map<string, NoticeRegionEntry>; retryAt: number }> {
  const entries = new Map<string, NoticeRegionEntry>();
  if (signal.aborted) return { entries, retryAt: getNoticeRegionsRetryAt() };
  const targets = [...new Map(bids.filter(needsNoticeRegions).map(bid => [noticeRegionKey(bid), bid])).values()];
  const requestAbort = new AbortController();
  let stoppedForQuota = false;
  const cancel = () => requestAbort.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const emit = (bid: NoticeRegionTarget, entry: NoticeRegionEntry, cacheable = true) => {
    if (signal.aborted) return;
    const key = noticeRegionKey(bid);
    const confirmed = storeRegion(key, entry, cacheable);
    entries.set(key, confirmed); publish?.(key, confirmed);
  };
  const queue: NoticeRegionTarget[][] = [];
  const missing = targets.filter(bid => {
    const hit = cache.get(noticeRegionKey(bid));
    if (hit && hit.until > Date.now() && ((hit.complete && hit.allowedRegions?.length) || !options.retryFailed)) { emit(bid, hit); return false; }
    return true;
  });
  for (const type of ['공사', '용역'] as const) {
    for (const procurementSource of ['public', 'private'] as const) {
      const business = missing.filter(bid => bid.type === type && (bid.procurementSource ?? 'public') === procurementSource);
      for (let index = 0; index < business.length; index += 10) queue.push(business.slice(index, index + 10));
    }
  }
  async function worker() {
    while (queue.length && !signal.aborted && !stoppedForQuota && !getNoticeRegionsRetryAt()) {
      const batch = queue.shift()!;
      try {
        const payload = await fetchApi<unknown>(`/api/notice-regions?${new URLSearchParams({
          type: batch[0].type, notices: batch.map(bid => `${bid.number}:${bid.revision}`).join(','),
          ...(batch[0].procurementSource === 'private' ? { procurementSource: 'private' } : {}),
          ...(options.retryFailed ? { refresh: '1' } : {}),
        })}`, requestAbort.signal);
        if (signal.aborted) return;
        const page = record(payload);
        const delay = page?.retryAfterSeconds;
        if (page?.quotaExceeded === true || (typeof delay === 'number' && Number.isFinite(delay) && delay > 0)) {
          stoppedForQuota = true; rememberRetryAfter(delay); requestAbort.abort();
        }
        const rows = Array.isArray(page?.items) ? page.items.map(record).filter((item): item is Record<string, unknown> => !!item) : [];
        for (const bid of batch) {
          const matching = rows.filter(item => item.number === bid.number && item.revision === bid.revision && item.type === bid.type
            && (item.procurementSource ?? 'public') === (bid.procurementSource ?? 'public'));
          const entry = verifiedEntry(matching.length === 1 ? matching[0] : undefined);
          emit(bid, !entry.complete && stoppedForQuota ? unconfirmed(true) : entry, entry.complete || !stoppedForQuota);
        }
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof ApiError && (cause.status === 429 || cause.code === 'G2B_QUOTA_EXCEEDED')) {
          stoppedForQuota = true;
          rememberRetryAfter(cause.retryAfterSeconds);
          requestAbort.abort();
        }
        for (const bid of batch) emit(bid, unconfirmed(stoppedForQuota), !stoppedForQuota);
      }
    }
  }
  try {
    await Promise.all([worker(), worker()]);
    if (!signal.aborted) for (const batch of queue) for (const bid of batch) emit(bid, unconfirmed(stoppedForQuota), !stoppedForQuota && !getNoticeRegionsRetryAt());
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  return { entries, retryAt: getNoticeRegionsRetryAt() };
}
