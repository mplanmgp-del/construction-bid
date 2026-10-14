import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BidNotice } from '../types';
import type { G2bNoticePage, G2bNoticeDetail } from '../g2b-types';
import { ApiError, currentNotice, recentDates } from './client';
import { fetchStartedNotices, type NoticeQuery } from './notice-search';
import { NOTICE_CACHE_FRESH_MS, NOTICE_CACHE_MAX_AGE_MS, normalizedNoticeQuery, noticeQueryKey, readLastNoticeQuery, readNoticeCache, writeNoticeCache } from './notice-cache';
export type { NoticeQuery } from './notice-search';

interface NoticeResult { key: string; items: BidNotice[]; meta: G2bNoticePage }
interface SearchState { key: string; loading: boolean; refreshing: boolean; progress: { done: number; total: number }; error: string; retryAt: number }
const EXPIRED_RESULT_MESSAGE = '저장된 조회 결과가 만료되었습니다. 다시 조회해 주세요.';

export function canRetainNoticePage(page: G2bNoticePage | null | undefined, now = Date.now()): page is G2bNoticePage {
  if (!page) return false;
  const age = now - Date.parse(page.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < NOTICE_CACHE_MAX_AGE_MS;
}

export function useLiveNotices(enabled: boolean) {
  const [query, setQuery] = useState<NoticeQuery>(() => readLastNoticeQuery() ?? ({ type: '공사·용역', ...recentDates(7), keyword: '' }));
  const normalized = useMemo(() => normalizedNoticeQuery(query), [query.type, query.from, query.to, query.keyword]);
  const key = noticeQueryKey(normalized);
  const requiresKeyword = !normalized.keyword;
  const [result, setResult] = useState<NoticeResult | null>(null);
  const [state, setState] = useState<SearchState>({ key: '', loading: false, refreshing: false, progress: { done: 0, total: 0 }, error: '', retryAt: 0 });
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
    const initial = cached?.page ?? (canRetainNoticePage(previous) ? previous : null);
    if (initial) {
      // Remember the most recently used successful query without resetting data age.
      writeNoticeCache(normalized, initial);
      lastComplete.current = { key, page: initial };
      setResult({ key, items: initial.items.map(item => currentNotice({ ...item, source: 'live' })), meta: initial });
    } else setResult(null);
    const fresh = cached?.fresh ?? (age >= 0 && age < NOTICE_CACHE_FRESH_MS);
    const needsFetch = !!normalized.keyword && (force || !fresh);
    setState({ key, loading: !initial && needsFetch, refreshing: !!initial && needsFetch, progress: { done: 0, total: 0 }, error: '', retryAt: 0 });
    if (!needsFetch) return;
    let visiblePage = initial;
    const publish = (page: G2bNoticePage) => {
      if (token !== sequence.current || controller.signal.aborted) return false;
      if (!canRetainNoticePage(page)) throw new Error(EXPIRED_RESULT_MESSAGE);
      writeNoticeCache(normalized, page);
      lastComplete.current = { key, page };
      setResult({ key, items: page.items.map(item => currentNotice({ ...item, source: 'live' })), meta: page });
      setState(value => value.key === key ? { ...value, error: '', retryAt: 0 } : value);
      visiblePage = page;
      return true;
    };
    const updateProgress = (done: number, total: number) => {
      if (token === sequence.current && !controller.signal.aborted) setState(value => ({ ...value, progress: { done, total } }));
    };
    try {
      const page = await fetchStartedNotices(normalized, controller.signal, updateProgress, { force });
      if (!publish(page)) return;
    } catch (cause) {
      if (!controller.signal.aborted && token === sequence.current) {
        const message = cause instanceof Error ? cause.message : '조회에 실패했습니다.';
        const retryAt = cause instanceof ApiError && cause.status === 429 && cause.retryAfterSeconds
          ? Date.now() + cause.retryAfterSeconds * 1000 : 0;
        const retained = canRetainNoticePage(visiblePage);
        if (!retained) {
          setResult(value => value?.key === key ? null : value);
          if (lastComplete.current?.key === key) lastComplete.current = null;
        }
        setState(value => ({ ...value, error: retained ? `최신 정보 갱신 실패: ${message} 이전 조회 결과를 표시합니다.`
          : visiblePage ? `${message} ${EXPIRED_RESULT_MESSAGE}` : message, retryAt }));
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
  const visible = result?.key === key && canRetainNoticePage(result.meta) ? result : null;
  const active = state.key === key ? state : null;
  const loading = enabled && !requiresKeyword && (active?.loading ?? true);
  const refreshing = enabled && !!active?.refreshing;
  useEffect(() => {
    if (!enabled || !active?.retryAt) return;
    const until = active.retryAt;
    // Honor an explicit Retry-After only; never retry the API on a timer.
    const timer = window.setTimeout(() => setState(value => value.key === key && value.retryAt === until ? { ...value, retryAt: 0 } : value), Math.max(0, until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [enabled, key, active?.retryAt]);
  useEffect(() => {
    if (!enabled || result?.key !== key) return;
    const fetchedAt = result.meta.fetchedAt;
    const expiresAt = Date.parse(fetchedAt) + NOTICE_CACHE_MAX_AGE_MS;
    const timer = window.setTimeout(() => {
      // A later query or successful refresh must never be cleared by an old timer.
      if (lastComplete.current?.key !== key || lastComplete.current.page.fetchedAt !== fetchedAt) return;
      lastComplete.current = null;
      setResult(value => value?.key === key && value.meta.fetchedAt === fetchedAt ? null : value);
      setState(value => value.key === key ? { ...value, loading: value.loading || value.refreshing, refreshing: false, error: EXPIRED_RESULT_MESSAGE } : value);
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [enabled, key, result?.key, result?.meta.fetchedAt]);
  function applyDetail(id: string, detail: G2bNoticeDetail) {
    setResult(previous => previous && previous.key === key ? { ...previous, items: previous.items.map(bid => bid.id === id ? { ...bid,
      allowedRegions: detail.regionComplete ? detail.allowedRegions : bid.allowedRegions,
      licenses: detail.licenseComplete ? detail.licenses : bid.licenses,
    } : bid) } : previous);
  }
  return { query, setQuery, queryVersion: `${key}:${refreshCount}`, items: visible?.items ?? [], meta: visible?.meta ?? null, loading, refreshing, requiresKeyword, retryAt: active?.retryAt ?? 0,
    progress: active?.progress ?? { done: 0, total: 0 }, error: active?.error ?? '', applyDetail,
    search: (next: NoticeQuery) => { setQuery(next); setRefreshCount(value => value + 1); },
    refresh: () => { if (!requiresKeyword && Date.now() >= (active?.retryAt ?? 0)) setRefreshCount(value => value + 1); },
  };
}
