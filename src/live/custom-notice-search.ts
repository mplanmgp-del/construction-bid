import type { BidNotice, CompanyProfile } from '../types';
import type { G2bBusinessType, G2bNoticeDetail, G2bNoticePage } from '../g2b-types';
import { alertNoticeKey, isOlderAlertNotice, matchAlertNotice, normalizeAlertSettings } from '../alerts/domain';
import type { AlertNotice, AlertSettings } from '../alerts/types';
import { ApiError, dateRangeError, fetchApi } from './client';
import { matchesDeadlineWindow } from '../notice-deadline-window';

export interface CustomNoticeQuery { settings: AlertSettings; profile: CompanyProfile | null; from: string; to: string; basis?: 'opening' | 'deadline'; publicKeyword?: string }
export interface CustomNoticeSource {
  type: G2bBusinessType; from: string; to: string; keyword: string; basis?: 'opening' | 'deadline';
  agency?: string; demandAgency?: string; license?: string;
  minAmount?: number; maxAmount?: number; excludeClosed?: true;
}
export interface CustomNoticeRepository {
  notices(source: CustomNoticeSource, page: number, signal: AbortSignal): Promise<G2bNoticePage>;
  detail(notice: Pick<BidNotice, 'number' | 'revision' | 'type'>, signal: AbortSignal): Promise<G2bNoticeDetail>;
  lookup?(notice: Pick<BidNotice, 'number' | 'type'>, signal: AbortSignal): Promise<G2bNoticePage>;
}
export interface CustomNoticesSnapshot {
  userId: string | null; items: AlertNotice[]; loading: boolean; error: string; hasMore: boolean;
  candidateCount: number; checkedCount: number; apiRequests: number; fetchedAt: string | null;
  excludedItems?: AlertNotice[];
  indexCoverage?: { complete: boolean; pending: number; checked: number };
}
const empty = (userId: string | null): CustomNoticesSnapshot => ({ userId, items: [], loading: false, error: '', hasMore: false,
  candidateCount: 0, checkedCount: 0, apiRequests: 0, fetchedAt: null, excludedItems: [] });
const usable = (value: string) => value.trim() && !/^(?:기관 미제공|미제공|원문 확인|확인 필요|없음|-)$/u.test(value.trim());
const plainLicense = (value: string) => value.normalize('NFKC').trim();
const comparableLicense = (value: string) => plainLicense(value).toLowerCase().replace(/[ㆍ・ᆞ]/g, '·').replace(/\s+/g, '').replace(/\/\d+$/, '');
export const CUSTOM_NOTICE_MAX_DAYS = 90;
export const CUSTOM_ACTIVE_MAX_DAYS = 366;
export const CUSTOM_DEADLINE_MAX_DAYS = 367;
const PROVIDER_WINDOW_DAYS = 31;
const DAY_MS = 86_400_000;
function publicationWindows(from: string, to: string): Pick<CustomNoticeSource, 'from' | 'to'>[] {
  const first = Date.parse(from), windows: Pick<CustomNoticeSource, 'from' | 'to'>[] = [];
  // The public endpoint accepts at most 31 inclusive days per call. Search the
  // requested period, newest first, without repeating or omitting boundary days.
  for (let end = Date.parse(to); end >= first;) {
    const start = Math.max(first, end - (PROVIDER_WINDOW_DAYS - 1) * DAY_MS);
    windows.push({ from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) });
    end = start - DAY_MS;
  }
  return windows;
}
function openingWindows(from: string, to: string): Pick<CustomNoticeSource, 'from' | 'to'>[] {
  const last = Date.parse(to), windows: Pick<CustomNoticeSource, 'from' | 'to'>[] = [];
  // Opening-date searches reject some 31-day spans across February. Calendar-contained
  // windows satisfy the provider's one-month rule for every month, including leap years.
  for (let start = Date.parse(from); start <= last;) {
    const date = new Date(start), monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
    const end = Math.min(last, monthEnd);
    windows.push({ from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) });
    start = end + DAY_MS;
  }
  return windows;
}
function safeLicenseAxis(values: string[]): string[] {
  const licenses = [...new Set(values.map(plainLicense))];
  // The provider's partial name search does not promise our whitespace/dot/code normalization.
  // Dropping only an unsafe OR branch would omit matches, so fall back for the entire axis.
  return licenses.length && licenses.every(value => value === comparableLicense(value)) ? licenses : [];
}

/** Push only one OR axis. The complete saved rule is always evaluated locally. */
export function planCustomNoticeSearch(input: CustomNoticeQuery): { query: CustomNoticeQuery; sources: CustomNoticeSource[] } {
  const periodError = dateRangeError(input.from, input.to, input.basis === 'deadline' ? CUSTOM_DEADLINE_MAX_DAYS : input.basis === 'opening' ? CUSTOM_ACTIVE_MAX_DAYS : CUSTOM_NOTICE_MAX_DAYS);
  if (periodError) throw new Error(periodError);
  // Disabling notifications does not disable a deliberate, read-only search.
  const settings = normalizeAlertSettings({ ...input.settings, enabled: false });
  const query: CustomNoticeQuery = { settings, profile: input.profile ? structuredClone(input.profile) : null, from: input.from, to: input.to,
    ...(input.basis ? { basis: input.basis } : {}), ...(input.publicKeyword ? { publicKeyword: input.publicKeyword.trim() } : {}) };
  // The shared index is already keyed by the actual submission deadline. Read
  // only this exact interval; evaluate private member conditions in memory.
  if (query.basis === 'deadline') return { query, sources: settings.filter.types.map(type => ({
    type, from: query.from, to: query.to, keyword: query.publicKeyword ?? '', basis: 'deadline' as const,
  })) };
  const filter = settings.filter;
  const common = { keyword: '', ...(!filter.includeUnknown ? {
    excludeClosed: true as const, ...(filter.minAmount !== null ? { minAmount: filter.minAmount } : {}),
    ...(filter.maxAmount !== null ? { maxAmount: filter.maxAmount } : {}),
  } : {}) };
  const axis: Partial<Pick<CustomNoticeSource, 'keyword' | 'agency' | 'demandAgency' | 'license'>>[] = [];
  const agencies = filter.agencies ?? [];
  const companyLicenses = filter.useCompanyLicenses ? query.profile?.licenses.filter(usable) ?? [] : [];
  const explicitAxis = safeLicenseAxis(filter.licenses), companyAxis = safeLicenseAxis(companyLicenses);
  const licenses = explicitAxis.length ? explicitAxis : companyAxis;
  if (!filter.includeUnknown && agencies.length) {
    axis.push(...agencies.map(agency => ({ agency })), ...agencies.map(demandAgency => ({ demandAgency })));
  } else if (!filter.includeUnknown && licenses.length) {
    axis.push(...licenses.map(license => ({ license })));
  } else if (filter.keywords.length) {
    // Title matches appear first; agency-only keyword matches remain in scope.
    axis.push(...filter.keywords.map(keyword => ({ keyword })), ...filter.keywords.map(agency => ({ agency })),
      ...filter.keywords.map(demandAgency => ({ demandAgency })));
  } else axis.push({});
  // Active searches start with openings closest to today. Posting searches keep their newest-first order.
  const windows = query.basis === 'opening' ? openingWindows(query.from, query.to) : publicationWindows(query.from, query.to);
  const sources = windows.flatMap(window =>
    axis.flatMap(part => filter.types.map(type => ({ ...common, ...window, ...part, type, ...(query.basis ? { basis: query.basis } : {}) }))));
  return { query, sources: [...new Map(sources.map(source => [JSON.stringify(source), source])).values()] };
}

export const browserCustomNoticeRepository: CustomNoticeRepository = {
  notices: (source, page, signal) => {
    const params = new URLSearchParams({ type: source.type, from: source.from, to: source.to, keyword: source.keyword,
      page: String(page), pageSize: '100', ...(source.agency ? { agency: source.agency } : {}),
      ...(source.demandAgency ? { demandAgency: source.demandAgency } : {}), ...(source.license ? { license: source.license } : {}),
      ...(source.minAmount !== undefined ? { minAmount: String(source.minAmount) } : {}),
      ...(source.maxAmount !== undefined ? { maxAmount: String(source.maxAmount) } : {}),
      ...(source.basis === 'deadline' ? { mode: 'deadline' } : source.basis ? { basis: source.basis } : {}),
      ...(source.excludeClosed ? { excludeClosed: '1' } : {}) });
    return fetchApi<G2bNoticePage>(`/api/notices?${params}`, signal);
  },
  detail: (notice, signal) => fetchApi<G2bNoticeDetail>(`/api/detail?${new URLSearchParams({ number: notice.number, revision: notice.revision, type: notice.type })}`, signal),
  lookup: (notice, signal) => fetchApi<G2bNoticePage>(`/api/notices?${new URLSearchParams({ mode: 'number', type: notice.type, number: notice.number })}`, signal),
};

interface Cursor { source: CustomNoticeSource; key: string; page: number }
interface Candidate { key: string; notice: AlertNotice; verified?: boolean }
const SOURCE_BATCH_LIMIT = 12;
const DETAIL_BATCH_LIMIT = 20;
const CONCURRENCY = 4;
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : '나라장터 연결 상태를 확인해 주세요.';
const asAlertNotice = (row: BidNotice): AlertNotice => ({ ...row, source: 'live', sourceUpdatedAt: (row as Partial<AlertNotice>).sourceUpdatedAt || row.postedAt,
  regionComplete: (row as Partial<AlertNotice>).regionComplete === true, licenseComplete: (row as Partial<AlertNotice>).licenseComplete === true });
// Do not treat enriching a candidate with region/license details as a new list version.
const sourceVersion = (row: AlertNotice) => JSON.stringify([row.revision, row.sourceUpdatedAt, row.status, row.title, row.agency, row.demandAgency,
  row.deadline, row.openingAt, row.biddingStartAt, row.estimatedPrice, row.plannedAmount, row.contractMethod, row.category, row.province, row.district, row.noticeKind, row.openingCompleted]);
function completeLatest(page: G2bNoticePage, original: AlertNotice): AlertNotice {
  if (page.quotaExceeded) throw new ApiError('나라장터 호출 한도에 도달했습니다. 잠시 후 다시 조회해 주세요.', 'G2B_QUOTA_EXCEEDED', 429, page.retryAfterSeconds);
  if (!Array.isArray(page.items) || !page.items.length || page.hasMore !== false || !Number.isInteger(page.totalCount)
    || page.totalCount !== page.items.length || !Number.isFinite(Date.parse(page.fetchedAt))) throw new Error('공고의 최신 차수 전체 이력을 확인하지 못했습니다.');
  const revisions = new Set<string>();
  for (const row of page.items) {
    if (row.number !== original.number || row.type !== original.type || !/^\d{3}$/.test(row.revision) || revisions.has(row.revision)) {
      throw new Error('최신 공고의 번호·업무·차수 정보를 확인하지 못했습니다.');
    }
    revisions.add(row.revision);
  }
  const latest = asAlertNotice([...page.items].sort((first, second) => Number(second.revision) - Number(first.revision))[0]);
  if (isOlderAlertNotice(latest, original)) throw new Error('목록보다 오래된 차수 이력입니다. 최신 공고를 다시 확인해 주세요.');
  return latest;
}

function requiredDetails(notice: AlertNotice, query: CustomNoticeQuery) {
  const filter = query.settings.filter, basis = filter.regionBasis ?? 'auto';
  const participation = filter.useCompanyRegion || !!filter.regions.length
    && (basis === 'participation' || basis === 'either' || basis === 'both' || basis === 'auto' && notice.type === '용역');
  return { region: participation && !notice.regionComplete,
    license: (filter.licenses.length > 0 || filter.useCompanyLicenses === true) && !notice.licenseComplete };
}
function take<T>(queue: T[], limit: number, eligible: (item: T) => boolean): T[] {
  const selected: T[] = [], count = queue.length;
  for (let index = 0; index < count && selected.length < limit; index++) {
    const item = queue.shift()!;
    if (eligible(item)) selected.push(item); else queue.push(item);
  }
  return selected;
}

/** Per-account, in-memory search. No profile, query rule, or filtered result enters a shared cache. */
export class CustomNoticesController {
  private snapshot = empty(null);
  private listeners = new Set<() => void>();
  private generation = 0;
  private request: AbortController | null = null;
  private running: Promise<void> | null = null;
  private query: CustomNoticeQuery | null = null;
  private sources: Cursor[] = [];
  private pending: Candidate[] = [];
  private candidates = new Map<string, AlertNotice>();
  private checked = new Set<string>();
  private matches = new Map<string, AlertNotice>();
  private excluded = new Map<string, AlertNotice>();
  private failures = new Map<string, string>();
  constructor(private repository: CustomNoticeRepository = browserCustomNoticeRepository, private clock: () => number = Date.now) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(changes: Partial<CustomNoticesSnapshot> = {}) {
    this.pending = this.pending.filter(item => this.candidates.get(item.key) === item.notice);
    this.snapshot = { ...this.snapshot, items: [...this.matches.values()], excludedItems: [...this.excluded.values()], candidateCount: this.candidates.size, checkedCount: this.checked.size,
      hasMore: this.sources.length > 0 || this.pending.length > 0,
      error: this.failures.size ? `일부 공고 또는 상세 조건을 조회하지 못했습니다. ${[...new Set(this.failures.values())].join(' ')} 확인된 결과를 먼저 표시합니다. 더 조회하면 실패한 범위를 다시 확인합니다.` : '', ...changes };
    this.listeners.forEach(listener => listener());
  }
  clear = () => {
    this.generation++; this.request?.abort(); this.request = null; this.running = null; this.query = null;
    this.sources = []; this.pending = []; this.candidates.clear(); this.checked.clear(); this.matches.clear(); this.excluded.clear(); this.failures.clear();
    this.snapshot = empty(this.snapshot.userId); this.listeners.forEach(listener => listener());
  };
  setUser(userId?: string) { this.clear(); this.snapshot = empty(userId || null); this.listeners.forEach(listener => listener()); }
  search = async (input: CustomNoticeQuery): Promise<void> => {
    if (!this.snapshot.userId) return;
    this.clear();
    try {
      const plan = planCustomNoticeSearch(input); this.query = plan.query;
      this.sources = plan.sources.map(source => ({ source, key: JSON.stringify(source), page: 1 }));
    } catch (cause) { this.publish({ error: messageOf(cause) }); return; }
    await this.loadMore();
  };
  loadMore = (): Promise<void> => {
    if (this.running) return this.running;
    if (!this.snapshot.userId || !this.query || !this.sources.length && !this.pending.length) return Promise.resolve();
    const promise = this.runBatch(); this.running = promise;
    void promise.finally(() => { if (this.running === promise) this.running = null; });
    return promise;
  };
  applyDetail = (id: string, detail: G2bNoticeDetail) => {
    const original = [...this.matches.values()].find(notice => notice.id === id);
    if (!original || detail.number !== original.number || detail.revision !== original.revision
      || detail.notice && (detail.notice.number !== original.number || detail.notice.revision !== original.revision || detail.notice.type !== original.type)) return;
    const notice: AlertNotice = { ...original, ...detail.notice, source: 'live', sourceUpdatedAt: original.sourceUpdatedAt,
      allowedRegions: detail.regionComplete ? detail.allowedRegions : original.allowedRegions,
      licenses: detail.licenseComplete ? detail.licenses : original.licenses,
      regionComplete: original.regionComplete || detail.regionComplete,
      licenseComplete: original.licenseComplete || detail.licenseComplete };
    const key = alertNoticeKey(notice);
    this.candidates.set(key, notice); this.finish({ key, notice, verified: true }); this.publish();
  };
  private finish(candidate: Candidate) {
    if (!this.query || this.candidates.get(candidate.key) !== candidate.notice) return;
    if (this.query.basis && !candidate.verified) return;
    this.checked.add(candidate.key);
    if (this.query.basis === 'deadline' && !matchesDeadlineWindow(candidate.notice, this.query, this.clock())) {
      this.matches.delete(candidate.key); return;
    }
    if (this.query.basis === 'opening') {
      const deadline = Date.parse(candidate.notice.deadline);
      if (candidate.notice.status === '취소' || candidate.notice.status === '마감' || Number.isFinite(deadline) && deadline <= this.clock()) {
        this.excluded.set(candidate.key, candidate.notice); this.matches.delete(candidate.key); return;
      }
      this.excluded.delete(candidate.key);
    }
    const matched = matchAlertNotice(candidate.notice, { ...this.query.settings, enabled: true }, this.query.profile, this.clock());
    if (matched.matched) this.matches.set(candidate.key, candidate.notice); else this.matches.delete(candidate.key);
  }
  private acceptPage(page: G2bNoticePage) {
    if (!this.query) return;
    const relaxed = { ...this.query.settings, enabled: true, filter: { ...this.query.settings.filter, includeUnknown: true } };
    for (const row of page.items) {
      const notice = asAlertNotice(row);
      const key = alertNoticeKey(notice), previous = this.candidates.get(key);
      if (previous && (isOlderAlertNotice(notice, previous) || (this.query.basis
        ? sourceVersion(notice) === sourceVersion(previous) : notice.revision === previous.revision))) continue;
      this.candidates.set(key, notice); this.checked.delete(key); this.matches.delete(key); this.excluded.delete(key);
      this.failures.delete(`detail:${key}`); this.failures.delete(`latest:${key}`);
      const candidate = { key, notice };
      // Opening lists may contain an old original whose newer cancellation has a different opening date.
      // Never publish it, or reject it on obsolete facts, until every revision is checked by number.
      if (this.query.basis) { this.pending.push(candidate); continue; }
      // Missing facts cannot fail this prefilter; known mismatches avoid expensive detail calls.
      if (!matchAlertNotice(notice, relaxed, this.query.profile, this.clock()).matched) this.checked.add(key);
      else {
        const needed = requiredDetails(notice, this.query);
        if (needed.region || needed.license) this.pending.push(candidate); else this.finish(candidate);
      }
    }
    const fetchedAt = !this.snapshot.fetchedAt || Date.parse(page.fetchedAt) < Date.parse(this.snapshot.fetchedAt) ? page.fetchedAt : this.snapshot.fetchedAt;
    const coverage = (page as G2bNoticePage & Pick<CustomNoticesSnapshot, 'indexCoverage'>).indexCoverage;
    this.publish({ fetchedAt, ...(coverage ? { indexCoverage: coverage } : {}) });
  }
  private async runBatch(): Promise<void> {
    const controller = new AbortController(); this.request = controller;
    const token = this.generation, owner = this.snapshot.userId;
    const active = () => token === this.generation && owner === this.snapshot.userId && !controller.signal.aborted;
    const failedSources = new Set<string>(), failedDetails = new Set<string>();
    let sourceCount = 0, detailCount = 0, sourceInFlight = 0, detailInFlight = 0;
    const inFlight = new Set<Promise<void>>();
    this.publish({ loading: true });
    const countRequest = () => this.publish({ apiRequests: this.snapshot.apiRequests + 1 });
    const loadSource = async (cursor: Cursor) => {
      countRequest();
      try {
        const page = await this.repository.notices(cursor.source, cursor.page, controller.signal);
        if (!active()) return;
        if (page.quotaExceeded) throw new ApiError('나라장터 호출 한도에 도달했습니다. 잠시 후 다시 조회해 주세요.', 'G2B_QUOTA_EXCEEDED', 429, page.retryAfterSeconds);
        if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean' || !Number.isFinite(Date.parse(page.fetchedAt))
          || page.hasMore && page.items.length === 0) throw new Error('공고 목록의 전체 범위를 확인하지 못했습니다.');
        this.failures.delete(`source:${cursor.key}`);
        if (page.hasMore) this.sources.push({ ...cursor, page: cursor.page + 1 });
        this.acceptPage(page);
      } catch (cause) {
        if (!active()) return;
        failedSources.add(cursor.key); this.sources.push(cursor); this.failures.set(`source:${cursor.key}`, messageOf(cause)); this.publish();
      }
    };
    const loadDetail = async (candidate: Candidate) => {
      let current = candidate;
      let latestPending = !!this.query?.basis && !candidate.verified;
      try {
        if (latestPending) {
          if (!this.repository.lookup) throw new Error('최신 공고 차수 조회를 사용할 수 없습니다.');
          countRequest();
          const versions = await this.repository.lookup(candidate.notice, controller.signal);
          if (!active() || this.candidates.get(candidate.key) !== candidate.notice || !this.query) return;
          const notice = completeLatest(versions, candidate.notice);
          this.candidates.set(candidate.key, notice); current = { key: candidate.key, notice, verified: true };
          if (this.query.basis === 'deadline') {
            this.failures.delete(`latest:${candidate.key}`); latestPending = false;
            if (!matchesDeadlineWindow(notice, this.query, this.clock())) { this.finish(current); this.publish(); return; }
          }
          // Closed/cancelled latest revisions are useful evidence even if the provider changed their opening date.
          const deadline = Date.parse(notice.deadline);
          if (this.query.basis !== 'deadline' && (notice.status === '취소' || notice.status === '마감' || Number.isFinite(deadline) && deadline <= this.clock())) {
            latestPending = false; this.failures.delete(`latest:${candidate.key}`); this.finish(current); this.publish(); return;
          }
          const opening = Date.parse(notice.openingAt);
          if (this.query.basis !== 'deadline' && !Number.isFinite(opening)) throw new Error('최신 공고의 개찰일을 확인하지 못했습니다.');
          this.failures.delete(`latest:${candidate.key}`); latestPending = false;
          const openingDay = Number.isFinite(opening) ? new Date(opening + 9 * 60 * 60_000).toISOString().slice(0, 10) : '';
          if (this.query.basis !== 'deadline' && (openingDay < this.query.from || openingDay > this.query.to)) {
            this.checked.add(candidate.key); this.matches.delete(candidate.key); this.excluded.delete(candidate.key); this.publish(); return;
          }
          const relaxed = { ...this.query.settings, enabled: true, filter: { ...this.query.settings.filter, includeUnknown: true } };
          if (!matchAlertNotice(notice, relaxed, this.query.profile, this.clock()).matched) {
            this.finish(current); this.publish(); return;
          }
        }
        if (!this.query) return;
        const needed = requiredDetails(current.notice, this.query);
        if (!needed.region && !needed.license) { this.finish(current); this.publish(); return; }
        countRequest();
        const detail = await this.repository.detail(current.notice, controller.signal);
        if (!active() || this.candidates.get(current.key) !== current.notice || !this.query) return;
        if (detail.number !== current.notice.number || detail.revision !== current.notice.revision
          || detail.notice && (detail.notice.type !== current.notice.type || detail.notice.number !== current.notice.number || detail.notice.revision !== current.notice.revision)) {
          throw new Error('상세 공고의 식별정보를 확인하지 못했습니다.');
        }
        const regionComplete = detail.regionComplete === true && (detail.allowedRegions === null || Array.isArray(detail.allowedRegions));
        const licenseComplete = detail.licenseComplete === true && Array.isArray(detail.licenses);
        const notice: AlertNotice = { ...current.notice, ...detail.notice, source: 'live', sourceUpdatedAt: current.notice.sourceUpdatedAt,
          allowedRegions: regionComplete ? detail.allowedRegions : current.notice.allowedRegions,
          licenses: licenseComplete ? detail.licenses : current.notice.licenses,
          regionComplete: current.notice.regionComplete || regionComplete, licenseComplete: current.notice.licenseComplete || licenseComplete };
        this.candidates.set(candidate.key, notice); current = { ...current, notice };
        if (needed.region && !notice.regionComplete || needed.license && !notice.licenseComplete) throw new Error('상세 참가 지역 또는 면허조건을 모두 확인하지 못했습니다.');
        this.failures.delete(`detail:${candidate.key}`); this.finish(current); this.publish();
      } catch (cause) {
        if (!active() || this.candidates.get(current.key) !== current.notice) return;
        failedDetails.add(current.key);
        // A version or opening-date failure is never downgraded to an unknown, potentially active original.
        if (latestPending) current = { ...current, verified: false };
        this.pending.push(current); this.failures.set(`${latestPending ? 'latest' : 'detail'}:${current.key}`, messageOf(cause));
        // A failed detail remains unknown. The user's includeUnknown preference decides its visibility.
        if (!latestPending) this.finish(current);
        this.publish();
      }
    };
    try {
      while (active()) {
        this.pending = this.pending.filter(item => this.candidates.get(item.key) === item.notice);
        const sourceJobs = take(this.sources, Math.min(CONCURRENCY - sourceInFlight, SOURCE_BATCH_LIMIT - sourceCount), item => !failedSources.has(item.key));
        for (const cursor of sourceJobs) {
          sourceCount++; sourceInFlight++;
          const task = loadSource(cursor).finally(() => { sourceInFlight--; inFlight.delete(task); });
          inFlight.add(task);
        }
        if (this.query?.basis && this.pending.length > 1) {
          const query = this.query, relaxed = { ...query.settings, enabled: true, filter: { ...query.settings.filter, includeUnknown: true } };
          const now = this.clock();
          // Faster sources must not spend the entire bounded check budget on old closed
          // or unrelated rows. This only changes priority: every candidate remains queued
          // for mandatory latest-version validation, including facts which may have changed.
          this.pending = this.pending.map((candidate, index) => {
            const opening = Date.parse(candidate.notice.openingAt);
            const legacyClosed = query.basis === 'opening' && Date.parse(candidate.notice.deadline) <= now;
            return { candidate, index, rank: !legacyClosed && matchAlertNotice(candidate.notice, relaxed, query.profile, now).matched ? 0 : 1,
              opening: Number.isFinite(opening) ? opening : Infinity };
          }).sort((first, second) => first.rank - second.rank
            || (first.opening === second.opening ? 0 : first.opening - second.opening) || first.index - second.index)
            .map(item => item.candidate);
        }
        const detailJobs = take(this.pending, Math.min(CONCURRENCY - detailInFlight, DETAIL_BATCH_LIMIT - detailCount), item => !failedDetails.has(item.key));
        for (const candidate of detailJobs) {
          detailCount++; detailInFlight++;
          const task = loadDetail(candidate).finally(() => { detailInFlight--; inFlight.delete(task); });
          inFlight.add(task);
        }
        if (!inFlight.size) break;
        // A slow agency source must not delay completed title pages or their detail checks.
        await Promise.race(inFlight);
      }
    } finally {
      if (active()) { this.request = null; this.publish({ loading: false }); }
    }
  }
  dispose() { this.setUser(); this.listeners.clear(); }
}

/** Render-time guard hides prior-account results before effect cleanup runs. */
export function visibleCustomNotices(snapshot: CustomNoticesSnapshot, userId?: string): CustomNoticesSnapshot {
  return snapshot.userId === (userId || null) ? snapshot : empty(userId || null);
}
