import { describe, expect, it, vi } from 'vitest';
import { createOpeningResultsLoader, createOpeningSummaryLoader, OpeningResultsError } from '../server/g2b-results.ts';
import type { RelatedRequest } from '../server/g2b-related.ts';

const query = { number: 'R26BK01756799', revision: '000', type: '공사' as const };
const identity = { bidNtceNo: query.number, bidNtceOrd: '000', bidClsfcNo: '0', rbidNo: '000' };
const now = () => Date.parse('2026-10-14T10:00:00+09:00');
const opening = { ...identity, bidNtceNm: '철거공사', dminsttNm: '공공기관', opengDt: '2026-10-13 11:00:00',
  progrsDivCdNm: '개찰완료', prtcptCnum: '2', opengCorpInfo: '첫째업체^1234567890^대표자^900000^89.745' };
const winner = { ...identity, bidwinnrNm: '최종낙찰업체', bidwinnrBizno: '2345678901', sucsfbidAmt: '910000' };
const participant = { ...identity, prcbdrBizno: '1234567890', prcbdrNm: '첫째업체', opengRank: '1', bidprcAmt: '900000',
  bidprcrt: '89.745', bidprcDt: '2026-10-12 10:10:20', rmrk: '정상', opengRsltDivNm: '개찰완료' };
type Row = Record<string, unknown>;
function fixture(overrides: Record<string, Row[] | Error> = {}) {
  const rows: Record<string, Row[] | Error> = {
    getOpengResultListInfoCnstwk: [opening], getScsbidListSttusCnstwk: [winner],
    getOpengResultListInfoOpengCompt: [participant, { ...participant, prcbdrBizno: '2345678901', prcbdrNm: '최종낙찰업체', opengRank: '2', bidprcAmt: '910000' }],
    getOpengResultListInfoFailing: [], getOpengResultListInfoRebid: [], ...overrides,
  };
  return vi.fn<RelatedRequest>(async (_base, op, params) => {
    const source = rows[op] || [];
    if (source instanceof Error) throw source;
    const start = (Number(params.pageNo) - 1) * Number(params.numOfRows);
    return { items: source.slice(start, start + Number(params.numOfRows)), totalCount: source.length };
  });
}

describe('approved exact-notice opening service', () => {
  it('uses only two direct-notice operations for summaries, without all participants or date scans', async () => {
    const request = fixture();
    const result = await createOpeningSummaryLoader(request, now)(query);
    expect(result).toMatchObject({ complete: true, firstCompanies: ['첫째업체'], winnerCompanies: ['최종낙찰업체'], result: '개찰완료' });
    expect(request).toHaveBeenCalledTimes(2);
    for (const [base, , params] of request.mock.calls) {
      expect(base).toBe('https://apis.data.go.kr/1230000/as/ScsbidInfoService/');
      expect(params).toEqual({ inqryDiv: '4', bidNtceNo: query.number, bidNtceOrd: '000', pageNo: '1', numOfRows: '999' });
    }
  });

  it('joins actual final awards by business number, lot and round rather than rank or name', async () => {
    const request = fixture({
      getOpengResultListInfoCnstwk: [opening, { ...opening, bidClsfcNo: '1' }, { ...opening, rbidNo: '001' }],
      getOpengResultListInfoOpengCompt: [participant,
        { ...participant, prcbdrBizno: '2345678901', prcbdrNm: '최종낙찰업체', opengRank: '2' },
        { ...participant, bidClsfcNo: '1', prcbdrBizno: '2345678901' },
        { ...participant, rbidNo: '001', prcbdrBizno: '2345678901' }],
    });
    const result = await createOpeningResultsLoader(request, now)(query);
    expect(result.complete).toBe(true);
    expect(result.groups).toHaveLength(3);
    const first = result.groups.find(g => g.classification === '0' && g.rebid === '0')!;
    expect(first.participants.map(p => p.awarded)).toEqual([false, true]);
    expect(result.groups.filter(g => g.id !== first.id).flatMap(g => g.participants.map(p => p.awarded))).toEqual([null, null]);
    expect(first).toMatchObject({ winningAmount: 910000, openingAt: '2026-10-13T11:00:00+09:00', participantCount: 2 });
    expect(first.participants[0]).toMatchObject({ bidAmount: 900000, bidRate: 89.745, biddingAt: '2026-10-12T10:10:20+09:00' });
  });

  it('keeps final award unknown until the final award endpoint publishes a winner', async () => {
    const result = await createOpeningResultsLoader(fixture({ getScsbidListSttusCnstwk: [] }), now)(query);
    expect(result.complete).toBe(true);
    expect(result.groups[0].firstCompany).toBe('첫째업체');
    expect(result.groups[0].winnerCompany).toBe('');
    expect(result.groups[0].participants.every(p => p.awarded === null)).toBe(true);
  });

  it('filters sibling notice revisions and uses the service-specific business endpoint', async () => {
    const request = fixture({ getOpengResultListInfoServc: [{ ...opening, bidNtceOrd: '001' }, opening], getScsbidListSttusServc: [winner] });
    const result = await createOpeningSummaryLoader(request, now)({ ...query, type: '용역' });
    expect(result.firstCompanies).toEqual(['첫째업체']);
    expect(result.complete).toBe(true);
    expect(request.mock.calls.map(call => call[1])).toEqual(['getOpengResultListInfoServc', 'getScsbidListSttusServc']);
  });

  it('loads every participant page after the first 999 records', async () => {
    const source = Array.from({ length: 1000 }, (_, index) => ({ ...participant, prcbdrBizno: String(7000000000 + index), opengRank: String(index + 1) }));
    const request = fixture({ getOpengResultListInfoOpengCompt: source });
    const result = await createOpeningResultsLoader(request, now)(query);
    expect(result.complete).toBe(true);
    expect(result.participantCount).toBe(1000);
    expect(request.mock.calls.filter(call => call[1] === 'getOpengResultListInfoOpengCompt').map(call => call[2].pageNo)).toEqual(['1', '2']);
  });

  it('reports partial responses without converting unavailable award data to false', async () => {
    const result = await createOpeningResultsLoader(fixture({ getScsbidListSttusCnstwk: new Error('unavailable') }), now)(query);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(' ')).toContain('최종 낙찰');
    expect(result.participantCount).toBe(2);
    expect(result.groups[0].participants.every(p => p.awarded === null)).toBe(true);
    expect(result.summary.complete).toBe(false);
  });

  it('bounds background archive pages without truncating the interactive result', async () => {
    const source = Array.from({ length: 3000 }, (_, index) => ({ ...participant, prcbdrBizno: String(7000000000 + index), opengRank: String(index + 1) }));
    const background = fixture({ getOpengResultListInfoOpengCompt: source });
    const partial = await createOpeningResultsLoader(background, now)(query, { archive: true });
    expect(partial.complete).toBe(false);
    expect(partial.archiveLimitExceeded).toBe(true);
    expect(partial.participantCount).toBe(2997);
    expect(background.mock.calls.filter(call => call[1] === 'getOpengResultListInfoOpengCompt')).toHaveLength(3);
    expect(background.mock.calls.length).toBeLessThanOrEqual(15);
    const interactive = await createOpeningResultsLoader(fixture({ getOpengResultListInfoOpengCompt: source }), now)(query);
    expect(interactive.complete).toBe(true);
    expect(interactive.archiveLimitExceeded).not.toBe(true);
    expect(interactive.participantCount).toBe(3000);
  });

  it('does not classify transient archive failures or a fully read third page as a page limit', async () => {
    const source = Array.from({ length: 2997 }, (_, index) => ({ ...participant, prcbdrBizno: String(7000000000 + index), opengRank: String(index + 1) }));
    const complete = await createOpeningResultsLoader(fixture({ getOpengResultListInfoOpengCompt: source }), now)(query, { archive: true });
    expect(complete.complete).toBe(true);
    expect(complete.archiveLimitExceeded).toBe(false);
    const fallback = fixture();
    const failure: RelatedRequest = async (...args) => {
      if (args[1] === 'getOpengResultListInfoOpengCompt') throw new Error('temporary failure');
      return fallback(...args);
    };
    const partial = await createOpeningResultsLoader(failure, now)(query, { archive: true });
    expect(partial.complete).toBe(false);
    expect(partial.archiveLimitExceeded).toBe(false);
  });

  it('rejects total failures instead of returning a fabricated empty completed result', async () => {
    const error = new Error('provider access denied');
    const request: RelatedRequest = async () => { throw error; };
    await expect(createOpeningResultsLoader(request, now)(query)).rejects.toBe(error);
    await expect(createOpeningSummaryLoader(request, now)(query)).rejects.toBe(error);
  });

  it('marks short, inconsistent and repeated pages incomplete', async () => {
    const fallback = fixture();
    const short: RelatedRequest = async (...args) => args[1] === 'getOpengResultListInfoOpengCompt'
      ? { items: [participant], totalCount: 1000 } : fallback(...args);
    const result = await createOpeningResultsLoader(short, now)(query);
    expect(result.complete).toBe(false);
    expect(result.participantCount).toBe(0);
    expect(result.warnings.join(' ')).toContain('참가업체');
    const repeated: RelatedRequest = async (...args) => args[1] === 'getOpengResultListInfoOpengCompt'
      ? { items: [participant, participant], totalCount: 2 } : fallback(...args);
    expect((await createOpeningResultsLoader(repeated, now)(query)).complete).toBe(false);
  });

  it('does not merge missing classification or different notice rows into this notice', async () => {
    const request = fixture({ getOpengResultListInfoOpengCompt: [participant,
      { ...participant, bidClsfcNo: '' }, { ...participant, bidNtceNo: 'R26BK09999999' }] });
    const result = await createOpeningResultsLoader(request, now)(query);
    expect(result.complete).toBe(false);
    expect(result.participantCount).toBe(1);
  });

  it('includes failed lots and rebid schedules even when they have no participants', async () => {
    const request = fixture({ getOpengResultListInfoFailing: [{ ...identity, bidClsfcNo: '2', nobidRsn: '응찰업체 없음', opengRsltDivNm: '유찰' }],
      getOpengResultListInfoRebid: [{ ...identity, rbidNo: '001', rbidRsn: '유효 입찰 부족', bidClseDt: '2026-10-14 14:00:00', opengDt: '2026-10-14 15:00:00' }] });
    const result = await createOpeningResultsLoader(request, now)(query);
    expect(result.groups.find(g => g.classification === '2')).toMatchObject({ status: '유찰', reason: '응찰업체 없음', participants: [] });
    expect(result.groups.find(g => g.rebid === '1')).toMatchObject({ status: '재입찰', deadline: '2026-10-14T14:00:00+09:00', reason: '유효 입찰 부족' });
  });

  it('keeps zero money, rejects malformed money/dates and returns only public minimal fields', async () => {
    const result = await createOpeningResultsLoader(fixture({ getOpengResultListInfoOpengCompt: [
      { ...participant, bidprcAmt: '0', prcbdrCeoNm: 'private representative', secret: 'not exposed' },
      { ...participant, prcbdrBizno: '2345678901', bidprcAmt: 'NaN', bidprcrt: 'unknown', bidprcDt: '2026-02-30 10:00:00' },
    ] }), now)(query);
    expect(result.groups[0].participants[0].bidAmount).toBe(0);
    expect(result.groups[0].participants[1]).toMatchObject({ bidAmount: null, bidRate: null, biddingAt: '' });
    expect(JSON.stringify(result)).not.toContain('private representative');
    expect(JSON.stringify(result)).not.toContain('not exposed');
  });

  it('returns genuine empty source results as complete, and validates input before any call', async () => {
    const request = vi.fn<RelatedRequest>(async () => ({ items: [], totalCount: 0 }));
    expect(await createOpeningResultsLoader(request, now)(query)).toMatchObject({ complete: true, groups: [], participantCount: 0 });
    request.mockClear();
    await expect(createOpeningResultsLoader(request, now)({ ...query, number: '../../bad' })).rejects.toBeInstanceOf(OpeningResultsError);
    expect(request).not.toHaveBeenCalled();
  });
});
