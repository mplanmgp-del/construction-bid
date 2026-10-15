import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS } from '../src/data';
import { readSearchSession, writeSearchSession, SEARCH_SESSION_KEY } from '../src/ui/search-session';

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
const query = { type: '공사' as const, keyword: '학교 철거', from: '2026-01-01', to: '2027-01-01' };
const filters = { ...DEFAULT_FILTERS, type: '공사' as const, license: '구조물해체ㆍ비계공사업', minAmount: '100000000', autoRegion: true, regions: [{ province: '서울특별시' }] };

describe('session search context', () => {
  it('restores safe search conditions but leaves company region matching off for each visit', () => {
    const s = storage(); writeSearchSession(query, filters, s, 1000);
    const result = readSearchSession(s, 1100);
    expect(result?.query).toEqual(query);
    expect(result?.filters).toMatchObject({ license: filters.license, minAmount: '100000000', autoRegion: false, regionView: 'all', regions: filters.regions });
    expect(s.getItem(SEARCH_SESSION_KEY)).not.toContain('companyName');
  });
  it('ignores expired, future-dated and malformed records without deleting them', () => {
    const s = storage(); writeSearchSession(query, filters, s, 1000);
    expect(readSearchSession(s, 1000 + 12 * 60 * 60 * 1000 + 1)).toBeNull();
    expect(readSearchSession(s, 900)).toBeNull();
    s.setItem(SEARCH_SESSION_KEY, '{"version":1}');
    expect(readSearchSession(s, 1100)).toBeNull();
    expect(s.getItem(SEARCH_SESSION_KEY)).toBe('{"version":1}');
  });
  it('rejects reversed dates and filters with unexpected values', () => {
    const s = storage(); writeSearchSession(query, filters, s, 1000);
    const record = JSON.parse(s.getItem(SEARCH_SESSION_KEY)!);
    record.query.to = '2025-01-01'; s.setItem(SEARCH_SESSION_KEY, JSON.stringify(record));
    expect(readSearchSession(s, 1100)).toBeNull();
    record.query = query; record.filters.sort = 'malicious'; s.setItem(SEARCH_SESSION_KEY, JSON.stringify(record));
    expect(readSearchSession(s, 1100)).toBeNull();
  });
  it('allows all tasks to continue when browser session storage is unavailable', () => {
    const denied = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); } };
    expect(readSearchSession(denied)).toBeNull();
    expect(writeSearchSession(query, filters, denied)).toBe(false);
  });
});
