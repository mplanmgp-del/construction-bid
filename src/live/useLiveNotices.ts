import { useCallback, useEffect, useRef, useState } from 'react';
import type { BidNotice } from '../types';
import type { G2bNoticePage, G2bNoticeDetail } from '../g2b-types';
import { currentNotice, mergeById, recentDates } from './client';
import { fetchStartedNotices, type NoticeQuery } from './notice-search';
export type { NoticeQuery } from './notice-search';

export function useLiveNotices(enabled: boolean) {
  const [query, setQuery] = useState<NoticeQuery>(() => ({ type: '공사·용역', ...recentDates(7), keyword: '' }));
  const [items, setItems] = useState<BidNotice[]>([]);
  const [meta, setMeta] = useState<G2bNoticePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const [refreshCount, setRefreshCount] = useState(0);
  const load = useCallback(async (page: number) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const token = ++sequence.current;
    setLoading(true); setError('');
    if (page === 1) { setItems([]); setMeta(null); }
    try {
      const result = await fetchStartedNotices(query, controller.signal, (done, total) => { if (token === sequence.current) setProgress({ done, total }); });
      if (token !== sequence.current) return;
      setItems(previous => mergeById(page === 1 ? [] : previous, result.items.map(item => currentNotice({ ...item, source: 'live' }))));
      setMeta(result);
    } catch (cause) {
      if (!controller.signal.aborted && token === sequence.current) setError(cause instanceof Error ? cause.message : '조회에 실패했습니다.');
    } finally { if (token === sequence.current) setLoading(false); }
  }, [query]);
  useEffect(() => {
    if (enabled) void load(1);
    return () => { sequence.current++; request.current?.abort(); };
  }, [enabled, load, refreshCount]);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      // Multi-page searches stay stable; refresh them explicitly to avoid silently dropping loaded rows.
      if (document.visibilityState === 'visible' && !loading && !error && (meta?.page ?? 1) === 1) setRefreshCount(value => value + 1);
    }, 300_000);
    return () => window.clearInterval(timer);
  }, [enabled, loading, error, meta?.page]);
  function applyDetail(id: string, detail: G2bNoticeDetail) {
    setItems(previous => previous.map(bid => bid.id === id ? { ...bid,
      allowedRegions: detail.regionComplete ? detail.allowedRegions : bid.allowedRegions,
      licenses: detail.licenseComplete ? detail.licenses : bid.licenses,
    } : bid));
  }
  return { query, setQuery, items, meta, loading, progress, error, applyDetail,
    refresh: () => setRefreshCount(value => value + 1),
    loadMore: () => { if (!loading && meta?.hasMore) void load(meta.page + 1); },
  };
}
