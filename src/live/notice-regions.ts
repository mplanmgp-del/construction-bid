import type { BidNotice } from '../types';
import { ApiError, fetchApi } from './client';

export type NoticeRegionTarget = Pick<BidNotice, 'number' | 'revision' | 'type' | 'source' | 'allowedRegions'>;
export interface NoticeRegionEntry {
  allowedRegions: string[] | null;
  complete: boolean;
  fetchedAt: string;
  error?: string;
  until: number;
}
const CACHE_MS = 300_000;
const cache = new Map<string, NoticeRegionEntry>();
// Only an explicit server/provider Retry-After may hold a later user request.
let blockedUntil = 0;
const unknownMessage = '참가 가능 지역을 확인하지 못했습니다. 공고 원문을 확인해 주세요.';
const quotaMessage = '지역 조회 호출 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.';

export function noticeRegionKey(bid: Pick<BidNotice, 'number' | 'revision' | 'type'>) { return `${bid.type}:${bid.number}:${bid.revision}`; }
export function needsNoticeRegions(bid: NoticeRegionTarget) {
  return bid.source === 'live' && !bid.allowedRegions?.some(region => region.trim());
}
export function getCachedNoticeRegions(bids: NoticeRegionTarget[]): Map<string, NoticeRegionEntry> {
  return new Map(bids.filter(needsNoticeRegions).flatMap(bid => {
    const key = noticeRegionKey(bid); const entry = cache.get(key);
    return entry && entry.until > Date.now() ? [[key, entry] as const] : [];
  }));
}
export function mergeNoticeRegions(bids: BidNotice[], entries: ReadonlyMap<string, NoticeRegionEntry>): BidNotice[] {
  return bids.map(bid => {
    if (!needsNoticeRegions(bid)) return bid;
    const entry = entries.get(noticeRegionKey(bid));
    return entry?.complete && entry.allowedRegions?.length && entry.until > Date.now()
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

/** Hydrates only public identities; failed or missing rows remain unknown. */
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
    cache.delete(key);
    if (cacheable) cache.set(key, entry);
    while (cache.size > 1000) cache.delete(cache.keys().next().value!);
    entries.set(key, entry); publish?.(key, entry);
  };
  const queue: NoticeRegionTarget[][] = [];
  const missing = targets.filter(bid => {
    const hit = cache.get(noticeRegionKey(bid));
    if (hit && hit.until > Date.now() && ((hit.complete && hit.allowedRegions?.length) || !options.retryFailed)) { emit(bid, hit); return false; }
    return true;
  });
  for (const type of ['공사', '용역'] as const) {
    const business = missing.filter(bid => bid.type === type);
    for (let index = 0; index < business.length; index += 10) queue.push(business.slice(index, index + 10));
  }
  async function worker() {
    while (queue.length && !signal.aborted && !stoppedForQuota && !getNoticeRegionsRetryAt()) {
      const batch = queue.shift()!;
      try {
        const payload = await fetchApi<unknown>(`/api/notice-regions?${new URLSearchParams({
          type: batch[0].type, notices: batch.map(bid => `${bid.number}:${bid.revision}`).join(','),
        })}`, requestAbort.signal);
        if (signal.aborted) return;
        const page = record(payload);
        const delay = page?.retryAfterSeconds;
        if (page?.quotaExceeded === true || (typeof delay === 'number' && Number.isFinite(delay) && delay > 0)) {
          stoppedForQuota = true; rememberRetryAfter(delay); requestAbort.abort();
        }
        const rows = Array.isArray(page?.items) ? page.items.map(record).filter((item): item is Record<string, unknown> => !!item) : [];
        for (const bid of batch) {
          const matching = rows.filter(item => item.number === bid.number && item.revision === bid.revision && item.type === bid.type);
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
