import { describe, expect, it, vi } from 'vitest';
import { createG2bClient, mapNotice } from '../server/g2b';
import { handleG2bRequest } from '../server/http';
const base = { bidNtceNo: 'NOTICE', bidNtceOrd: '000', bsnsDivNm: '공사', opengRsltDivNm: '개찰완료', opengRank: '1', bidprcCorpNm: '1순위 업체', fnlSucsfCorpNm: '최종 업체' };
const response = (items: unknown[], totalCount = items.length) => new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items, totalCount } } }));
describe('list result summary', () => {
  it('keeps demand agency distinct from the announcing agency', () => {
    expect(mapNotice({ ...base, ntceInsttNm: '공고기관', dminsttNm: '수요기관', ntceKindNm: '등록공고' }, '공사')).toMatchObject({ agency: '공고기관', demandAgency: '수요기관', noticeKind: '등록공고' });
  });
  it('joins exact identity and keeps first-ranked and winning companies separate across pages', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response([{ ...base, bidNtceOrd: '001' }, { ...base, bsnsDivNm: '용역' }, { ...base, bidNtceNo: 'OTHER' }, { ...base, bidNtceOrd: '' }], 5)).mockResolvedValueOnce(response([base], 5));
    const api = createG2bClient({ serviceKey: 'test', fetcher });
    const result = await api.resultSummary('NOTICE', '000', '공사', '2026-10-07T12:00:00+09:00');
    expect(result).toMatchObject({ firstCompanies: ['1순위 업체'], winnerCompanies: ['최종 업체'], result: '개찰완료', complete: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const query = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(query.get('opengBgnDt')).toBe('202610071200');
    expect(query.get('opengEndDt')).toBe('202610071200');
    await api.resultSummary('NOTICE', '000', '공사', '2026-10-07T12:00:00+09:00');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not infer a winner from first rank or completion from no results', async () => {
    const api = createG2bClient({ serviceKey: 'test', fetcher: vi.fn().mockResolvedValue(response([{ ...base, fnlSucsfCorpNm: '', sucsfYn: 'N' }])) });
    expect((await api.resultSummary('NOTICE', '000', '공사', '2026-10-07T12:00:00+09:00')).winnerCompanies).toEqual([]);
    expect(await api.resultSummary('MISSING', '000', '공사', '2026-10-07T12:00:00+09:00')).toMatchObject({ firstCompanies: [], winnerCompanies: [], result: '' });
  });
  it('reports bounded incomplete scans without exposing unrelated companies', async () => {
    const fetcher = vi.fn().mockImplementation(async () => response([{ ...base, bidNtceNo: 'OTHER' }], 99999));
    const api = createG2bClient({ serviceKey: 'test', fetcher });
    expect(await api.resultSummary('NOTICE', '000', '공사', '2026-10-07T12:00:00+09:00')).toMatchObject({ complete: false, firstCompanies: [], winnerCompanies: [] });
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
  it('validates opening time before any upstream calls', async () => {
    const fetcher = vi.fn();
    const api = createG2bClient({ serviceKey: 'test', fetcher });
    const result = await handleG2bRequest('/api/result-summary', new URLSearchParams({ number: 'NOTICE', revision: '000', type: '공사', openingAt: 'bad' }), api);
    expect(result.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
