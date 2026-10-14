import type { CompanyAward, CompanyAwardQuery } from '../company-award-types';

export interface AwardDateRange { from: string; to: string }

export function normalizeAwardDay(value: string | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  const day = /^\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(text) ? text.slice(0, 10)
    : /^\d{8}(?:$|[ T])/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : '';
  const time = Date.parse(`${day}T00:00:00Z`);
  return day && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? day : null;
}

/** Calendar-month slices, newest first, include both endpoints without gaps. */
export function splitCompanyAwardRange(from: string, to: string): AwardDateRange[] {
  const start = normalizeAwardDay(from), end = normalizeAwardDay(to);
  if (!start || !end || start > end) throw new Error('조회 시작일과 종료일을 확인해 주세요.');
  const slices: AwardDateRange[] = [];
  let last: string = end;
  for (;;) {
    const first: string = start > `${last.slice(0, 7)}-01` ? start : `${last.slice(0, 7)}-01`;
    slices.push({ from: first, to: last });
    if (first === start) break;
    const previous = new Date(`${first}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    last = previous.toISOString().slice(0, 10);
  }
  return slices;
}

export function companyAwardTaskKey(query: CompanyAwardQuery): string {
  return [query.businessNumber, query.type, query.from, query.to].join('|');
}

export function companyAwardTasks(businessNumber: string, from: string, to: string): CompanyAwardQuery[] {
  return splitCompanyAwardRange(from, to).flatMap(range => (['공사', '용역'] as const).map(type => ({ businessNumber, type, ...range })));
}

export function companyAwardKey(row: CompanyAward): string {
  return JSON.stringify([row.businessNumber, row.type, row.number || row.id, row.revision, row.classification, row.rebid]);
}

/** One company/notice/lot/round award remains one row even when ranges are retried. */
export function mergeCompanyAwards(...collections: CompanyAward[][]): CompanyAward[] {
  const unique = new Map<string, CompanyAward>();
  for (const collection of collections) for (const row of collection) unique.set(companyAwardKey(row), row);
  return [...unique.values()].sort((left, right) => right.awardDate.localeCompare(left.awardDate)
    || right.openingAt.localeCompare(left.openingAt) || right.number.localeCompare(left.number)
    || right.revision.localeCompare(left.revision) || left.classification.localeCompare(right.classification)
    || left.rebid.localeCompare(right.rebid) || left.businessNumber.localeCompare(right.businessNumber));
}
