import type { BidNotice, CompanyProfile, RegionAssessment, SearchFilters, SearchRegion } from './types.ts';
import { DEMO_TODAY, DISTRICTS } from './data.ts';
import { assessCompanyRegionKeywords, assessKeywordRegions } from './region-keywords.ts';
import { noticeState } from './notice-status.ts';
import { canonicalProvince, selectedRegions, selectedStatuses } from './search-filters.ts';

const cleanText = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const canonicalLicense = (value: string) => cleanText(value.replace(/[ㆍ・ᆞ]/g, '·')).replace(/\/\d+$/, '').replace(/\s+/g, '');

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
  if (!bid.allowedRegions?.length) {
    return { status: 'review', reason: '참가 가능 지역이 미제공되어 공고 원문 확인이 필요합니다.' };
  }
  const regions = bid.allowedRegions.map(parseRegion);
  if (regions.some(region => region === null)) {
    return { status: 'review', reason: '지역조건에 불명확한 내용이 포함되어 공고 원문 확인이 필요합니다.' };
  }
  // The badge compares geography only. Additional terms do not cancel an explicit regional match.
  const participationNote = bid.specialRegionCondition
    ? ' 공동수급·지사 등 별도 참가조건은 원문에서 확인해 주세요.'
    : ' 다른 참가자격은 별도로 확인해 주세요.';
  for (const region of regions) {
    if (!region) continue;
    if ('nationwide' in region) {
      return { status: 'matched', reason: `참가 가능 지역이 전국으로 명시되어 있습니다.${participationNote}` };
    }
    if (region.province === province && (region.district === null || region.district === district)) {
      return { status: 'matched', reason: `본점 ${province} ${district}가 참가 가능 지역에 해당합니다.${participationNote}` };
    }
  }
  if (bid.specialRegionCondition) {
    return { status: 'review', reason: '공동수급 또는 별도 지역조건이 포함되어 있습니다. 원문 참가조건을 확인해 주세요.' };
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

/** Search every available notice text field for the selected region names. */
export const assessSearchRegions = assessKeywordRegions;
/** Retain the single-province API for existing saved searches and callers. */
export function assessSearchRegion(bid: BidNotice, selectedProvince: string): RegionAssessment {
  return assessSearchRegions(bid, [{ province: selectedProvince }]);
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

export function filterNotices(notices: BidNotice[], filters: SearchFilters, profile: CompanyProfile, now = Date.now()): BidNotice[] {
  const minimum = amountBound(filters.minAmount);
  const maximum = amountBound(filters.maxAmount);
  if (Number.isNaN(minimum) || Number.isNaN(maximum) || (minimum !== null && maximum !== null && minimum > maximum)) return [];
  if (filters.deadlineFrom && filters.deadlineTo && filters.deadlineFrom > filters.deadlineTo) return [];
  const keyword = cleanText(filters.keyword).toLocaleLowerCase('ko-KR');
  const excludeKeywords = cleanText(filters.excludeKeyword).toLocaleLowerCase('ko-KR')
    .split(',').map(keyword => keyword.trim()).filter(Boolean);

  const regions = selectedRegions(filters);
  const statuses = selectedStatuses(filters);
  const deadlinePriority = (bid: BidNotice) => {
    const phase = noticeState(bid, now).label;
    if (phase === '마감 임박') return 0;
    if (phase === '진행중') return timestamp(bid.deadline) > now ? 1 : 2;
    return phase === '예정' ? 3 : 4;
  };

  return notices.filter(bid => {
    const searchText = cleanText(`${bid.title} ${bid.number} ${bid.agency}`).toLocaleLowerCase('ko-KR');
    if (keyword && !searchText.includes(keyword)) return false;
    if (excludeKeywords.some(keyword => searchText.includes(keyword))) return false;
    if (filters.category !== '전체' && bid.category !== filters.category) return false;
    if (filters.type !== '전체' && bid.type !== filters.type) return false;
    if (regions.length) {
      const assessment = assessSearchRegions(bid, regions).status;
      if (assessment === 'excluded' || assessment === 'review' && filters.regions !== undefined && !filters.includeUnknownRegions) return false;
    }
    if (filters.license !== '전체' && !bid.licenses.some(license => canonicalLicense(license) === canonicalLicense(filters.license))) return false;
    if (statuses.length && !statuses.some(status => noticeState(bid, now).label === status)) return false;
    if (filters.contractMethod !== '전체' && bid.contractMethod !== filters.contractMethod) return false;
    const price = priceOrNull(bid.estimatedPrice);
    if ((minimum !== null || maximum !== null) && price === null) return false;
    if (price !== null && ((minimum !== null && price < minimum) || (maximum !== null && price > maximum))) return false;
    const deadlineDate = koreanDate(bid.deadline);
    if (filters.deadlineFrom && (!deadlineDate || deadlineDate < filters.deadlineFrom)) return false;
    if (filters.deadlineTo && (!deadlineDate || deadlineDate > filters.deadlineTo)) return false;
    const region = assessCompanyRegionKeywords(bid, profile).status;
    if (filters.regionView !== 'all') return region === filters.regionView;
    return !filters.autoRegion || region === 'matched';
  }).sort((a, b) => {
    if (filters.sort === 'amountAsc' || filters.sort === 'amountDesc') {
      const first = priceOrNull(a.estimatedPrice);
      const second = priceOrNull(b.estimatedPrice);
      if (first === null && second === null) return 0;
      if (first === null) return 1;
      if (second === null) return -1;
      return filters.sort === 'amountAsc' ? first - second : second - first;
    }
    if (filters.sort === 'deadline') {
      const priority = deadlinePriority(a) - deadlinePriority(b);
      if (priority) return priority;
    }
    const first = timestamp(filters.sort === 'newest' ? a.postedAt : a.deadline);
    const second = timestamp(filters.sort === 'newest' ? b.postedAt : b.deadline);
    if (!Number.isFinite(first) && !Number.isFinite(second)) return 0;
    if (!Number.isFinite(first)) return 1;
    if (!Number.isFinite(second)) return -1;
    const order = filters.sort === 'newest' ? second - first : first - second;
    if (order || filters.sort === 'newest') return order;
    const firstPosted = timestamp(a.postedAt);
    const secondPosted = timestamp(b.postedAt);
    if (Number.isFinite(firstPosted) !== Number.isFinite(secondPosted)) return Number.isFinite(firstPosted) ? -1 : 1;
    if (Number.isFinite(firstPosted) && firstPosted !== secondPosted) return secondPosted - firstPosted;
    return a.type < b.type ? -1 : a.type > b.type ? 1 : a.number < b.number ? -1 : a.number > b.number ? 1 : 0;
  });
}

export function formatPrice(value: number | null): string {
  const price = priceOrNull(value);
  return price === null ? '미제공' : `${price.toLocaleString('ko-KR')}원`;
}

export function formatAmountInput(value: string): string {
  const digits = value.trim().replaceAll(',', '');
  // 문자열로 묶어 큰 금액의 자릿수를 보존하고, 잘못된 입력은 검증 안내에 남깁니다.
  return /^\d*$/.test(digits) ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : value;
}

export function buildBidCsv(notices: BidNotice[]): string {
  const rows = [['공고번호', '공고명', '발주기관', '공사 위치', '참가 가능 지역', '계약방법', '추정가격(원)', '제출 마감'],
    ...notices.map(bid => [bid.number, bid.title, bid.agency, `${bid.province} ${bid.district}`,
      bid.allowedRegions?.join(' · ') || '원문 확인', bid.contractMethod,
      formatPrice(bid.estimatedPrice).replace(/원$/, ''), bid.deadline])];
  // Public titles and agency names are untrusted text; Excel must not interpret them as formulas.
  const safeCell = (value: string) => /^[\s]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return '\uFEFF' + rows.map(row => row.map(value => '"' + safeCell(value).replaceAll('"', '""') + '"').join(',')).join('\r\n');
}

export function daysUntil(deadline: string, today: string = DEMO_TODAY): number {
  const day = koreanDate(deadline);
  if (!day) return Number.NaN;
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export function formatDateTime(value: string, { includeYear = false }: { includeYear?: boolean } = {}): string {
  const time = timestamp(value);
  if (!Number.isFinite(time)) return '일정 미제공';
  const koreanTime = new Date(time + 9 * 60 * 60 * 1000).toISOString();
  return `${koreanTime.slice(includeYear ? 0 : 5, 10).replaceAll('-', '.')} ${koreanTime.slice(11, 16)}`;
}
