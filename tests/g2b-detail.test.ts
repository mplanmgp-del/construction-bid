import { describe, expect, it, vi } from 'vitest';
import { createG2bClient } from '../server/g2b';
import { mapDetailSections } from '../server/g2b-detail';
import type { G2bDetailSection } from '../src/g2b-types';

const id = { bidNtceNo: 'R26BK01764541', bidNtceOrd: '000' };
const general = { ...id, bidNtceNm: '우수관로 정비공사', presmptPrce: '57836364', bdgtAmt: '94340000', VAT: '5783636', indstrytyEvlRt: '', govcnstrtnGovsplyMtrlAmt: '0' };
const base = { ...id, bssamt: '63620000', bssAmtPurcnstcst: '', bidClsfcNo: '0', bidPrceCalclAYn: 'Y', npnInsrprm: '812252', mrfnHealthInsrprm: '614746', rtrfundNon: '0', odsnLngtrmrcprInsrprm: '80777', sftyMngcst: '1194035', sftyChckMngcst: '2046980', qltyMngcst: '0', rsrvtnPrceRngBgnRate: '-3', rsrvtnPrceRngEndRate: '+3' };
const response = (items: unknown[], totalCount = items.length) => new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items, totalCount } } }));
const value = (sections: G2bDetailSection[] | undefined, key: string) => sections?.flatMap(section => section.fields).find(field => field.key === key)?.value;
function fetchByOperation(overrides: Record<string, unknown[] | Error> = {}) {
  const rows: Record<string, unknown[] | Error> = {
    getBidPblancListInfoCnstwk: [general], getBidPblancListInfoCnstwkBsisAmount: [base],
    getBidPblancListInfoPrtcptPsblRgn: [{ ...id, bsnsDivNm: '공사', prtcptPsblRgnNm: '경기도 화성시' }],
    getBidPblancListInfoLicenseLimit: [{ ...id, bsnsDivNm: '공사', lcnsLmtNm: '상ㆍ하수도설비공사업/4996' }],
    ...overrides,
  };
  return vi.fn(async (url: URL | Request | string) => {
    const row = rows[new URL(String(url)).pathname.split('/').at(-1)!] || [];
    if (row instanceof Error) throw row;
    return response(row);
  });
}
const detail = (fetcher: ReturnType<typeof fetchByOperation>) => createG2bClient({ serviceKey: 'test', fetcher: fetcher as typeof fetch }).detail(id.bidNtceNo, id.bidNtceOrd, '공사');

describe('complete official notice detail', () => {
  it('joins four exact queries without changing estimated price or original attachments', async () => {
    const fetcher = fetchByOperation({ getBidPblancListInfoCnstwk: [{ ...general, ntceSpecFileNm1: '공고.hwpx', ntceSpecDocUrl1: 'https://www.g2b.go.kr/download?file=1' }] });
    const result = await detail(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const [input] of fetcher.mock.calls) {
      const url = new URL(String(input));
      expect(url.searchParams.get('inqryDiv')).toBe('2');
      expect(url.searchParams.get('bidNtceNo')).toBe(id.bidNtceNo);
      expect(url.searchParams.get('bidNtceOrd')).toBe('000');
    }
    expect(result.notice).toMatchObject({ estimatedPrice: 57836364, allowedRegions: ['경기도 화성시'], licenses: ['상ㆍ하수도설비공사업/4996'], documents: [{ name: '공고.hwpx', url: 'https://www.g2b.go.kr/download?file=1' }] });
    expect(result.sourceUrl).toBe('https://www.g2b.go.kr/link/PNPE027_01/?bidPbancNo=R26BK01764541&bidPbancOrd=000');
    expect(value(result.sections, 'presmptPrce')).toBe('57,836,364 원');
    expect(value(result.sections, 'bssamt')).toBe('63,620,000 원');
    expect(value(result.sections, 'insuranceManagementSum')).toBe('4,748,790 원');
    expect(result.warnings).toEqual([]);
    expect(result.licenseCodes).toEqual(['4996']);
    expect(result.notice?.licenseCodes).toEqual(['4996']);
  });
  it('rejects wrong number, revision, missing revision and wrong business type rather than taking row order', async () => {
    const invalid = [
      { ...general, bidNtceNo: 'OTHER', presmptPrce: '1' }, { ...general, bidNtceOrd: '001', presmptPrce: '2' },
      { ...general, bidNtceOrd: '', presmptPrce: '3' }, { ...general, bsnsDivNm: '용역', presmptPrce: '4' },
    ];
    const result = await detail(fetchByOperation({ getBidPblancListInfoCnstwk: [...invalid, general], getBidPblancListInfoCnstwkBsisAmount: invalid.map(row => ({ ...row, bssamt: '123' })) }));
    expect(result.notice?.estimatedPrice).toBe(57836364);
    expect(value(result.sections, 'bssamt')).toBeNull();
    const noExact = await detail(fetchByOperation({ getBidPblancListInfoCnstwk: invalid }));
    expect(noExact.notice).toBeUndefined();
    expect(value(noExact.sections, 'presmptPrce')).toBeNull();
    expect(noExact.warnings.some(warning => warning.includes('일반 상세정보'))).toBe(true);
  });
  it('does not borrow base price or budget when official estimated price is missing', async () => {
    const result = await detail(fetchByOperation({ getBidPblancListInfoCnstwk: [{ ...general, presmptPrce: '' }] }));
    expect(result.notice?.estimatedPrice).toBeNull();
    expect(value(result.sections, 'presmptPrce')).toBeNull();
    expect(value(result.sections, 'bdgtAmt')).toBe('94,340,000 원');
    expect(value(result.sections, 'bssamt')).toBe('63,620,000 원');
  });
  it('keeps independent successful sections on partial provider failure', async () => {
    const result = await detail(fetchByOperation({ getBidPblancListInfoCnstwk: new Error('offline'), getBidPblancListInfoLicenseLimit: new Error('offline') }));
    expect(result.notice).toBeUndefined();
    expect(result.allowedRegions).toEqual(['경기도 화성시']);
    expect(result.regionComplete).toBe(true);
    expect(result.licenseComplete).toBe(false);
    expect(value(result.sections, 'bssamt')).toBe('63,620,000 원');
    expect(result.warnings).toHaveLength(2);
    const mainOnly = await detail(fetchByOperation({ getBidPblancListInfoPrtcptPsblRgn: new Error('offline'), getBidPblancListInfoLicenseLimit: new Error('offline'), getBidPblancListInfoCnstwkBsisAmount: new Error('offline') }));
    expect(mainOnly.notice?.title).toBe('우수관로 정비공사');
    expect(mainOnly.allowedRegions).toBeNull();
    expect(value(mainOnly.sections, 'bssamt')).toBeNull();
    expect(mainOnly.warnings).toHaveLength(3);
  });
  it('reports total provider failure and does not leak a credential-bearing error', async () => {
    const failed = Object.fromEntries(['getBidPblancListInfoCnstwk', 'getBidPblancListInfoCnstwkBsisAmount', 'getBidPblancListInfoPrtcptPsblRgn', 'getBidPblancListInfoLicenseLimit'].map(op => [op, new Error('serviceKey=TOP_SECRET')]));
    await expect(detail(fetchByOperation(failed))).rejects.toMatchObject({ code: 'G2B_UNAVAILABLE' });
    await expect(detail(fetchByOperation(failed))).rejects.not.toThrow('TOP_SECRET');
  });
  it('keeps separate base-amount rows and refuses ambiguous duplicate general records', async () => {
    const result = await detail(fetchByOperation({ getBidPblancListInfoCnstwk: [general, { ...general, presmptPrce: '999' }], getBidPblancListInfoCnstwkBsisAmount: [base, { ...base, bidClsfcNo: '1', bssamt: '999', npnInsrprm: '' }] }));
    expect(result.notice).toBeUndefined();
    expect(result.sections?.find(section => section.id === 'baseAmount')?.fields[0].value).toBe('2건');
    expect(value(result.sections?.filter(section => section.id === 'baseAmount-1'), 'bssamt')).toBe('63,620,000 원');
    expect(value(result.sections?.filter(section => section.id === 'baseAmount-2'), 'bssamt')).toBe('999 원');
    expect(value(result.sections?.filter(section => section.id === 'baseAmount-2'), 'insuranceManagementSum')).toBeNull();
  });
});

describe('detail field semantics', () => {
  it('distinguishes omitted values, explicit zeros and negative/positive percent bounds', () => {
    const sections = mapDetailSections({ row: { ...general, indstrytyLmtYn: 'N', pqApplDocRcptMthdNm: '', refNo: '참조번호' }, type: '공사', baseRows: [base] });
    expect(value(sections, 'indstrytyEvlRt')).toBeNull();
    expect(value(sections, 'bssAmtPurcnstcst')).toBeNull();
    expect(value(sections, 'govcnstrtnGovsplyMtrlAmt')).toBe('0 원');
    expect(value(sections, 'indstrytyLmtYn')).toBe('아니오');
    expect(value(sections, 'pqApplDocRcptMthdNm')).toBeNull();
    expect(value(sections, 'rsrvtnPrceRngBgnRate')).toBe('-3%');
    expect(value(sections, 'rsrvtnPrceRngEndRate')).toBe('+3%');
    expect(value(sections, 'relatedNotice')).toBeNull();
  });
  it('does not calculate partial insurance sums or retain unlisted private provider fields', () => {
    const sections = mapDetailSections({ row: { ...general, password: 'secret', privateInternalMemo: 'secret' }, type: '공사', baseRows: [{ ...base, qltyMngcst: '' }] });
    expect(value(sections, 'insuranceManagementSum')).toBeNull();
    expect(JSON.stringify(sections)).not.toContain('secret');
  });
  it('keeps official-page-only fields and unreported trade collections visibly unknown', () => {
    const sections = mapDetailSections({ row: general, type: '공사' });
    for (const key of ['constructionPeriod', 'contractType', 'crossMarketReason', 'subcontractAllowed', 'mainFieldRestriction', 'siteBriefingRestriction', 'gradeRestriction', 'bidAmountCeiling', 'longTermContract', 'bidItemProgram', 'quantityStatement', 'reviewGuideline', 'surveyStatement', 'priorSpecificationPrivateReason', 'demandContactName', 'demandContactPhone', 'demandContactFax']) {
      expect(value(sections, key)).toBeNull();
    }
    expect(sections.find(section => section.id === 'tradeShares')?.fields.every(field => field.value === null)).toBe(true);
    const emptySubTrades = sections.find(section => section.id === 'subTrades')!;
    expect(emptySubTrades.fields).toEqual([expect.objectContaining({ key: 'subTradeInformation', value: null })]);
    expect(JSON.stringify(emptySubTrades)).not.toContain('0건');
    const subTrades = mapDetailSections({ row: { ...general, subsiCnsttyNm2: '전기공사', subsiCnsttyIndstrytyEvlRt2: '0' }, type: '공사' });
    expect(value(subTrades, 'subsiCnsttyNm2')).toBe('전기공사');
    expect(value(subTrades, 'subsiCnsttyIndstrytyEvlRt2')).toBe('0%');
    expect(value(subTrades, 'subTradeInformation')).toBeUndefined();
  });
});
