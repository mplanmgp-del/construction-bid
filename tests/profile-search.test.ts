import { describe, expect, it } from 'vitest';
import { filterNotices } from '../src/domain';
import { DEFAULT_FILTERS, DEMO_PROFILES, NOTICES } from '../src/data';
import { normalizeIndexedSearch, indexedSearchKey } from '../src/live/indexed-notice-search';
import { parseVerifiedNoticeSearch } from '../server/verified-notice-search';
import { alertFilterFromSearch } from '../src/alerts/useAlerts';

const profile = { ...DEMO_PROFILES[0], province: '서울특별시', district: '마포구', licenseCodes: ['4995', '0002'] };
const filters = { ...DEFAULT_FILTERS, category: '전체' as const, status: '전체' as const, autoRegion: true };
const query = { type: '공사·용역' as const, from: '1995-10-01', to: '2100-12-31', keyword: '', filters, profile };
const notice = (id: string, region: string, codes: string[]) => ({ ...NOTICES[0], id, title: `${region} 시설 공사`,
  agency: '', demandAgency: '', province: '', district: '', allowedRegions: null, regionSearchText: region,
  description: '', requirements: [], documents: [], licenses: ['같은 표시명'], licenseCodes: codes });
const ids = (items: ReturnType<typeof filterNotices>) => items.map(item => item.id).sort();
const params = (codes: unknown, enabled = true) => new URLSearchParams({ from: query.from, to: query.to,
  filters: JSON.stringify({ autoRegion: enabled }), companyRegion: JSON.stringify({ province: '서울', district: '마포구',
    licenseCodes: codes, companyName: 'PRIVATE COMPANY', email: 'private@example.test' }) });

describe('내 정보로 찾기: 지역 키워드와 저장 업종코드', () => {
  it('keeps both profile criteria when preparing a saved alert, without changing manual codes', () => {
    const selected = { ...filters, license: '5652' };
    expect(alertFilterFromSearch(selected, query)).toMatchObject({ useCompanyRegion: true, useCompanyLicenses: true, licenses: ['5652'] });
    expect(alertFilterFromSearch({ ...selected, autoRegion: false }, query)).toMatchObject({ useCompanyRegion: false, useCompanyLicenses: false, licenses: ['5652'] });
  });
  it('requires the region keyword and any saved exact code, including a leading-zero code', () => {
    const rows = [notice('seoul-4995', '서울', ['4995']), notice('seoul-0002', '서울', ['0002']),
      notice('wrong-code', '서울', ['5652']), notice('wrong-region', '부산', ['4995']), notice('unknown-code', '서울', [])];
    expect(ids(filterNotices(rows, filters, profile))).toEqual(['seoul-0002', 'seoul-4995']);
  });
  it('keeps the manual industry filter separate and restores it when the profile toggle is off', () => {
    const rows = [notice('manual', '부산', ['5652']), notice('both', '서울', ['4995', '5652']), notice('profile-only', '서울', ['4995'])];
    const manual = { ...filters, license: '5652' };
    expect(ids(filterNotices(rows, manual, profile))).toEqual(['both']);
    expect(ids(filterNotices(rows, { ...manual, autoRegion: false }, profile))).toEqual(['both', 'manual']);
    expect(manual.license).toBe('5652');
  });
  it('does not silently broaden an explicitly empty saved code set or bypass codes in excluded-region view', () => {
    const row = notice('empty', '서울', ['4995']);
    expect(filterNotices([row], filters, { ...profile, licenseCodes: [] })).toEqual([]);
    expect(filterNotices([notice('excluded', '부산', ['5652'])], { ...filters, regionView: 'excluded' }, profile)).toEqual([]);
  });
  it('projects only canonical geography and sorted unique codes when enabled', () => {
    const value = normalizeIndexedSearch({ ...query, profile: { ...profile, licenseCodes: ['4995', '0002', '4995'] } });
    expect(value.profile).toEqual({ province: '서울특별시', district: '마포구', licenseCodes: ['0002', '4995'] });
    expect(JSON.stringify(value)).not.toContain(profile.companyName);
    expect(indexedSearchKey({ ...query, profile: { ...profile, licenseCodes: ['5652'] } })).not.toBe(indexedSearchKey(query));
    const off = { ...query, filters: { ...filters, autoRegion: false } };
    expect(indexedSearchKey({ ...off, profile: { ...profile, licenseCodes: ['5652'] } })).toBe(indexedSearchKey(off));
    expect(normalizeIndexedSearch({ ...query, profile: { ...profile, licenseCodes: [] } }).profile).toHaveProperty('licenseCodes', []);
  });
  it('validates and preserves only the search code array at the public API boundary', () => {
    const value = parseVerifiedNoticeSearch(params(['4995', '0002', '4995']));
    expect(value.profile).toEqual({ province: '서울특별시', district: '마포구', licenseCodes: ['0002', '4995'] });
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE COMPANY|private@example/);
    expect(parseVerifiedNoticeSearch(params([])).profile).toHaveProperty('licenseCodes', []);
  });
  it.each([null, '4995', [4995], ['42'], ['00002'], Array(101).fill('4995')])('rejects invalid enabled code arrays: %j', codes => {
    expect(() => parseVerifiedNoticeSearch(params(codes))).toThrow();
  });
  it('ignores saved codes when off, including a region-exclusion query', () => {
    expect(parseVerifiedNoticeSearch(params(['4995'], false)).profile).toEqual({ province: '서울특별시', district: '마포구' });
    const value = normalizeIndexedSearch({ ...query, filters: { ...filters, autoRegion: false, regionView: 'excluded' } });
    expect(value.profile).toEqual({ province: '서울특별시', district: '마포구' });
  });
});
