import type { BidNotice } from '../types';
import type { G2bBusinessType, G2bNoticeDetail, G2bNoticePage } from '../g2b-types';
import { matchesDeadlineWindow } from '../notice-deadline-window';
import { ApiError, dateRangeError, fetchApi } from './client';
import type { NoticeQuery } from './notice-search';

export interface IndexedNoticeSource { type: G2bBusinessType; from: string; to: string; keyword: string }
export interface IndexedNoticeRepository {
  notices(source: IndexedNoticeSource, page: number, signal: AbortSignal): Promise<G2bNoticePage>;
  lookup(notice: Pick<BidNotice, 'number' | 'type'>, signal: AbortSignal): Promise<G2bNoticePage>;
}
export interface IndexedNoticesSnapshot {
  userId: string | null; items: BidNotice[]; loading: boolean; error: string; hasMore: boolean;
  candidateCount: number; checkedCount: number; apiRequests: number; fetchedAt: string | null;
  indexCoverage?: { complete: boolean; pending: number; checked: number };
}
const empty = (userId: string | null): IndexedNoticesSnapshot => ({ userId, items: [], loading: false, error: '', hasMore: false, candidateCount: 0, checkedCount: 0, apiRequests: 0, fetchedAt: null });
const keyOf = (notice: Pick<BidNotice, 'number' | 'type'>) => `${notice.type}:${notice.number}`;
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : '나라장터 연결 상태를 확인해 주세요.';
const older = (incoming: BidNotice, previous: BidNotice) => Number(incoming.revision) !== Number(previous.revision)
  ? Number(incoming.revision) < Number(previous.revision)
  : Date.parse(incoming.sourceUpdatedAt || incoming.postedAt) < Date.parse(previous.sourceUpdatedAt || previous.postedAt);
const sourceVersion = (notice: BidNotice) => JSON.stringify([notice.revision, notice.sourceUpdatedAt, notice.postedAt, notice.title,
  notice.status, notice.deadline, notice.openingAt, notice.openingCompleted, notice.biddingStartAt, notice.noticeKind,
  notice.agency, notice.demandAgency, notice.estimatedPrice, notice.plannedAmount, notice.contractMethod, notice.category, notice.province, notice.district]);

export function planIndexedNoticeSearch(input: NoticeQuery): { query: NoticeQuery; sources: IndexedNoticeSource[] } {
  const error = dateRangeError(input.from, input.to, 367); if (error) throw new Error(error);
  if (!['공사', '용역', '공사·용역'].includes(input.type) || input.keyword.length > 100 || /[\u0000-\u001f]/.test(input.keyword)) throw new Error('업무와 검색어를 확인해 주세요.');
  const query = { ...input, keyword: input.keyword.trim() };
  const types: G2bBusinessType[] = query.type === '공사·용역' ? ['공사', '용역'] : [query.type];
  return { query, sources: types.map(type => ({ type, from: query.from, to: query.to, keyword: query.keyword })) };
}
export const browserIndexedNoticeRepository: IndexedNoticeRepository = {
  notices: (source, page, signal) => fetchApi<G2bNoticePage>(`/api/notices?${new URLSearchParams({ ...source, mode: 'deadline', page: String(page), pageSize: '100' })}`, signal),
  lookup: (notice, signal) => fetchApi<G2bNoticePage>(`/api/notices?${new URLSearchParams({ mode: 'number', type: notice.type, number: notice.number })}`, signal),
};
function completeLatest(page: G2bNoticePage, original: BidNotice): BidNotice {
  if (page.quotaExceeded) throw new ApiError('나라장터 호출 한도에 도달했습니다. 잠시 후 다시 조회해 주세요.', 'G2B_QUOTA_EXCEEDED', 429, page.retryAfterSeconds);
  if (!Array.isArray(page.items) || !page.items.length || page.hasMore !== false || page.totalCount !== page.items.length
    || !Number.isFinite(Date.parse(page.fetchedAt)) || new Set(page.items.map(notice => notice.revision)).size !== page.items.length
    || page.items.some(notice => notice.type !== original.type || notice.number !== original.number || !/^\d{3}$/.test(notice.revision))) throw new Error('공고의 최신 차수 전체 이력을 확인하지 못했습니다.');
  const latest = [...page.items].sort((a, b) => Number(b.revision) - Number(a.revision))[0];
  if (older(latest, original)) throw new Error('목록보다 오래된 공고 이력입니다. 최신 공고를 다시 확인해 주세요.');
  const before = original as BidNotice & { regionComplete?: boolean; licenseComplete?: boolean };
  const after = latest as typeof before;
  const sourceClock = Date.parse(before.sourceUpdatedAt || '');
  const sameVersion = latest.revision === original.revision && Number.isFinite(sourceClock)
    && sourceClock === Date.parse(after.sourceUpdatedAt || '');
  return sameVersion ? { ...latest,
    ...(before.regionComplete && !after.regionComplete ? { allowedRegions: before.allowedRegions, regionComplete: true } : {}),
    ...(before.licenseComplete && !after.licenseComplete ? { licenses: before.licenses, licenseComplete: true } : {}),
  } : latest;
}
interface Cursor { source: IndexedNoticeSource; key: string; page: number }
interface Candidate { key: string; notice: BidNotice }
function take<T>(queue: T[], limit: number, eligible: (item: T) => boolean): T[] {
  const selected: T[] = [], count = queue.length;
  for (let index = 0; index < count && selected.length < limit; index++) { const item = queue.shift()!; if (eligible(item)) selected.push(item); else queue.push(item); }
  return selected;
}

/** Shared public index pages with bounded, exact current-revision verification. */
export class IndexedNoticesController {
  private snapshot = empty(null);
  private listeners = new Set<() => void>();
  private generation = 0;
  private request: AbortController | null = null;
  private running: Promise<void> | null = null;
  private query: NoticeQuery | null = null;
  private sources: Cursor[] = [];
  private pending: Candidate[] = [];
  private candidates = new Map<string, BidNotice>();
  private checked = new Set<string>();
  private matches = new Map<string, BidNotice>();
  private failures = new Map<string, string>();
  constructor(private repository: IndexedNoticeRepository = browserIndexedNoticeRepository, private clock: () => number = Date.now) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(changes: Partial<IndexedNoticesSnapshot> = {}) {
    this.pending = this.pending.filter(candidate => this.candidates.get(candidate.key) === candidate.notice);
    this.snapshot = { ...this.snapshot, items: [...this.matches.values()], candidateCount: this.candidates.size, checkedCount: this.checked.size,
      hasMore: this.sources.length > 0 || this.pending.length > 0,
      error: this.failures.size ? `일부 공고를 확인하지 못했습니다. ${[...new Set(this.failures.values())].join(' ')} 확인된 결과부터 표시하며, 더 조회하면 실패한 범위를 다시 확인합니다.` : '', ...changes };
    this.listeners.forEach(listener => listener());
  }
  clear = () => {
    this.generation++; this.request?.abort(); this.request = null; this.running = null; this.query = null;
    this.sources = []; this.pending = []; this.candidates.clear(); this.checked.clear(); this.matches.clear(); this.failures.clear();
    this.snapshot = empty(this.snapshot.userId); this.listeners.forEach(listener => listener());
  };
  setUser(userId?: string) { this.clear(); this.snapshot = empty(userId || null); this.listeners.forEach(listener => listener()); }
  search = async (input: NoticeQuery) => {
    if (!this.snapshot.userId) return; this.clear();
    try { const plan = planIndexedNoticeSearch(input); this.query = plan.query; this.sources = plan.sources.map(source => ({ source, key: JSON.stringify(source), page: 1 })); }
    catch (cause) { this.publish({ error: messageOf(cause) }); return; }
    await this.loadMore();
  };
  loadMore = (): Promise<void> => {
    if (this.running) return this.running;
    if (!this.snapshot.userId || !this.query || !this.sources.length && !this.pending.length) return Promise.resolve();
    const promise = this.runBatch(); this.running = promise; void promise.finally(() => { if (this.running === promise) this.running = null; }); return promise;
  };
  private finish(notice: BidNotice) {
    if (!this.query) return;
    const key = keyOf(notice); this.checked.add(key);
    if (matchesDeadlineWindow(notice, this.query, this.clock()) && (!this.query.keyword || notice.title.normalize('NFKC').toLowerCase().includes(this.query.keyword.normalize('NFKC').toLowerCase()))) this.matches.set(key, notice);
    else this.matches.delete(key);
  }
  applyDetail = (id: string, detail: G2bNoticeDetail) => {
    const original = [...this.matches.values()].find(notice => notice.id === id);
    if (!original || detail.number !== original.number || detail.revision !== original.revision
      || detail.notice && (detail.notice.number !== original.number || detail.notice.revision !== original.revision || detail.notice.type !== original.type)) return;
    const notice = { ...original, ...detail.notice,
      allowedRegions: detail.regionComplete ? detail.allowedRegions : original.allowedRegions, licenses: detail.licenseComplete ? detail.licenses : original.licenses };
    this.candidates.set(keyOf(notice), notice); this.finish(notice); this.publish();
  };
  private acceptPage(page: G2bNoticePage) {
    for (const notice of page.items) {
      const key = keyOf(notice), previous = this.candidates.get(key);
      if (previous && (older(notice, previous) || sourceVersion(notice) === sourceVersion(previous))) continue;
      this.candidates.set(key, notice); this.checked.delete(key); this.matches.delete(key); this.failures.delete(`latest:${key}`); this.pending.push({ key, notice });
    }
    const fetchedAt = !this.snapshot.fetchedAt || Date.parse(page.fetchedAt) < Date.parse(this.snapshot.fetchedAt) ? page.fetchedAt : this.snapshot.fetchedAt;
    const coverage = (page as G2bNoticePage & Pick<IndexedNoticesSnapshot, 'indexCoverage'>).indexCoverage;
    this.publish({ fetchedAt, ...(coverage ? { indexCoverage: coverage } : {}) });
  }
  private async runBatch() {
    const controller = new AbortController(); this.request = controller; const generation = this.generation, owner = this.snapshot.userId;
    const active = () => generation === this.generation && owner === this.snapshot.userId && !controller.signal.aborted;
    const failedSources = new Set<string>(), failedCandidates = new Set<string>(), inFlight = new Set<Promise<void>>();
    let sourceCount = 0, verifyCount = 0, sourceInFlight = 0, verifyInFlight = 0;
    this.publish({ loading: true }); const countRequest = () => this.publish({ apiRequests: this.snapshot.apiRequests + 1 });
    const loadSource = async (cursor: Cursor) => {
      countRequest();
      try {
        const page = await this.repository.notices(cursor.source, cursor.page, controller.signal); if (!active()) return;
        if (page.quotaExceeded) throw new ApiError('나라장터 호출 한도에 도달했습니다.', 'G2B_QUOTA_EXCEEDED', 429, page.retryAfterSeconds);
        if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean' || !Number.isFinite(Date.parse(page.fetchedAt)) || page.hasMore && !page.items.length
          || page.items.some(notice => notice.type !== cursor.source.type)) throw new Error('공고 목록의 조회 범위를 확인하지 못했습니다.');
        this.failures.delete(`source:${cursor.key}`); if (page.hasMore) this.sources.push({ ...cursor, page: cursor.page + 1 }); this.acceptPage(page);
      } catch (cause) { if (!active()) return; failedSources.add(cursor.key); this.sources.push(cursor); this.failures.set(`source:${cursor.key}`, messageOf(cause)); this.publish(); }
    };
    const verify = async (candidate: Candidate) => {
      countRequest();
      try {
        const versions = await this.repository.lookup(candidate.notice, controller.signal);
        if (!active() || this.candidates.get(candidate.key) !== candidate.notice) return;
        const latest = completeLatest(versions, candidate.notice); this.candidates.set(candidate.key, latest); this.failures.delete(`latest:${candidate.key}`); this.finish(latest); this.publish();
      } catch (cause) { if (!active() || this.candidates.get(candidate.key) !== candidate.notice) return; failedCandidates.add(candidate.key); this.pending.push(candidate); this.failures.set(`latest:${candidate.key}`, messageOf(cause)); this.publish(); }
    };
    try {
      while (active()) {
        this.pending = this.pending.filter(candidate => this.candidates.get(candidate.key) === candidate.notice);
        for (const cursor of take(this.sources, Math.min(4 - sourceInFlight, 12 - sourceCount), item => !failedSources.has(item.key))) {
          sourceCount++; sourceInFlight++; const task = loadSource(cursor).finally(() => { sourceInFlight--; inFlight.delete(task); }); inFlight.add(task);
        }
        for (const candidate of take(this.pending, Math.min(4 - verifyInFlight, 20 - verifyCount), item => !failedCandidates.has(item.key))) {
          verifyCount++; verifyInFlight++; const task = verify(candidate).finally(() => { verifyInFlight--; inFlight.delete(task); }); inFlight.add(task);
        }
        if (!inFlight.size) break; await Promise.race(inFlight);
      }
    } finally { if (active()) { this.request = null; this.publish({ loading: false }); } }
  }
  dispose() { this.setUser(); this.listeners.clear(); }
}
