import type { G2bDetailField, G2bDetailSection, G2bNoticeDetail, G2bRelatedDetail } from '../g2b-types';
import type { BidNotice } from '../types';

export interface PrintField { label: string; value: string }
export interface PrintSection { id: string; title: string; fields: PrintField[] }
export interface NoticePrintDocument {
  title: string;
  number: string;
  summary: PrintField[];
  sections: PrintSection[];
  documents: string[];
  filename: string;
}

const placeholders = new Set(['미제공', '정보 미제공', '일정 미제공', '링크 미제공', '-', '–', '—', '조회 불가', '공개 내역 없음']);
const presentationOnlyKeys = new Set(['lookupPeriod', 'partyListStatus']);
const insuranceBasis = [
  '국민연금보험료', '국민건강보험료', '퇴직공제부금비', '노인장기요양보험료',
  '산업안전보건관리비', '안전관리비', '품질관리비',
].join(' + ');

function provided(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && !placeholders.has(trimmed.replace(/\s+/g, ' ')) ? trimmed : null;
}

function printField(label: string, value: string | null | undefined): PrintField[] {
  const actual = provided(value);
  return actual === null ? [] : [{ label, value: actual }];
}

function projectFields(fields: G2bDetailField[]): PrintField[] {
  return fields.flatMap(field => {
    if (presentationOnlyKeys.has(field.key)) return [];
    const result = printField(field.label, field.value);
    // This calculation is not the official A value. Keep its basis as data,
    // while omitting display notes, provider warnings and empty-state guidance.
    if (result.length && field.key === 'insuranceManagementSum') {
      result.push({ label: '합계 산출 근거', value: insuranceBasis });
    }
    return result;
  });
}

function amount(value: number | null): string | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? `${value.toLocaleString('ko-KR')} 원` : null;
}

function date(value: string): string | null {
  if (!provided(value)) return null;
  // Preserve the year and normalize explicit time zones to Korea time.
  const qualified = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value
    : /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+09:00` : `${value.replace(' ', 'T')}+09:00`;
  const time = Date.parse(qualified);
  return Number.isFinite(time) ? new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ') : null;
}

function fallbackSections(bid: BidNotice, detail: G2bNoticeDetail): G2bDetailSection[] {
  const field = (key: string, label: string, value: string | null): G2bDetailField => ({ key, label, value });
  return [
    { id: 'general', label: '공고 일반', fields: [
      field('noticeNumber', '입찰공고번호', `${bid.number}-${bid.revision}`),
      field('bidNtceNm', '공고명', bid.title), field('ntceInsttNm', '공고 기관', bid.agency),
      field('businessType', '업무 구분', bid.type), field('cntrctCnclsMthdNm', '계약 방법', bid.contractMethod),
      field('bidNtceDt', '게시 일시', date(bid.postedAt)),
    ] },
    { id: 'schedule', label: '입찰 진행 정보', fields: [
      field('bidQlfctRgstDt', '입찰참가자격 등록 마감', date(bid.registrationDeadline)),
      field('bidClseDt', '입찰 마감', date(bid.deadline)), field('opengDt', '개찰 일시', date(bid.openingAt)),
    ] },
    { id: 'eligibility', label: '투찰 제한', fields: [
      field('allowedRegions', '참가 가능 지역', detail.allowedRegions?.map(provided).filter(Boolean).join(' · ') || null),
      field('licenses', '제한 업종·면허', detail.licenses.map(provided).filter(Boolean).join(' · ') || null),
    ] },
    { id: 'pricing', label: '예정가격·입찰금액', fields: [field('presmptPrce', '추정가격', amount(bid.estimatedPrice))] },
  ];
}

function assertIdentity(bid: BidNotice, candidate: { number: string; revision: string; type?: string }): void {
  if (candidate.number !== bid.number || candidate.revision !== bid.revision || (candidate.type !== undefined && candidate.type !== bid.type)) {
    throw new Error('인쇄할 공고번호·차수·업무 구분이 조회 자료와 일치하지 않습니다.');
  }
}

/** Creates a fresh full-data print projection, independently of screen filters. */
export function buildNoticePrintDocument(bid: BidNotice, detail: G2bNoticeDetail, related?: G2bRelatedDetail | null): NoticePrintDocument {
  assertIdentity(bid, detail);
  if (detail.notice) assertIdentity(bid, detail.notice);
  if (related) assertIdentity(bid, related);
  const notice = detail.notice ?? bid;
  const sourceSections = detail.sections?.length ? detail.sections : fallbackSections(notice, detail);
  const findValue = (key: string) => provided(sourceSections.flatMap(section => section.fields).find(field => field.key === key)?.value);
  const number = `${bid.number}-${bid.revision}`;
  const title = provided(notice.title) ?? findValue('bidNtceNm') ?? number;
  const summary: PrintField[] = [
    ...printField('추정가격', findValue('presmptPrce') ?? amount(notice.estimatedPrice)),
    ...printField('입찰 마감', findValue('bidClseDt') ?? date(notice.deadline)),
    ...printField('개찰 일시', findValue('opengDt') ?? date(notice.openingAt)),
    ...printField('공고 기관', findValue('ntceInsttNm') ?? notice.agency),
  ];
  const sections: PrintSection[] = sourceSections.map(section => ({
    id: section.id, title: section.label, fields: projectFields(section.fields),
  })).filter(section => section.fields.length > 0);
  for (const group of related?.groups ?? []) {
    // Partial groups can have valid records even if another lookup failed.
    for (const [index, record] of group.records.entries()) {
      const fields = projectFields(record.fields);
      if (!fields.length) continue;
      const recordTitle = provided(record.title);
      sections.push({
        id: `related-${group.id}-${record.id}-${index}`,
        title: recordTitle && recordTitle !== group.label ? `${group.label} · ${recordTitle}` : group.label,
        fields,
      });
    }
  }
  const documents = notice.documents.map(document => provided(document.name)).filter((name): name is string => name !== null);
  const safeTitle = title.replace(/[<>:"/\\|?*\u0000-\u001F\u007F]/g, '_').replace(/[. ]+$/, '').slice(0, 80);
  return { title, number, summary, sections, documents, filename: `${safeTitle || '입찰공고'}_${number}.pdf` };
}
