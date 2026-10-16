import { expect, it } from 'vitest';
import type { G2bNoticePage } from '../src/g2b-types';
import type { NoticeQuery } from '../src/live/notice-search';
import { NOTICE_CACHE_KEY, NOTICE_CACHE_FRESH_MS, NOTICE_CACHE_MAX_AGE_MS, noticeQueryKey, readLastNoticeQuery, readNoticeCache, writeNoticeCache } from '../src/live/notice-cache';
import { mapPrivateNotice } from '../server/g2b-private';
import privateFixture from './fixtures/g2b-private-notice.json';

const now = Date.parse('2026-10-13T02:00:00Z');
const query: NoticeQuery = { type: '공사·용역', from: '2026-10-07', to: '2026-10-13', keyword: '철거' };
const page = (): G2bNoticePage => ({ items: [{ id: '공사:R1:000', number: 'R1', revision: '000', title: '철거 공사', agency: '발주처', type: '공사',
  category: '철거·해체', province: '서울특별시', district: '', allowedRegions: null, estimatedPrice: 100000,
  contractMethod: '일반', status: '접수중', postedAt: '2026-10-12T10:00:00+09:00', deadline: '2026-10-15T10:00:00+09:00',
  openingAt: '2026-10-15T11:00:00+09:00', registrationDeadline: '', licenses: [], duration: '', description: '', requirements: [],
  documents: [{ name: '공고서', size: '', url: 'https://g2b.go.kr/file' }], revised: false, source: 'live' }],
  totalCount: 1, hasMore: false, page: 1, pageSize: 1, fetchedAt: new Date(now).toISOString(), source: '나라장터', warnings: [] });
function store() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

it('reuses the complete query result immediately while isolating dates, business and keywords', () => {
  const storage = store(); writeNoticeCache(query, page(), now, storage);
  expect(readNoticeCache({ ...query, keyword: ' 철거 ' }, now + 100, storage)).toMatchObject({ fresh: true, page: { totalCount: 1 } });
  for (const other of [{ ...query, type: '공사' as const }, { ...query, from: '2026-10-08' }, { ...query, keyword: '석면' }]) {
    expect(readNoticeCache(other, now, storage)).toBeNull();
  }
});

it('requires refresh after five minutes and removes data at the 24-hour boundary', () => {
  const storage = store(); writeNoticeCache(query, page(), now, storage);
  expect(readNoticeCache(query, now + NOTICE_CACHE_FRESH_MS - 1, storage)?.fresh).toBe(true);
  expect(readNoticeCache(query, now + NOTICE_CACHE_FRESH_MS, storage)?.fresh).toBe(false);
  expect(readNoticeCache(query, now + NOTICE_CACHE_MAX_AGE_MS, storage)).toBeNull();
  expect(storage.getItem(NOTICE_CACHE_KEY)).toBe('[]');
});

it('uses the provider fetched time, so persisting an old response cannot make it fresh again', () => {
  const storage = store(); writeNoticeCache(query, page(), now + NOTICE_CACHE_FRESH_MS, storage);
  expect(readNoticeCache(query, now + NOTICE_CACHE_FRESH_MS, storage)?.fresh).toBe(false);
});

it('never caches incomplete, duplicate, truncated or paginated results', () => {
  for (const result of [{ ...page(), hasMore: true }, { ...page(), totalCount: 2 }, { ...page(), page: 2 },
    { ...page(), items: [...page().items, ...page().items], totalCount: 2 }]) {
    const storage = store(); writeNoticeCache(query, result, now, storage);
    expect(readNoticeCache(query, now, storage)).toBeNull();
  }
});

it('persists only public notice fields and detaches subsequent UI mutations', () => {
  const storage = store(); const result = page();
  Object.assign(result.items[0], { companyProfile: { email: 'private@example.test' }, eligible: true });
  Object.assign(result, { accountId: 'secret-account' });
  writeNoticeCache(query, result, now, storage);
  result.items[0].licenses.push('UI 변경'); result.items[0].title = '다른 표시';
  const cached = readNoticeCache(query, now, storage)!;
  expect(cached.page.items[0].title).toBe('철거 공사'); expect(cached.page.items[0].licenses).toEqual([]);
  expect(storage.getItem(NOTICE_CACHE_KEY)).not.toMatch(/companyProfile|eligible|accountId|private@example/);
});

it('round-trips private procurement and bid method without inventing a deadline, estimated price or region', () => {
  const storage = store(); const cacheTime = Date.parse('2026-10-16T03:00:00Z');
  const notice = mapPrivateNotice(privateFixture.response.body.items[1], '공사', cacheTime);
  const result = { ...page(), items: [notice], fetchedAt: new Date(cacheTime).toISOString(), source: '누리장터 민간입찰공고정보서비스' };
  writeNoticeCache(query, result, cacheTime, storage);
  notice.bidMethod = 'UI 변경'; notice.procurementSource = 'public';
  const restored = readNoticeCache(query, cacheTime + 1000, storage);
  expect(restored).toMatchObject({ fresh: true, page: { items: [{
    id: 'g2b:공사:R26BK01774453:001', type: '공사', procurementSource: 'private', bidMethod: '직찰',
    noticeKind: '변경공고', deadline: '', status: '확인필요', estimatedPrice: null,
    allowedRegions: null, licenses: [], sourceUpdatedAt: '2026-10-16T10:32:23+09:00',
  }] } });
});

it('rejects a cached malformed procurement source rather than routing it as a public notice', () => {
  const storage = store(); writeNoticeCache(query, page(), now, storage);
  const entries = JSON.parse(storage.getItem(NOTICE_CACHE_KEY)!);
  entries[0].page.items[0].procurementSource = 'live';
  storage.setItem(NOTICE_CACHE_KEY, JSON.stringify(entries));
  expect(readNoticeCache(query, now, storage)).toBeNull();
});

it('bounds storage to six successful searches and keeps unrelated account preferences', () => {
  const storage = store(); storage.setItem('account-preferences', 'keep');
  for (let i = 0; i < 8; i++) writeNoticeCache({ ...query, keyword: `검색${i}` }, page(), now + i, storage);
  expect(JSON.parse(storage.getItem(NOTICE_CACHE_KEY)!)).toHaveLength(6);
  expect(readNoticeCache({ ...query, keyword: '검색0' }, now + 8, storage)).toBeNull();
  expect(readNoticeCache({ ...query, keyword: '검색7' }, now + 8, storage)).not.toBeNull();
  expect(storage.getItem('account-preferences')).toBe('keep');
});

it('restores only the last valid successful public query on reload', () => {
  const storage = store(); writeNoticeCache(query, page(), now, storage);
  writeNoticeCache({ ...query, keyword: '석면' }, page(), now + 1, storage);
  expect(readLastNoticeQuery(now + 2, storage)).toEqual({ ...query, keyword: '석면' });
  expect(readLastNoticeQuery(now + NOTICE_CACHE_MAX_AGE_MS + 1, storage)).toBeNull();
});

it('does not restore invalid date ranges or hidden account fields from a modified cache', () => {
  const storage = store(); writeNoticeCache(query, page(), now, storage);
  const entries = JSON.parse(storage.getItem(NOTICE_CACHE_KEY)!);
  entries.push({ ...entries[0], key: noticeQueryKey({ ...query, from: '2024-01-01' }) });
  entries.push({ ...entries[0], key: JSON.stringify(['공사', query.from, query.to, '철거', { autoRegion: true }]) });
  storage.setItem(NOTICE_CACHE_KEY, JSON.stringify(entries));
  expect(readLastNoticeQuery(now, storage)).toEqual(query);
});

it('corrupt, future-dated and blocked browser storage fall back to live search', () => {
  const storage = store(); storage.setItem(NOTICE_CACHE_KEY, '{bad');
  expect(readNoticeCache(query, now, storage)).toBeNull(); expect(storage.getItem(NOTICE_CACHE_KEY)).toBeNull();
  writeNoticeCache(query, page(), now, storage);
  expect(readNoticeCache(query, now - 1, storage)).toBeNull();
  const blocked = { getItem: () => { throw new Error('Denied'); }, setItem: () => { throw new Error('Quota'); }, removeItem: () => {} };
  expect(() => writeNoticeCache(query, page(), now, blocked)).not.toThrow();
  expect(readNoticeCache(query, now, blocked)).toBeNull();
});

it('does not evict usable results for a single response larger than the cache budget', () => {
  const storage = store(); writeNoticeCache(query, page(), now, storage);
  const large = page(); large.items[0].description = '가'.repeat(1_000_001);
  writeNoticeCache({ ...query, keyword: '초대형' }, large, now, storage);
  expect(readNoticeCache(query, now, storage)).not.toBeNull();
  expect(readNoticeCache({ ...query, keyword: '초대형' }, now, storage)).toBeNull();
});
