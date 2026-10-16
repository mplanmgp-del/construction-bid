import type { BidNotice } from '../types';
import type { G2bNoticeDetail } from '../g2b-types';
import { mergeNoticeDetail, type MemberWorkspace } from '../member/workspace';
import { fetchApi } from './client';

export const BOOKMARK_INDUSTRY_BATCH_SIZE = 10;
export const BOOKMARK_INDUSTRY_RETRY_MS = 10 * 60_000;
export const bookmarkIndustryKey = (notice: BidNotice) => `${notice.type}:${notice.number}:${notice.revision}:${notice.procurementSource ?? 'public'}`;
export type BookmarkIndustryResult = { notice: BidNotice; detail: G2bNoticeDetail };
export type BookmarkIndustryRepository = (notice: BidNotice, signal: AbortSignal) => Promise<G2bNoticeDetail>;
const sourceClock = (notice?: Pick<BidNotice, 'sourceUpdatedAt'>) => notice?.sourceUpdatedAt ?? '';
function detailFactClock(notice: BidNotice, detail: G2bNoticeDetail): string | null {
  const captured = sourceClock(notice), fetched = sourceClock(detail.notice);
  // A detail cache may hold an older generation of the same revision. A known
  // baseline needs an exact response clock; missing legacy clocks can upgrade.
  return captured && captured !== fetched ? null : fetched || captured;
}
function canUpgradeSavedClock(current: BidNotice, captured: BidNotice, detail: G2bNoticeDetail): boolean {
  const previous = sourceClock(current), target = sourceClock(captured);
  if (previous === target) return true;
  if (!target || sourceClock(detail.notice) !== target) return false;
  const targetTime = Date.parse(target), previousTime = Date.parse(previous);
  return Number.isFinite(targetTime) && (!previous || Number.isFinite(previousTime) && previousTime < targetTime);
}

export const browserBookmarkIndustryRepository: BookmarkIndustryRepository = (notice, signal) => fetchApi<G2bNoticeDetail>(
  `/api/detail?${new URLSearchParams({ number: notice.number, revision: notice.revision, type: notice.type })}`, signal);

export function needsBookmarkIndustryRefresh(notice: BidNotice): boolean {
  // A legacy /code label contains only the primary restriction. Fetch the
  // condition rows once to recover any permitted alternative industry codes.
  return notice.source === 'live' && notice.licenseCodes === undefined;
}

/** Preserve confirmed saved facts when a list response omits participant details. */
export function withSavedIndustryFacts(notice: BidNotice, saved?: BidNotice): BidNotice {
  if (notice.source !== 'live' || notice.licenseCodes !== undefined || !saved || saved.source !== 'live' || !Array.isArray(saved.licenseCodes)
    || bookmarkIndustryKey(notice) !== bookmarkIndustryKey(saved)
    || sourceClock(notice) !== sourceClock(saved)) return notice;
  return { ...notice, licenses: saved.licenses, licenseCodes: saved.licenseCodes };
}

/** Fetch one bounded batch; publish only after both lanes have completely settled. */
export async function loadBookmarkIndustryBatch(notices: BidNotice[], signal: AbortSignal,
  repository: BookmarkIndustryRepository = browserBookmarkIndustryRepository) {
  const targets = notices.filter(needsBookmarkIndustryRefresh).slice(0, BOOKMARK_INDUSTRY_BATCH_SIZE);
  const results: BookmarkIndustryResult[] = [], failed: string[] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, async () => {
    while (!signal.aborted && index < targets.length) {
      const notice = targets[index++];
      try {
        const detail = await repository(notice, signal);
        if (signal.aborted) return;
        if (detail.number !== notice.number || detail.revision !== notice.revision || !detail.licenseComplete
          || !Array.isArray(detail.licenses) || !detail.licenses.every(value => typeof value === 'string')
          || detail.notice && (detail.notice.type !== notice.type || bookmarkIndustryKey(detail.notice) !== bookmarkIndustryKey(notice))
          || detailFactClock(notice, detail) === null
          || detail.licenseCodes !== undefined && (!Array.isArray(detail.licenseCodes)
            || detail.licenseCodes.length > 100 || !detail.licenseCodes.every(code => typeof code === 'string' && /^\d{4}$/.test(code)))) {
          throw new Error('공고 업종코드 확인을 완료하지 못했습니다.');
        }
        // A successful code-less source is settled unknown, not a name match.
        results.push({ notice, detail: { ...detail, licenseCodes: detail.licenseCodes ?? [] } });
      } catch {
        if (!signal.aborted) failed.push(bookmarkIndustryKey(notice));
      }
    }
  }));
  return signal.aborted ? { results: [], failed: [] } : { results, failed };
}

export function mergeBookmarkIndustryBatch(workspace: MemberWorkspace, userId: string, results: BookmarkIndustryResult[]): MemberWorkspace {
  if (workspace.profile.id !== userId) return workspace;
  const snapshots = { ...workspace.noticeSnapshots };
  let changed = false;
  for (const { notice, detail } of results) {
    const current = snapshots[notice.id];
    if (!current || !workspace.bookmarks.includes(notice.id) || bookmarkIndustryKey(current) !== bookmarkIndustryKey(notice)
      || !canUpgradeSavedClock(current, notice, detail)) continue;
    const factClock = detailFactClock(notice, detail);
    if (factClock === null) continue;
    // A newer available list can supply the target while its saved snapshot is
    // older. Adopt that confirmed generation's source metadata with its codes;
    // never relabel old metadata with a newer clock alone.
    const upgrading = sourceClock(current) !== sourceClock(notice) || sourceClock(current) !== factClock;
    const baseline = upgrading ? { ...current, ...notice, ...detail.notice, id: current.id } : current;
    const enriched = mergeNoticeDetail(baseline, detail);
    const merged = factClock && sourceClock(enriched) !== factClock ? { ...enriched, sourceUpdatedAt: factClock } : enriched;
    if (merged !== current) { snapshots[notice.id] = merged; changed = true; }
  }
  return changed ? { ...workspace, noticeSnapshots: snapshots } : workspace;
}
