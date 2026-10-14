import { describe, expect, it, vi } from 'vitest';
import { createCompanyAwardsLoader, validateCompanyAwardQuery } from '../server/company-awards.ts';
import type { RelatedRequest } from '../server/g2b-related.ts';
import { ProviderQuotaError } from '../server/provider-quota.ts';

const query = { businessNumber: '3028128785', type: '공사' as const, from: '2026-10-01', to: '2026-10-31' };
const sample = {
  bidNtceNo: 'R26BK01757822', bidNtceOrd: '000', bidClsfcNo: '0', rbidNo: '000', bidNtceNm: '황간고 본관 석면철거공사',
  bidwinnrBizno: query.businessNumber, bidwinnrNm: '주식회사 아이엔건설환경', sucsfbidAmt: '55968000', sucsfbidRate: '90.399',
  prtcptCnum: '8', rlOpengDt: '2026-10-13 11:06:59', fnlSucsfDate: '2026-10-13', dminsttNm: '영동교육지원청',
  bidwinnrCeoNm: 'unneeded person', bidwinnrTelNo: 'unneeded phone', extra: 'serviceKey=secret',
};
const page = (items: Record<string, unknown>[], totalCount = items.length) => ({ items, totalCount });
const now = () => Date.parse('2026-10-14T15:00:00+09:00');

describe('direct company final-award history', () => {
  it('uses the verified bizno PPSSrch filter and exact monthly dates for construction and services', async () => {
    const request = vi.fn<RelatedRequest>(async () => page([sample]));
    for (const type of ['공사', '용역'] as const) {
      const result = await createCompanyAwardsLoader(request, now)({ ...query, type });
      expect(result).toMatchObject({ complete: true, totalCount: 1, warnings: [] });
      expect(result.items[0]).toMatchObject({ businessNumber: query.businessNumber, classification: '0', rebid: '0',
        number: sample.bidNtceNo, revision: '000', openingAt: '2026-10-13T11:06:59+09:00', awarded: true,
        winningAmount: 55968000, awardRate: 90.399, participantCount: 8, awardDate: '2026-10-13' });
    }
    expect(request.mock.calls.map(call => call[1])).toEqual(['getScsbidListSttusCnstwkPPSSrch', 'getScsbidListSttusServcPPSSrch']);
    expect(request.mock.calls[0][2]).toEqual({ inqryDiv: '2', bizno: query.businessNumber,
      inqryBgnDt: '202610010000', inqryEndDt: '202610312359', pageNo: '1', numOfRows: '999' });
  });

  it('does not invent rank, submitted bid amount or submitted bid rate from an award', async () => {
    const result = await createCompanyAwardsLoader(async () => page([sample]), now)(query);
    expect(result.items[0]).toMatchObject({ rank: '', bidAmount: null, bidRate: null, method: '', awardRate: 90.399 });
    expect(JSON.stringify(result)).not.toContain('unneeded');
    expect(JSON.stringify(result)).not.toContain('serviceKey');
  });

  it('rejects invalid business numbers, invalid dates and >31-day source slices before traffic', async () => {
    const request = vi.fn<RelatedRequest>();
    for (const invalid of [
      { ...query, businessNumber: '302-81-28785' }, { ...query, businessNumber: 'wrong' },
      { ...query, from: '2026-02-30' }, { ...query, from: '2026-11-01' }, { ...query, to: '2026-11-01' },
    ]) await expect(createCompanyAwardsLoader(request, now)(invalid)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(() => validateCompanyAwardQuery({ ...query, from: '1990-01-01', to: '1990-01-31' })).not.toThrow();
    expect(() => validateCompanyAwardQuery({ ...query, from: '2024-02-01', to: '2024-02-29' })).not.toThrow();
  });

  it('retains distinct revisions, classifications and rebid rounds of the same notice', async () => {
    const rows = [sample, { ...sample, bidNtceOrd: '001' }, { ...sample, bidClsfcNo: '1' }, { ...sample, rbidNo: '001' }];
    const result = await createCompanyAwardsLoader(async () => page(rows), now)(query);
    expect(result.complete).toBe(true);
    expect(result.items).toHaveLength(4);
    expect(new Set(result.items.map(item => item.id)).size).toBe(4);
  });

  it('loads all pages after 999 rows without duplicating or silently capping the list', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({ ...sample, bidNtceNo: `R26BK${String(index).padStart(8, '0')}` }));
    const request = vi.fn<RelatedRequest>(async (_base, _op, params) => page(Number(params.pageNo) === 1 ? rows.slice(0, 999) : rows.slice(999), rows.length));
    const result = await createCompanyAwardsLoader(request, now)(query);
    expect(result).toMatchObject({ complete: true, totalCount: 1000, warnings: [] });
    expect(result.items).toHaveLength(1000);
    expect(request.mock.calls.map(call => call[2].pageNo)).toEqual(['1', '2']);
  });

  it('does not treat another business or malformed lot identity as a complete empty match', async () => {
    const rows = [sample, { ...sample, bidwinnrBizno: '9999999999' }, { ...sample, bidClsfcNo: '' }];
    const request = vi.fn<RelatedRequest>(async () => page(rows));
    const result = await createCompanyAwardsLoader(request, now)(query);
    expect(result).toMatchObject({ complete: false, totalCount: 3 });
    expect(result.items).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('detects a repeated identity even if its amount changed', async () => {
    const result = await createCompanyAwardsLoader(async () => page([sample, { ...sample, sucsfbidAmt: '1000' }]), now)(query);
    expect(result.complete).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it('detects short pages and changing totals rather than claiming complete coverage', async () => {
    const short = await createCompanyAwardsLoader(async () => page([sample], 2), now)(query);
    expect(short).toMatchObject({ complete: false, items: [], totalCount: 2 });
    const rows = Array.from({ length: 999 }, (_, index) => ({ ...sample, bidNtceNo: `R26BK${String(index).padStart(8, '0')}` }));
    const changed = await createCompanyAwardsLoader(async (_base, _op, params) => params.pageNo === '1' ? page(rows, 1000) : page([sample], 1001), now)(query);
    expect(changed.complete).toBe(false);
    expect(changed.items).toHaveLength(999);
  });

  it('propagates initial provider failure but preserves confirmed pages after a later failure', async () => {
    const failure = new Error('serviceKey=secret');
    await expect(createCompanyAwardsLoader(async () => { throw failure; }, now)(query)).rejects.toBe(failure);
    const rows = Array.from({ length: 999 }, (_, index) => ({ ...sample, bidNtceNo: `R26BK${String(index).padStart(8, '0')}` }));
    const partial = await createCompanyAwardsLoader(async (_base, _op, params) => { if (params.pageNo === '1') return page(rows, 1000); throw failure; }, now)(query);
    expect(partial.complete).toBe(false);
    expect(partial.items).toHaveLength(999);
    expect(JSON.stringify(partial)).not.toContain('secret');
  });

  it('propagates a later-page quota failure and restarts that month cleanly on explicit retry', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({ ...sample, bidNtceNo: `R26BK${String(index).padStart(8, '0')}` }));
    const quota = new ProviderQuotaError(60);
    let failSecondPage = true;
    const request = vi.fn<RelatedRequest>(async (_base, _op, params) => {
      if (params.pageNo === '1') return page(rows.slice(0, 999), 1000);
      if (failSecondPage) { failSecondPage = false; throw quota; }
      return page(rows.slice(999), 1000);
    });
    const load = createCompanyAwardsLoader(request, now);
    await expect(load(query)).rejects.toBe(quota);
    expect(request.mock.calls.map(call => call[2].pageNo)).toEqual(['1', '2']);
    expect(quota).toMatchObject({ status: 429, code: 'G2B_QUOTA_EXCEEDED', retryAfterSeconds: 60 });
    const retried = await load(query);
    expect(retried).toMatchObject({ complete: true, totalCount: 1000, warnings: [] });
    expect(retried.items).toHaveLength(1000);
    expect(request.mock.calls.map(call => call[2].pageNo)).toEqual(['1', '2', '1', '2']);
  });

  it('preserves zero amounts, validates dates, and keeps malformed values unknown', async () => {
    const result = await createCompanyAwardsLoader(async () => page([{ ...sample, sucsfbidAmt: '0', sucsfbidRate: '0', rlOpengDt: '2026-02-30 11:00:00', fnlSucsfDate: 'bad' },
      { ...sample, rbidNo: '001', sucsfbidAmt: '9007199254740992', sucsfbidRate: 'N/A' }]), now)(query);
    expect(result.items.find(item => item.rebid === '0')).toMatchObject({ winningAmount: 0, awardRate: 0, openingAt: '', awardDate: '' });
    expect(result.items.find(item => item.rebid === '1')).toMatchObject({ winningAmount: null, awardRate: null });
  });

  it('returns zero only as a confirmed empty result for the requested period', async () => {
    expect(await createCompanyAwardsLoader(async () => page([]), now)(query)).toMatchObject({ ...query, items: [], complete: true, totalCount: 0, warnings: [] });
  });
});
