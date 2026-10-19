import { useCallback, useEffect, useRef, useState } from 'react';
import type { G2bNoticePage } from '../g2b-types';
import type { CompanyProfile, SearchFilters } from '../types';
import { deadlineMonthWindow } from '../notice-deadline-window';
import { IndexedNoticesController, indexedSearchKey } from './indexed-notice-search';
import { NOTICE_CACHE_MAX_AGE_MS, normalizedNoticeQuery } from './notice-cache';
import type { NoticeQuery } from './notice-search';
export type { NoticeQuery } from './notice-search';

export function canRetainNoticePage(page: G2bNoticePage | null | undefined, now = Date.now()): page is G2bNoticePage {
  if (!page) return false; const age = now - Date.parse(page.fetchedAt); return Number.isFinite(age) && age >= 0 && age < NOTICE_CACHE_MAX_AGE_MS;
}

/** Filtered results arrive first; aggregate collection status follows separately. */
export function useLiveNotices(enabled: boolean, filters?: SearchFilters, profile?: Pick<CompanyProfile, 'province' | 'district' | 'licenseCodes'>, initialQuery?: NoticeQuery) {
  const [query, setQuery] = useState<NoticeQuery>(() => initialQuery ?? ({ type: '공사·용역', ...deadlineMonthWindow(6), keyword: '' }));
  const [version, setVersion] = useState(0);
  const controllerRef = useRef<IndexedNoticesController | null>(null);
  if (!controllerRef.current) controllerRef.current = new IndexedNoticesController();
  const controller = controllerRef.current;
  const activeKey = useRef('');
  const [snapshot, setSnapshot] = useState(controller.getSnapshot);
  const normalized = normalizedNoticeQuery(query), input = { ...normalized, filters, profile };
  let key: string; try { key = indexedSearchKey(input); } catch { key = JSON.stringify(input); }
  useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller]);
  useEffect(() => {
    if (!enabled) { controller.setUser(); return; }
    activeKey.current = key;
    if (controller.getSnapshot().userId !== 'public-verified-search') controller.setUser('public-verified-search');
    void controller.search(input);
    return () => controller.clear();
  }, [controller, enabled, key, version]);
  const search = useCallback((next: NoticeQuery) => { setQuery(next); setVersion(value => value + 1); }, []);
  const refresh = useCallback(() => setVersion(value => value + 1), []);
  const current = enabled && activeKey.current === key && snapshot.userId === 'public-verified-search';
  const meta = current ? snapshot.meta : null;
  return { query, setQuery, queryVersion: `${key}:${version}`, selectionKey: `${key}:${snapshot.selectionKey}`, items: current ? snapshot.items : [], meta,
    loading: enabled && (!current || snapshot.loading), refreshing: false, requiresKeyword: false, retryAt: 0,
    error: enabled ? snapshot.error : '', stale: current && snapshot.stale, indexCoverage: meta?.status?.indexCoverage,
    hasMore: current && snapshot.hasMore, hasPrevious: current && snapshot.hasPrevious, pageNumber: snapshot.pageNumber,
    totalCount: meta?.totalCount ?? 0, loadMore: controller.next, next: controller.next, previous: controller.previous, search, refresh, applyDetail: controller.applyDetail };
}
