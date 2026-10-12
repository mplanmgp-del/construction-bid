import { describe, expect, it, vi } from 'vitest';
import { contractMatches, createRelatedLoader, readOfficialList, type RelatedRequest } from '../server/g2b-related';
import type { G2bRelatedDetail } from '../src/g2b-types';

const identity = { bidNtceNo: 'R26BK01764541', bidNtceOrd: '000' };
const general = { ...identity, ntceInsttCd: '5530307', dminsttCd: '5530307' };
const process = {
  ...identity, bidNtceNm: '우수관로 공사', orderPlanNo: 'PLAN-1', bfSpecRgstNo: 'SPEC-1',
  bidwinrInfoList: '[1^공개 낙찰회사^0012345678^개인대표명^0^89.745^7^2026-10-16 11:00]',
  cntrctInfoList: '[1^CONTRACT-1^우수관로 계약^화성시^화성시 맑은물사업소^수의계약^63620000^2026-10-20]',
};
const contract = { ntceNo: 'R26BK01764541000', dcsnCntrctNo: 'CONTRACT-1', untyCntrctNo: 'UNIFIED-1', cnstwkNm: '우수관로 계약', totCntrctAmt: '63620000', thtmCntrctAmt: '0', bsnsDivNm: '공사', cntrctInfoUrl: 'https://www.g2b.go.kr/contract/one' };
const agency = { dminsttCd: '5530307', dminsttNm: '화성시 맑은물사업소', telNo: '031-000-0000', adrs: '경기도 화성시', dtlAdrs: '공공청사', privatePassword: 'SECRET' };
type Rows = Record<string, unknown>[];
function requester(changes: Record<string, Rows | Error | { items: Rows; totalCount: number }> = {}) {
  const table: Record<string, Rows | Error | { items: Rows; totalCount: number }> = {
    getBidPblancListInfoCnstwk: [general], getCntrctProcssIntgOpenCnstwk: [process], getCntrctInfoListCnstwkPPSSrch: [contract], getDminsttInfo02: [agency], ...changes,
  };
  return vi.fn<RelatedRequest>(async (_base, operation) => {
    const rows = table[operation] ?? [];
    if (rows instanceof Error) throw rows;
    return Array.isArray(rows) ? { items: rows, totalCount: rows.length } : rows;
  });
}
const load = (request: RelatedRequest) => createRelatedLoader(request, () => Date.parse('2026-10-12T12:00:00+09:00'))(identity.bidNtceNo, identity.bidNtceOrd, '공사');
const group = (result: G2bRelatedDetail, id: string) => result.groups.find(item => item.id === id)!;
const value = (result: G2bRelatedDetail, groupId: string, key: string) => group(result, groupId).records.flatMap(record => record.fields).find(field => field.key === key)?.value;

describe('related official service integration', () => {
  it('links exact public process, contracts and deduplicated agency codes with formatted zero amounts', async () => {
    const request = requester();
    const result = await load(request);
    expect(result.groups.map(item => [item.id, item.status])).toEqual([['process', 'ok'], ['awards', 'ok'], ['contracts', 'ok'], ['agencies', 'ok'], ['contractHistory', 'empty']]);
    expect(request).toHaveBeenCalledTimes(6);
    expect(request.mock.calls.filter(call => call[1] === 'getDminsttInfo02')).toHaveLength(1);
    expect(request.mock.calls.find(call => call[1] === 'getDminsttInfo02')?.[0]).toBe('https://apis.data.go.kr/1230000/ao/UsrInfoService02/');
    expect(request.mock.calls.find(call => call[1] === 'getDminsttInfo02')?.[2]).toMatchObject({ inqryDiv: '2', inqryBgnDt: '202510130000', inqryEndDt: '202610122359' });
    expect(value(result, 'agencies', 'role')).toBe('공고 기관 · 수요 기관');
    expect(value(result, 'awards', 'amount')).toBe('0 원');
    expect(value(result, 'contracts', 'totCntrctAmt')).toBe('63,620,000 원');
    expect(value(result, 'contracts', 'thtmCntrctAmt')).toBe('0 원');
    expect(group(result, 'contracts').records).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('개인대표명');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result.warnings).toEqual([]);
  });
  it('never attaches a different revision, business type, contract or institution from broad provider results', async () => {
    const result = await load(requester({
      getCntrctProcssIntgOpenCnstwk: [{ ...process, bidNtceOrd: '001' }, { ...process, bsnsDivNm: '용역' }],
      getCntrctInfoListCnstwkPPSSrch: [{ ...contract, ntceNo: 'R26BK01764541001' }, { ...contract, ntceNo: 'R26BK01764541' }, { ...contract, bsnsDivNm: '용역' }],
      getDminsttInfo02: [{ ...agency, dminsttCd: 'OTHER' }],
    }));
    expect(group(result, 'process')).toMatchObject({ status: 'unavailable', records: [] });
    expect(group(result, 'awards')).toMatchObject({ status: 'unavailable', records: [] });
    expect(group(result, 'contracts')).toMatchObject({ status: 'unavailable', records: [] });
    expect(group(result, 'agencies')).toMatchObject({ status: 'unavailable', records: [] });
  });
  it('requires exact process linkage before accepting a contract with an omitted revision', async () => {
    const result = await load(requester({ getCntrctInfoListCnstwkPPSSrch: [{ ...contract, ntceNo: 'R26BK01764541' }] }));
    expect(value(result, 'contracts', 'untyCntrctNo')).toBe('UNIFIED-1');
    const unrelated = await load(requester({ getCntrctInfoListCnstwkPPSSrch: [{ ...contract, ntceNo: 'R26BK01764541', dcsnCntrctNo: 'OTHER' }] }));
    expect(group(unrelated, 'contracts').records.every(record => record.id.startsWith('process-contract-'))).toBe(true);
  });
  it('keeps successful process and contract fallback data when another service is not approved', async () => {
    const result = await load(requester({ getCntrctInfoListCnstwkPPSSrch: new Error('serviceKey=SECRET'), getDminsttInfo02: new Error('serviceKey=SECRET') }));
    expect(group(result, 'process').status).toBe('ok');
    expect(group(result, 'awards').status).toBe('ok');
    expect(group(result, 'contracts').status).toBe('ok');
    expect(value(result, 'contracts', 'contractAmount')).toBe('63,620,000 원');
    expect(group(result, 'agencies').status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result.warnings.length).toBeGreaterThan(0);
  });
  it('distinguishes zero public results from unavailable institution registration coverage', async () => {
    const result = await load(requester({ getCntrctProcssIntgOpenCnstwk: [], getCntrctInfoListCnstwkPPSSrch: [], getDminsttInfo02: [] }));
    expect(group(result, 'process').status).toBe('empty');
    expect(group(result, 'awards').status).toBe('empty');
    expect(group(result, 'contracts').status).toBe('empty');
    expect(group(result, 'agencies').status).toBe('unavailable');
    expect(group(result, 'agencies').message).toContain('기관 미등록을 뜻하지 않습니다');
  });
  it('only derives institution lookup keys from one complete exact general notice', async () => {
    const request = requester({ getBidPblancListInfoCnstwk: [{ ...general, bidNtceOrd: '001', dminsttCd: 'ATTACKER' }] });
    const result = await load(request);
    expect(request.mock.calls.some(call => call[1] === 'getDminsttInfo02')).toBe(false);
    expect(group(result, 'agencies').status).toBe('unavailable');
  });
  it('passes bounded timeouts, stops dependent lookups after the deadline, and sanitizes external links', async () => {
    let clock = 0;
    const request = requester({ getCntrctInfoListCnstwkPPSSrch: [{ ...contract, cntrctInfoUrl: 'https://evil.example/secret', cntrctDtlInfoUrl: 'javascript:alert(1)' }] });
    const wrapped: RelatedRequest = async (...args) => { const result = await request(...args); clock = 31_000; return result; };
    const result = await createRelatedLoader(wrapped, () => clock)(identity.bidNtceNo, identity.bidNtceOrd, '공사');
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every(call => Number(call[3]) <= 12_000)).toBe(true);
    expect(group(result, 'agencies').status).toBe('unavailable');
    expect(group(result, 'contracts').records[0].sourceUrl).toBeUndefined();
  });
  it('reports truncated or malformed provider lists rather than moving the wrong cell into a price', async () => {
    const result = await load(requester({ getCntrctProcssIntgOpenCnstwk: { items: [{ ...process, bidwinrInfoList: '[1^업체^번호^이름^100^90^2026-10-12]', cntrctInfoList: 'unstructured text' }], totalCount: 101 } }));
    expect(group(result, 'awards').status).toBe('unavailable');
    expect(group(result, 'awards').records).toHaveLength(0);
    expect(result.warnings.some(warning => warning.includes('형식'))).toBe(true);
    expect(result.warnings.some(warning => warning.includes('첫 100건'))).toBe(true);
  });
  it('parses contract company roles, shares and demand institutions without exposing private party-name columns', async () => {
    const result = await load(requester({ getCntrctInfoListCnstwkPPSSrch: [{ ...contract,
      corpList: '[1^대표^단독^공개 업체명^대표자 비표시^대한민국^100^채권자 비표시^담당자 비표시^0012345678]',
      dminsttList: '[1^5530307^화성시 맑은물사업소^지방자치단체^운영부서^담당자 비표시^031-111-1111]',
    }] }));
    expect(value(result, 'contracts', 'company-0-name')).toBe('공개 업체명');
    expect(value(result, 'contracts', 'company-0-role')).toBe('대표');
    expect(value(result, 'contracts', 'company-0-share')).toBe('100%');
    expect(value(result, 'contracts', 'company-0-businessNumber')).toBe('0012345678');
    expect(value(result, 'contracts', 'demand-0-name')).toBe('화성시 맑은물사업소');
    expect(JSON.stringify(result)).not.toContain('비표시');
  });
  it('queries history only for proven unified contract IDs and rejects unrelated history records', async () => {
    const request = requester({
      getCntrctInfoListCnstwkChgHstry: [{ ...contract, chgDt: '2026-10-22 10:00', totCntrctAmt: '70000000' }, { ...contract, untyCntrctNo: 'OTHER', totCntrctAmt: '999' }],
      getCntrctInfoListCnstwkDltHstry: [{ untyCntrctNo: 'UNIFIED-1', dcsnCntrctNo: 'CONTRACT-1', dltDt: '2026-10-23 10:00', chgDivNm: '삭제' }, { untyCntrctNo: 'OTHER', dltDt: '2099-01-01' }],
    });
    const result = await load(request);
    expect(group(result, 'contractHistory')).toMatchObject({ status: 'ok' });
    expect(group(result, 'contractHistory').records).toHaveLength(2);
    expect(value(result, 'contractHistory', 'totCntrctAmt')).toBe('70,000,000 원');
    expect(value(result, 'contracts', 'totCntrctAmt')).toBe('63,620,000 원');
    for (const call of request.mock.calls.filter(call => /Hstry$/.test(call[1]))) expect(call[2]).toMatchObject({ inqryDiv: '2', untyCntrctNo: 'UNIFIED-1' });
  });
  it('limits history fanout to three linked contracts and clearly marks remaining histories incomplete', async () => {
    const request = requester({ getCntrctInfoListCnstwkPPSSrch: Array.from({ length: 5 }, (_, index) => ({ ...contract, untyCntrctNo: `UNIFIED-${index}`, dcsnCntrctNo: `CONTRACT-${index}` })) });
    const result = await load(request);
    expect(request.mock.calls.filter(call => /Hstry$/.test(call[1]))).toHaveLength(6);
    expect(group(result, 'contractHistory').status).toBe('unavailable');
    expect(group(result, 'contractHistory').message).toContain('최대 3건');
    expect(result.warnings.some(warning => warning.includes('변경·삭제'))).toBe(true);
  });
  it('falls back through at most three non-overlapping annual agency change windows', async () => {
    const normal = requester();
    let agencyCalls = 0;
    const request = vi.fn<RelatedRequest>(async (...args) => {
      if (args[1] === 'getDminsttInfo02' && ++agencyCalls < 3) return { items: [], totalCount: 0 };
      return normal(...args);
    });
    const result = await load(request);
    const calls = request.mock.calls.filter(call => call[1] === 'getDminsttInfo02');
    expect(calls).toHaveLength(3);
    expect(calls.map(call => [call[2].inqryBgnDt, call[2].inqryEndDt])).toEqual([
      ['202510130000', '202610122359'], ['202410130000', '202510122359'], ['202310140000', '202410122359'],
    ]);
    expect(value(result, 'agencies', 'lookupPeriod')).toBe('2023-10-14 ~ 2024-10-12 (변경일 기준)');
    expect(group(result, 'agencies').status).toBe('ok');
    const absent = requester({ getDminsttInfo02: [] });
    const missing = await load(absent);
    expect(absent.mock.calls.filter(call => call[1] === 'getDminsttInfo02')).toHaveLength(3);
    expect(group(missing, 'agencies').status).toBe('unavailable');
  });
});

describe('official linkage parsers', () => {
  it('handles documented multiple caret records and rejects extra unparsed data', () => {
    expect(readOfficialList('[1^a^b^c^d^e^f^g], [2^a^b^c^d^e^f^g]')).toMatchObject({ rows: [expect.any(Array), expect.any(Array)], malformed: false });
    expect(readOfficialList('')).toEqual({ rows: [], malformed: false });
    expect(readOfficialList('[1^a^b^c^d^e^f^g] unexpected').malformed).toBe(true);
    expect(readOfficialList('[1^a^b]')).toEqual({ rows: [], malformed: true });
  });
  it('accepts explicit legacy two-digit and modern three-digit revisions, never prefix matches', () => {
    expect(contractMatches({ ntceNo: '2016081387600' }, '20160813876', '000', new Set())).toBe(true);
    expect(contractMatches({ ntceNo: 'R26BK01764541-000' }, identity.bidNtceNo, '000', new Set())).toBe(true);
    expect(contractMatches({ ntceNo: 'R26BK01764541-001' }, identity.bidNtceNo, '000', new Set())).toBe(false);
    expect(contractMatches({ ntceNo: identity.bidNtceNo }, identity.bidNtceNo, '000', new Set())).toBe(false);
  });
});
