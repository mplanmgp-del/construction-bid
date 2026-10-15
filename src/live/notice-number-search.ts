import type { BidNotice } from '../types';
import type { G2bBusinessType, G2bNoticePage } from '../g2b-types';
import { fetchApi } from './client';

export type NoticeNumberType = G2bBusinessType | '공사·용역';
export interface ParsedNoticeNumber { number: string; revision: string | null }
export interface NoticeNumberResult {
  type: G2bBusinessType; latest: BidNotice; history: BidNotice[];
  requestedRevision: string | null; requested: BidNotice | null; fetchedAt: string; warnings: string[];
}
export type NoticeNumberRepository = (number: string, type: G2bBusinessType, signal: AbortSignal) => Promise<G2bNoticePage>;
export interface NoticeNumberSnapshot {
  userId: string | null; loading: boolean; attempted: boolean; query: ParsedNoticeNumber | null;
  groups: NoticeNumberResult[]; errors: { type: G2bBusinessType; message: string }[]; error: string;
}
const empty = (userId: string | null): NoticeNumberSnapshot => ({ userId, loading: false, attempted: false, query: null, groups: [], errors: [], error: '' });
const invalid = () => new Error('공고번호를 확인해 주세요. 예: R26BK01359594 또는 R26BK01359594-000');

export function parseNoticeNumberInput(value: string): ParsedNoticeNumber {
  const match = /^([A-Z0-9_]{5,40})(?:-(\d{1,3}))?$/.exec(value.trim().toUpperCase());
  if (!match) throw invalid();
  return { number: match[1], revision: match[2] === undefined ? null : match[2].padStart(3, '0') };
}

/** A partial history must never make an obsolete revision look like the latest. */
export function buildNoticeNumberResult(page: G2bNoticePage, query: ParsedNoticeNumber, type: G2bBusinessType): NoticeNumberResult | null {
  if (!Array.isArray(page.items) || page.hasMore || page.quotaExceeded || !Number.isSafeInteger(page.totalCount)
    || page.totalCount < 0 || page.items.length !== page.totalCount) {
    throw new Error('공고 차수를 모두 확인하지 못했습니다. 다시 조회해 주세요.');
  }
  const byRevision = new Map<string, BidNotice>();
  for (const item of page.items) {
    if (item.number.toUpperCase() !== query.number || item.type !== type || !/^\d{1,3}$/.test(item.revision)) {
      throw new Error('공고번호와 차수 응답을 확인하지 못했습니다. 다시 조회해 주세요.');
    }
    const revision = item.revision.padStart(3, '0'), previous = byRevision.get(revision);
    if (!previous || (Date.parse(item.postedAt) || 0) > (Date.parse(previous.postedAt) || 0)) byRevision.set(revision, { ...item, revision });
  }
  const history = [...byRevision.values()].sort((a, b) => Number(b.revision) - Number(a.revision));
  if (!history.length) return null;
  return { type, latest: history[0], history, requestedRevision: query.revision,
    requested: query.revision === null ? null : byRevision.get(query.revision) ?? null,
    fetchedAt: page.fetchedAt, warnings: page.warnings ?? [] };
}

export const browserNoticeNumberRepository: NoticeNumberRepository = (number, type, signal) => fetchApi<G2bNoticePage>(
  `/api/notices?${new URLSearchParams({ mode: 'number', type, number })}`, signal,
);

export function visibleNoticeNumberSearch(snapshot: NoticeNumberSnapshot, userId?: string): NoticeNumberSnapshot {
  return snapshot.userId === (userId || null) ? snapshot : empty(userId || null);
}

/** Explicit queries only; results are held in memory for one account. */
export class NoticeNumberController {
  private snapshot = empty(null);
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private generation = 0;
  constructor(private readonly repository: NoticeNumberRepository = browserNoticeNumberRepository) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(snapshot: NoticeNumberSnapshot) { this.snapshot = snapshot; for (const listener of this.listeners) listener(); }
  setUser(userId?: string) { if (this.snapshot.userId === (userId || null)) return; this.cancel(); this.update(empty(userId || null)); }
  private cancel() { this.generation++; this.abort?.abort(); this.abort = null; }
  clear() { this.cancel(); this.update(empty(this.snapshot.userId)); }
  async search(input: string, selection: NoticeNumberType): Promise<void> {
    const owner = this.snapshot.userId;
    this.cancel();
    if (!owner) return;
    let query: ParsedNoticeNumber;
    try { query = parseNoticeNumberInput(input); }
    catch (cause) { this.update({ ...empty(owner), error: cause instanceof Error ? cause.message : invalid().message }); return; }
    const types: G2bBusinessType[] = selection === '공사·용역' ? ['공사', '용역'] : [selection];
    if (types.some(type => type !== '공사' && type !== '용역')) { this.update({ ...empty(owner), error: '업무 구분을 확인해 주세요.' }); return; }
    const generation = this.generation, controller = new AbortController(); this.abort = controller;
    const active = () => generation === this.generation && owner === this.snapshot.userId && !controller.signal.aborted;
    this.update({ ...empty(owner), loading: true, attempted: true, query });
    await Promise.all(types.map(async type => {
      try {
        const page = await this.repository(query.number, type, controller.signal);
        if (!active()) return;
        const group = buildNoticeNumberResult(page, query, type);
        if (group) this.update({ ...this.snapshot, groups: [...this.snapshot.groups, group].sort((a, b) => types.indexOf(a.type) - types.indexOf(b.type)) });
      } catch (cause) {
        if (!active()) return;
        this.update({ ...this.snapshot, errors: [...this.snapshot.errors, { type, message: cause instanceof Error ? cause.message : '나라장터 연결 상태를 확인해 주세요.' }] });
      }
    }));
    if (active()) { this.abort = null; this.update({ ...this.snapshot, loading: false }); }
  }
}
