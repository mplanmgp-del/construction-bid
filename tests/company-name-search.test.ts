import { describe, expect, it, vi } from 'vitest';
import { createCompanyNameLoader } from '../server/g2b-company';
import type { RelatedRequest } from '../server/g2b-related';
import { ProviderQuotaError } from '../server/provider-quota';

const now = () => Date.parse('2026-10-14T06:00:00Z');
const together = { bizno: '8488802470', corpNm: '주식회사 함께하는개발', rgstDt: '2023-12-27 09:59:20',
  chgDt: '2026-10-06 10:39:25', adrs: '서울특별시', dtlAdrs: '광진구', ceoNm: '공개 대표자',
  privateEmail: 'not-for-candidates@example.test', corpBsnsDivNm: '공사' };
const request = (items: Record<string, unknown>[], totalCount = items.length) => vi.fn<RelatedRequest>(async () => ({ items, totalCount }));

describe('official company-name candidates', () => {
  it('looks up a partial name by official registration year and retains a single candidate as a list', async () => {
    const req = request([together]);
    const result = await createCompanyNameLoader(req, now)('  함께하는개발  ', 2023);
    expect(req).toHaveBeenCalledWith('https://apis.data.go.kr/1230000/ao/UsrInfoService02/', 'getPrcrmntCorpBasicInfo02', {
      inqryDiv: '1', corpNm: '함께하는개발', inqryBgnDt: '202301010000', inqryEndDt: '202312312359', pageNo: '1', numOfRows: '100',
    }, 25_000);
    expect(result).toMatchObject({ year: 2023, page: 1, totalCount: 1, hasMore: false });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ businessNumber: '8488802470', name: '주식회사 함께하는개발',
      address: '서울특별시 광진구', registrationDate: '2023-12-27 09:59:20', licenses: [], products: [] });
    expect(result).not.toHaveProperty('company');
    expect(JSON.stringify(result)).not.toContain('not-for-candidates');
  });

  it('keeps related partial-name results distinct by their business number', async () => {
    const req = request([together, { ...together, bizno: '8618102455', corpNm: '주식회사 우리함께' },
      { ...together, bizno: '0012345678', corpNm: '함께 건설' }]);
    const result = await createCompanyNameLoader(req, now)('함께', 2023);
    expect(result.items.map(item => item.businessNumber)).toEqual(['8488802470', '8618102455', '0012345678']);
  });

  it('handles an actual empty year without treating provider failure as absence', async () => {
    const empty = await createCompanyNameLoader(request([]), now)('함께', 2022);
    expect(empty).toMatchObject({ items: [], totalCount: 0, hasMore: false, year: 2022, page: 1 });
    const quota = new ProviderQuotaError(42);
    await expect(createCompanyNameLoader(async () => { throw quota; }, now)('함께', 2023)).rejects.toBe(quota);
  });

  it('retains provider candidates across company-name letter case and spacing', async () => {
    const req = request([{ ...together, corpNm: 'ABC\t건설' }]);
    const result = await createCompanyNameLoader(req, now)('abc 건설', 2023);
    expect(result.items.map(item => item.businessNumber)).toEqual(['8488802470']);
  });

  it('keeps source pagination and validates the exact final page size', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...together, bizno: String(7000000000 + index) }));
    expect(await createCompanyNameLoader(request(rows, 101), now)('함께', 2023, 1)).toMatchObject({ hasMore: true, totalCount: 101 });
    const final = await createCompanyNameLoader(request([together], 101), now)('함께', 2023, 2);
    expect(final).toMatchObject({ hasMore: false, totalCount: 101, page: 2 });
    expect(final.items).toHaveLength(1);
    await expect(createCompanyNameLoader(request([together], 101), now)('함께', 2023, 1)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects invalid keywords, years and page numbers before making an upstream call', async () => {
    const req = request([]), load = createCompanyNameLoader(req, now);
    for (const [keyword, year, page] of [['가', 2023, 1], ['   ', 2023, 1], ['가'.repeat(101), 2023, 1], ['함께\u0000', 2023, 1],
      ['함께', 1899, 1], ['함께', 2027, 1], ['함께', 2023.5, 1], ['함께', 2023, 0], ['함께', 2023, 1.5]] as const) {
      await expect(load(keyword, year, page)).rejects.toMatchObject({ status: 400 });
    }
    expect(req).not.toHaveBeenCalled();
  });
});
