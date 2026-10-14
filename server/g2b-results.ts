import type { G2bResultSummary } from '../src/g2b-types.ts';
import type { NoticeOpeningResults, OpeningResultGroup, OpeningResultsQuery } from '../src/opening-result-types.ts';
import type { RelatedRequest } from './g2b-related.ts';

type Row = Record<string, unknown>;
type Collected = { rows: Row[]; complete: boolean; warnings: string[]; error?: unknown; pageLimitExceeded?: boolean };
const BASE = 'https://apis.data.go.kr/1230000/as/ScsbidInfoService/';
const PAGE_SIZE = 999;
const MAX_PAGES = 100;
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const integer = (value: unknown): number | null => {
  const raw = text(value).replaceAll(',', '');
  const n = Number(raw);
  return /^\d+(?:\.0+)?$/.test(raw) && Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const rate = (value: unknown): number | null => /^\d+(?:\.\d+)?$/.test(text(value)) && Number.isFinite(Number(value)) ? Number(value) : null;
const business = (value: unknown): string => /^\d{10}$/.test(text(value).replaceAll('-', '')) ? text(value).replaceAll('-', '') : '';
const timestamp = (value: unknown): string => {
  const m = text(value).match(/^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?$/);
  if (!m) return '';
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+09:00`, ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms + 9 * 3600_000).toISOString().slice(0, 19) === iso.slice(0, 19) ? iso : '';
};
// Canonicalize zero padding, while refusing to merge rows missing a lot or rebid identity.
const ordinal = (value: unknown): string => /^\d{1,10}$/.test(text(value)) ? String(Number(value)) : '';
const groupIdentity = (row: Row) => {
  const classification = ordinal(row.bidClsfcNo), rebid = ordinal(row.rbidNo);
  return classification && rebid ? `${classification}:${rebid}` : '';
};
export class OpeningResultsError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function validate(query: OpeningResultsQuery) {
  if (!/^[A-Za-z0-9]{8,20}$/.test(query.number) || !/^\d{3}$/.test(query.revision) || !['공사', '용역'].includes(query.type)) {
    throw new OpeningResultsError(400, 'INVALID_QUERY', '공고번호, 차수 또는 업무 구분이 올바르지 않습니다.');
  }
}
const exact = (row: Row, q: OpeningResultsQuery) => text(row.bidNtceNo) === q.number
  && /^\d{1,3}$/.test(text(row.bidNtceOrd)) && text(row.bidNtceOrd).padStart(3, '0') === q.revision;

/** The newly approved service supports exact notice lookup: no date-wide participant scans. */
function collector(request: RelatedRequest, now: () => number, q: OpeningResultsQuery, finishBy: number, maxPages = MAX_PAGES) {
  return async (operation: string, label: string, byDivision = false): Promise<Collected> => {
    const rows: Row[] = [], seen = new Set<string>();
    let total: number | undefined;
    try {
      for (let page = 1; page <= maxPages; page++) {
        const remaining = finishBy - now();
        if (remaining <= 0) throw new OpeningResultsError(504, 'OPENING_INCOMPLETE', '결과 조회를 모두 완료하지 못했습니다.');
        const result = await request(BASE, operation, {
          ...(byDivision ? { inqryDiv: '4' } : {}), bidNtceNo: q.number, bidNtceOrd: q.revision,
          pageNo: String(page), numOfRows: String(PAGE_SIZE),
        }, Math.min(15_000, remaining));
        if (!Number.isSafeInteger(result.totalCount) || result.totalCount < 0 || (total !== undefined && total !== result.totalCount)) {
          throw new OpeningResultsError(502, 'OPENING_CHANGED', '조회 중 공개 결과 건수가 변경되었습니다.');
        }
        total = result.totalCount;
        const expected = Math.min(PAGE_SIZE, Math.max(0, total - (page - 1) * PAGE_SIZE));
        if (result.items.length !== expected) throw new OpeningResultsError(502, 'OPENING_INCOMPLETE', '공개 결과 목록과 전체 건수가 일치하지 않습니다.');
        for (const row of result.items) {
          const key = JSON.stringify(row);
          if (seen.has(key)) throw new OpeningResultsError(502, 'OPENING_INCOMPLETE', '공개 결과 페이지가 중복되었습니다.');
          seen.add(key); rows.push(row);
        }
        if (page * PAGE_SIZE >= total) {
          const wrongNotice = rows.some(row => text(row.bidNtceNo) !== q.number || !/^\d{1,3}$/.test(text(row.bidNtceOrd)));
          const matched = rows.filter(row => exact(row, q));
          const invalidGroup = matched.some(row => !groupIdentity(row));
          return { rows: matched.filter(row => groupIdentity(row)), complete: !wrongNotice && !invalidGroup,
            warnings: wrongNotice || invalidGroup ? [`${label}의 일부 공고·입찰분류·재입찰 번호를 확인하지 못했습니다.`] : [] };
        }
      }
      throw new OpeningResultsError(502, 'OPENING_PAGE_LIMIT', '공개 결과가 많아 일부만 조회되었습니다.');
    } catch (error) {
      return { rows: rows.filter(row => exact(row, q) && groupIdentity(row)), complete: false,
        warnings: [`${label}을 모두 불러오지 못했습니다. 다시 조회해 주세요.`], error,
        pageLimitExceeded: error instanceof OpeningResultsError && error.code === 'OPENING_PAGE_LIMIT' };
    }
  };
}
function firstCompany(row: Row): string {
  // Official schema: company ^ business number ^ representative ^ bid amount ^ bid rate.
  const cells = text(row.opengCorpInfo).split('^');
  return cells.length === 5 && business(cells[1]) ? cells[0].trim() : '';
}
function summary(q: OpeningResultsQuery, opening: Collected, winners: Collected, now: () => number): G2bResultSummary {
  const states = unique(opening.rows.map(row => text(row.progrsDivCdNm)));
  return { ...q, fetchedAt: new Date(now()).toISOString(), complete: opening.complete && winners.complete,
    firstCompanies: unique(opening.rows.map(firstCompany)), winnerCompanies: unique(winners.rows.map(row => text(row.bidwinnrNm))),
    result: states.length === 1 ? states[0] : '' };
}

/** Two small exact-notice calls only; participant details are not loaded for list summaries. */
export function createOpeningSummaryLoader(request: RelatedRequest, now = Date.now) {
  return async (q: OpeningResultsQuery): Promise<G2bResultSummary> => {
    validate(q);
    const collect = collector(request, now, q, now() + 40_000), suffix = q.type === '공사' ? 'Cnstwk' : 'Servc';
    const [opening, winners] = await Promise.all([
      collect(`getOpengResultListInfo${suffix}`, '개찰 결과', true), collect(`getScsbidListSttus${suffix}`, '최종 낙찰 결과', true),
    ]);
    if (opening.error && winners.error && !opening.rows.length && !winners.rows.length) throw opening.error;
    return summary(q, opening, winners, now);
  };
}

export function createOpeningResultsLoader(request: RelatedRequest, now = Date.now) {
  return async (q: OpeningResultsQuery, options: { archive?: boolean } = {}): Promise<NoticeOpeningResults> => {
    validate(q);
    // The background worker reserves 15 provider calls per notice. Interactive
    // detail reads keep their existing full pagination allowance.
    const collect = collector(request, now, q, now() + 45_000, options.archive ? 3 : MAX_PAGES), suffix = q.type === '공사' ? 'Cnstwk' : 'Servc';
    const [opening, winners, participants, failing, rebids] = await Promise.all([
      collect(`getOpengResultListInfo${suffix}`, '개찰 결과', true), collect(`getScsbidListSttus${suffix}`, '최종 낙찰 결과', true),
      collect('getOpengResultListInfoOpengCompt', '참가업체 결과'), collect('getOpengResultListInfoFailing', '유찰 결과'),
      collect('getOpengResultListInfoRebid', '재입찰 결과'),
    ]);
    const sources = [opening, winners, participants, failing, rebids];
    if (sources.every(source => source.error && !source.rows.length)) throw opening.error;
    const warnings = sources.flatMap(source => source.warnings), groups = new Map<string, OpeningResultGroup>();
    const ensure = (row: Row) => {
      const key = groupIdentity(row);
      if (!groups.has(key)) groups.set(key, {
        id: `${q.type}:${q.number}:${q.revision}:${key}`, classification: ordinal(row.bidClsfcNo), rebid: ordinal(row.rbidNo),
        title: '', agency: '', openingAt: '', status: '', participantCount: null,
        firstCompany: '', winnerCompany: '', winnerBusinessNumber: '', winningAmount: null, reason: '', deadline: '', participants: [],
      });
      return groups.get(key)!;
    };
    for (const row of opening.rows) {
      const group = ensure(row);
      Object.assign(group, { title: text(row.bidNtceNm), agency: text(row.dminsttNm) || text(row.ntceInsttNm),
        openingAt: timestamp(row.opengDt), status: text(row.progrsDivCdNm), participantCount: integer(row.prtcptCnum), firstCompany: firstCompany(row) });
    }
    // Never join by company name or rank: only the same notice, lot, round and business number.
    const awardRows = new Map<string, Row[]>();
    for (const row of winners.rows) {
      const key = groupIdentity(row), list = awardRows.get(key) || [];
      list.push(row); awardRows.set(key, list);
      const group = ensure(row);
      group.title ||= text(row.bidNtceNm); group.agency ||= text(row.dminsttNm); group.openingAt ||= timestamp(row.rlOpengDt);
      group.participantCount ??= integer(row.prtcptCnum);
      group.winnerCompany = unique(list.map(item => text(item.bidwinnrNm))).join(', ');
      if (list.length === 1) { group.winnerBusinessNumber = business(row.bidwinnrBizno); group.winningAmount = integer(row.sucsfbidAmt); }
      else { group.winnerBusinessNumber = ''; group.winningAmount = null; }
    }
    for (const row of failing.rows) { const group = ensure(row); group.status ||= text(row.opengRsltDivNm) || '유찰'; group.reason = text(row.nobidRsn); }
    for (const row of rebids.rows) {
      const group = ensure(row); group.status ||= text(row.opengRsltDivNm) || '재입찰'; group.reason = text(row.rbidRsn) || group.reason;
      group.deadline = timestamp(row.bidClseDt); group.openingAt ||= timestamp(row.opengDt);
    }
    const seenParticipants = new Set<string>();
    for (const row of participants.rows) {
      const group = ensure(row), businessNumber = business(row.prcbdrBizno), biddingAt = timestamp(row.bidprcDt);
      const id = `${group.id}:${businessNumber || text(row.prcbdrNm)}:${biddingAt}`;
      if (seenParticipants.has(id)) { warnings.push('동일 업체의 중복 투찰 결과가 있어 일부 결과를 확인하지 못했습니다.'); continue; }
      seenParticipants.add(id);
      const finalRows = awardRows.get(groupIdentity(row)) || [], winnerIds = finalRows.map(item => business(item.bidwinnrBizno));
      const awarded = businessNumber && winnerIds.includes(businessNumber) ? true
        : winners.complete && businessNumber && winnerIds.length && winnerIds.every(Boolean) ? false : null;
      group.status ||= text(row.opengRsltDivNm);
      group.participants.push({ id, rank: text(row.opengRank), businessNumber, companyName: text(row.prcbdrNm),
        bidAmount: integer(row.bidprcAmt), bidRate: rate(row.bidprcrt), biddingAt, result: text(row.opengRsltDivNm),
        remarks: text(row.rmrk), awarded });
    }
    const items = [...groups.values()].sort((a, b) => Number(a.classification) - Number(b.classification) || Number(a.rebid) - Number(b.rebid));
    for (const group of items) group.participants.sort((a, b) => (integer(a.rank) ?? Infinity) - (integer(b.rank) ?? Infinity) || a.companyName.localeCompare(b.companyName, 'ko'));
    const complete = sources.every(source => source.complete) && warnings.length === 0;
    return { ...q, fetchedAt: new Date(now()).toISOString(), source: '나라장터 낙찰정보서비스', complete, warnings: unique(warnings),
      ...(options.archive ? { archiveLimitExceeded: sources.some(source => source.pageLimitExceeded) } : {}),
      participantCount: items.reduce((count, group) => count + group.participants.length, 0), groups: items, summary: summary(q, opening, winners, now) };
  };
}
