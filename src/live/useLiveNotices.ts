import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BidNotice } from '../types';
import type { G2bNoticePage, G2bNoticeDetail } from '../g2b-types';
import { currentNotice, recentDates } from './client';
import { fetchStartedNotices, type NoticeQuery } from './notice-search';
import { NOTICE_CACHE_FRESH_MS, NOTICE_CACHE_MAX_AGE_MS, normalizedNoticeQuery, noticeQueryKey, readLastNoticeQuery, readNoticeCache, writeNoticeCache } from './notice-cache';
export type { NoticeQuery } from './notice-search';

interface NoticeResult { key: string; items: BidNotice[]; meta: G2bNoticePage }
interface SearchState { key: string; loading: boolean; refreshing: boolean; progress: { done: number; total: number }; error: string }

export function useLiveNotices(enabled: boolean) {
  const [query, setQuery] = useState<NoticeQuery>(() => readLastNoticeQuery() ?? ({ type: '공사·용역', ...recentDates(7), keyword: '' }));
  const normalized = useMemo(() => normalizedNoticeQuery(query), [query.type, query.from, query.to, query.keyword]);
  const key = noticeQueryKey(normalized);
  const [result, setResult] = useState<NoticeResult | null>(null);
  const [state, setState] = useState<SearchState>({ key: '', loading: false, refreshing: false, progress: { done: 0, total: 0 }, error: '' });
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const [refreshCount, setRefreshCount] = useState(0);
  const handledRefresh = useRef(0);
  // Keep provider results separate from detail-enriched, account-filtered UI data.
  const lastComplete = useRef<{ key: string; page: G2bNoticePage } | null>(null);
  const load = useCallback(async (force: boolean) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const token = ++sequence.current;
    const cached = readNoticeCache(normalized);
    const previous = lastComplete.current?.key === key ? lastComplete.current.page : null;
    const age = previous ? Date.now() - Date.parse(previous.fetchedAt) : Infinity;
    const initial = cached?.page ?? (age >= 0 && age < NOTICE_CACHE_MAX_AGE_MS ? previous : null);
    if (initial) {
      // Remember the most recently used successful query without resetting data age.
      writeNoticeCache(normalized, initial);
      lastComplete.current = { key, page: initial };
      setResult({ key, items: initial.items.map(item => currentNotice({ ...item, source: 'live' })), meta: initial });
    } else setResult(null);
    const fresh = cached?.fresh ?? (age >= 0 && age < NOTICE_CACHE_FRESH_MS);
    const needsFetch = force || !fresh;
    setState({ key, loading: !initial && needsFetch, refreshing: !!initial && needsFetch, progress: { done: 0, total: 0 }, error: '' });
    if (!needsFetch) return;
    let hasVisible = !!initial;
    const publish = (page: G2bNoticePage) => {
      if (token !== sequence.current || controller.signal.aborted) return false;
      writeNoticeCache(normalized, page);
      lastComplete.current = { key, page };
      setResult({ key, items: page.items.map(item => currentNotice({ ...item, source: 'live' })), meta: page });
      hasVisible = true;
      return true;
    };
    const updateProgress = (done: number, total: number) => {
      if (token === sequence.current && !controller.signal.aborted) setState(value => ({ ...value, progress: { done, total } }));
    };
    try {
      const page = await fetchStartedNotices(normalized, controller.signal, updateProgress, { force: force || !!initial });
      if (!publish(page)) return;
      // The shared cache can serve a complete stale snapshot to a new browser.
      // Show it immediately, then wait once for the provider refresh to finish.
      if (page.warnings?.includes('저장된 공고를 표시하며 최신 자료를 갱신 중입니다.')) {
        setState(value => ({ ...value, loading: false, refreshing: true }));
        publish(await fetchStartedNotices(normalized, controller.signal, updateProgress, { force: true }));
      }
    } catch (cause) {
      if (!controller.signal.aborted && token === sequence.current) {
        const message = cause instanceof Error ? cause.message : '조회에 실패했습니다.';
        setState(value => ({ ...value, error: hasVisible ? `최신 정보 갱신 실패: ${message} 이전 조회 결과를 표시합니다.` : message }));
      }
    } finally {
      if (token === sequence.current && !controller.signal.aborted) setState(value => ({ ...value, loading: false, refreshing: false }));
    }
  }, [normalized, key]);
  useEffect(() => {
    const force = refreshCount !== handledRefresh.current;
    handledRefresh.current = refreshCount;
    if (enabled) void load(force);
    return () => { sequence.current++; request.current?.abort(); };
  }, [enabled, load, refreshCount]);
  const visible = result?.key === key ? result : null;
  const active = state.key === key ? state : null;
  const loading = enabled && (active?.loading ?? true);
  const refreshing = enabled && !!active?.refreshing;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !loading && !refreshing) setRefreshCount(value => value + 1);
    }, 300_000);
    return () => window.clearInterval(timer);
  }, [enabled, loading, refreshing]);
  function applyDetail(id: string, detail: G2bNoticeDetail) {
    setResult(previous => previous && previous.key === key ? { ...previous, items: previous.items.map(bid => bid.id === id ? { ...bid,
      allowedRegions: detail.regionComplete ? detail.allowedRegions : bid.allowedRegions,
      licenses: detail.licenseComplete ? detail.licenses : bid.licenses,
    } : bid) } : previous);
  }
  return { query, setQuery, items: visible?.items ?? [], meta: visible?.meta ?? null, loading, refreshing,
    progress: active?.progress ?? { done: 0, total: 0 }, error: active?.error ?? '', applyDetail,
    refresh: () => setRefreshCount(value => value + 1),
  };
}
