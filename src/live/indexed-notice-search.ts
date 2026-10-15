import type { BidNotice, CompanyProfile, SearchFilters } from '../types';
import type { G2bNoticeDetail } from '../g2b-types';
import type { VerifiedNoticeSearchQuery, VerifiedNoticeSearchResults, VerifiedNoticeSearchStatus, VerifiedNoticeSearchStatusQuery, VerifiedNoticeSearchView } from './active-catalog-types';
import { canonicalProvince, selectedRegions, selectedStatuses } from '../search-filters';
import { DEFAULT_FILTERS } from '../data';
import { ApiError, dateRangeError, fetchApi } from './client';
import type { NoticeQuery } from './notice-search';

export type IndexedSearchInput = NoticeQuery & { filters?: SearchFilters; profile?: Pick<CompanyProfile, 'province' | 'district'> };
export interface IndexedNoticeRepository {
  search(query: VerifiedNoticeSearchQuery, signal: AbortSignal): Promise<VerifiedNoticeSearchResults>;
  status?(query: VerifiedNoticeSearchStatusQuery, signal: AbortSignal): Promise<VerifiedNoticeSearchStatus>;
}
export interface IndexedNoticesSnapshot {
  userId: string | null; items: BidNotice[]; loading: boolean; error: string; stale: boolean;
  totalCount: number; pageNumber: number; hasMore: boolean; hasPrevious: boolean; apiRequests: number;
  selectionKey: number; meta: VerifiedNoticeSearchView | null;
}
const empty = (userId: string | null, selectionKey = 0): IndexedNoticesSnapshot => ({ userId, items: [], loading: false, error: '', stale: false, totalCount: 0, pageNumber: 1, hasMore: false, hasPrevious: false, apiRequests: 0, selectionKey, meta: null });
const SEARCH_CHANGED = '공고 또는 일정의 조회 기준이 변경되었습니다. 현재 목록은 이전 조회 결과입니다. 다시 검색해 주세요.';

export function indexedSearchDateError(from: string, to: string): string | null {
  const error = dateRangeError(from, to, 100_000); if (error) return error;
  return from < '1995-10-01' || to > '2100-12-31' ? '조회 날짜는 1995년 10월부터 2100년 사이로 선택해 주세요.' : null;
}
/** Explicitly project preferences and the two company geography fields only. */
export function normalizeIndexedSearch(input: IndexedSearchInput): VerifiedNoticeSearchQuery {
  const error = indexedSearchDateError(input.from, input.to); if (error) throw new Error(error);
  if (!['공사', '용역', '공사·용역'].includes(input.type) || input.keyword.length > 100 || /[\u0000-\u001f]/.test(input.keyword)) throw new Error('업무와 검색어를 확인해 주세요.');
  const value = input.filters ?? { ...DEFAULT_FILTERS, category: '전체', status: '전체' };
  const filters: SearchFilters = { keyword: value.keyword.trim(), excludeKeyword: value.excludeKeyword.trim(), category: value.category,
    type: value.type, siteProvince: value.siteProvince, regions: selectedRegions(value), license: value.license, minAmount: value.minAmount,
    maxAmount: value.maxAmount, status: value.status, statuses: selectedStatuses(value), includeUnknownRegions: value.includeUnknownRegions === true,
    contractMethod: value.contractMethod, deadlineFrom: '', deadlineTo: '', regionView: value.regionView, autoRegion: value.autoRegion, sort: value.sort };
  return { from: input.from, to: input.to, type: input.type, keyword: input.keyword.trim(), filters,
    ...(input.profile && (filters.autoRegion || filters.regionView !== 'all') ? { profile: { province: canonicalProvince(input.profile.province) ?? input.profile.province.trim(), district: input.profile.district.trim() } } : {}), limit: 50 };
}
export function indexedSearchKey(input: IndexedSearchInput): string { return JSON.stringify(normalizeIndexedSearch(input)); }
function searchParams(query: VerifiedNoticeSearchQuery, mode: string) {
  return new URLSearchParams({ mode, type: query.type, from: query.from, to: query.to, keyword: query.keyword,
      filters: JSON.stringify(query.filters), limit: '50', ...(query.profile ? { companyRegion: JSON.stringify({ province: query.profile.province, district: query.profile.district }) } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) });
}
export const browserIndexedNoticeRepository: IndexedNoticeRepository = {
  search: (query, signal) => fetchApi<VerifiedNoticeSearchResults>(`/api/notices?${searchParams(query, 'search-results')}`, signal),
  status: (query, signal) => {
    const params = searchParams(query, 'search-status'); params.delete('cursor');
    params.set('asOf', query.asOf); params.set('snapshotVersion', query.snapshotVersion);
    return fetchApi<VerifiedNoticeSearchStatus>(`/api/notices?${params}`, signal);
  },
};

function validStatus(value: unknown): value is VerifiedNoticeSearchStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as VerifiedNoticeSearchStatus;
  const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  return typeof status.snapshotVersion === 'string' && Boolean(status.snapshotVersion) && Number.isFinite(Date.parse(status.asOf))
    && Boolean(status.indexCoverage) && typeof status.indexCoverage.complete === 'boolean' && count(status.indexCoverage.checked) && count(status.indexCoverage.pending)
    && count(status.verifiedCount) && count(status.pendingCount) && count(status.conditionPendingCount)
    && Boolean(status.storage) && count(status.storage.bytes) && count(status.storage.ceiling) && typeof status.storage.full === 'boolean'
    && (!status.currentCoverage || typeof status.currentCoverage.complete === 'boolean' && count(status.currentCoverage.checked)
      && count(status.currentCoverage.pending) && count(status.currentCoverage.verificationPending));
}

/** One verified server page per request; no per-row upstream requests. */
export class IndexedNoticesController {
  private snapshot = empty(null);
  private listeners = new Set<() => void>();
  private generation = 0;
  private request: AbortController | null = null;
  private statusRequest: AbortController | null = null;
  private status: VerifiedNoticeSearchStatus | null = null;
  private statusLoading = false;
  private statusError = '';
  private query: VerifiedNoticeSearchQuery | null = null;
  private pages = new Map<number, VerifiedNoticeSearchResults>();
  private cursors = new Map<number, string | undefined>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryPage: VerifiedNoticeSearchResults | null = null;
  constructor(private repository: IndexedNoticeRepository = browserIndexedNoticeRepository) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(changes: Partial<IndexedNoticesSnapshot>) { this.snapshot = { ...this.snapshot, ...changes }; this.listeners.forEach(listener => listener()); }
  private clearExpiryTimer() { if (this.expiryTimer !== null) clearTimeout(this.expiryTimer); this.expiryTimer = null; this.expiryPage = null; }
  private markStale() {
    this.clearExpiryTimer(); this.generation++; this.request?.abort(); this.statusRequest?.abort(); this.request = null; this.statusRequest = null;
    this.status = null; this.statusLoading = false; this.statusError = '';
    this.publish({ stale: true, loading: false, error: SEARCH_CHANGED,
      ...(this.snapshot.meta ? { meta: { ...this.snapshot.meta, status: null, statusLoading: false, statusError: '' } } : {}) });
  }
  private rejectExpired(page: VerifiedNoticeSearchResults | null) {
    if (page?.validUntil !== undefined && Date.parse(page.validUntil) <= Date.now()) { this.markStale(); return true; }
    return false;
  }
  private scheduleExpiry(page: VerifiedNoticeSearchResults) {
    this.clearExpiryTimer();
    // Optional for old responses. The current search endpoint always supplies the boundary.
    if (page.validUntil === undefined) return;
    this.expiryPage = page;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      if (this.expiryPage === page && !this.rejectExpired(page)) this.scheduleExpiry(page);
    }, Math.min(2_147_483_647, Math.max(0, Date.parse(page.validUntil) - Date.now())));
  }
  clear = () => { this.clearExpiryTimer(); this.generation++; this.request?.abort(); this.statusRequest?.abort(); this.request = null; this.statusRequest = null;
    this.status = null; this.statusLoading = false; this.statusError = ''; this.query = null; this.pages.clear(); this.cursors.clear();
    this.snapshot = empty(this.snapshot.userId, this.snapshot.selectionKey + 1); this.listeners.forEach(listener => listener()); };
  setUser(userId?: string) { this.clear(); this.publish({ userId: userId || null }); }
  search = async (input: IndexedSearchInput) => {
    if (!this.snapshot.userId) return; this.clear();
    try { this.query = normalizeIndexedSearch(input); } catch (cause) { this.publish({ error: cause instanceof Error ? cause.message : '검색 조건을 확인해 주세요.' }); return; }
    this.cursors.set(1, undefined); await this.loadPage(1);
  };
  next = async () => { if (this.snapshot.loading || this.snapshot.stale || this.rejectExpired(this.snapshot.meta) || !this.snapshot.meta?.nextCursor) return; this.cursors.set(this.snapshot.pageNumber + 1, this.snapshot.meta.nextCursor); await this.loadPage(this.snapshot.pageNumber + 1); };
  previous = async () => { if (this.snapshot.loading || this.snapshot.stale || this.rejectExpired(this.snapshot.meta) || this.snapshot.pageNumber <= 1) return; await this.loadPage(this.snapshot.pageNumber - 1); };
  loadMore = this.next;
  private show(page: VerifiedNoticeSearchResults, pageNumber: number) {
    if (this.rejectExpired(page)) return;
    this.publish({ items: page.items, totalCount: page.totalCount, pageNumber,
      hasMore: Boolean(page.nextCursor), hasPrevious: pageNumber > 1,
      meta: { ...page, status: this.status, statusLoading: this.statusLoading, statusError: this.statusError }, error: '', stale: false, selectionKey: this.snapshot.selectionKey + 1 });
    this.scheduleExpiry(page);
  }
  private publishStatus() {
    if (this.snapshot.meta) this.publish({ meta: { ...this.snapshot.meta, status: this.status, statusLoading: this.statusLoading, statusError: this.statusError } });
  }
  private async loadStatus(firstPage: VerifiedNoticeSearchResults, generation: number) {
    if (!this.repository.status || !this.query) return;
    const controller = new AbortController(); this.statusRequest?.abort(); this.statusRequest = controller;
    const active = () => generation === this.generation && !controller.signal.aborted;
    this.statusLoading = true; this.statusError = ''; this.publish({ apiRequests: this.snapshot.apiRequests + 1 }); this.publishStatus();
    try {
      const status = await this.repository.status({ ...this.query, asOf: firstPage.asOf, snapshotVersion: firstPage.snapshotVersion }, controller.signal);
      if (!active() || this.rejectExpired(firstPage)) return;
      if (!validStatus(status)) throw new Error('자료 확인 상태를 불러오지 못했습니다. 검색 결과는 계속 볼 수 있습니다.');
      if (status.snapshotVersion !== firstPage.snapshotVersion) throw new ApiError(SEARCH_CHANGED, 'SEARCH_CHANGED', 409);
      if (Date.parse(status.asOf) !== Date.parse(firstPage.asOf)) throw new Error('자료 확인 상태의 조회 기준이 달라 상태를 표시하지 않습니다.');
      this.status = status;
    } catch (cause) {
      if (!active()) return;
      if (cause instanceof ApiError && (cause.code === 'SEARCH_CHANGED' || cause.status === 409)) { this.markStale(); return; }
      this.statusError = cause instanceof Error ? cause.message : '자료 확인 상태를 불러오지 못했습니다.';
    } finally {
      if (active()) { this.statusRequest = null; this.statusLoading = false; this.publishStatus(); }
    }
  }
  private async loadPage(pageNumber: number) {
    if (!this.query) return;
    const cached = this.pages.get(pageNumber); if (cached) { this.show(cached, pageNumber); return; }
    const controller = new AbortController(); this.request?.abort(); this.request = controller;
    const generation = this.generation; const active = () => generation === this.generation && !controller.signal.aborted;
    let firstPage: VerifiedNoticeSearchResults | null = null;
    this.publish({ loading: true, error: '', apiRequests: this.snapshot.apiRequests + 1 });
    try {
      const page = await this.repository.search({ ...this.query, ...(this.cursors.get(pageNumber) ? { cursor: this.cursors.get(pageNumber) } : {}) }, controller.signal);
      if (!active()) return;
      if (!Array.isArray(page.items) || page.items.length > 50 || new Set(page.items.map(item => item.id)).size !== page.items.length
        || !Number.isSafeInteger(page.totalCount) || page.totalCount < page.items.length || typeof page.snapshotVersion !== 'string' || !page.snapshotVersion
        || !Number.isFinite(Date.parse(page.asOf)) || page.validUntil !== undefined && !Number.isFinite(Date.parse(page.validUntil))
        || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0)) throw new Error('검색 페이지 정보를 확인하지 못했습니다. 다시 검색해 주세요.');
      if (this.snapshot.meta && (this.snapshot.meta.snapshotVersion !== page.snapshotVersion || Date.parse(this.snapshot.meta.asOf) !== Date.parse(page.asOf))) throw new ApiError(SEARCH_CHANGED, 'SEARCH_CHANGED', 409);
      if (this.rejectExpired(page)) return;
      if (pageNumber === 1 && !this.repository.status && validStatus(page)) this.status = page;
      this.pages.set(pageNumber, page);
      // Pin page one: it has no cursor with which to re-fetch the original asOf.
      while (this.pages.size > 10) this.pages.delete([...this.pages.keys()].find(number => number !== 1)!);
      this.show(page, pageNumber);
      if (pageNumber === 1) firstPage = page;
    } catch (cause) {
      if (!active()) return;
      const stale = cause instanceof ApiError && (cause.code === 'SEARCH_CHANGED' || cause.status === 409);
      if (stale) this.markStale();
      else this.publish({ error: cause instanceof Error ? cause.message : '검색 결과를 불러오지 못했습니다.' });
    } finally { if (active()) { this.request = null; this.publish({ loading: false }); } }
    // The fast page is already visible and its loading state is finished.
    // Fetch aggregates once per query, without delaying results or pagination.
    if (firstPage && active()) void this.loadStatus(firstPage, generation);
  }
  // A detail view may enrich its saved bookmark independently. Keep the server's
  // page membership and ordering fixed until the next explicit search.
  applyDetail = (_id: string, _detail: G2bNoticeDetail) => {};
  dispose() { this.setUser(); this.listeners.clear(); }
}
