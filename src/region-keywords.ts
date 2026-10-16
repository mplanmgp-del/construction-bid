import { DISTRICTS } from './data.ts';
import { canonicalSearchProvince, normalizeSearchRegion } from './search-filters.ts';
import type { BidNotice, CompanyProfile, RegionAssessment, SearchRegion } from './types.ts';

const clean = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const provinceKeywords: Record<string, string[]> = {
  서울특별시: ['서울', '서울특별시'], 부산광역시: ['부산', '부산광역시'], 대구광역시: ['대구', '대구광역시'],
  인천광역시: ['인천', '인천광역시'], 대전광역시: ['대전', '대전광역시'], 울산광역시: ['울산', '울산광역시'],
  세종특별자치시: ['세종', '세종시', '세종특별자치시'], 경기도: ['경기', '경기도'],
  강원특별자치도: ['강원', '강원도', '강원특별자치도'], 충청북도: ['충북', '충청북도'], 충청남도: ['충남', '충청남도'],
  전북특별자치도: ['전북', '전라북도', '전북특별자치도'],
  전남광주통합특별시: ['전남', '전라남도', '광주', '광주광역시', '전남광주통합특별시'],
  경상북도: ['경북', '경상북도'], 경상남도: ['경남', '경상남도'], 제주특별자치도: ['제주', '제주도', '제주특별자치도'],
};
const knownRegions = [...new Set([...Object.values(provinceKeywords).flat(), ...Object.values(DISTRICTS).flat().map(value => value.split(' ').at(-1)!)])];
const contains = (text: string, keyword: string): boolean => keyword === '광주' ? /광주($|[^시])/u.test(text) : text.includes(keyword);

/** Provider text is retained separately so compact catalog rows also search details omitted from display. */
export function noticeRegionSearchText(notice: BidNotice): string {
  return clean([
    notice.regionSearchText, notice.title, notice.agency, notice.demandAgency, notice.province, notice.district,
    ...(notice.allowedRegions ?? []), notice.description, ...notice.requirements, ...notice.documents.map(document => document.name),
    ...notice.licenses, notice.duration, notice.contractMethod, notice.noticeKind, notice.bidMethod, notice.category, notice.type,
  ].filter((value): value is string => typeof value === 'string').join(' '));
}

/** Discovery keywords deliberately do not establish the notice's site or participation eligibility. */
export function assessKeywordRegions(notice: BidNotice, regions: SearchRegion[]): RegionAssessment {
  if (!regions.length) return { status: 'matched', reason: '전체 지역을 검색합니다.' };
  if (notice.allowedRegions?.some(value => clean(value) === '전국')) return { status: 'matched', reason: '참가 가능 지역에 전국이 명시되어 있습니다. 실제 참가자격은 공고 원문을 확인해 주세요.' };
  const text = noticeRegionSearchText(notice);
  for (const region of regions) {
    const selected = normalizeSearchRegion(region);
    const leaf = clean(selected.locality || selected.district || '').split(' ').filter(Boolean).at(-1);
    const province = canonicalSearchProvince(selected.province);
    const keywords = leaf ? [leaf] : provinceKeywords[province ?? ''] ?? [clean(selected.province)].filter(Boolean);
    const found = keywords.find(keyword => leaf ? text.includes(keyword) : contains(text, keyword));
    if (found) return { status: 'matched', reason: `공고 전체 정보에서 지역명 '${found}'을 찾았습니다. 실제 현장과 참가자격은 공고 원문을 확인해 주세요.` };
  }
  return knownRegions.some(keyword => contains(text, keyword))
    ? { status: 'excluded', reason: '공고 전체 정보에서 선택한 지역명 키워드를 찾지 못했습니다.' }
    : { status: 'review', reason: '지역명 확인 필요: 공고 전체 정보에서 지역명을 찾지 못했습니다. 공고 원문을 확인해 주세요.' };
}

/** Company discovery keeps province-wide notices; detail eligibility still uses assessRegion. */
export function assessCompanyRegionKeywords(notice: BidNotice, profile: Pick<CompanyProfile, 'province'>): RegionAssessment {
  return profile.province.trim()
    ? assessKeywordRegions(notice, [{ province: profile.province }])
    : { status: 'review', reason: '업체 소재지 시·도를 확인해 주세요.' };
}
