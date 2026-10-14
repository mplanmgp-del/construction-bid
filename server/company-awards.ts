import type { CompanyAward, CompanyAwardPage, CompanyAwardQuery } from '../src/company-award-types.ts';
import { CompanyLookupError } from './g2b-company.ts';
import type { RelatedRequest } from './g2b-related.ts';

const BASE = 'https://apis.data.go.kr/1230000/as/ScsbidInfoService/';
const PAGE_SIZE = 999;
type Row = Record<string, unknown>;
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const integer = (value: unknown): number | null => {
  const raw = text(value).replaceAll(',', '');
  return /^\d+(?:\.0+)?$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null;
};
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = (value: unknown): string => {
  const m = text(value).match(/^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?$/);
  if (!m) return '';
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+09:00`, ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms + 9 * 3600_000).toISOString().slice(0, 19) === iso.slice(0, 19) ? iso : '';
};
const business = (value: unknown) => text(value).replace(/[\s-]/g, '');
const ordinal = (value: unknown) => /^\d{1,10}$/.test(text(value)) ? String(Number(value)) : '';

export function validateCompanyAwardQuery(query: CompanyAwardQuery) {
  if (!/^\d{10}$/.test(query.businessNumber) || !['공사', '용역'].includes(query.type)) {
    throw new CompanyLookupError(400, 'INVALID_QUERY', '사업자등록번호 10자리와 업무 구분을 확인해 주세요.');
  }
  if (!validDay(query.from) || !validDay(query.to) || query.from > query.to || Date.parse(query.to) - Date.parse(query.from) >= 31 * 86400_000) {
    throw new CompanyLookupError(400, 'INVALID_DATE_RANGE', '개별 낙찰 조회 구간은 올바른 날짜로 최대 31일 이내여야 합니다.');
  }
}

function mapAward(row: Row, query: CompanyAwardQuery): CompanyAward | null {
  const number = text(row.bidNtceNo), ord = text(row.bidNtceOrd), classification = ordinal(row.bidClsfcNo), rebid = ordinal(row.rbidNo);
  if (business(row.bidwinnrBizno) !== query.businessNumber || !/^[A-Za-z0-9_-]{1,40}$/.test(number) || !/^\d{1,3}$/.test(ord) || !classification || !rebid) return null;
  const revision = ord.padStart(3, '0'), rate = text(row.sucsfbidRate), rawAwardDate = text(row.fnlSucsfDate);
  return {
    id: `award:${query.type}:${number}:${revision}:${classification}:${rebid}:${query.businessNumber}`,
    number, revision, type: query.type, businessNumber: query.businessNumber, classification, rebid,
    title: text(row.bidNtceNm), agency: text(row.dminsttNm) || text(row.ntceInsttNm),
    openingAt: timestamp(row.rlOpengDt), rank: '', participantCount: integer(row.prtcptCnum),
    // This endpoint publishes final award amounts/rates, not the full opening ranking or submitted bid amounts.
    bidAmount: null, bidRate: null,
    awardRate: /^\d+(?:\.\d+)?$/.test(rate) && Number.isFinite(Number(rate)) ? Number(rate) : null,
    awarded: true, winningAmount: integer(row.sucsfbidAmt), method: text(row.cntrctCnclsMthdNm),
    awardDate: validDay(rawAwardDate) ? rawAwardDate : timestamp(rawAwardDate),
  };
}

/** The official PPSSrch operation supports bizno. A monthly slice is server-filtered,
 * then checked again locally; no nationwide participant scan is performed here. */
export function createCompanyAwardsLoader(request: RelatedRequest, now = Date.now) {
  return async (query: CompanyAwardQuery): Promise<CompanyAwardPage> => {
    validateCompanyAwardQuery(query);
    const operation = query.type === '공사' ? 'getScsbidListSttusCnstwkPPSSrch' : 'getScsbidListSttusServcPPSSrch';
    const items: CompanyAward[] = [], seen = new Set<string>(), warnings: string[] = [];
    const finishBy = now() + 40_000;
    let totalCount = 0, complete = false, received = false;
    try {
      for (let page = 1; page <= 100; page++) {
        const remaining = finishBy - now();
        if (remaining <= 0) throw new CompanyLookupError(504, 'COMPANY_AWARDS_INCOMPLETE', '업체 낙찰 목록 조회를 완료하지 못했습니다.');
        const result = await request(BASE, operation, {
          inqryDiv: '2', bizno: query.businessNumber, inqryBgnDt: query.from.replaceAll('-', '') + '0000',
          inqryEndDt: query.to.replaceAll('-', '') + '2359', pageNo: String(page), numOfRows: String(PAGE_SIZE),
        }, Math.min(15_000, remaining));
        if (!Number.isSafeInteger(result.totalCount) || result.totalCount < 0 || (received && result.totalCount !== totalCount)) {
          throw new CompanyLookupError(502, 'COMPANY_AWARDS_CHANGED', '조회 중 낙찰 목록 건수가 변경되었습니다.');
        }
        totalCount = result.totalCount; received = true;
        if (result.items.length !== Math.min(PAGE_SIZE, Math.max(0, totalCount - (page - 1) * PAGE_SIZE))) {
          throw new CompanyLookupError(502, 'COMPANY_AWARDS_INCOMPLETE', '낙찰 목록과 전체 건수가 일치하지 않습니다.');
        }
        let invalid = false;
        for (const row of result.items) {
          const item = mapAward(row, query);
          if (!item) { invalid = true; continue; }
          if (seen.has(item.id)) throw new CompanyLookupError(502, 'COMPANY_AWARDS_INCOMPLETE', '낙찰 목록에서 중복된 공고·분류·재입찰 회차가 발견되었습니다.');
          seen.add(item.id); items.push(item);
        }
        // If the provider ignores the business filter, stop instead of scanning unrelated companies.
        if (invalid) throw new CompanyLookupError(502, 'COMPANY_AWARDS_INCOMPLETE', '요청 업체와 공고 식별자가 일치하지 않는 결과가 포함되어 있습니다.');
        if (page * PAGE_SIZE >= totalCount) { complete = true; break; }
      }
      if (!complete) warnings.push('이 구간의 낙찰 내역을 모두 확인하지 못했습니다. 다시 조회해 주세요.');
    } catch (error) {
      // Preserve provider errors on a wholly failed request; never disguise failure as a zero result.
      if (!received) throw error;
      warnings.push('이 구간의 낙찰 내역을 모두 확인하지 못했습니다. 확인된 내역만 표시합니다. 다시 조회해 주세요.');
    }
    items.sort((a, b) => b.openingAt.localeCompare(a.openingAt) || a.id.localeCompare(b.id));
    return { ...query, items, totalCount, complete, warnings, fetchedAt: new Date(now()).toISOString(), source: '나라장터 낙찰정보서비스 · 업체별 최종 낙찰' };
  };
}
