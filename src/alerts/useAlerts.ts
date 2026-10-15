import { useCallback, useEffect, useRef, useState } from 'react';
import { getMemberClient } from '../member/client';
import { selectedRegions, regionLabel } from '../search-filters';
import type { SearchFilters } from '../types';
import type { NoticeQuery } from '../live/notice-search';
import type { AlertFilter, AlertOverview, AlertSettings } from './types';

export interface AlertRepository {
  load(offset: number, existingOffset: number, signal: AbortSignal): Promise<AlertOverview>;
  mutate(action: 'save' | 'read' | 'setup', body: Record<string, unknown>, signal: AbortSignal): Promise<void>;
}
export interface AlertsSnapshot {
  userId: string | null;
  overview: AlertOverview | null;
  loading: boolean;
  loadingMore: boolean;
  loadingExisting: boolean;
  saving: boolean;
  reading: boolean;
  settingUp: boolean;
  error: string | null;
  message: string;
}
export interface AlertsAccess extends AlertsSnapshot {
  refresh: () => Promise<boolean>;
  save: (settings: AlertSettings) => Promise<boolean>;
  read: (target: { id: string } | { all: true }) => Promise<boolean>;
  setup: () => Promise<boolean>;
  loadMore: () => Promise<boolean>;
  loadExisting: () => Promise<boolean>;
}
const empty = (userId: string | null): AlertsSnapshot => ({ userId, overview: null, loading: false, loadingMore: false, loadingExisting: false, saving: false, reading: false, settingUp: false, error: null, message: '' });
const messageOf = (error: unknown) => error instanceof Error ? error.message : '알림 정보를 처리하지 못했습니다. 다시 시도해 주세요.';

async function alertRequest<T>(action: string, signal: AbortSignal, body?: Record<string, unknown>, params?: Record<string, string>): Promise<T> {
  signal.throwIfAborted();
  const client = getMemberClient();
  const session = client ? await client.auth.getSession() : null;
  signal.throwIfAborted();
  if (session?.error || !session?.data.session?.access_token) throw new Error('로그인 후 알림을 이용해 주세요.');
  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${session.data.session.access_token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const query = new URLSearchParams({ action, ...params });
  const response = await fetch(`/api/alerts?${query}`, { method: body ? 'POST' : 'GET', headers, signal, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || result.error) throw new Error(typeof result?.error?.message === 'string' ? result.error.message : typeof result?.error === 'string' ? result.error : '알림 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return result as T;
}
export const browserAlertRepository: AlertRepository = {
  load: (offset, existingOffset, signal) => alertRequest<AlertOverview>('overview', signal, undefined, { offset: String(offset), existingOffset: String(existingOffset) }),
  mutate: async (action, body, signal) => { const result = await alertRequest<{ ok: boolean }>(action, signal, body); if (result.ok !== true) throw new Error('알림 변경 결과를 확인하지 못했습니다. 다시 시도해 주세요.'); },
};
function mergeItems<T extends { id: string }>(previous: T[], next: T[]): T[] {
  return [...new Map([...previous, ...next].map(item => [item.id, item])).values()];
}

/** One user's alert state. Every request is cancelled and invalidated when the account changes. */
export class AlertsController {
  private snapshot = empty(null);
  private listeners = new Set<() => void>();
  private generation = 0;
  private readingRequest: AbortController | null = null;
  private writingRequest: AbortController | null = null;
  constructor(private repository: AlertRepository = browserAlertRepository) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: AlertsSnapshot) { this.snapshot = next; this.listeners.forEach(listener => listener()); }
  setUser(userId?: string) {
    this.generation++; this.readingRequest?.abort(); this.writingRequest?.abort();
    this.readingRequest = null; this.writingRequest = null;
    this.publish(empty(userId || null));
  }
  async refresh(mode: 'refresh' | 'more' | 'existing' = 'refresh', replace = false): Promise<boolean> {
    if (!this.snapshot.userId || (mode !== 'refresh' && this.snapshot.loading)) return false;
    this.readingRequest?.abort();
    const request = new AbortController(); this.readingRequest = request;
    const generation = this.generation;
    const previous = this.snapshot.overview;
    const offset = mode === 'more' ? previous?.notifications.length ?? 0 : 0;
    const existingOffset = mode === 'existing' ? previous?.existingMatches.length ?? 0 : 0;
    this.publish({ ...this.snapshot, loading: mode === 'refresh', loadingMore: mode === 'more', loadingExisting: mode === 'existing', error: null });
    try {
      const result = await this.repository.load(offset, existingOffset, request.signal);
      if (request.signal.aborted || generation !== this.generation) return false;
      const current = this.snapshot.overview;
      const overview = { ...result,
        notifications: replace || !current ? result.notifications : mode === 'existing' ? current.notifications : mode === 'more' ? mergeItems(current.notifications, result.notifications) : mergeItems(result.notifications, current.notifications).map(item => result.notifications.find(latest => latest.id === item.id) ?? item),
        existingMatches: replace || !current ? result.existingMatches : mode === 'more' ? current.existingMatches : mode === 'existing' ? mergeItems(current.existingMatches, result.existingMatches) : result.existingMatches,
        hasMore: mode === 'existing' && current ? current.hasMore : result.hasMore,
        existingHasMore: mode === 'more' && current ? current.existingHasMore : result.existingHasMore,
      };
      this.publish({ ...this.snapshot, overview, loading: false, loadingMore: false, loadingExisting: false, error: null });
      return true;
    } catch (error) {
      if (request.signal.aborted || generation !== this.generation) return false;
      this.publish({ ...this.snapshot, loading: false, loadingMore: false, loadingExisting: false, error: messageOf(error) });
      return false;
    } finally { if (this.readingRequest === request) this.readingRequest = null; }
  }
  private async mutate(action: 'save' | 'read' | 'setup', body: Record<string, unknown>, pending: 'saving' | 'reading' | 'settingUp', success: string): Promise<boolean> {
    if (!this.snapshot.userId || this.writingRequest) return false;
    const generation = this.generation;
    const request = new AbortController(); this.writingRequest = request;
    this.publish({ ...this.snapshot, [pending]: true, error: null, message: '' });
    try {
      await this.repository.mutate(action, body, request.signal);
      if (request.signal.aborted || generation !== this.generation) return false;
      if (action === 'read' && this.snapshot.overview) {
        const readAt = new Date().toISOString();
        this.publish({ ...this.snapshot, overview: { ...this.snapshot.overview, notifications: this.snapshot.overview.notifications.map(item => !item.readAt && (body.all === true || body.id === item.id) ? { ...item, readAt } : item) } });
      }
      const refreshed = await this.refresh('refresh', action === 'save');
      if (request.signal.aborted || generation !== this.generation) return false;
      this.publish({ ...this.snapshot, [pending]: false, message: refreshed ? success : '' });
      return refreshed;
    } catch (error) {
      if (request.signal.aborted || generation !== this.generation) return false;
      this.publish({ ...this.snapshot, [pending]: false, message: '', error: messageOf(error) });
      return false;
    } finally { if (this.writingRequest === request) this.writingRequest = null; }
  }
  save = (settings: AlertSettings) => this.mutate('save', { settings }, 'saving', '알림 조건을 저장했습니다.');
  read = (target: { id: string } | { all: true }) => this.mutate('read', target, 'reading', '읽음 상태를 저장했습니다.');
  setup = () => this.mutate('setup', {}, 'settingUp', '서버 알림 설정 상태를 갱신했습니다.');
  loadMore = () => this.refresh('more');
  loadExisting = () => this.refresh('existing');
  dispose() { this.setUser(); this.listeners.clear(); }
}

export function useAlerts(userId?: string, enabled = true): AlertsAccess {
  const controllerRef = useRef<AlertsController | null>(null);
  if (!controllerRef.current) controllerRef.current = new AlertsController();
  const controller = controllerRef.current;
  const [snapshot, setSnapshot] = useState(controller.getSnapshot);
  const activeUserId = enabled ? userId : undefined;
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setSnapshot(controller.getSnapshot()));
    controller.setUser(activeUserId);
    if (!activeUserId) return () => { unsubscribe(); controller.setUser(); };
    void controller.refresh();
    // This only refreshes the inbox. Collection runs on the server independently.
    const timer = window.setInterval(() => { const current = controller.getSnapshot(); if (!current.saving && !current.reading && !current.settingUp && !current.loading && !current.loadingMore && !current.loadingExisting) void controller.refresh(); }, 60_000);
    return () => { window.clearInterval(timer); unsubscribe(); controller.setUser(); };
  }, [controller, activeUserId]);
  const refresh = useCallback(() => controller.refresh(), [controller]);
  const visible = snapshot.userId === (activeUserId || null) ? snapshot : empty(activeUserId || null);
  return { ...visible, refresh, save: controller.save, read: controller.read, setup: controller.setup, loadMore: controller.loadMore, loadExisting: controller.loadExisting };
}

export function alertFilterFromSearch(filters: SearchFilters, query: NoticeQuery): AlertFilter {
  const split = (value: string) => [...new Set(value.split(/[,\n]+/).map(text => text.trim()).filter(Boolean))];
  const type = filters.type === '전체' ? query.type : filters.type;
  return { keywords: split(query.keyword || filters.keyword), excludeKeywords: split(filters.excludeKeyword),
    types: type === '공사·용역' ? ['공사', '용역'] : [type], categories: filters.category === '전체' ? [] : [filters.category],
    regions: selectedRegions(filters).map(regionLabel), licenses: filters.license === '전체' ? [] : [filters.license],
    minAmount: filters.minAmount ? Number(filters.minAmount) : null, maxAmount: filters.maxAmount ? Number(filters.maxAmount) : null,
    includeUnknown: filters.includeUnknownRegions === true, useCompanyRegion: filters.autoRegion };
}
