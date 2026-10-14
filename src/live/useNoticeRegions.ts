import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { BidNotice } from '../types';
import {
  getCachedNoticeRegions, getNoticeRegionsRetryAt, loadNoticeRegions, mergeNoticeRegions,
  needsNoticeRegions, noticeRegionKey, type NoticeRegionEntry, type NoticeRegionTarget,
  subscribeNoticeRegions, getNoticeRegionsVersion, pinNoticeRegions,
} from './notice-regions';

export function useCachedNoticeRegions(notices: BidNotice[]) {
  useEffect(() => pinNoticeRegions(notices), [notices]);
  const version = useSyncExternalStore(subscribeNoticeRegions, getNoticeRegionsVersion, getNoticeRegionsVersion);
  // Keep confirmed labels on screen; freshness controls the next request, not visibility.
  return useMemo(() => mergeNoticeRegions(notices, getCachedNoticeRegions(notices, true), true), [notices, version]);
}

interface RegionLoadState {
  key: string;
  entries: Map<string, NoticeRegionEntry>;
  running: boolean;
  retryAt: number;
}

export function useNoticeRegions(notices: BidNotice[], enabled: boolean, companyFilter = false, requestKey = '') {
  // Only public identities determine the request lifetime. Rendering a response
  // or changing an unrelated filter must not start the same requests again.
  const signature = JSON.stringify(notices.filter(bid => needsNoticeRegions(bid) && (companyFilter || bid.type === '용역')).map(({ number, revision, type }) => ({
    number, revision, type, source: 'live', allowedRegions: null,
  })));
  const targets = useMemo(() => JSON.parse(signature) as NoticeRegionTarget[], [signature]);
  const [retryVersion, setRetryVersion] = useState(0);
  const previousRetry = useRef(0);
  const previousRequest = useRef(requestKey);
  const key = `${enabled}:${requestKey}:${retryVersion}:${signature}`;
  const [state, setState] = useState<RegionLoadState>(() => ({
    key, entries: getCachedNoticeRegions(targets), running: enabled, retryAt: getNoticeRegionsRetryAt(),
  }));

  useEffect(() => {
    const abort = new AbortController();
    const retryFailed = previousRetry.current !== retryVersion || previousRequest.current !== requestKey;
    previousRetry.current = retryVersion;
    previousRequest.current = requestKey;
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
  }, [key, targets, enabled, retryVersion, requestKey]);

  // Release explicit Retry-After without deleting confirmed screen data or polling.
  useEffect(() => {
    if (!state.retryAt) return;
    const timer = setTimeout(() => setState(previous => ({
      ...previous,
      retryAt: getNoticeRegionsRetryAt(),
    })), Math.max(0, state.retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state.retryAt]);

  const view = state.key === key ? state : {
    entries: getCachedNoticeRegions(targets), running: enabled, retryAt: getNoticeRegionsRetryAt(),
  };
  const pending = enabled ? targets.filter(bid => !view.entries.has(noticeRegionKey(bid))).length : 0;
  const failed = enabled ? targets.filter(bid => view.entries.get(noticeRegionKey(bid))?.complete === false).length : 0;
  const items = useMemo(() => mergeNoticeRegions(notices, view.entries), [notices, view.entries]);
  const retry = useCallback(() => {
    if (enabled && !getNoticeRegionsRetryAt()) setRetryVersion(value => value + 1);
  }, [enabled]);
  const pendingKeys = new Set(enabled && view.running ? targets.filter(bid => !view.entries.has(noticeRegionKey(bid))).map(noticeRegionKey) : []);
  const failedKeys = new Set(enabled ? targets.filter(bid => view.entries.get(noticeRegionKey(bid))?.complete === false).map(noticeRegionKey) : []);
  return { items, loading: enabled && view.running && pending > 0, pending, pendingKeys, failedKeys, failed, retry, retryAt: view.retryAt };
}
