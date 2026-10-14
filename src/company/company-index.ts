import type { CompanyHistory, PublicCompany } from '../company-types';
import { ApiError, fetchApi } from '../live/client';

export interface CompanyIndexFilter {
  from: string;
  to: string;
  outcome: 'all' | 'won' | 'lost' | 'pending';
  page: number;
  awardsPage: number;
  contractsPage: number;
}

export function companyHistoryPath(businessNumber: string, filter: CompanyIndexFilter) {
  const query = new URLSearchParams({ businessNumber, page: String(filter.page), outcome: filter.outcome,
    awardsPage: String(filter.awardsPage), contractsPage: String(filter.contractsPage) });
  if (filter.from) query.set('from', filter.from);
  if (filter.to) query.set('to', filter.to);
  return `/api/company-history?${query}`;
}

/** Zero is meaningful only when collection of the requested scope is complete. */
export function collectedCount(value: number, coverage?: CompanyHistory['coverage']) {
  if (!coverage || coverage.status === 'unavailable') return null;
  return value > 0 || coverage.status === 'ready' ? value : null;
}

export function collectedWinningAmount(summary: CompanyHistory['summary'] | null, coverage?: CompanyHistory['coverage']) {
  if (!summary || !coverage || coverage.status === 'unavailable') return null;
  if (summary.winCount === 0 && (coverage.status !== 'ready' || summary.pendingCount > 0)) return null;
  return summary.winningAmount;
}

/** Index-only company entries cannot erase a more complete official profile. */
export function mergeCompanyProfile(selected: PublicCompany | null, stored?: PublicCompany | null): PublicCompany | null {
  if (!selected || !stored || selected.businessNumber !== stored.businessNumber) return selected;
  const newer = !selected.updatedAt || !stored.updatedAt || Date.parse(stored.updatedAt) >= Date.parse(selected.updatedAt);
  const merged = { ...selected };
  for (const key of ['name', 'representative', 'address', 'phone', 'registrationDate', 'companyType', 'updatedAt'] as const) {
    if (stored[key] && (newer || !selected[key])) merged[key] = stored[key];
  }
  for (const key of ['licenses', 'products'] as const) if (stored[key]?.length && (newer || !selected[key].length)) merged[key] = stored[key];
  return merged;
}

export function historyRefreshDelay(history: CompanyHistory | null, failures = 0, error?: unknown) {
  const partial = !history || history.coverage.status !== 'ready'
    || history.awards?.coverage.status !== 'ready' || history.contracts?.coverage.status !== 'ready';
  const normal = partial ? 60_000 : 180_000;
  const retryAfter = error instanceof ApiError ? (error.retryAfterSeconds ?? 0) * 1_000 : 0;
  return Math.max(normal, Math.min(900_000, 60_000 * 2 ** Math.min(failures, 4)), retryAfter);
}

type Update = { history: CompanyHistory | null; error: string; refreshing: boolean };
type WatchOptions = {
  path: string;
  businessNumber: string;
  initial?: CompanyHistory | null;
  onUpdate: (update: Update) => void;
  load?: (path: string, signal: AbortSignal) => Promise<CompanyHistory>;
  visible?: () => boolean;
};

/** One indexed request per view, with no provider-date or provider-page scans. */
export function watchCompanyHistory(options: WatchOptions) {
  let history = options.initial ?? null, error = '', failures = 0, stopped = false;
  let active: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextAt = 0;
  const visible = options.visible ?? (() => true);
  const publish = (refreshing: boolean) => { if (!stopped) options.onUpdate({ history, error, refreshing }); };
  const schedule = (delay: number) => {
    clearTimeout(timer);
    nextAt = Date.now() + delay;
    timer = setTimeout(() => { if (visible()) void reload(); }, delay);
  };
  async function reload() {
    if (stopped || active) return;
    clearTimeout(timer);
    const controller = new AbortController(); active = controller;
    publish(true);
    let failure: unknown;
    try {
      const result = await (options.load ?? fetchApi<CompanyHistory>)(options.path, controller.signal);
      if (stopped || controller.signal.aborted) return;
      if (result.company && result.company.businessNumber !== options.businessNumber) throw new Error('조회한 업체와 응답 업체가 일치하지 않습니다.');
      if (result.contracts?.items.some(item => item.businessNumber !== options.businessNumber)) throw new Error('조회한 업체와 계약 업체가 일치하지 않습니다.');
      if (!result.coverage || !Array.isArray(result.items) || !Number.isFinite(result.totalCount)
        || !Number.isInteger(result.page) || result.page < 1 || !Number.isInteger(result.pageSize) || result.pageSize <= 0) throw new Error('저장된 이력의 응답 형식을 확인하지 못했습니다.');
      history = result; error = ''; failures = 0;
    } catch (cause) {
      if (stopped || controller.signal.aborted) return;
      failure = cause; failures++;
      error = cause instanceof Error ? cause.message : '저장된 업체 이력을 불러오지 못했습니다.';
    } finally {
      if (!stopped && !controller.signal.aborted) {
        active = null; publish(false);
        schedule(historyRefreshDelay(history, failures, failure));
      }
    }
  }
  void reload();
  return {
    refresh: reload,
    visibilityChanged() { if (visible() && Date.now() >= nextAt) void reload(); },
    stop() { stopped = true; clearTimeout(timer); active?.abort(); active = null; },
  };
}
