import { describe, expect, it, vi } from 'vitest';
import { createG2bClient, koreanTimestamp, mapNotice, mapResult, money, parseSearch, readProviderPayload, safeG2bUrl } from '../server/g2b';
import { handleG2bRequest } from '../server/http';

const query = () => parseSearch(new URLSearchParams({ type: '공사', from: '2026-10-12', to: '2026-10-12', pageSize: '2' }));
const record = (extra = {}) => ({ bidNtceNo: 'R26BK01764167', bidNtceOrd: '000', bidNtceNm: '별관 철거공사', presmptPrce: '1000000', bidClseDt: '2026-10-21 10:00:00', bidBeginDt: '2026-10-13 09:00:00', ...extra });
const response = (items: unknown[], totalCount = items.length) => new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items, totalCount } } }));

describe('official G2B mapping', () => {
  it('uses estimated price only, preserving zero and missing values', () => {
    expect(mapNotice(record({ presmptPrce: '0', bssAmt: '999' }), '공사').estimatedPrice).toBe(0);
    expect(mapNotice(record({ presmptPrce: '', bssAmt: '999', bdgtAmt: '1000' }), '공사').estimatedPrice).toBeNull();
    expect(money('100,000')).toBe(100000);
    expect(money('9007199254740992')).toBeNull();
    expect(money('-1')).toBeNull();
  });
  it('preserves actual contract methods, source and safe downloadable attachments', () => {
    const mapped = mapNotice(record({ cntrctCnclsMthdNm: '지명경쟁', ntceSpecFileNm1: '한글 공고.hwpx', ntceSpecDocUrl1: 'https://www.g2b.go.kr/download?a=1', stdNtceDocUrl: 'https://www.g2b.go.kr/download?a=1', ntceSpecFileNm2: '악성.hwp', ntceSpecDocUrl2: 'javascript:alert(1)' }), '공사');
    expect(mapped).toMatchObject({ source: 'live', category: '철거·해체', contractMethod: '지명경쟁', documents: [{ name: '한글 공고.hwpx', url: 'https://www.g2b.go.kr/download?a=1' }, { name: '악성.hwp' }] });
    expect(mapped.documents[1].url).toBeUndefined();
  });
  it.each(['javascript:alert(1)', 'https://g2b.go.kr.attacker.example/file', 'https://attacker.example/g2b.go.kr', 'https://user:password@www.g2b.go.kr/file', 'http://www.g2b.go.kr/file', 'https://www.g2b.go.kr:8080/file', 'file:///file'])('rejects untrusted attachment link %s', url => {
    expect(safeG2bUrl(url)).toBeUndefined();
  });
  it('uses Korean time consistently and rejects calendar overflow', () => {
    expect(koreanTimestamp('2026-10-12 14:05')).toBe('2026-10-12T14:05:00+09:00');
    expect(koreanTimestamp('20261012140500')).toBe('2026-10-12T14:05:00+09:00');
    expect(koreanTimestamp('2026-02-30 14:05')).toBe('');
    expect(koreanTimestamp('2026-10-12 99:00')).toBe('');
    expect(mapNotice(record({ bidClseDt: '' }), '공사').status).toBe('확인필요');
    expect(mapNotice(record(), '공사', Date.parse('2026-10-12T09:00:00+09:00')).status).toBe('접수예정');
    expect(mapNotice(record(), '공사', Date.parse('2026-10-21T10:00:00+09:00')).status).toBe('마감');
  });
  it('never uses construction site as participation region and flags joint requirements', () => {
    expect(mapNotice(record({ cnstrtsiteRgnNm: '서울특별시 강남구' }), '공사')).toMatchObject({ province: '서울특별시', district: '강남구', allowedRegions: null });
    expect(mapNotice(record({ rgnDutyJntcontrctYn: 'Y' }), '공사').specialRegionCondition).toBe(true);
    expect(mapNotice(record({ brffcBidprcPermsnYn: 'Y' }), '공사').specialRegionCondition).toBe(true);
    expect(mapNotice(record({ rgnLmtBidLocplcJdgmBssNm: '본사또는참여지사소재지' }), '공사').specialRegionCondition).toBe(true);
  });
  it('maps bidder result separately from the final winner and preserves IDs', () => {
    const mapped = mapResult({ ...record(), opengDate: '2026-10-12', opengTm: '11:00', opengRank: '1', bidprcCorpNm: '가나다', bidprcCorpBizrno: '0012345678', bidprcAmt: '100000', bidprcRt: '89.745', sucsfYn: 'N', fnlSucsfCorpNm: '', fnlSucsfAmt: '' }, '공사');
    expect(mapped).toMatchObject({ businessNumber: '0012345678', rank: '1', awarded: false, winnerName: '', winningAmount: null, bidAmount: 100000, bidRate: 89.745, openingAt: '2026-10-12T11:00:00+09:00' });
  });
});

describe('G2B request validation', () => {
  it.each([
    { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-13', to: '2026-10-12' },
    { from: '2026-09-01', to: '2026-10-12' }, { page: '0' }, { pageSize: '101' }, { type: '물품' }, { keyword: 'a'.repeat(101) },
  ])('rejects malformed or unbounded queries %o', change => {
    const values: Record<string, string> = { type: '공사', from: '2026-10-12', to: '2026-10-12' };
    Object.entries(change).forEach(([key, value]) => { if (value !== undefined) values[key] = value; });
    expect(() => parseSearch(new URLSearchParams(values))).toThrow();
  });
  it('allows at most seven calendar dates for results', () => {
    expect(() => parseSearch(new URLSearchParams({ type: '용역', from: '2026-10-01', to: '2026-10-07' }), 7)).not.toThrow();
    expect(() => parseSearch(new URLSearchParams({ type: '용역', from: '2026-10-01', to: '2026-10-08' }), 7)).toThrow();
  });
  it('normalizes array, nested item, single item and empty provider shapes', () => {
    for (const items of [[record()], { item: [record()] }, { item: record() }]) {
      expect(readProviderPayload({ response: { header: { resultCode: '00' }, body: { items, totalCount: 1 } } }).items).toHaveLength(1);
    }
    expect(readProviderPayload({ response: { header: { resultCode: '00' }, body: { items: '', totalCount: 0 } } }).items).toEqual([]);
    expect(readProviderPayload({ response: { header: { resultCode: '03' } } })).toEqual({ items: [], totalCount: 0 });
    expect(() => readProviderPayload({ response: { header: { resultCode: '00' }, body: { items: '', totalCount: 100 } } })).toThrow();
  });
});

describe('G2B integrations and bounded reads', () => {
  it('bulk-joins only exact number, revision and business type with full pagination metadata', async () => {
    const fetcher = vi.fn(async (url: URL | string | Request) => String(url).includes('PrtcptPsblRgn')
      ? response([{ bidNtceNo: 'R26BK01764167', bidNtceOrd: '000', bsnsDivNm: '공사', prtcptPsblRgnNm: '서울특별시' }, { bidNtceNo: 'R26BK01764167', bidNtceOrd: '001', bsnsDivNm: '공사', prtcptPsblRgnNm: '부산광역시' }, { bidNtceNo: 'R26BK01764167', bidNtceOrd: '000', bsnsDivNm: '용역', prtcptPsblRgnNm: '경기도' }])
      : response([record(), record({ bidNtceNo: 'R26BK01764168' })], 4));
    const result = await createG2bClient({ serviceKey: 'test', fetcher: fetcher as typeof fetch }).notices(query());
    expect(result).toMatchObject({ totalCount: 4, page: 1, pageSize: 2, hasMore: true });
    expect(result.items[0].allowedRegions).toEqual(['서울특별시']);
    expect(result.items[1].allowedRegions).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('deduplicates concurrent requests, reuses bulk region cache, expires after five minutes', async () => {
    let now = 100;
    const fetcher = vi.fn(async (url: URL | string | Request) => String(url).includes('PrtcptPsblRgn') ? response([]) : response([record()]));
    const client = createG2bClient({ serviceKey: 'test', fetcher: fetcher as typeof fetch, now: () => now });
    await Promise.all([client.notices(query()), client.notices(query())]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await client.notices({ ...query(), keyword: '철거' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    now += 300001;
    await client.notices(query());
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('does not classify any partially loaded regional membership as excluded', async () => {
    const fetcher = vi.fn(async (url: URL | string | Request) => String(url).includes('PrtcptPsblRgn')
      ? response([{ ...record(), prtcptPsblRgnNm: '서울특별시' }], 6000) : response([record()]));
    const result = await createG2bClient({ serviceKey: 'test', fetcher: fetcher as typeof fetch }).notices(query());
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(result.items[0].allowedRegions).toBeNull();
    expect(result.warnings?.length).toBe(1);
  });
  it('returns notices with review-required warning when regional endpoint fails', async () => {
    const fetcher = vi.fn(async (url: URL | string | Request) => String(url).includes('PrtcptPsblRgn') ? new Response('invalid', { status: 503 }) : response([record()]));
    const result = await createG2bClient({ serviceKey: 'test', fetcher: fetcher as typeof fetch }).notices(query());
    expect(result.items).toHaveLength(1);
    expect(result.items[0].allowedRegions).toBeNull();
    expect(result.warnings?.[0]).toContain('확인 필요');
  });
  it('bounds the combined region lookup time before the serverless timeout', async () => {
    let clock = Date.now();
    const fetcher = vi.fn(async (url: URL | string | Request) => {
      if (String(url).includes('PrtcptPsblRgn')) {
        clock += 15_000;
        return response([{ ...record(), prtcptPsblRgnNm: '서울특별시' }], 6000);
      }
      return response([record()]);
    });
    const result = await createG2bClient({ serviceKey: 'test', fetcher: fetcher as typeof fetch, now: () => clock }).notices(query());
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.items[0].allowedRegions).toBeNull();
    expect(result.warnings).toHaveLength(1);
  });
  it('returns exact detail without pretending empty regions are nationwide', async () => {
    const fetcher = vi.fn(async (url: URL | string | Request) => String(url).includes('PrtcptPsblRgn') ? response([]) : response([{ ...record(), lcnsLmtNm: '구조물해체·비계공사업' }]));
    const result = await createG2bClient({ serviceKey: 'test', fetcher: fetcher as typeof fetch }).detail('R26BK01764167', '000', '공사');
    expect(result).toMatchObject({ allowedRegions: null, regionComplete: true, licenses: ['구조물해체·비계공사업'], licenseComplete: true });
  });
  it('uses standard-service result date/type parameters and exposes every page', async () => {
    const fetcher = vi.fn(async (_url: URL | string | Request) => response([{ ...record(), opengDate: '2026-10-12', opengTm: '11:00' }], 50000));
    const result = await createG2bClient({ serviceKey: 'test', fetcher: fetcher as typeof fetch }).results(query());
    expect(result).toMatchObject({ totalCount: 50000, hasMore: true });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe('/1230000/ao/PubDataOpnStdService/getDataSetOpnStdScsbidInfo');
    expect(url.searchParams.get('bsnsDivCd')).toBe('3');
    expect(url.searchParams.get('opengEndDt')).toBe('202610122359');
  });
  it('reports missing key explicitly without attempting upstream calls', async () => {
    const fetcher = vi.fn();
    const result = await handleG2bRequest('/api/notices', new URLSearchParams({ type: '공사', from: '2026-10-12', to: '2026-10-12' }), createG2bClient({ fetcher }));
    expect(result).toMatchObject({ status: 503, body: { error: { code: 'G2B_NOT_CONFIGURED' } } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['json', 'xml', 'network'])('never leaks service keys or upstream bodies for %s failures', async format => {
    const secret = 'TOP_SECRET_KEY';
    const fetcher = vi.fn(async () => {
      if (format === 'network') throw new Error(`https://example.com?serviceKey=${secret}`);
      return new Response(format === 'xml' ? `<returnReasonCode>30</returnReasonCode><error>${secret}</error>` : JSON.stringify({ OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: '30', returnAuthMsg: secret } } }), { status: 403 });
    });
    const client = createG2bClient({ serviceKey: secret, fetcher: fetcher as typeof fetch });
    const result = await handleG2bRequest('/api/notices', new URLSearchParams({ type: '공사', from: '2026-10-12', to: '2026-10-12' }), client);
    expect(result.status).toBe(format === 'network' ? 504 : 503);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
