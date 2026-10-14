import { createHash } from 'node:crypto';
import type { CompanyParticipationPage, CompanyParticipationQuery } from '../src/company-live-types.ts';
import { createArchivePageLoader } from './company-archive-page.ts';
import { CompanyLookupError } from './g2b-company.ts';
import type { RelatedRequest } from './g2b-related.ts';

export function validateCompanyParticipationQuery(query: CompanyParticipationQuery) {
  const date = Date.parse(`${query.day}T00:00:00Z`);
  if (!/^\d{10}$/.test(query.businessNumber) || !['공사', '용역'].includes(query.type)
    || !/^\d{4}-\d{2}-\d{2}$/.test(query.day) || !Number.isFinite(date)
    || new Date(date).toISOString().slice(0, 10) !== query.day
    || !Number.isSafeInteger(query.page) || query.page < 1 || query.page > 1_000_000) {
    throw new CompanyLookupError(400, 'INVALID_COMPANY_PARTICIPATION_QUERY', '사업자등록번호, 개찰일 또는 페이지를 확인해 주세요.');
  }
}

/**
 * Reads one official opening-date page directly. The shared source-page parser
 * performs no database reads/writes: despite its historical name, it only calls
 * the provider and validates public rows. Filter BEFORE constructing the client
 * response, so unrelated companies' bids and names never leave this endpoint.
 *
 * Official standard documentation v1.2 (2026-06) restricts the source to one
 * opening day. A monthly request is rejected upstream with result code 07.
 */
export function createCompanyParticipationLoader(request: RelatedRequest, now: () => number = Date.now) {
  const sourcePage = createArchivePageLoader(request, now);
  return async (query: CompanyParticipationQuery): Promise<CompanyParticipationPage> => {
    validateCompanyParticipationQuery(query);
    let source: Awaited<ReturnType<typeof sourcePage>>;
    try { source = await sourcePage({ type: query.type, day: query.day, page: query.page }); }
    catch (error) {
      if (error instanceof CompanyLookupError && error.code === 'G2B_ARCHIVE_INCOMPLETE') {
        throw new CompanyLookupError(502, 'G2B_PARTICIPATION_INCOMPLETE', '공식 입찰 참여 원본 페이지를 모두 확인하지 못했습니다. 해당 구간을 다시 조회해 주세요.');
      }
      throw error;
    }
    const notices = new Map(source.notices.map(notice => [notice.id, notice]));
    const items = source.entries.filter(entry => entry.business_number === query.businessNumber).map(entry => {
      const notice = notices.get(entry.notice_id);
      if (!notice) throw new CompanyLookupError(502, 'G2B_PARTICIPATION_INCOMPLETE', '입찰 참여 공고를 확인하지 못했습니다. 해당 구간을 다시 조회해 주세요.');
      return { id: `standard:${entry.id}`, businessNumber: query.businessNumber,
        number: notice.number, revision: notice.revision, type: notice.type, title: notice.title, agency: notice.agency,
        openingAt: notice.opening_at, biddingAt: entry.bidding_at, rank: entry.rank,
        participantCount: notice.participant_count, bidAmount: entry.bid_amount, bidRate: entry.bid_rate,
        awarded: entry.awarded, winningAmount: entry.winning_amount, method: notice.method,
        classification: '', rebid: '' };
    });
    const pageFingerprint = createHash('sha256').update(JSON.stringify([
      query.type, query.day, source.notices.map(notice => notice.id).sort(), source.entries.map(entry => entry.id).sort(),
    ])).digest('hex');
    return { ...query, items, pageSize: source.pageSize, sourceCount: source.sourceCount, totalCount: source.totalCount,
      hasMore: source.hasMore, complete: true, pageFingerprint, warnings: [], fetchedAt: source.fetchedAt,
      source: '나라장터 공공데이터개방표준서비스 · 업체별 참여 직접 조회' };
  };
}
