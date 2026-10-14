import { describe, expect, it, vi } from 'vitest';
import { createCompanyContractsLoader, validateCompanyContractQuery } from '../server/company-contracts.ts';
import type { RelatedRequest } from '../server/g2b-related.ts';
import type { CompanyContractQuery } from '../src/company-contract-types.ts';

const query: CompanyContractQuery = { businessNumber: '8488802470', type: '공사', from: '2026-10-01', to: '2026-10-31', page: 1 };
const sample = {
  untyCntrctNo: 'R26TE18812747', bsnsDivNm: '공사', dcsnCntrctNo: 'R26TA0229571200', cntrctRefNo: 'R26TA0229571200',
  cnstwkNm: '송파문화예술회관 여가교실 철거공사', cntrctCnclsDate: '2026-10-07', totCntrctAmt: '40640000', thtmCntrctAmt: '40640000',
  cntrctInsttNm: '서울특별시 송파구', ntceNo: '', cntrctCnclsMthdNm: '수의계약',
  corpList: '[1^주계약업체^단독^주식회사 함께하는개발^대표자^대한민국^100^주식회사 함께하는개발^^8488802470]',
  cntrctDtlInfoUrl: 'https://www.g2b.go.kr/link/FIUA027_01/single/?ctrtNo=R26TA02295712&ctrtChgOrd=00',
  rgstDt: '2026-10-12 09:58:56', chgDt: '',
  cntrctInsttOfclNm: 'unneeded person', cntrctInsttOfclTelNo: 'unneeded phone', serviceKey: 'unneeded secret',
};
const page = (items: Record<string, unknown>[], totalCount = items.length) => ({ items, totalCount });
const now = () => Date.parse('2026-10-14T15:00:00+09:00');

describe('direct company contract page', () => {
  it('finds the verified no-notice negotiated contract using the ordinary monthly source scan', async () => {
    const request = vi.fn<RelatedRequest>(async () => page([sample]));
    const result = await createCompanyContractsLoader(request, now)(query);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0].slice(0, 3)).toEqual([
      'https://apis.data.go.kr/1230000/ao/CntrctInfoService/', 'getCntrctInfoListCnstwkPPSSrch',
      { inqryDiv: '1', inqryBgnDate: '20261001', inqryEndDate: '20261031', pageNo: '1', numOfRows: '999' },
    ]);
    expect(result).toMatchObject({ sourceCount: 1, totalCount: 1, hasMore: false, complete: true, warnings: [] });
    expect(result.items[0]).toMatchObject({ businessNumber: query.businessNumber, companyName: '주식회사 함께하는개발',
      contractNumber: 'R26TA0229571200', unifiedContractNumber: 'R26TE18812747', contractDate: '2026-10-07',
      title: sample.cnstwkNm, agency: sample.cntrctInsttNm, contractAmount: 40640000, totalContractAmount: 40640000,
      noticeNumber: '', method: '수의계약', shareRate: 100, registeredAt: '2026-10-12T09:58:56+09:00' });
    expect(JSON.stringify(result)).not.toContain('unneeded');
    expect(JSON.stringify(result)).not.toContain('대표자');
    expect(result.items[0]).not.toHaveProperty('awarded');
    expect(result.items[0]).not.toHaveProperty('winningAmount');
  });

  it('matches any selected business exactly, including a member of a joint contract', async () => {
    const otherBiz = '1234567890';
    const joint = { ...sample, corpList: sample.corpList + `[2^구성업체^공동이행^Other company^Person^대한민국^30^Other company^^${otherBiz}]` };
    const loader = createCompanyContractsLoader(async () => page([joint]), now);
    expect((await loader({ ...query, businessNumber: otherBiz })).items[0]).toMatchObject({ businessNumber: otherBiz, companyName: 'Other company', shareRate: 30, contractAmount: 40640000 });
    expect((await loader({ ...query, businessNumber: '0000000000' })).items).toEqual([]);
    expect((await loader({ ...query, businessNumber: '0000000000' })).totalCount).toBe(1);
  });

  it('does not match a company name or a number in another field as business identity', async () => {
    const result = await createCompanyContractsLoader(async () => page([{ ...sample,
      corpList: `[1^${query.businessNumber}^단독^주식회사 함께하는개발^Person^대한민국^100^${query.businessNumber}^^1234567890]`,
    }]), now)(query);
    expect(result).toMatchObject({ items: [], complete: true, totalCount: 1, sourceCount: 1 });
  });

  it('reads only one page and reports source pagination even when it has no matching company', async () => {
    const rows = Array.from({ length: 999 }, (_, index) => ({ ...sample, untyCntrctNo: `SOURCE${index}`, corpList: '[1^주계약업체^단독^Other^Person^대한민국^100^Other^^1234567890]' }));
    const request = vi.fn<RelatedRequest>(async () => page(rows, 1000));
    const result = await createCompanyContractsLoader(request, now)(query);
    expect(result).toMatchObject({ items: [], sourceCount: 999, totalCount: 1000, hasMore: true, complete: false });
    expect(request).toHaveBeenCalledTimes(1);
    const nextRequest = vi.fn<RelatedRequest>(async () => page([sample], 1000));
    const next = await createCompanyContractsLoader(nextRequest, now)({ ...query, page: 2 });
    expect(next).toMatchObject({ sourceCount: 1, totalCount: 1000, hasMore: false, complete: true });
    expect(next.items).toHaveLength(1);
    expect(nextRequest.mock.calls[0][2].pageNo).toBe('2');
  });

  it('uses service contract operation and accepts both general and technical service classifications', async () => {
    const request = vi.fn<RelatedRequest>(async () => page([{ ...sample, bsnsDivNm: '기술용역', cnstwkNm: '', cntrctNm: '설계 용역' }]));
    const result = await createCompanyContractsLoader(request, now)({ ...query, type: '용역' });
    expect(result.items[0].title).toBe('설계 용역');
    expect(request.mock.calls[0][1]).toBe('getCntrctInfoListServcPPSSrch');
  });

  it('keeps amendment identities distinct and avoids mutable money/name in the record key', async () => {
    const loader = createCompanyContractsLoader(async () => page([sample, { ...sample, dcsnCntrctNo: 'R26TA0229571201' }]), now);
    const result = await loader(query);
    expect(new Set(result.items.map(item => item.id)).size).toBe(2);
    const changed = await createCompanyContractsLoader(async () => page([{ ...sample, thtmCntrctAmt: '1234', cnstwkNm: '수정된 제목' }]), now)(query);
    expect(changed.items[0].id).toBe(result.items[0].id);
    expect(changed.items[0].contractAmount).toBe(1234);
  });

  it('flags malformed or unavailable company lists without silently claiming a complete zero', async () => {
    const result = await createCompanyContractsLoader(async () => page([
      sample, { ...sample, untyCntrctNo: 'OTHER001', corpList: '[1^bad^list]' },
      { ...sample, untyCntrctNo: 'OTHER002', corpList: '' },
      { ...sample, untyCntrctNo: 'OTHER003', corpList: sample.corpList.replace('8488802470', 'unpublished') },
    ]), now)(query);
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.warnings).toHaveLength(1);
  });

  it('does not sum repeated company shares for separate work classifications', async () => {
    const result = await createCompanyContractsLoader(async () => page([{ ...sample,
      corpList: sample.corpList + sample.corpList.replace('[1^', '[2^'),
    }]), now)(query);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].shareRate).toBeNull();
  });

  it('rejects invalid business/date/page before any upstream traffic but permits historical months', async () => {
    const request = vi.fn<RelatedRequest>();
    for (const invalid of [
      { ...query, businessNumber: '848-88-02470' }, { ...query, page: 0 }, { ...query, page: 1.5 },
      { ...query, from: '2026-02-30' }, { ...query, to: '2026-11-01' }, { ...query, from: '2026-11-02' },
    ]) await expect(createCompanyContractsLoader(request, now)(invalid)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(() => validateCompanyContractQuery({ ...query, from: '2004-07-01', to: '2004-07-31' })).not.toThrow();
    expect(() => validateCompanyContractQuery({ ...query, from: '2024-02-01', to: '2024-02-29' })).not.toThrow();
  });

  it('fails on a short page, impossible page, duplicate identity or ignored date/type filter', async () => {
    const invalidPages = [page([sample], 2), page([sample, sample]),
      page([{ ...sample, cntrctCnclsDate: '2026-09-30' }]), page([{ ...sample, bsnsDivNm: '용역' }]),
      page([{ ...sample, untyCntrctNo: '', dcsnCntrctNo: '' }]), page([{ ...sample, untyCntrctNo: 'bad identity' }]),
    ];
    for (const invalid of invalidPages) await expect(createCompanyContractsLoader(async () => invalid, now)(query)).rejects.toThrow();
    await expect(createCompanyContractsLoader(async () => page([]), now)({ ...query, page: 2 })).rejects.toThrow();
  });

  it('allows the continuation client to detect identical source pages even without company matches', async () => {
    const result = await createCompanyContractsLoader(async () => page([sample]), now)(query);
    const other = await createCompanyContractsLoader(async () => page([{ ...sample, thtmCntrctAmt: '9999' }]), now)(query);
    expect(result.sourceFingerprint).toBe(other.sourceFingerprint);
    expect(result.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preserves zero money, keeps missing or invalid money unknown, and restricts source links', async () => {
    const result = await createCompanyContractsLoader(async () => page([
      { ...sample, thtmCntrctAmt: '0', totCntrctAmt: '', cntrctDtlInfoUrl: 'https://g2b.go.kr.evil.test/contract' },
      { ...sample, untyCntrctNo: 'OTHER001', thtmCntrctAmt: '9007199254740992', totCntrctAmt: '1,000', cntrctDtlInfoUrl: 'http://www.g2b.go.kr' },
    ]), now)(query);
    expect(result.items[0]).toMatchObject({ contractAmount: 0, totalContractAmount: null, sourceUrl: '' });
    expect(result.items[1]).toMatchObject({ contractAmount: null, totalContractAmount: 1000, sourceUrl: '' });
    expect(result.complete).toBe(false);
    expect(result.warnings).toHaveLength(1);
  });

  it('propagates quota/network failure instead of treating it as zero contracts', async () => {
    const error = new Error('Provider quota exhausted');
    await expect(createCompanyContractsLoader(async () => { throw error; }, now)(query)).rejects.toBe(error);
    expect(await createCompanyContractsLoader(async () => page([]), now)(query)).toMatchObject({ items: [], sourceCount: 0, totalCount: 0, complete: true, hasMore: false });
  });
});
