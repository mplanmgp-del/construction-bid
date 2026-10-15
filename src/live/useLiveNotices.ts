import { useCallback, useEffect, useRef, useState } from 'react';
import type { G2bNoticePage } from '../g2b-types';
import { deadlineMonthWindow, matchesDeadlineWindow } from '../notice-deadline-window';
import { IndexedNoticesController } from './indexed-notice-search';
import { NOTICE_CACHE_MAX_AGE_MS, normalizedNoticeQuery, noticeQueryKey } from './notice-cache';
import type { NoticeQuery } from './notice-search';
export type { NoticeQuery } from './notice-search';

export function canRetainNoticePage(page: G2bNoticePage | null | undefined, now = Date.now()): page is G2bNoticePage {
  if (!page) return false;
  const age = now - Date.parse(page.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < NOTICE_CACHE_MAX_AGE_MS;
}

/** Bounded index pages are verified against every current revision before display. */
export function useLiveNotices(enabled: boolean) {
  const [query, setQuery] = useState<NoticeQuery>(() => ({ type: '공사·용역', ...deadlineMonthWindow(6), keyword: '' }));
  const [version, setVersion] = useState(0);
  const controllerRef = useRef<IndexedNoticesController | null>(null);
  if (!controllerRef.current) controllerRef.current = new IndexedNoticesController();
  const controller = controllerRef.current;
  const activeKey = useRef('');
  const [snapshot, setSnapshot] = useState(controller.getSnapshot);
  const normalized = normalizedNoticeQuery(query), key = noticeQueryKey(normalized);
  useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller]);
  useEffect(() => {
    if (!enabled) { controller.setUser(); return; }
    activeKey.current = key;
    controller.setUser('public-deadline-search');
    void controller.search(normalized);
    return () => controller.setUser();
  }, [controller, enabled, key, version]);
  const search = useCallback((next: NoticeQuery) => { setQuery(next); setVersion(value => value + 1); }, []);
  const refresh = useCallback(() => setVersion(value => value + 1), []);
  const items = enabled && activeKey.current === key && snapshot.userId === 'public-deadline-search'
    ? snapshot.items.filter(notice => matchesDeadlineWindow(notice, normalized)) : [];
  const meta: G2bNoticePage | null = snapshot.fetchedAt ? { items, totalCount: items.length, page: 1, pageSize: items.length,
    hasMore: snapshot.hasMore, fetchedAt: snapshot.fetchedAt, source: '나라장터 제출마감 공고 색인', warnings: [] } : null;
  return { query, setQuery, queryVersion: `${key}:${version}`, items, meta, loading: enabled && snapshot.loading,
    refreshing: false, requiresKeyword: false, retryAt: 0, progress: { done: snapshot.checkedCount, total: snapshot.candidateCount },
    error: enabled ? snapshot.error : '', indexCoverage: snapshot.indexCoverage,
    hasMore: enabled && snapshot.hasMore, loadMore: controller.loadMore, search, refresh,
    applyDetail: controller.applyDetail,
  };
}
