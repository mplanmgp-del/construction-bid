import { createHash } from 'node:crypto';
import type { RelatedRequest } from './g2b-related.ts';
import { CompanyLookupError } from './g2b-company.ts';

const STANDARD_BASE = 'https://apis.data.go.kr/1230000/ao/PubDataOpnStdService/';
const PAGE_SIZE = 999;
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const fail = (message: string): never => { throw new CompanyLookupError(502, 'G2B_ARCHIVE_INCOMPLETE', message); };
function numeric(value: unknown, integer: boolean): number | null {
  const raw = text(value).replaceAll(',', '');
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const result = Number(raw);
  return Number.isFinite(result) && result >= 0 && (integer ? Number.isSafeInteger(result) : true) ? result : null;
}
function dayValue(value: unknown): string {
  const raw = text(value);
  const match = raw.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!match) return '';
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const stamp = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === day ? day : '';
}
function koreanDateTime(day: unknown, time: unknown): string {
  const date = dayValue(day);
  const match = text(time).match(/^(\d{2}):?(\d{2})(?::?(\d{2}))?$/);
  if (!date || !match || +match[1] > 23 || +match[2] > 59 || +(match[3] || 0) > 59) return '';
  return `${date}T${match[1]}:${match[2]}:${match[3] || '00'}+09:00`;
}

export interface ArchivePageQuery { type: '공사' | '용역'; day: string; page: number }
export interface ArchiveNotice {
  id: string; number: string; revision: string; type: '공사' | '용역'; title: string; agency: string;
  opening_at: string; method: string; participant_count: number | null;
}
export interface ArchiveEntry {
  id: string; notice_id: string; business_number: string; bidding_at: string;
  bid_amount: number | null; bid_rate: number | null; rank: string; awarded: boolean | null;
  winning_amount: number | null; updated_at: string;
}
export interface CompanyArchivePage extends ArchivePageQuery {
  pageSize: number; totalCount: number; sourceCount: number; hasMore: boolean; fetchedAt: string;
  companies: { business_number: string; name: string; updated_at: string }[];
  notices: ArchiveNotice[]; entries: ArchiveEntry[];
}

/**
 * This standard dataset has no bid classification / rebid identifiers. Submission timestamps
 * preserve distinguishable rounds; ambiguous duplicate identities fail rather than silently
 * collapsing lots. It covers public opening results, not contracts without tender participation.
 */
export function createArchivePageLoader(request: RelatedRequest, now: () => number = Date.now) {
  // Detect a provider that ignores pageNo within a running ingestion client. The durable
  // ingestion transaction must also check repeated identities across process restarts.
  const fingerprints = new Map<string, { page: number; at: number }>();
  return async (query: ArchivePageQuery): Promise<CompanyArchivePage> => {
    if (!['공사', '용역'].includes(query.type) || dayValue(query.day) !== query.day || !Number.isSafeInteger(query.page) || query.page < 1 || query.page > 1_000_000) {
      throw new CompanyLookupError(400, 'INVALID_ARCHIVE_QUERY', '업무 구분, 조회일 또는 페이지가 올바르지 않습니다.');
    }
    const compactDay = query.day.replaceAll('-', '');
    const result = await request(STANDARD_BASE, 'getDataSetOpnStdScsbidInfo', {
      bsnsDivCd: query.type === '공사' ? '3' : '5', opengBgnDt: `${compactDay}0000`, opengEndDt: `${compactDay}2359`,
      pageNo: String(query.page), numOfRows: String(PAGE_SIZE),
    }, 25_000);
    const { totalCount, items } = result;
    if (!Number.isSafeInteger(totalCount) || totalCount < 0 || items.length !== Math.max(0, Math.min(PAGE_SIZE, totalCount - (query.page - 1) * PAGE_SIZE))) {
      fail('개찰 자료의 전체 건수와 페이지 응답 건수가 일치하지 않습니다. 수집을 다시 시도해 주세요.');
    }
    const fetchedAt = new Date(now()).toISOString();
    const companies = new Map<string, CompanyArchivePage['companies'][number]>();
    const notices = new Map<string, ArchiveNotice>();
    const entries = new Map<string, ArchiveEntry>();
    for (const row of items) {
      if (text(row.bsnsDivNm) && text(row.bsnsDivNm) !== query.type) fail('다른 업무의 개찰 자료가 포함되어 수집을 중단했습니다.');
      const number = text(row.bidNtceNo);
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(number)) fail('공고번호가 누락되었거나 형식이 올바르지 않아 이 페이지의 참여 자료를 모두 확인하지 못했습니다.');
      const revisionRaw = text(row.bidNtceOrd);
      if (!/^\d{1,3}$/.test(revisionRaw)) fail('공고 차수를 확인할 수 없어 수집을 중단했습니다.');
      const revision = revisionRaw.padStart(3, '0');
      const openingAt = koreanDateTime(row.opengDate, row.opengTm);
      if (!openingAt || openingAt.slice(0, 10) !== query.day) fail('요청일과 개찰일시가 일치하지 않아 수집을 중단했습니다.');
      const noticeId = hash([query.type, number, revision, openingAt]);
      notices.set(noticeId, { id: noticeId, number, revision, type: query.type, title: text(row.bidNtceNm),
        agency: text(row.dmndInsttNm) || text(row.ntceInsttNm), opening_at: openingAt,
        method: text(row.cntrctCnclsMthdNm), participant_count: null });
      const businessNumber = text(row.bidprcCorpBizrno);
      if (!businessNumber) continue;
      if (!/^\d{10}$/.test(businessNumber)) fail('업체 사업자등록번호를 확인할 수 없어 수집을 중단했습니다.');
      const biddingAt = koreanDateTime(row.bidprcDate, row.bidprcTm);
      if ((text(row.bidprcDate) || text(row.bidprcTm)) && !biddingAt) fail('투찰일시를 확인할 수 없어 수집을 중단했습니다.');
      const bidAmount = numeric(row.bidprcAmt, true);
      if (text(row.bidprcAmt) && bidAmount === null) fail('투찰금액을 확인할 수 없어 수집을 중단했습니다.');
      const id = hash([query.type, number, revision, businessNumber, openingAt, biddingAt, bidAmount]);
      if (entries.has(id)) fail('구분할 수 없는 중복 투찰 자료가 포함되어 수집을 중단했습니다.');
      const awarded = row.sucsfYn === 'Y' ? true : row.sucsfYn === 'N' ? false : null;
      entries.set(id, { id, notice_id: noticeId, business_number: businessNumber, bidding_at: biddingAt,
        bid_amount: bidAmount, bid_rate: numeric(row.bidprcRt, false), rank: text(row.opengRank), awarded,
        winning_amount: awarded === true ? numeric(row.fnlSucsfAmt, true) : null, updated_at: fetchedAt });
      companies.set(businessNumber, { business_number: businessNumber, name: text(row.bidprcCorpNm), updated_at: fetchedAt });
    }
    if (items.length && !notices.size) fail('공고번호가 없는 개찰 자료만 반환되어 수집을 중단했습니다.');
    if (items.length) {
      const fingerprint = `${query.type}:${query.day}:${hash([[...notices.keys()].sort(), [...entries.keys()].sort()])}`;
      const previous = fingerprints.get(fingerprint);
      if (previous && now() - previous.at < 300_000 && previous.page !== query.page) fail('다른 페이지에 동일한 개찰 자료가 반복되어 수집을 중단했습니다.');
      fingerprints.set(fingerprint, { page: query.page, at: now() });
      while (fingerprints.size > 128) fingerprints.delete(fingerprints.keys().next().value!);
    }
    return { ...query, pageSize: PAGE_SIZE, totalCount, sourceCount: items.length,
      hasMore: query.page * PAGE_SIZE < totalCount, fetchedAt,
      companies: [...companies.values()], notices: [...notices.values()], entries: [...entries.values()] };
  };
}
