import { describe, expect, it, vi } from 'vitest';
import { createCompanyParticipationLoader } from '../server/company-participation';
import type { RelatedRequest } from '../server/g2b-related';
import { ProviderQuotaError } from '../server/provider-quota';

const biz = '0012345678';
const query = { businessNumber: biz, type: '공사' as const, day: '2026-10-13', page: 1 };
const row = { bidNtceNo: 'R26BK01757822', bidNtceOrd: '000', bsnsDivNm: '공사', bidNtceNm: '선택 업체 공사',
  ntceInsttNm: '공고기관', dmndInsttNm: '수요기관', opengDate: '2026-10-13', opengTm: '11:00',
  bidprcCorpBizrno: biz, bidprcCorpNm: '선택 업체', bidprcDate: '2026-10-12', bidprcTm: '15:30',
  bidprcAmt: '1234000', bidprcRt: '88.123', opengRank: '1', sucsfYn: 'N', fnlSucsfAmt: '5000000', cntrctCnclsMthdNm: '제한경쟁' };
const request = (items: Record<string, unknown>[], totalCount = items.length) => vi.fn<RelatedRequest>(async () => ({ items, totalCount }));

describe('direct company participation source pages', () => {
  it('requests an official daily page and returns only the exact selected business', async () => {
    const req = request([row, { ...row, bidprcCorpBizrno: '9999999999', bidprcCorpNm: '다른 업체 비공개결과', bidNtceNm: '다른 업체만 공고', bidNtceNo: 'R26BK09999999' }]);
    const result = await createCompanyParticipationLoader(req)(query);
    expect(req).toHaveBeenCalledWith('https://apis.data.go.kr/1230000/ao/PubDataOpnStdService/', 'getDataSetOpnStdScsbidInfo', {
      bsnsDivCd: '3', opengBgnDt: '202610130000', opengEndDt: '202610132359', pageNo: '1', numOfRows: '999',
    }, 25_000);
    expect(result).toMatchObject({ ...query, totalCount: 2, sourceCount: 2, hasMore: false, complete: true, pageSize: 999 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ businessNumber: biz, title: '선택 업체 공사', agency: '수요기관',
      openingAt: '2026-10-13T11:00:00+09:00', biddingAt: '2026-10-12T15:30:00+09:00',
      bidAmount: 1234000, bidRate: 88.123, rank: '1', awarded: false, winningAmount: null, classification: '', rebid: '' });
    expect(JSON.stringify(result)).not.toContain('9999999999');
    expect(JSON.stringify(result)).not.toContain('다른 업체');
    expect(result.pageFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('continues source pagination even when none of the first 999 rows belong to this company', async () => {
    const rows = Array.from({ length: 999 }, (_, i) => ({ ...row, bidprcCorpBizrno: String(7000000000 + i) }));
    const load = createCompanyParticipationLoader(request(rows, 1000));
    expect(await load(query)).toMatchObject({ items: [], sourceCount: 999, totalCount: 1000, hasMore: true, complete: true });
    const last = await createCompanyParticipationLoader(request([row], 1000))({ ...query, page: 2 });
    expect(last).toMatchObject({ sourceCount: 1, totalCount: 1000, hasMore: false });
    expect(last.items).toHaveLength(1);
  });

  it('retains award distinctions, zero money and separate submission times', async () => {
    const result = await createCompanyParticipationLoader(request([
      { ...row, bidprcAmt: '0', sucsfYn: '' },
      { ...row, bidprcTm: '15:31', sucsfYn: 'Y', fnlSucsfAmt: '1234000' },
    ]))(query);
    expect(result.items[0]).toMatchObject({ bidAmount: 0, rank: '1', awarded: null, winningAmount: null });
    expect(result.items[1]).toMatchObject({ awarded: true, winningAmount: 1234000 });
    expect(new Set(result.items.map(item => item.id)).size).toBe(2);
  });

  it('makes source fingerprints independent of the requested company and ranking updates', async () => {
    const load = createCompanyParticipationLoader(request([row]));
    const original = await load(query);
    const other = await load({ ...query, businessNumber: '9999999999' });
    const updated = await createCompanyParticipationLoader(request([{ ...row, opengRank: '2', sucsfYn: 'Y' }]))(query);
    expect(other.items).toEqual([]);
    expect(other.pageFingerprint).toBe(original.pageFingerprint);
    expect(updated.items[0].id).toBe(original.items[0].id);
  });

  it('rejects invalid business numbers, dates and pages before upstream access', async () => {
    const req = request([]), load = createCompanyParticipationLoader(req);
    for (const change of [{ businessNumber: '12-34' }, { day: '2026-02-30' }, { page: 0 }, { type: '물품' as '공사' }]) {
      await expect(load({ ...query, ...change })).rejects.toMatchObject({ status: 400 });
    }
    expect(req).not.toHaveBeenCalled();
  });

  it('never converts provider quota failures or inconsistent pages to an empty complete result', async () => {
    const quota = new ProviderQuotaError(100);
    await expect(createCompanyParticipationLoader(async () => { throw quota; })(query)).rejects.toBe(quota);
    await expect(createCompanyParticipationLoader(request([row], 1000))(query)).rejects.toMatchObject({ status: 502 });
    await expect(createCompanyParticipationLoader(request([{ ...row, opengDate: '2026-10-12' }]))(query)).rejects.toMatchObject({ status: 502 });
    await expect(createCompanyParticipationLoader(request([row, row]))(query)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a missing or malformed selected-company notice instead of claiming a complete zero', async () => {
    for (const bidNtceNo of [undefined, '', 'bad notice', 'R26/INVALID', 'A'.repeat(41)]) {
      const req = request([
        { ...row, bidprcCorpBizrno: '9999999999' },
        { ...row, bidNtceNo },
      ]);
      await expect(createCompanyParticipationLoader(req)(query)).rejects.toMatchObject({ status: 502, code: 'G2B_PARTICIPATION_INCOMPLETE' });
      expect(req).toHaveBeenCalledTimes(1);
    }
  });

  it('handles empty days and service pages without contacting any store', async () => {
    expect(await createCompanyParticipationLoader(request([]))(query)).toMatchObject({ items: [], sourceCount: 0, totalCount: 0, hasMore: false, complete: true });
    const req = request([{ ...row, bsnsDivNm: '용역' }]);
    expect((await createCompanyParticipationLoader(req)({ ...query, type: '용역' })).items[0].type).toBe('용역');
    expect(req.mock.calls[0][2].bsnsDivCd).toBe('5');
  });
});
