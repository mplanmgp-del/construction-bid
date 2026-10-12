import type { BidNotice, CompanyProfile, RegionAssessment, SearchFilters } from './types';
import { DEMO_TODAY, DISTRICTS } from './data';

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
const canonicalProvince = (value: string) => provinceAliases[cleanText(value)] ?? null;

type ParsedRegion = { province: string; district: string | null } | { nationwide: true };

function parseRegion(value: string): ParsedRegion | null {
  const text = cleanText(value);
  if (text === '전국') return { nationwide: true };
  const province = canonicalProvince(text);
  if (province) return { province, district: null };
  const [first, ...rest] = text.split(' ');
  const qualifiedProvince = canonicalProvince(first);
  const district = rest.join(' ');
  if (qualifiedProvince && DISTRICTS[qualifiedProvince]?.includes(district)) {
    return { province: qualifiedProvince, district };
  }
  const candidates = Object.entries(DISTRICTS).filter(([, districts]) => districts.includes(text));
  if (candidates.length === 1) return { province: candidates[0][0], district: text };
  return null;
}

export function assessRegion(bid: BidNotice, profile: CompanyProfile): RegionAssessment {
  const province = canonicalProvince(profile.province);
  const district = cleanText(profile.district);
  if (!province || !district || !DISTRICTS[province]?.includes(district)) {
    return { status: 'review', reason: '업체의 본점 시·도와 시·군·구 정보가 누락되었거나 올바르지 않습니다. 업체정보를 확인해 주세요.' };
  }
  if (bid.specialRegionCondition) {
    return { status: 'review', reason: '공동수급 또는 별도 지역조건이 포함되어 있습니다. 원문 참가조건을 확인해 주세요.' };
  }
  if (!bid.allowedRegions?.length) {
    return { status: 'review', reason: '참가 가능 지역이 미제공되어 공고 원문 확인이 필요합니다.' };
  }
  const regions = bid.allowedRegions.map(parseRegion);
  if (regions.some(region => region === null)) {
    return { status: 'review', reason: '지역조건에 불명확한 내용이 포함되어 공고 원문 확인이 필요합니다.' };
  }
  for (const region of regions) {
    if (!region) continue;
    if ('nationwide' in region) {
      return { status: 'matched', reason: '참가 가능 지역이 전국으로 명시되어 있습니다. 다른 참가자격은 별도로 확인해 주세요.' };
    }
    if (region.province === province && (region.district === null || region.district === district)) {
      return { status: 'matched', reason: `본점 ${province} ${district}가 참가 가능 지역에 해당합니다. 다른 참가자격은 별도로 확인해 주세요.` };
    }
  }
  return { status: 'excluded', reason: `본점 ${province} ${district}가 명시된 참가 가능 지역과 일치하지 않습니다.` };
}

function amountBound(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  // 금액은 원 단위의 0 이상 정수만 허용합니다. 잘못된 입력을 무조건 필터 해제로 처리하지 않습니다.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return Number.NaN;
  const number = Number(text.replace(/,/g, ''));
  return Number.isSafeInteger(number) && number >= 0 ? number : Number.NaN;
}

export function getPriceRangeError(minimum: string, maximum: string): string | null {
  const lowerBound = amountBound(minimum);
  const upperBound = amountBound(maximum);
  if (Number.isNaN(lowerBound) || Number.isNaN(upperBound)) {
    return '금액은 0 이상의 원 단위 정수로 입력해 주세요. 쉼표는 세 자리마다 사용할 수 있습니다.';
  }
  if (lowerBound !== null && upperBound !== null && lowerBound > upperBound) {
    return '최소 금액은 최대 금액 이하로 입력해 주세요.';
  }
  return null;
}

function priceOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value: string): number {
  // 시간대가 없는 예시 입력도 한국 시간으로 해석하여 기기 환경에 따른 결과 차이를 방지합니다.
  const qualified = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+09:00`
    : /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}+09:00`;
  return Date.parse(qualified);
}

function koreanDate(value: string): string {
  const time = timestamp(value);
  return Number.isFinite(time) ? new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) : '';
}

export function filterNotices(notices: BidNotice[], filters: SearchFilters, profile: CompanyProfile): BidNotice[] {
  const minimum = amountBound(filters.minAmount);
  const maximum = amountBound(filters.maxAmount);
  if (Number.isNaN(minimum) || Number.isNaN(maximum) || (minimum !== null && maximum !== null && minimum > maximum)) return [];
  if (filters.deadlineFrom && filters.deadlineTo && filters.deadlineFrom > filters.deadlineTo) return [];
  const keyword = cleanText(filters.keyword).toLocaleLowerCase('ko-KR');
  const excludeKeywords = cleanText(filters.excludeKeyword).toLocaleLowerCase('ko-KR')
    .split(',').map(keyword => keyword.trim()).filter(Boolean);
  const siteProvince = filters.siteProvince === '전체' ? null : canonicalProvince(filters.siteProvince);

  return notices.filter(bid => {
    const searchText = cleanText(`${bid.title} ${bid.number} ${bid.agency}`).toLocaleLowerCase('ko-KR');
    if (keyword && !searchText.includes(keyword)) return false;
    if (excludeKeywords.some(keyword => searchText.includes(keyword))) return false;
    if (filters.category !== '전체' && bid.category !== filters.category) return false;
    if (filters.type !== '전체' && bid.type !== filters.type) return false;
    if (filters.siteProvince !== '전체' && (!siteProvince || canonicalProvince(bid.province) !== siteProvince)) return false;
    if (filters.license !== '전체' && !bid.licenses.includes(filters.license)) return false;
    if (filters.status !== '전체' && bid.status !== filters.status) return false;
    if (filters.contractMethod !== '전체' && bid.contractMethod !== filters.contractMethod) return false;
    const price = priceOrNull(bid.estimatedPrice);
    if ((minimum !== null || maximum !== null) && price === null) return false;
    if (price !== null && ((minimum !== null && price < minimum) || (maximum !== null && price > maximum))) return false;
    const deadlineDate = koreanDate(bid.deadline);
    if (filters.deadlineFrom && (!deadlineDate || deadlineDate < filters.deadlineFrom)) return false;
    if (filters.deadlineTo && (!deadlineDate || deadlineDate > filters.deadlineTo)) return false;
    const region = assessRegion(bid, profile).status;
    if (filters.regionView !== 'all') return region === filters.regionView;
    return !filters.autoRegion || region !== 'excluded';
  }).sort((a, b) => {
    if (filters.sort === 'amountAsc' || filters.sort === 'amountDesc') {
      const first = priceOrNull(a.estimatedPrice);
      const second = priceOrNull(b.estimatedPrice);
      if (first === null && second === null) return 0;
      if (first === null) return 1;
      if (second === null) return -1;
      return filters.sort === 'amountAsc' ? first - second : second - first;
    }
    const first = timestamp(filters.sort === 'newest' ? a.postedAt : a.deadline);
    const second = timestamp(filters.sort === 'newest' ? b.postedAt : b.deadline);
    if (!Number.isFinite(first) && !Number.isFinite(second)) return 0;
    if (!Number.isFinite(first)) return 1;
    if (!Number.isFinite(second)) return -1;
    return filters.sort === 'newest' ? second - first : first - second;
  });
}

export function formatPrice(value: number | null): string {
  const price = priceOrNull(value);
  return price === null ? '미제공' : `${price.toLocaleString('ko-KR')}원`;
}

export function daysUntil(deadline: string): number {
  const day = koreanDate(deadline);
  if (!day) return Number.NaN;
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${DEMO_TODAY}T00:00:00Z`)) / 86_400_000);
}

export function formatDateTime(value: string): string {
  const time = timestamp(value);
  if (!Number.isFinite(time)) return '일정 미제공';
  const koreanTime = new Date(time + 9 * 60 * 60 * 1000).toISOString();
  return `${koreanTime.slice(5, 10).replace('-', '.')} ${koreanTime.slice(11, 16)}`;
}
