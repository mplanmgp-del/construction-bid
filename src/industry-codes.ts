import type { BidNotice, CompanyProfile, RegionAssessment } from './types.ts';

/** Verified against the official G2B LicenseLimit response on 2026-10-16.
 * Keep this explicit: similar names and a broad engineering heading are not codes.
 * Source evidence: outputs/industry-codes-20261016/official-condition-rows.json.
 */
export const INDUSTRY_CODES = [
  { name: '구조물해체·비계공사업', code: '4995' },
  { name: '석면해체·제거업', code: '5652' },
  { name: '건축공사업', code: '0002' },
  { name: '실내건축공사업', code: '4990' },
  { name: '토목공사업', code: '0001' },
  { name: '도장·습식·방수·석공사업', code: '4992' },
  { name: '전기공사업', code: '0037' },
  { name: '정보통신공사업', code: '0036' },
  { name: '전문소방시설공사업', code: '0040' },
  { name: '기계설비·가스공사업', code: '6202' },
  { name: '조경식재·시설물공사업', code: '4993' },
  { name: '건설폐기물 수집·운반업', code: '6728' },
  { name: '건설폐기물 중간처리업', code: '1253' },
  { name: '건축사사무소', code: '4817' },
] as const;

const clean = (value: string) => value.normalize('NFKC').trim();
const nameKey = (value: string) => clean(value).replace(/[ㆍ・ᆞ.]/g, '·').replace(/\s+/g, '');
const knownNames = new Map<string, string>(INDUSTRY_CODES.map(item => [nameKey(item.name), item.code]));

/** Industry codes are strings, so 0042 never becomes 42. */
export function normalizeIndustryCode(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}$/.test(clean(value)) ? clean(value) : null;
}

/** Only structured provider/company suffixes and an exact four digit input qualify. */
export function industryCodeFromLabel(value: string): string | null {
  const text = clean(value);
  return normalizeIndustryCode(text)
    ?? text.match(/\/(\d{4})$/u)?.[1]
    ?? text.match(/\((\d{4})\)(?:\s*[·ㆍ・]\s*[^()]*)?$/u)?.[1]
    ?? null;
}

export function resolveIndustrySelection(value: string): string | null {
  return industryCodeFromLabel(value) ?? knownNames.get(nameKey(value)) ?? null;
}

export function resolveIndustrySelections(values: readonly string[]): { codes: string[]; unresolved: string[] } {
  const codes = new Set<string>(), unresolved: string[] = [];
  for (const value of values) {
    const code = resolveIndustrySelection(value);
    if (code) codes.add(code); else unresolved.push(value);
  }
  return { codes: [...codes].sort(), unresolved };
}

/** Notice facts never use name-to-code inference. An explicit array is authoritative. */
export function noticeIndustryCodes(notice: Pick<BidNotice, 'licenses' | 'licenseCodes'>): string[] {
  const values = notice.licenseCodes === undefined
    ? (Array.isArray(notice.licenses) ? notice.licenses.filter((value): value is string => typeof value === 'string').map(industryCodeFromLabel) : [])
    : (Array.isArray(notice.licenseCodes) ? notice.licenseCodes.map(normalizeIndustryCode) : []);
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}

export function companyIndustrySelections(profile: Pick<CompanyProfile, 'licenses' | 'licenseCodes'>): string[] {
  return profile.licenseCodes === undefined ? profile.licenses : Array.isArray(profile.licenseCodes)
    ? profile.licenseCodes.filter((value): value is string => typeof value === 'string') : [];
}

export function assessIndustryCodes(notice: Pick<BidNotice, 'licenses' | 'licenseCodes'> & { licenseComplete?: boolean }, values: readonly string[]): RegionAssessment {
  const requested = resolveIndustrySelections(values);
  const actual = noticeIndustryCodes(notice);
  if (requested.codes.some(code => actual.includes(code))) {
    return { status: 'matched', reason: '요구 업종코드 일치' };
  }
  if (!requested.codes.length || requested.unresolved.length) {
    return { status: 'review', reason: '선택한 업종의 공식 업종코드 확인 필요' };
  }
  if (!actual.length || notice.licenseComplete === false) {
    return { status: 'review', reason: '공고 업종코드 확인 필요' };
  }
  return { status: 'excluded', reason: '요구 업종코드가 선택한 업종코드와 다릅니다.' };
}

export function industrySelectionLabel(value: string): string {
  const code = resolveIndustrySelection(value);
  if (!code) return `${value} · 업종코드 확인 필요`;
  const known = INDUSTRY_CODES.find(item => item.code === code);
  return `${known?.name ?? value.replace(/\s*\(\d{4}\).*$/u, '')} (${code})`;
}
