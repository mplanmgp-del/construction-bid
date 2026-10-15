import { useCallback, useEffect, useRef, useState } from 'react';
import type { G2bNoticePage } from '../g2b-types';
import { DEFAULT_ALERT_SETTINGS } from '../alerts/types';
import { deadlineMonthWindow, matchesDeadlineWindow } from '../notice-deadline-window';
import { CustomNoticesController } from './custom-notice-search';
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
  const controllerRef = useRef<CustomNoticesController | null>(null);
  if (!controllerRef.current) controllerRef.current = new CustomNoticesController();
  const controller = controllerRef.current;
  const activeKey = useRef('');
  const [snapshot, setSnapshot] = useState(controller.getSnapshot);
  const normalized = normalizedNoticeQuery(query), key = noticeQueryKey(normalized);
  useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller]);
  useEffect(() => {
    if (!enabled) { controller.setUser(); return; }
    activeKey.current = key;
    controller.setUser('public-deadline-search');
    const settings = { ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: false, filter: {
      ...structuredClone(DEFAULT_ALERT_SETTINGS.filter), keywords: normalized.keyword ? [normalized.keyword] : [],
      types: normalized.type === '공사·용역' ? ['공사', '용역'] as ['공사', '용역'] : [normalized.type],
      categories: [], regions: [], licenses: [], includeUnknown: true, useCompanyRegion: false, useCompanyLicenses: false,
      minAmount: null, maxAmount: null, minDaysUntilDeadline: null, agencies: [], contractMethods: [],
    } };
    void controller.search({ settings, profile: null, from: normalized.from, to: normalized.to, basis: 'deadline', publicKeyword: normalized.keyword });
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
