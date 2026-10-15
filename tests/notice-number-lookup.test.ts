import { describe, expect, it } from 'vitest';
import { createG2bClient } from '../server/g2b';
import { handleG2bRequest } from '../server/http';

const number = 'R26BK01359594';
const now = () => Date.parse('2026-10-15T12:00:00+09:00');
const row = (revision: string, changes: Record<string, unknown> = {}) => ({
  bidNtceNo: number, bidNtceOrd: revision, bidNtceNm: '구조물 철거 공사', bsnsDivNm: '공사',
  bidNtceDt: '2026-02-26 17:23:00', bidBeginDt: '2026-02-27 10:00:00', bidClseDt: '2027-03-05 10:00:00',
  ntceKindNm: '등록공고', ...changes,
});
const apiWith = (items: Record<string, unknown>[], totalCount = items.length) => createG2bClient({ serviceKey: 'test', now,
  fetcher: async () => Response.json({ response: { header: { resultCode: '00' }, body: { items, totalCount } } }),
});

describe('notice-number lookup without a publication-date cutoff', () => {
  it.each(['공사', '용역'] as const)('requests all %s revisions without a date or revision parameter', async type => {
    const outgoing: URL[] = [];
    const api = createG2bClient({ serviceKey: 'test', now, fetcher: async input => {
      outgoing.push(new URL(String(input)));
      return Response.json({ response: { header: { resultCode: '00' }, body: {
        items: [row('000', { bsnsDivNm: type }), row('001', { bsnsDivNm: type, ntceKindNm: '취소공고' })], totalCount: 2,
      } } });
    } });
    const result = await api.lookupNotices(type, number);
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].pathname).toBe(`/1230000/ad/BidPublicInfoService/${type === '공사' ? 'getBidPblancListInfoCnstwk' : 'getBidPblancListInfoServc'}`);
    expect(Object.fromEntries(outgoing[0].searchParams)).toEqual({ inqryDiv: '2', bidNtceNo: number,
      pageNo: '1', numOfRows: '999', type: 'json', serviceKey: 'test' });
    expect(result).toMatchObject({ totalCount: 2, page: 1, pageSize: 999, hasMore: false, fetchedAt: new Date(now()).toISOString() });
    expect(result.items.map(notice => [notice.revision, notice.status])).toEqual([['001', '취소'], ['000', '접수중']]);
  });

  it('sorts numeric revisions and reuses the existing official-data cache', async () => {
    let calls = 0;
    const api = createG2bClient({ serviceKey: 'test', now, fetcher: async () => {
      calls++;
      return Response.json({ response: { header: { resultCode: '00' }, body: { items: [row('2'), row('010'), row('000')], totalCount: 3 } } });
    } });
    const result = await api.lookupNotices('공사', number);
    expect(result.items.map(notice => notice.revision)).toEqual(['010', '002', '000']);
    expect(await api.lookupNotices('공사', number)).toEqual(result);
    expect(calls).toBe(1);
  });

  it('distinguishes a complete empty history from a failed lookup', async () => {
    expect(await apiWith([]).lookupNotices('공사', number)).toMatchObject({ items: [], totalCount: 0, hasMore: false });
  });

  it('retries the provider after incomplete history instead of caching an unverifiable latest state', async () => {
    let calls = 0;
    const api = createG2bClient({ serviceKey: 'test', now, fetcher: async () => {
      calls++;
      return Response.json({ response: { header: { resultCode: '00' }, body: {
        items: calls === 1 ? [row('000')] : [row('000'), row('001', { ntceKindNm: '취소공고' })], totalCount: 2,
      } } });
    } });
    await expect(api.lookupNotices('공사', number)).rejects.toMatchObject({ code: 'G2B_INCOMPLETE_RESPONSE' });
    expect((await api.lookupNotices('공사', number)).items[0]).toMatchObject({ revision: '001', status: '취소' });
    expect(calls).toBe(2);
  });

  it.each([
    ['partial history', [row('000')], 2],
    ['too many history rows', [row('000')], 1000],
    ['duplicate normalized revision', [row('1'), row('001')], 2],
    ['different notice number', [row('000', { bidNtceNo: 'R26BK00000000' })], 1],
    ['different business type', [row('000', { bsnsDivNm: '용역' })], 1],
    ['invalid revision', [row('old')], 1],
  ] as const)('rejects %s instead of inventing a latest notice', async (_label, items, totalCount) => {
    await expect(apiWith([...items], totalCount).lookupNotices('공사', number)).rejects.toMatchObject({ status: 502, code: 'G2B_INCOMPLETE_RESPONSE' });
  });
});

describe('number lookup on the existing notices endpoint', () => {
  it('routes number mode before date validation and returns cancellation history', async () => {
    const result = await handleG2bRequest('/api/notices', new URLSearchParams({ mode: 'number', type: '공사', number }),
      apiWith([row('000'), row('001', { ntceKindNm: '취소공고' })]));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ totalCount: 2, items: [{ revision: '001', status: '취소' }, { revision: '000', status: '접수중' }] });
  });

  it.each([
    { type: '물품', number }, { type: '공사', number: '' }, { type: '공사', number: 'a'.repeat(41) },
    { type: '공사', number: `${number}\u0000` }, { type: '공사', number: '../notice' },
  ])('rejects invalid identity input before calling the provider: %j', async input => {
    let calls = 0;
    const api = createG2bClient({ serviceKey: 'test', fetcher: async () => { calls++; throw new Error('must not call'); } });
    const result = await handleG2bRequest('/api/notices', new URLSearchParams({ mode: 'number', ...input }), api);
    expect(result).toMatchObject({ status: 400, body: { error: { code: 'INVALID_QUERY' } } });
    expect(calls).toBe(0);
  });

  it('keeps incomplete-history errors visible through the HTTP boundary', async () => {
    expect(await handleG2bRequest('/api/notices', new URLSearchParams({ mode: 'number', type: '공사', number }), apiWith([row('000')], 2)))
      .toMatchObject({ status: 502, body: { error: { code: 'G2B_INCOMPLETE_RESPONSE' } } });
  });
});
