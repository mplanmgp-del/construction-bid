import { describe, expect, it } from 'vitest';
import { createG2bClient, parseSearch } from '../server/g2b';

const params = (changes: Record<string, string> = {}) => new URLSearchParams({
  type: '공사', from: '2026-10-01', to: '2026-10-15', keyword: '철거', ...changes,
});

describe('custom notice query validation', () => {
  it('keeps the existing query shape when optional conditions are absent or blank', () => {
    const expected = { type: '공사', from: '2026-10-01', to: '2026-10-15', keyword: '철거', page: 1, pageSize: 100 };
    expect(parseSearch(params())).toEqual(expected);
    expect(parseSearch(params({ agency: '  ', demandAgency: '', license: '', minAmount: '', maxAmount: '', excludeClosed: '0' }))).toEqual(expected);
  });

  it('normalizes provider-supported conditions and preserves a zero minimum price', () => {
    expect(parseSearch(params({ agency: ' 서울시 ', demandAgency: ' 교육청 ', license: ' 구조물해체·비계공사업 ', minAmount: '0', maxAmount: '9007199254740991', excludeClosed: '1' })))
      .toEqual({ type: '공사', from: '2026-10-01', to: '2026-10-15', keyword: '철거', page: 1, pageSize: 100,
        agency: '서울시', demandAgency: '교육청', license: '구조물해체·비계공사업', minAmount: 0, maxAmount: 9007199254740991, excludeClosed: true });
  });

  it.each(['agency', 'demandAgency', 'license'])('rejects overlong or control-containing %s conditions', field => {
    for (const value of ['가'.repeat(101), '서울\u0000시', '\n서울시', '서울시\u007f']) {
      expect(() => parseSearch(params({ [field]: value }))).toThrow();
    }
  });

  it.each(['minAmount', 'maxAmount'])('rejects invalid or unsafe %s values', field => {
    for (const value of ['-1', '1.5', '1e3', '1,000', 'NaN', 'Infinity', '9007199254740992']) {
      expect(() => parseSearch(params({ [field]: value }))).toThrow();
    }
  });

  it('rejects reversed amount bounds and unsupported closed-notice flags', () => {
    expect(() => parseSearch(params({ minAmount: '101', maxAmount: '100' }))).toThrow();
    for (const value of ['true', 'Y', '2']) expect(() => parseSearch(params({ excludeClosed: value }))).toThrow();
  });
});

describe('custom conditions at the official notice API boundary', () => {
  it.each(['공사', '용역'])('passes supported %s filters to one posting-date API request', async type => {
    const urls: URL[] = [];
    const api = createG2bClient({ serviceKey: 'test', fetcher: async input => {
      urls.push(new URL(String(input)));
      return Response.json({ response: { header: { resultCode: '00' }, body: { items: [], totalCount: 0 } } });
    } });
    const result = await api.notices(parseSearch(params({ type, agency: '서울시', demandAgency: '교육청', license: '해체공사업', minAmount: '0', maxAmount: '100000000', excludeClosed: '1' })));
    expect(result).toMatchObject({ items: [], totalCount: 0, hasMore: false });
    expect(urls).toHaveLength(1);
    expect(urls[0].pathname).toBe(`/1230000/ad/BidPublicInfoService/${type === '공사' ? 'getBidPblancListInfoCnstwkPPSSrch' : 'getBidPblancListInfoServcPPSSrch'}`);
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ inqryDiv: '1', inqryBgnDt: '202610010000', inqryEndDt: '202610152359',
      pageNo: '1', numOfRows: '100', bidNtceNm: '철거', ntceInsttNm: '서울시', dminsttNm: '교육청', indstrytyNm: '해체공사업',
      presmptPrceBgn: '0', presmptPrceEnd: '100000000', bidClseExcpYn: 'Y', type: 'json', serviceKey: 'test' });
  });

  it('omits unspecified conditions from the official request', async () => {
    let outgoing: URL | undefined;
    const api = createG2bClient({ serviceKey: 'test', fetcher: async input => {
      outgoing = new URL(String(input));
      return Response.json({ response: { header: { resultCode: '00' }, body: { items: [], totalCount: 0 } } });
    } });
    await api.notices(parseSearch(params({ excludeClosed: '0' })));
    for (const field of ['ntceInsttNm', 'dminsttNm', 'indstrytyNm', 'presmptPrceBgn', 'presmptPrceEnd', 'bidClseExcpYn']) {
      expect(outgoing?.searchParams.has(field)).toBe(false);
    }
  });
});
