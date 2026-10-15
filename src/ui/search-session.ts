import { CATEGORIES, NOTICE_STATUSES, type SearchFilters } from '../types';
import type { NoticeQuery } from '../live/notice-search';
import { indexedSearchDateError } from '../live/indexed-notice-search';

export const SEARCH_SESSION_KEY = 'construction-bid.search-session.v1';
const MAX_AGE = 12 * 60 * 60 * 1000;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type SearchSession = { query: NoticeQuery; filters: SearchFilters };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 100): value is string => typeof value === 'string' && value.length <= max;

/** Session-only UI preferences; no account data, snapshots, or automatic eligibility decisions. */
export function readSearchSession(storage?: StorageLike, now = Date.now()): SearchSession | null {
  try {
    const raw = (storage ?? window.sessionStorage).getItem(SEARCH_SESSION_KEY);
    if (!raw || raw.length > 25000) return null;
    const record = JSON.parse(raw);
    if (!isObject(record) || record.version !== 1 || typeof record.at !== 'number' || now < record.at || now - record.at > MAX_AGE) return null;
    const q = record.query, f = record.filters;
    if (!isObject(q) || !isObject(f) || !['공사·용역', '공사', '용역'].includes(String(q.type))
      || !text(q.keyword) || !text(q.from, 10) || !text(q.to, 10) || indexedSearchDateError(q.from, q.to)) return null;
    for (const key of ['keyword', 'excludeKeyword', 'siteProvince', 'license', 'minAmount', 'maxAmount', 'contractMethod', 'deadlineFrom', 'deadlineTo']) {
      if (!text(f[key])) return null;
    }
    if (!['전체', '공사', '용역'].includes(String(f.type)) || !['전체', '기타', ...CATEGORIES].includes(String(f.category))
      || !['전체', ...NOTICE_STATUSES].includes(String(f.status)) || !['deadline', 'newest', 'amountAsc', 'amountDesc'].includes(String(f.sort))) return null;
    if (f.statuses !== undefined && (!Array.isArray(f.statuses) || f.statuses.length > 4 || !f.statuses.every(s => NOTICE_STATUSES.includes(s)))) return null;
    if (f.regions !== undefined && (!Array.isArray(f.regions) || f.regions.length > 200 || !f.regions.every(r => isObject(r) && text(r.province, 50) && (r.district === undefined || text(r.district, 50)) && (r.locality === undefined || text(r.locality, 50))))) return null;
    return { query: { type: q.type, keyword: q.keyword, from: q.from, to: q.to } as NoticeQuery,
      filters: { ...f, autoRegion: false, regionView: 'all', includeUnknownRegions: f.includeUnknownRegions === true } as unknown as SearchFilters };
  } catch { return null; }
}

export function writeSearchSession(query: NoticeQuery, filters: SearchFilters, storage?: StorageLike, now = Date.now()): boolean {
  try {
    (storage ?? window.sessionStorage).setItem(SEARCH_SESSION_KEY, JSON.stringify({ version: 1, at: now, query,
      filters: { ...filters, autoRegion: false, regionView: 'all' } }));
    return true;
  } catch { return false; }
}
