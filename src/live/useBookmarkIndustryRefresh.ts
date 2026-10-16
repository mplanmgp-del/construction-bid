import { useEffect, useRef, useState } from 'react';
import type { BidNotice } from '../types';
import type { MemberWorkspace } from '../member/workspace';
import { bookmarkIndustryKey, BOOKMARK_INDUSTRY_RETRY_MS, loadBookmarkIndustryBatch,
  mergeBookmarkIndustryBatch, needsBookmarkIndustryRefresh } from './bookmark-industry-refresh';

export function useBookmarkIndustryRefresh(notices: BidNotice[], enabled: boolean, userId: string | undefined,
  industryFilter: string, updateWorkspace: (updater: (current: MemberWorkspace) => MemberWorkspace) => void) {
  const retries = useRef(new Map<string, number>());
  const updater = useRef(updateWorkspace);
  updater.current = updateWorkspace;
  const [wake, setWake] = useState(0);
  const targets = notices.filter(needsBookmarkIndustryRefresh);
  const signature = JSON.stringify(targets.map(notice => [bookmarkIndustryKey(notice), notice.sourceUpdatedAt ?? '']));
  const latestNotices = useRef(targets);
  latestNotices.current = targets;

  useEffect(() => { retries.current.clear(); }, [userId]);
  useEffect(() => {
    if (!enabled || !userId || industryFilter === '전체') return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const now = Date.now();
    const eligible = latestNotices.current.filter(notice => (retries.current.get(bookmarkIndustryKey(notice)) ?? 0) <= now);
    if (eligible.length) {
      void loadBookmarkIndustryBatch(eligible, abort.signal).then(({ results, failed }) => {
        if (abort.signal.aborted) return;
        for (const key of failed) retries.current.set(key, Date.now() + BOOKMARK_INDUSTRY_RETRY_MS);
        // A removed bookmark or an account transition may make the guarded
        // write a no-op. Do not immediately repeat its successful request.
        for (const { notice } of results) retries.current.set(bookmarkIndustryKey(notice), Date.now() + BOOKMARK_INDUSTRY_RETRY_MS);
        // One account-guarded write per batch avoids cancelling a sibling request.
        if (results.length) updater.current(current => mergeBookmarkIndustryBatch(current, userId, results));
        setWake(value => value + 1);
      });
    } else {
      const retryAt = Math.min(...latestNotices.current.map(notice => retries.current.get(bookmarkIndustryKey(notice)) ?? Infinity));
      if (Number.isFinite(retryAt)) timer = setTimeout(() => setWake(value => value + 1), Math.max(1, retryAt - now));
    }
    return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [enabled, userId, industryFilter, signature, wake]);
}
