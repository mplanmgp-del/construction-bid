import type { BidNotice } from '../src/types.ts';
import type { G2bBusinessType, G2bDetailField, G2bDetailSection } from '../src/g2b-types.ts';
import { mapNotice, money } from './g2b.ts';

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

export const PRIVATE_BID_BASE = 'https://apis.data.go.kr/1230000/ao/PrvtBidNtceService/';
// Official reference: data.go.kr/data/15129456/openapi.do (reference DOCX).
// These divisions differ from both public notices and private PPSSrch operations.
export const PRIVATE_NOTICE_DIVISIONS = { registered: '1', posted: '2', opening: '3', number: '4' } as const;
export const PRIVATE_SEARCH_DIVISIONS = { posted: '1', opening: '2' } as const;
export const PRIVATE_CONDITION_DIVISIONS = { registered: '1', number: '2' } as const;
export function privateNoticeOperation(type: G2bBusinessType, search = false): string {
  return `getPrvtBidPblancListInfo${type === '공사' ? 'Cnstwk' : 'Servc'}${search ? 'PPSSrch' : ''}`;
}
export function privateConditionParams(number: string, revision: string): Record<string, string> {
  return { inqryDiv: PRIVATE_CONDITION_DIVISIONS.number, bidNtceNo: number, bidNtceOrd: revision, pageNo: '1', numOfRows: '999' };
}
export function matchesPrivateNotice(row: Row, number: string, type: G2bBusinessType): boolean {
  return text(row.bidNtceNo) === number && /^\d{1,3}$/.test(text(row.bidNtceOrd))
    && (type === '공사' ? text(row.bidNtceClsfc) === '민간공사' : ['민간일반용역', '민간기술용역'].includes(text(row.bidNtceClsfc)));
}

/** Private field allowlist: a reference amount is never a public estimated/base price. */
export function mapPrivateNotice(row: Row, type: G2bBusinessType, now = Date.now()): BidNotice {
  const normalized: Row = {
    bidNtceNo: row.bidNtceNo, bidNtceOrd: row.bidNtceOrd, bidNtceNm: row.ntceNm,
    ntceInsttNm: row.ntceInsttNm, ntceKindNm: row.ntceDivNm, cntrctCnclsMthdNm: row.cntrctMthdNm,
    bidNtceDt: row.nticeDt, bidBeginDt: row.bidBeginDt, bidClseDt: row.bidClseDt, opengDt: row.opengDt,
    rgstDt: row.rgstDt, bdgtAmt: row.asignBdgtAmt,
  };
  for (let index = 1; index <= 10; index++) {
    normalized[`ntceSpecFileNm${index}`] = row[`ntceSpecDocNm${index}`];
    normalized[`ntceSpecDocUrl${index}`] = row[`ntceSpecDocUrl${index}`];
  }
  const notice = mapNotice(normalized, type, now);
  return { ...notice, procurementSource: 'private', bidMethod: text(row.bidMethdNm),
    description: '누리장터 민간 입찰공고입니다. 제출 방법과 참가조건은 첨부파일 또는 나라장터의 누리장터 민간입찰 메뉴에서 공고번호로 조회해 확인해 주세요.',
    requirements: [...notice.requirements, ...[text(row.bidQlfctNm), text(row.rgnLmtDivNm)].filter(Boolean)],
    // This service does not supply a notice detail URL. Its authenticated
    // document URLs are preserved above; do not invent a public-notice route.
    detailUrl: 'https://www.g2b.go.kr/',
  };
}

/** Keep private labels and money semantics; omit public base-price/A-value sections. */
export function mapPrivateDetailSections(row: Row, regionRows: Row[], licenseRows: Row[]): G2bDetailSection[] {
  const s = (key: string, label: string, wide = false): G2bDetailField => ({ key, label, value: text(row[key]) || null, ...(wide ? { wide } : {}) });
  const m = (key: string, label: string): G2bDetailField => {
    const amount = money(row[key]);
    return { key, label, value: amount === null ? null : `${amount.toLocaleString('ko-KR')} 원` };
  };
  const joined = (items: Row[], key: string) => [...new Set(items.map(item => text(item[key])).filter(Boolean))].join(' · ') || null;
  return [
    { id: 'general', label: '민간 공고 일반', fields: [
      { key: 'procurementSource', label: '공고 출처', value: '누리장터 민간입찰' },
      s('bidNtceClsfc', '입찰공고 분류'), s('ntceDivNm', '공고 종류'),
      { key: 'noticeNumber', label: '입찰공고번호', value: `${text(row.bidNtceNo)}-${text(row.bidNtceOrd).padStart(3, '0')}` },
      s('refNo', '참조번호'), s('ntceNm', '공고명', true), s('ntceInsttNm', '공고 기관'),
      s('nticeDt', '게시 일시'), s('rgstDt', '등록 일시'), s('bidMethdNm', '입찰 방식'),
      s('cntrctMthdNm', '계약 방법'), s('sucsfbidMthdNm', '낙찰 방법'), s('rbidDivNm', '재입찰 구분'),
    ] },
    { id: 'schedule', label: '입찰 진행 정보', fields: [
      s('bidBeginDt', '입찰 개시'), s('bidClseDt', '입찰 마감'), s('opengDt', '개찰 일시'), s('opengPlce', '개찰 장소'),
      s('bidWgrnteeRcptClseDt', '입찰보증서 접수 마감'), s('sptDscrptDt', '현장설명 일시'), s('sptDscrptPlce', '현장설명 장소'),
    ] },
    { id: 'eligibility', label: '참가조건', fields: [
      s('bidQlfctNm', '입찰 자격'), s('rgnLmtDivNm', '지역 제한 구분'),
      { key: 'allowedRegions', label: '참가 가능 지역', value: joined(regionRows, 'prtcptPsblRgnNm'), wide: true },
      { key: 'licenses', label: '제한 업종·면허', value: joined(licenseRows, 'lcnsLmtNm'), wide: true },
      { key: 'permittedIndustries', label: '허용 업종', value: joined(licenseRows, 'permsnIndstrytyList'), wide: true },
      s('cnstwkDtlList', '공사 상세 목록', true), s('servcDtlList', '용역 상세 목록', true),
    ] },
    { id: 'privatePricing', label: '민간 공고 금액', fields: [
      s('refAmtUseYn', '기준금액 사용 여부'), s('refAmtOpenYn', '기준금액 공개 여부'),
      { ...m('refAmt', '기준금액'), note: '민간 공고의 기준금액입니다. 공공입찰 추정가격·기초금액과 구분됩니다.' },
      m('asignBdgtAmt', '배정예산금액'), s('vatInclsnYnNm', '부가가치세 포함 여부'), s('refAmtDscrpt', '기준금액 설명', true),
    ] },
    { id: 'contacts', label: '공고 담당자', fields: [s('ofclNm', '담당자'), s('ofclTelNo', '전화'), s('ofclEmail', '이메일')] },
  ];
}
