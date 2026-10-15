import type { G2bNoticePage } from '../g2b-types';
import type { NoticeQuery } from './notice-search';
import type { BidNotice } from '../types';
import { dateRangeError } from './client';

// Provider notices only. Account profiles and eligibility decisions stay outside this cache.
export const NOTICE_CACHE_KEY = 'construction-bid:public-deadline-notices:v2';
export const NOTICE_CACHE_FRESH_MS = 5 * 60_000;
export const NOTICE_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 6;
const MAX_CHARACTERS = 1_000_000;
type CacheStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
interface Entry { key: string; savedAt: number; page: G2bNoticePage }

export function normalizedNoticeQuery(query: NoticeQuery): NoticeQuery {
  return { type: query.type, from: query.from, to: query.to, keyword: query.keyword.trim() };
}

export function noticeQueryKey(query: NoticeQuery): string {
  const value = normalizedNoticeQuery(query);
  return JSON.stringify(['deadline-v2', value.type, value.from, value.to, value.keyword]);
}

function browserStorage(): CacheStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

function publicNotice(bid: BidNotice): BidNotice {
  // Explicit projection strips any later UI/account-specific additions.
  return {
    id: bid.id, number: bid.number, revision: bid.revision, title: bid.title, agency: bid.agency,
    type: bid.type, category: bid.category, province: bid.province, district: bid.district,
    allowedRegions: bid.allowedRegions, estimatedPrice: bid.estimatedPrice, plannedAmount: bid.plannedAmount,
    demandAgency: bid.demandAgency, noticeKind: bid.noticeKind, contractMethod: bid.contractMethod,
    status: bid.status, postedAt: bid.postedAt, deadline: bid.deadline, openingAt: bid.openingAt,
    registrationDeadline: bid.registrationDeadline, biddingStartAt: bid.biddingStartAt,
    ...(bid.openingCompleted !== undefined ? { openingCompleted: bid.openingCompleted } : {}),
    licenses: bid.licenses, duration: bid.duration, description: bid.description, requirements: bid.requirements,
    documents: bid.documents.map(doc => ({ name: doc.name, size: doc.size, url: doc.url })),
    revised: bid.revised, source: 'live', detailUrl: bid.detailUrl, specialRegionCondition: bid.specialRegionCondition,
  };
}

function isCompletePage(value: unknown): value is G2bNoticePage {
  if (!value || typeof value !== 'object') return false;
  const page = value as G2bNoticePage;
  return page.hasMore === false && page.page === 1 && Array.isArray(page.items)
    && Number.isInteger(page.totalCount) && page.totalCount === page.items.length
    && Number.isFinite(Date.parse(page.fetchedAt)) && typeof page.source === 'string'
    && page.items.every(item => item && typeof item.id === 'string' && typeof item.title === 'string'
      && typeof item.number === 'string' && typeof item.revision === 'string'
      && ['공사', '용역'].includes(item.type) && Array.isArray(item.documents)
      && Array.isArray(item.licenses) && Array.isArray(item.requirements)
      && (item.allowedRegions === null || Array.isArray(item.allowedRegions)))
    && new Set(page.items.map(item => item.id)).size === page.items.length;
}

function readEntries(storage: CacheStorage, now: number): Entry[] {
  const raw = storage.getItem(NOTICE_CACHE_KEY);
  if (!raw) return [];
  try {
    if (raw.length > MAX_CHARACTERS) throw new Error('Oversized cache');
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) throw new Error('Invalid cache');
    const valid = entries.filter((entry): entry is Entry => entry && typeof entry.key === 'string'
      && Number.isFinite(entry.savedAt) && entry.savedAt <= now
      && now - entry.savedAt < NOTICE_CACHE_MAX_AGE_MS && isCompletePage(entry.page)
      && Date.parse(entry.page.fetchedAt) <= now && now - Date.parse(entry.page.fetchedAt) < NOTICE_CACHE_MAX_AGE_MS)
      .slice(-MAX_ENTRIES);
    if (valid.length !== entries.length) {
      try { storage.setItem(NOTICE_CACHE_KEY, JSON.stringify(valid)); } catch { /* Read-only storage can still serve valid entries. */ }
    }
    return valid;
  } catch { storage.removeItem(NOTICE_CACHE_KEY); return []; }
}

export function readNoticeCache(query: NoticeQuery, now = Date.now(), storage = browserStorage()): { page: G2bNoticePage; fresh: boolean } | null {
  if (!storage) return null;
  try {
    const entry = readEntries(storage, now).find(item => item.key === noticeQueryKey(query));
    if (!entry) return null;
    return { page: entry.page, fresh: now - Date.parse(entry.page.fetchedAt) < NOTICE_CACHE_FRESH_MS };
  } catch { return null; }
}

export function readLastNoticeQuery(now = Date.now(), storage = browserStorage()): NoticeQuery | null {
  if (!storage) return null;
  try {
    for (const entry of readEntries(storage, now).reverse()) {
      try {
        const parts: unknown = JSON.parse(entry.key);
        if (!Array.isArray(parts) || parts.length !== 5 || parts[0] !== 'deadline-v2') continue;
        const [, type, from, to, keyword] = parts;
        if (!['공사', '용역', '공사·용역'].includes(type) || typeof from !== 'string' || typeof to !== 'string'
          || typeof keyword !== 'string' || keyword.length > 100 || /[\u0000-\u001f]/.test(keyword) || dateRangeError(from, to, 367)) continue;
        return { type, from, to, keyword };
      } catch { /* Skip malformed entries without changing account preferences. */ }
    }
  } catch { /* A denied browser store falls back to the usual initial query. */ }
  return null;
}

export function writeNoticeCache(query: NoticeQuery, page: G2bNoticePage, now = Date.now(), storage = browserStorage()): void {
  if (!storage || !isCompletePage(page) || now - Date.parse(page.fetchedAt) >= NOTICE_CACHE_MAX_AGE_MS || Date.parse(page.fetchedAt) > now) return;
  try {
    const key = noticeQueryKey(query);
    const publicPage: G2bNoticePage = { items: page.items.map(publicNotice), totalCount: page.totalCount,
      page: 1, pageSize: page.items.length, hasMore: false, fetchedAt: page.fetchedAt, source: page.source,
      warnings: page.warnings?.filter(warning => typeof warning === 'string') };
    if (JSON.stringify([{ key, savedAt: now, page: publicPage }]).length > MAX_CHARACTERS) return;
    const entries = [...readEntries(storage, now).filter(entry => entry.key !== key), { key, savedAt: now, page: publicPage }].slice(-MAX_ENTRIES);
    let serialized = JSON.stringify(entries);
    while (serialized.length > MAX_CHARACTERS && entries.length) {
      entries.shift(); serialized = JSON.stringify(entries);
    }
    storage.setItem(NOTICE_CACHE_KEY, serialized);
  } catch { /* Private mode or a full browser store must not break live search. */ }
}
