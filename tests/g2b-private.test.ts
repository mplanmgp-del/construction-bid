import { describe, expect, it } from 'vitest';
import { createG2bClient, readProviderPayload } from '../server/g2b';
import { mapPrivateNotice } from '../server/g2b-private';
import fixture from './fixtures/g2b-private-notice.json';

const number = 'R26BK01774453';
const now = () => Date.parse('2026-10-16T12:00:00+09:00');
const rows: Record<string, unknown>[] = fixture.response.body.items;
const response = (items: Record<string, unknown>[], totalCount = items.length) => Response.json({ response: {
  header: { resultCode: '00' }, body: { items, totalCount },
} });
const fields = (detail: Awaited<ReturnType<ReturnType<typeof createG2bClient>['detail']>>) => detail.sections?.flatMap(section => section.fields) || [];

function privateApi(privateRows = rows, totalCount = privateRows.length) {
  const requests: URL[] = [];
  const api = createG2bClient({ serviceKey: 'test', now, fetcher: async input => {
    const url = new URL(String(input)); requests.push(url);
    if (!url.pathname.includes('/PrvtBidNtceService/')) return response([]);
    if (url.pathname.endsWith('getPrvtBidPblancListInfoCnstwk') || url.pathname.endsWith('getPrvtBidPblancListInfoServc')) {
      return response(privateRows, totalCount);
    }
    const identity = { bidNtceNo: number, bidNtceOrd: '001' };
    if (url.pathname.endsWith('getPrvtBidPblancListInfoPrtcptPsblRgn')) return response([{ ...identity, prtcptPsblRgnNm: '경기도' }]);
    if (url.pathname.endsWith('getPrvtBidPblancListInfoLicenseLimit')) return response([{ ...identity, lcnsLmtNm: '구조물해체·비계공사업' }]);
    throw new Error('Unexpected operation');
  } });
  return { api, requests };
}

describe('official private notice number lookup', () => {
  it('finds all private revisions after a complete public empty response and preserves private field meanings', async () => {
    const { api, requests } = privateApi();
    const result = await api.lookupNotices('공사', number);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      id: 'g2b:공사:R26BK01774453:001', number, revision: '001', type: '공사', procurementSource: 'private',
      title: '건물외벽 드라이비트 철거 및 준불연재 재시공 업체선정 입찰공고',
      agency: '주식회사 한국자산보증관리', noticeKind: '변경공고', bidMethod: '직찰', contractMethod: '일반경쟁',
      estimatedPrice: null, plannedAmount: 0, status: '확인필요', revised: true, deadline: '',
      postedAt: '2026-10-16T10:32:23+09:00', openingAt: '2026-11-25T13:00:00+09:00',
      documents: [{ name: '건물외벽 드라이비트 철거, 준불연재 재시공 업체선정 입찰공고(수정, 관리단회의).pdf',
        url: 'https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do?bidPbancNo=R26BK01774453&bidPbancOrd=001&fileType=&fileSeq=1&prcmBsneSeCd=24' }],
    });
    expect(result.items.map(item => item.revision)).toEqual(['001', '000']);
    expect(result.source).toContain('민간');
    expect(requests).toHaveLength(2);
    expect(requests[1].pathname).toBe('/1230000/ao/PrvtBidNtceService/getPrvtBidPblancListInfoCnstwk');
    expect(Object.fromEntries(requests[1].searchParams)).toEqual({ inqryDiv: '4', bidNtceNo: number,
      pageNo: '1', numOfRows: '999', type: 'json', serviceKey: 'test' });
  });

  it.each(['민간일반용역', '민간기술용역'])('routes %s through the service operation and retains cancellation history', async bidNtceClsfc => {
    const { api, requests } = privateApi(rows.map((row, index) => ({ ...row, bidNtceClsfc, ntceDivNm: index ? '취소공고' : '등록공고' })));
    const result = await api.lookupNotices('용역', number);
    expect(result.items[0]).toMatchObject({ type: '용역', revision: '001', status: '취소', procurementSource: 'private' });
    expect(requests[1].pathname).toBe('/1230000/ao/PrvtBidNtceService/getPrvtBidPblancListInfoServc');
  });

  it.each([
    ['partial history', rows.slice(0, 1), 2],
    ['too many revisions', rows.slice(0, 1), 1000],
    ['wrong number', [{ ...rows[0], bidNtceNo: 'OTHER' }], 1],
    ['wrong classification', [{ ...rows[0], bidNtceClsfc: '민간용역' }], 1],
    ['missing classification', [{ ...rows[0], bidNtceClsfc: '' }], 1],
    ['invalid revision', [{ ...rows[0], bidNtceOrd: '' }], 1],
    ['duplicate revision', [rows[0], { ...rows[0], bidNtceOrd: '0' }], 2],
  ] as const)('refuses %s rather than asserting a private latest state', async (_label, items, total) => {
    await expect(privateApi([...items], total).api.lookupNotices('공사', number)).rejects.toMatchObject({ code: 'G2B_INCOMPLETE_RESPONSE' });
  });

  it('does not require private API access for an existing public record', async () => {
    const requests: URL[] = [];
    const api = createG2bClient({ serviceKey: 'test', now, fetcher: async input => {
      const url = new URL(String(input)); requests.push(url);
      if (url.pathname.includes('Prvt')) throw new Error('private service unavailable');
      return response([{ bidNtceNo: number, bidNtceOrd: '000', bidNtceNm: '공공 철거공사', bsnsDivNm: '공사' }]);
    } });
    expect((await api.lookupNotices('공사', number)).items[0].title).toBe('공공 철거공사');
    expect(requests).toHaveLength(1);
  });

  it('keeps a private authorization failure visible instead of returning a false empty result', async () => {
    const api = createG2bClient({ serviceKey: 'test', now, fetcher: async input => new URL(String(input)).pathname.includes('Prvt')
      ? Response.json({ 'nkoneps.com.response.ResponseError': { header: { resultCode: '30', resultMsg: 'secret body' } } }) : response([]) });
    await expect(api.lookupNotices('공사', number)).rejects.toMatchObject({ code: 'G2B_AUTH_ERROR' });
    await expect(api.lookupNotices('공사', number)).rejects.not.toThrow('secret body');
  });
});

describe('private detail integration', () => {
  it('loads exact private regional/license conditions and separates private reference amounts from public pricing', async () => {
    const { api, requests } = privateApi();
    const result = await api.detail(number, '001', '공사');
    expect(result.notice).toMatchObject({ procurementSource: 'private', revision: '001', allowedRegions: ['경기도'], licenses: ['구조물해체·비계공사업'] });
    expect(result).toMatchObject({ allowedRegions: ['경기도'], licenses: ['구조물해체·비계공사업'], regionComplete: true, licenseComplete: true });
    expect(result.sourceUrl).toBe('https://www.g2b.go.kr/');
    expect(fields(result).find(field => field.key === 'bidMethdNm')?.value).toBe('직찰');
    expect(fields(result).find(field => field.key === 'refAmt')?.value).toBeNull();
    expect(fields(result).find(field => field.key === 'asignBdgtAmt')?.value).toBe('0 원');
    expect(fields(result).some(field => ['presmptPrce', 'bssamt', 'insuranceManagementSum'].includes(field.key))).toBe(false);
    const conditions = requests.filter(url => /Prvt.*(?:Rgn|Limit)$/.test(url.pathname));
    expect(conditions).toHaveLength(2);
    for (const url of conditions) expect(Object.fromEntries(url.searchParams)).toMatchObject({ inqryDiv: '2', bidNtceNo: number, bidNtceOrd: '001' });
  });
});

describe('private field allowlist', () => {
  it('does not borrow similarly named public money or deadlines and retains only safe official documents', () => {
    const notice = mapPrivateNotice({ ...rows[0], presmptPrce: '123', bssamt: '456', bidNtceDt: '2026-01-01 00:00:00',
      bdgtAmt: '999', ntceSpecDocNm2: 'unsafe file', ntceSpecDocUrl2: 'https://example.com/file', ntceSpecDocNm3: '',
      ntceSpecDocUrl3: 'https://www.g2b.go.kr/download?file=3', secret: 'PRIVATE' }, '공사', now());
    expect(notice).toMatchObject({ estimatedPrice: null, plannedAmount: 0, deadline: '', postedAt: '2026-10-15T20:33:16+09:00',
      detailUrl: 'https://www.g2b.go.kr/' });
    expect(notice.documents).toContainEqual({ name: 'unsafe file', size: '크기 미제공' });
    expect(notice.documents).toContainEqual({ name: '공고 첨부파일 3', size: '크기 미제공', url: 'https://www.g2b.go.kr/download?file=3' });
    expect(JSON.stringify(notice)).not.toContain('PRIVATE');
    expect(JSON.stringify(notice)).not.toContain('example.com');
  });
});

describe('provider namespaced response errors', () => {
  it.each([['30', 'G2B_AUTH_ERROR'], ['22', 'G2B_QUOTA_EXCEEDED'], ['08', 'G2B_PROVIDER_ERROR']])('classifies a private code %s without exposing provider content', (resultCode, code) => {
    expect(() => readProviderPayload({ 'nkoneps.com.response.ResponseError': { header: { resultCode, resultMsg: 'serviceKey=SECRET' } } })).toThrow(expect.objectContaining({ code }));
  });
});
