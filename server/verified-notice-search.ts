import { CATEGORIES, NOTICE_STATUSES, type SearchFilters } from '../src/types.ts';
import { canonicalProvince, canonicalSearchProvince, normalizeSearchRegion } from '../src/search-filters.ts';
import { getPriceRangeError } from '../src/domain.ts';
import type { VerifiedNoticeSearchQuery } from '../src/live/active-catalog-types.ts';
import { G2bError } from './g2b.ts';

const invalid = (message = '검색 조건과 날짜를 확인해 주세요.'): never => { throw new G2bError(400, 'INVALID_SEARCH_QUERY', message); };
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1995-10-01' && value <= '2100-12-31'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const clean = (value: unknown, limit: number) => {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  return value.normalize('NFKC').trim();
};
function objectParam(params: URLSearchParams, name: string, max: number): Record<string, unknown> {
  const raw = params.get(name); if (raw === null) return {};
  if (raw.length > max) return invalid();
  let value: unknown; try { value = JSON.parse(raw); } catch { return invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
const choice = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T => {
  if (value === undefined) return fallback;
  return typeof value === 'string' && choices.includes(value as T) ? value as T : invalid();
};
const boolean = (value: unknown, fallback = false) => value === undefined ? fallback : typeof value === 'boolean' ? value : invalid();

/** Public search sends only explicit filters and minimal company geography. */
export function parseVerifiedNoticeSearch(params: URLSearchParams): VerifiedNoticeSearchQuery {
  const type = choice(params.get('type') ?? undefined, ['공사', '용역', '공사·용역'] as const, '공사·용역');
  const from = params.get('from') || '', to = params.get('to') || '';
  if (!validDay(from) || !validDay(to) || from > to) return invalid('조회 날짜는 1995-10-01부터 2100-12-31 사이로 선택해 주세요.');
  const keyword = clean(params.get('keyword') ?? '', 100);
  const raw = objectParam(params, 'filters', 8_000);
  const filters: SearchFilters = {
    keyword: clean(raw.keyword ?? '', 100), excludeKeyword: clean(raw.excludeKeyword ?? '', 300),
    category: choice(raw.category, ['전체', ...CATEGORIES, '기타'] as const, '전체'),
    type: choice(raw.type, ['전체', '공사', '용역'] as const, '전체'),
    siteProvince: clean(raw.siteProvince ?? '전체', 60), license: clean(raw.license ?? '전체', 160),
    minAmount: clean(raw.minAmount ?? '', 30), maxAmount: clean(raw.maxAmount ?? '', 30),
    status: choice(raw.status, ['전체', ...NOTICE_STATUSES] as const, '전체'),
    contractMethod: clean(raw.contractMethod ?? '전체', 100),
    deadlineFrom: clean(raw.deadlineFrom ?? '', 10), deadlineTo: clean(raw.deadlineTo ?? '', 10),
    regionView: choice(raw.regionView, ['all','matched','excluded','review'] as const, 'all'),
    autoRegion: boolean(raw.autoRegion), includeUnknownRegions: boolean(raw.includeUnknownRegions),
    sort: choice(raw.sort, ['deadline','newest','amountAsc','amountDesc'] as const, 'deadline'),
  };
  if (filters.siteProvince !== '전체') filters.siteProvince = canonicalSearchProvince(filters.siteProvince) ?? invalid();
  const amountError = getPriceRangeError(filters.minAmount, filters.maxAmount); if (amountError) return invalid(amountError);
  if (filters.deadlineFrom && !validDay(filters.deadlineFrom) || filters.deadlineTo && !validDay(filters.deadlineTo)
    || filters.deadlineFrom && filters.deadlineTo && filters.deadlineFrom > filters.deadlineTo) return invalid();
  if (raw.statuses !== undefined) {
    if (!Array.isArray(raw.statuses) || raw.statuses.length > NOTICE_STATUSES.length || raw.statuses.some(value => !NOTICE_STATUSES.includes(value))) return invalid();
    filters.statuses = [...new Set(raw.statuses)] as SearchFilters['statuses'];
  }
  if (raw.regions !== undefined) {
    if (!Array.isArray(raw.regions) || raw.regions.length > 30) return invalid();
    filters.regions = raw.regions.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
      const region = value as Record<string, unknown>, province = canonicalSearchProvince(clean(region.province, 60));
      if (!province) return invalid();
      return normalizeSearchRegion({ province, ...(region.district ? {district:clean(region.district,100)} : {}), ...(region.locality ? {locality:clean(region.locality,100)} : {}) });
    });
  }
  const company = objectParam(params, 'companyRegion', 2_000);
  let profile: VerifiedNoticeSearchQuery['profile'];
  if (Object.keys(company).length) {
    const province = clean(company.province ?? '', 60), district = clean(company.district ?? '', 100);
    profile = { province: canonicalProvince(province) ?? province, district };
  }
  const rawLimit = params.get('limit') ?? '50';
  if (!/^\d{1,2}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) return invalid('한 번에 최대 50건씩 조회할 수 있습니다.');
  const cursor = params.get('cursor') ?? '';
  if (cursor.length > 4096 || /[\u0000-\u0020\u007f]/.test(cursor)) return invalid('다음 페이지 정보를 확인해 주세요.');
  return { type, from, to, keyword, filters, ...(profile ? {profile} : {}), limit: Number(rawLimit), ...(cursor ? {cursor} : {}) };
}
