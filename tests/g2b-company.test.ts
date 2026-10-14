import { describe, expect, it, vi } from 'vitest';
import { createCompanyLoader } from '../server/g2b-company';
import type { RelatedRequest } from '../server/g2b-related';

const biz = '0012345678';
const basic = { bizno: biz, corpNm: '공개 건설', ceoNm: '홍길동', adrs: '서울시', dtlAdrs: '광진구', telNo: '02-123-4567', rgstDt: '2020-01-01 00:00:00', corpBsnsDivNm: '공사', chgDt: '2026-10-14 10:00:00', privateEmail: 'secret@example.test' };
const basicOp = 'getPrcrmntCorpBasicInfo02';
const licenseOp = 'getPrcrmntCorpIndstrytyInfo02';
const productOp = 'getPrcrmntCorpSplyPrdctInfo02';
const page = (items: Record<string, unknown>[], totalCount = items.length) => ({ items, totalCount });
const request = (override?: RelatedRequest) => vi.fn<RelatedRequest>(override || (async (_base, op) => op === basicOp ? page([basic]) : page([])));

describe('public company loader', () => {
  it('uses exact business-number operations and only public allowlisted fields', async () => {
    const req = request(async (_base, op) => op === basicOp ? page([basic]) : op === licenseOp ? page([{ bizno: biz, indstrytyNm: '해체공사업', indstrytyCd: '4990', indstrytyStatsNm: '등록' }]) : page([{ bizno: biz, dtilPrdctClsfcNoNm: '공급품목', dtilPrdctClsfcNo: '1234567890' }]));
    const result = await createCompanyLoader(req)(biz);
    expect(result.company).toMatchObject({ businessNumber: biz, name: '공개 건설', representative: '홍길동', address: '서울시 광진구', companyType: '공사', licenses: ['해체공사업 (4990) · 등록'], products: ['공급품목 (1234567890)'] });
    expect(result.warnings).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('secret@example.test');
    expect(req.mock.calls.map(call => [call[1], call[2].inqryDiv, call[2].bizno])).toEqual([[basicOp, '3', biz], [licenseOp, '1', biz], [productOp, '1', biz]]);
  });
  it('rejects invalid IDs before any provider call and never strips arbitrary characters', async () => {
    const req = request();
    await expect(createCompanyLoader(req)('123-45-67890')).rejects.toThrow();
    await expect(createCompanyLoader(req)('abc0012345678')).rejects.toThrow();
    expect(req).not.toHaveBeenCalled();
  });
  it('returns null only for a genuinely empty basic response and propagates basic failure', async () => {
    const req = request(async () => page([]));
    expect(await createCompanyLoader(req)(biz)).toEqual({ company: null, warnings: [] });
    expect(req).toHaveBeenCalledTimes(1);
    const failure = new Error('provider failed');
    await expect(createCompanyLoader(request(async () => { throw failure; }))(biz)).rejects.toBe(failure);
  });
  it('does not confuse a different company response with company absence', async () => {
    await expect(createCompanyLoader(request(async () => page([{ ...basic, bizno: '9999999999' }])))(biz)).rejects.toThrow();
  });
  it('checks bizno on every subsidiary row and preserves leading zeros', async () => {
    const req = request(async (_base, op) => op === basicOp ? page([basic]) : op === licenseOp ? page([{ bizno: biz, indstrytyNm: '정상' }, { bizno: '9999999999', indstrytyNm: '타사' }, { indstrytyNm: '번호 없음' }]) : page([{ bizno: '9999999999', dtilPrdctClsfcNoNm: '타사 품목' }]));
    const result = await createCompanyLoader(req)(biz);
    expect(result.company?.licenses).toEqual(['정상']);
    expect(result.company?.products).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });
  it('loads each page and deduplicates displayed registrations', async () => {
    const req = request(async (_base, op, params) => op === basicOp ? page([basic]) : op === productOp ? page([]) : params.pageNo === '1' ? page(Array.from({ length: 100 }, (_, i) => ({ bizno: biz, indstrytyNm: `업종${i}` })), 101) : page([{ bizno: biz, indstrytyNm: '업종100' }], 101));
    const result = await createCompanyLoader(req)(biz);
    expect(result.company?.licenses).toHaveLength(101);
    expect(result.warnings).toEqual([]);
    expect(req.mock.calls.filter(call => call[1] === licenseOp).map(call => call[2].pageNo)).toEqual(['1', '2']);
  });
  it('keeps basic and successful license fields when product requests fail, without leaking errors', async () => {
    const req = request(async (_base, op) => { if (op === productOp) throw new Error('serviceKey=secret'); return op === basicOp ? page([basic]) : page([{ bizno: biz, indstrytyNm: '해체' }]); });
    const result = await createCompanyLoader(req)(biz);
    expect(result.company?.licenses).toEqual(['해체']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('공급품목');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('warns about capped or interrupted pages rather than claiming a complete empty list', async () => {
    const req = request(async (_base, op, params) => op === basicOp ? page([basic]) : op === productOp ? page([]) : page([{ bizno: biz, indstrytyNm: `업종${params.pageNo}` }], 1000));
    const result = await createCompanyLoader(req)(biz);
    expect(result.company?.licenses.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.includes('전체'))).toBe(true);
    expect(req.mock.calls.filter(call => call[1] === licenseOp).length).toBeLessThanOrEqual(10);
  });
  it('stops when the provider repeats a page and reports incomplete data', async () => {
    const req = request(async (_base, op) => op === basicOp ? page([basic]) : op === productOp ? page([]) : page([{ bizno: biz, indstrytyNm: '같은 업종' }], 10));
    const result = await createCompanyLoader(req)(biz);
    expect(result.company?.licenses).toEqual(['같은 업종']);
    expect(result.warnings).toHaveLength(1);
    expect(req.mock.calls.filter(call => call[1] === licenseOp)).toHaveLength(2);
  });
  it('chooses the head office rather than another registered branch of the same business', async () => {
    const req = request(async (_base, op) => op === basicOp ? page([{ ...basic, corpNm: '지점', hdoffceDivNm: '지점', chgDt: '2026-10-14' }, { ...basic, corpNm: '본사', hdoffceDivNm: '본사', chgDt: '2026-10-01' }]) : page([]));
    expect((await createCompanyLoader(req)(biz)).company?.name).toBe('본사');
  });
});
