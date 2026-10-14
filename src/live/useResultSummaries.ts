import { useEffect, useRef, useState } from 'react';
import type { BidNotice } from '../types';
import type { G2bResultSummary } from '../g2b-types';
import { ApiError, fetchApi } from './client';

export type ResultEntry = { data?: G2bResultSummary; error?: boolean; until: number };
export const resultKey = (bid: BidNotice) => `${bid.type}:${bid.number}:${bid.revision}:${bid.openingAt}`;
export const needsResult = (bid: BidNotice) => bid.source === 'live' && bid.status !== '취소' && Number.isFinite(Date.parse(bid.openingAt)) && Date.parse(bid.openingAt) <= Date.now();

// Preserve only an explicit Retry-After across pages; quota without one stops
// the current queue, while a later user request can try the provider again.
let blockedUntil = 0;
export async function loadResultSummaryQueue(bids: BidNotice[], signal: AbortSignal, publish: (bid: BidNotice, entry: ResultEntry) => void) {
  const queue = [...bids];
  let stoppedForQuota = false;
  async function worker() {
    while (queue.length && !signal.aborted) {
      const bid = queue.shift()!;
      let entry: ResultEntry;
      if (stoppedForQuota || blockedUntil > Date.now()) entry = { error: true, until: Math.max(Date.now(), blockedUntil) };
      else {
        try {
          const data = await fetchApi<G2bResultSummary>(`/api/result-summary?${new URLSearchParams({ number: bid.number, revision: bid.revision, type: bid.type, openingAt: bid.openingAt })}`, signal);
          if (data.number !== bid.number || data.revision !== bid.revision || data.type !== bid.type) throw new Error('Identity mismatch');
          entry = { data, until: Date.now() + 300_000 };
        } catch (cause) {
          const quota = cause instanceof ApiError && (cause.code === 'G2B_QUOTA_EXCEEDED' || cause.status === 429);
          const until = Date.now() + (quota ? (cause.retryAfterSeconds ?? 0) * 1000 : 30_000);
          if (quota) {
            stoppedForQuota = true;
            if (cause.retryAfterSeconds) blockedUntil = Math.max(blockedUntil, until);
          }
          entry = { error: true, until };
        }
      }
      if (signal.aborted) return;
      publish(bid, entry);
    }
  }
  await Promise.all([worker(), worker()]);
}

export function useResultSummaries(bids: BidNotice[], enabled = true) {
  const cache = useRef(new Map<string, ResultEntry>());
  const [entries, setEntries] = useState<Record<string, ResultEntry>>({});
  const [retry, setRetry] = useState(0);
  const signature = JSON.stringify(bids.filter(needsResult).map(bid => ({ number: bid.number, revision: bid.revision, type: bid.type, openingAt: bid.openingAt })));
  useEffect(() => {
    const abort = new AbortController();
    const targets = JSON.parse(signature) as BidNotice[];
    const queue = targets.filter(bid => (cache.current.get(resultKey(bid))?.until ?? 0) <= Date.now());
    setEntries(Object.fromEntries(targets.flatMap(bid => {
      const hit = cache.current.get(resultKey(bid));
      return hit && hit.until > Date.now() ? [[resultKey(bid), hit]] : [];
    })));
    if (!enabled) return () => abort.abort();
    void loadResultSummaryQueue(queue, abort.signal, (bid, entry) => {
      cache.current.set(resultKey(bid), entry);
      while (cache.current.size > 160) cache.current.delete(cache.current.keys().next().value!);
      setEntries(previous => ({ ...previous, [resultKey(bid)]: entry }));
    });
    return () => abort.abort();
  }, [signature, retry, enabled]);
  return { entries, refresh: () => { cache.current.clear(); setRetry(value => value + 1); } };
}
