import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BidNotice } from '../types';
import {
  getCachedNoticeRegions, getNoticeRegionsRetryAt, loadNoticeRegions, mergeNoticeRegions,
  needsNoticeRegions, noticeRegionKey, type NoticeRegionEntry, type NoticeRegionTarget,
} from './notice-regions';

interface RegionLoadState {
  key: string;
  entries: Map<string, NoticeRegionEntry>;
  running: boolean;
  retryAt: number;
}

export function useNoticeRegions(notices: BidNotice[], enabled: boolean) {
  // Only public identities determine the request lifetime. Rendering a response
  // or changing an unrelated filter must not start the same requests again.
  const signature = JSON.stringify(notices.filter(needsNoticeRegions).map(({ number, revision, type }) => ({
    number, revision, type, source: 'live', allowedRegions: null,
  })));
  const targets = useMemo(() => JSON.parse(signature) as NoticeRegionTarget[], [signature]);
  const [retryVersion, setRetryVersion] = useState(0);
  const previousRetry = useRef(0);
  const key = `${enabled}:${retryVersion}:${signature}`;
  const [state, setState] = useState<RegionLoadState>(() => ({
    key, entries: getCachedNoticeRegions(targets), running: enabled, retryAt: getNoticeRegionsRetryAt(),
  }));

  useEffect(() => {
    const abort = new AbortController();
    const retryFailed = previousRetry.current !== retryVersion;
    previousRetry.current = retryVersion;
    const entries = getCachedNoticeRegions(targets);
    if (retryFailed) for (const [entryKey, entry] of entries) if (!entry.complete || !entry.allowedRegions?.length) entries.delete(entryKey);
    setState({ key, entries, running: enabled, retryAt: getNoticeRegionsRetryAt() });
    if (enabled) void loadNoticeRegions(targets, abort.signal, (entryKey, entry) => {
      if (!abort.signal.aborted) setState(previous => previous.key !== key ? previous : {
        ...previous, entries: new Map(previous.entries).set(entryKey, entry), retryAt: getNoticeRegionsRetryAt(),
      });
    }, { retryFailed }).then(result => {
      if (!abort.signal.aborted) setState({ key, entries: result.entries, running: false, retryAt: result.retryAt });
    });
    return () => abort.abort();
  }, [key, targets, enabled, retryVersion]);

  // Expire visible region data and re-enable the quota retry button locally.
  // A user action is required to request regions again after expiry.
  useEffect(() => {
    const deadlines = [...state.entries.values()].map(entry => entry.until);
    if (state.retryAt > 0) deadlines.push(state.retryAt);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setState(previous => ({
      ...previous,
      entries: new Map([...previous.entries].filter(([, entry]) => entry.until > Date.now())),
      retryAt: getNoticeRegionsRetryAt(),
    })), Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => clearTimeout(timer);
  }, [state.entries, state.retryAt]);

  const view = state.key === key ? state : {
    entries: getCachedNoticeRegions(targets), running: enabled, retryAt: getNoticeRegionsRetryAt(),
  };
  const pending = enabled ? targets.filter(bid => !view.entries.has(noticeRegionKey(bid))).length : 0;
  const failed = enabled ? targets.filter(bid => view.entries.get(noticeRegionKey(bid))?.complete === false).length : 0;
  const items = useMemo(() => mergeNoticeRegions(notices, view.entries), [notices, view.entries]);
  const retry = useCallback(() => {
    if (enabled && !getNoticeRegionsRetryAt()) setRetryVersion(value => value + 1);
  }, [enabled]);
  return { items, loading: enabled && view.running && pending > 0, pending, failed, retry, retryAt: view.retryAt };
}
