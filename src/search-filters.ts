import { NOTICE_STATUSES, type NoticeStatus, type SearchFilters, type SearchRegion } from './types.ts';

const provinceAliases: Record<string, string> = {
  서울: '서울특별시', 서울특별시: '서울특별시', 부산: '부산광역시', 부산광역시: '부산광역시',
  대구: '대구광역시', 대구광역시: '대구광역시', 인천: '인천광역시', 인천광역시: '인천광역시',
  광주: '광주광역시', 광주광역시: '광주광역시', 대전: '대전광역시', 대전광역시: '대전광역시',
  울산: '울산광역시', 울산광역시: '울산광역시', 세종: '세종특별자치시', 세종시: '세종특별자치시', 세종특별자치시: '세종특별자치시',
  경기: '경기도', 경기도: '경기도', 강원: '강원특별자치도', 강원도: '강원특별자치도', 강원특별자치도: '강원특별자치도',
  충북: '충청북도', 충청북도: '충청북도', 충남: '충청남도', 충청남도: '충청남도',
  전북: '전북특별자치도', 전라북도: '전북특별자치도', 전북특별자치도: '전북특별자치도',
  전남: '전라남도', 전라남도: '전라남도', 경북: '경상북도', 경상북도: '경상북도',
  경남: '경상남도', 경상남도: '경상남도', 제주: '제주특별자치도', 제주도: '제주특별자치도', 제주특별자치도: '제주특별자치도',
};

const cleanText = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');

export const canonicalProvince = (value: string): string | null => provinceAliases[cleanText(value)] ?? null;
/** Search uses the current official directory; company eligibility keeps its original geography. */
export function canonicalSearchProvince(value: string): string | null {
  const text = cleanText(value);
  const legacy = canonicalProvince(text);
  if (text === '전남광주통합특별시' || legacy === '광주광역시' || legacy === '전라남도') return '전남광주통합특별시';
  return legacy;
}

export function normalizeSearchRegion(region: SearchRegion): SearchRegion {
  const province = canonicalSearchProvince(region.province) ?? cleanText(region.province);
  const inputDistrict = cleanText(region.district ?? '');
  const district = province === '세종특별자치시' && inputDistrict === '세종시' ? '' : inputDistrict;
  const locality = cleanText(region.locality ?? '');
  return { province, ...(district ? { district } : {}), ...(locality ? { locality } : {}) };
}

export function regionLabel(region: SearchRegion): string {
  const normalized = normalizeSearchRegion(region);
  return [normalized.province, normalized.district, normalized.locality].filter(Boolean).join(' ');
}

export function regionKey(region: SearchRegion): string {
  return JSON.stringify(regionLabel(region).split(' '));
}

const regionPath = (region: SearchRegion): string[] => regionLabel(region).split(' ');
const containsPath = (parent: SearchRegion, child: SearchRegion): boolean => {
  const parentPath = regionPath(parent);
  const childPath = regionPath(child);
  return parentPath.length <= childPath.length && parentPath.every((part, index) => part === childPath[index]);
};

export function selectedStatuses(filters: Pick<SearchFilters, 'status' | 'statuses'>): NoticeStatus[] {
  const statuses = filters.statuses ?? (filters.status === '전체' ? [] : [filters.status]);
  return [...new Set(statuses.filter(status => NOTICE_STATUSES.includes(status)))];
}

export function selectedRegions(filters: Pick<SearchFilters, 'siteProvince' | 'regions'>): SearchRegion[] {
  const regions = filters.regions ?? (filters.siteProvince === '전체' ? [] : [{ province: filters.siteProvince }]);
  const unique = new Map<string, SearchRegion>();
  for (const region of regions) {
    const normalized = normalizeSearchRegion(region);
    if (normalized.province) unique.set(regionKey(normalized), normalized);
  }
  return [...unique.values()];
}

/** A selected parent covers its children; choosing a child replaces its selected parent. */
export function toggleSearchRegion(current: SearchRegion[], region: SearchRegion): SearchRegion[] {
  const normalized = normalizeSearchRegion(region);
  const regions = selectedRegions({ siteProvince: '전체', regions: current });
  if (!normalized.province) return regions;
  const key = regionKey(normalized);
  if (regions.some(item => regionKey(item) === key)) return regions.filter(item => regionKey(item) !== key);
  return [...regions.filter(item => !containsPath(item, normalized) && !containsPath(normalized, item)), normalized];
}
