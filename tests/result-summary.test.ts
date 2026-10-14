import { afterEach, describe, expect, it, vi } from 'vitest';
import { createG2bClient, mapNotice } from '../server/g2b';
import { handleG2bRequest, nodeApiHandler } from '../server/http';
const identity = { bidNtceNo: 'R26BK01756799', bidNtceOrd: '000', bidClsfcNo: '1', rbidNo: '0' };
const opening = { ...identity, progrsDivCdNm: '개찰완료', opengCorpInfo: '1순위 업체^1111111111^대표^100000^90.1' };
const winner = { ...identity, bidwinnrNm: '최종 업체', bidwinnrBizno: '2222222222', sucsfbidAmt: '110000' };
const response = (items: unknown[]) => Response.json({ response: { header: { resultCode: '00' }, body: { items, totalCount: items.length } } });
const params = () => new URLSearchParams({ number: identity.bidNtceNo, revision: '0', type: '공사' });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('dedicated public result HTTP integration', () => {
  it('keeps demand agency distinct from the announcing agency', () => {
    expect(mapNotice({ ...identity, ntceInsttNm: '공고기관', dminsttNm: '수요기관', ntceKindNm: '등록공고' }, '공사')).toMatchObject({ agency: '공고기관', demandAgency: '수요기관', noticeKind: '등록공고' });
  });
  it('queries exact notice summaries without full participants and reuses provider cache', async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo) => response(new URL(String(url)).pathname.includes('getScsbid') ? [winner] : [opening, { ...opening, bidNtceOrd: '001', opengCorpInfo: '다른 차수^3333333333^대표^100000^90.1' }]));
    const api = createG2bClient({ serviceKey: 'test', fetcher });
    expect(await api.resultSummary(identity.bidNtceNo, '000', '공사', '2026-10-07T12:00:00+09:00')).toMatchObject({ firstCompanies: ['1순위 업체'], winnerCompanies: ['최종 업체'], result: '개찰완료', complete: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url] of fetcher.mock.calls) {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toContain('/ScsbidInfoService/');
      expect(parsed.searchParams.get('bidNtceNo')).toBe(identity.bidNtceNo);
      expect(parsed.searchParams.get('inqryDiv')).toBe('4');
      expect(parsed.searchParams.has('opengBgnDt')).toBe(false);
      expect(parsed.pathname).not.toContain('OpengCompt');
    }
    await api.resultSummary(identity.bidNtceNo, '000', '공사', '2026-10-07T12:00:00+09:00');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not infer a final winner from first rank', async () => {
    const api = createG2bClient({ serviceKey: 'test', fetcher: async url => response(new URL(String(url)).pathname.includes('getScsbid') ? [] : [opening]) });
    expect(await api.resultSummary(identity.bidNtceNo, '000', '공사', '')).toMatchObject({ firstCompanies: ['1순위 업체'], winnerCompanies: [] });
  });
  it('validates identity before traffic and normalizes revisions', async () => {
    const api = createG2bClient({ serviceKey: 'test' });
    const loader = vi.spyOn(api, 'openingResults').mockResolvedValue({ complete: true } as never);
    expect((await handleG2bRequest('/api/opening-results', params(), api)).status).toBe(200);
    expect(loader).toHaveBeenCalledWith({ number: identity.bidNtceNo, revision: '000', type: '공사' }, { archive: false });
    const archive = params(); archive.set('archive', '1');
    expect((await handleG2bRequest('/api/opening-results', archive, api)).status).toBe(200);
    expect(loader).toHaveBeenLastCalledWith({ number: identity.bidNtceNo, revision: '000', type: '공사' }, { archive: true });
    loader.mockClear(); const invalid = params(); invalid.set('revision', 'broken');
    expect((await handleG2bRequest('/api/opening-results', invalid, api)).status).toBe(400);
    expect(loader).not.toHaveBeenCalled();
  });
  it('shares complete public responses briefly; explicit refresh bypasses CDN', async () => {
    vi.stubEnv('G2B_SERVICE_KEY', 'opening-cdn-test');
    vi.stubGlobal('fetch', async () => response([]));
    for (const refresh of [false, true]) {
      const headers = new Map<string,string>(); let body = '';
      const res = { statusCode: 0, setHeader: (key: string, value: string) => { headers.set(key, value); }, end: (value?: string) => { body = value || ''; } };
      await nodeApiHandler({ method: 'GET', url: `/api/opening-results?${params()}${refresh ? '&refresh=1' : ''}`, headers: { 'x-forwarded-for': 'opening-cdn-test' } }, res);
      expect(res.statusCode).toBe(200); expect(JSON.parse(body).complete).toBe(true);
      expect(headers.get('Cache-Control')).toBe('no-store');
      expect(headers.get('Vercel-CDN-Cache-Control')).toBe(refresh ? undefined : 'public, max-age=120');
    }
  });
  it('keeps invalid dates rejected for existing summary callers', async () => {
    const fetcher = vi.fn(); const api = createG2bClient({ serviceKey: 'test', fetcher });
    const query = params(); query.set('openingAt', 'bad');
    expect((await handleG2bRequest('/api/result-summary', query, api)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
