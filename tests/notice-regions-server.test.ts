import { afterEach, describe, expect, it, vi } from 'vitest';
import { createG2bClient } from '../server/g2b';
import { handleG2bRequest, nodeApiHandler } from '../server/http';

const response = (items: unknown[], totalCount = items.length) => new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items, totalCount } } }));
const identity = { number: 'R26BK01758083', revision: '001' };
const region = { bidNtceNo: identity.number, bidNtceOrd: identity.revision, bsnsDivNm: '용역', prtcptPsblRgnNm: '서울특별시' };
const guard = () => ({ assertAvailable: vi.fn(async () => {}), trip: vi.fn(async () => {}) });
const params = (notices = `${identity.number}:1`, type = '용역') => new URLSearchParams({ type, notices });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('on-demand participation regions', () => {
  it('hydrates an amended service through one exact regional operation without detail fan-out', async () => {
    const fetcher = vi.fn(async (_input: URL | RequestInfo) => response([region]));
    const client = createG2bClient({ serviceKey: 'region-test', fetcher, quotaGuard: guard() });
    const result = await handleG2bRequest('/api/notice-regions', params(), client);
    expect(result).toMatchObject({ status: 200, body: { items: [{ ...identity, type: '용역', allowedRegions: ['서울특별시'], complete: true }] } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname.split('/').at(-1)).toBe('getBidPblancListInfoPrtcptPsblRgn');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ inqryDiv: '2', bidNtceNo: identity.number, bidNtceOrd: '001', numOfRows: '999', pageNo: '1' });
  });

  it.each(['', 'NOTICE', 'NOTICE:', 'NOTICE:abc', 'NOTICE:0000', 'NOTICE:000,', 'NOTICE:000,OTHER:bad', Array.from({ length: 11 }, (_, index) => `NOTICE${index}:000`).join(',')])('rejects the entire invalid batch before any provider read: %s', async notices => {
    const fetcher = vi.fn();
    const result = await handleG2bRequest('/api/notice-regions', params(notices), createG2bClient({ serviceKey: 'test', fetcher, quotaGuard: guard() }));
    expect(result).toMatchObject({ status: 400, body: { error: { code: 'INVALID_QUERY' } } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unknown business types and normalized duplicate identities', async () => {
    const fetcher = vi.fn();
    const client = createG2bClient({ serviceKey: 'test', fetcher, quotaGuard: guard() });
    for (const input of [params('NOTICE:000', '물품'), params('NOTICE:0,NOTICE:000')]) {
      expect((await handleG2bRequest('/api/notice-regions', input, client)).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never borrows another revision, number, business type or blank revision', async () => {
    const fetcher = vi.fn(async () => response([
      { ...region, bidNtceOrd: '000', prtcptPsblRgnNm: '부산광역시' },
      { ...region, bidNtceNo: 'OTHER', prtcptPsblRgnNm: '경기도' },
      { ...region, bsnsDivNm: '공사', prtcptPsblRgnNm: '인천광역시' },
      { ...region, bidNtceOrd: '', prtcptPsblRgnNm: '전국' },
      region, { ...region, bidNtceOrd: '1' },
    ]));
    const result = await createG2bClient({ serviceKey: 'test', fetcher, quotaGuard: guard() }).participationRegions(identity.number, identity.revision, '용역');
    expect(result).toMatchObject({ allowedRegions: ['서울특별시'], complete: true });
  });

  it('keeps empty complete membership unknown and accepts only explicit nationwide values', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([{ ...region, bidNtceNo: 'NATIONWIDE', prtcptPsblRgnNm: '전국' }]));
    const client = createG2bClient({ serviceKey: 'test', fetcher, quotaGuard: guard() });
    expect(await client.participationRegions(identity.number, identity.revision, '용역')).toMatchObject({ allowedRegions: null, complete: true });
    expect(await client.participationRegions('NATIONWIDE', identity.revision, '용역')).toMatchObject({ allowedRegions: ['전국'], complete: true });
  });

  it('discards incomplete membership instead of excluding against a partial list', async () => {
    const client = createG2bClient({ serviceKey: 'test', fetcher: vi.fn(async () => response([region], 2)), quotaGuard: guard() });
    expect(await client.participationRegions(identity.number, identity.revision, '용역')).toMatchObject({ allowedRegions: null, complete: false, error: 'G2B_INCOMPLETE_RESPONSE' });
  });

  it('does not retain an incomplete raw membership response in the success cache', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response([region], 2)).mockResolvedValueOnce(response([region]));
    const client = createG2bClient({ serviceKey: 'test', fetcher, quotaGuard: guard() });
    expect((await client.participationRegions(identity.number, identity.revision, '용역')).complete).toBe(false);
    expect((await client.participationRegions(identity.number, identity.revision, '용역')).complete).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent raw requests and expires cached successes after five minutes', async () => {
    let now = 100;
    const fetcher = vi.fn(async () => response([region]));
    const client = createG2bClient({ serviceKey: 'test', fetcher, quotaGuard: guard(), now: () => now });
    await Promise.all([client.participationRegions(identity.number, identity.revision, '용역'), client.participationRegions(identity.number, identity.revision, '용역')]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 300_001;
    await client.participationRegions(identity.number, identity.revision, '용역');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('preserves input order and confirmed rows when one lookup fails without leaking its error', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const number = new URL(String(input)).searchParams.get('bidNtceNo');
      if (number === 'FAIL') throw new Error('serviceKey=SECRET');
      return response([{ ...region, bidNtceNo: number }]);
    });
    const result = await createG2bClient({ serviceKey: 'test', fetcher, quotaGuard: guard() }).noticeRegions([identity, { number: 'FAIL', revision: '000' }], '용역');
    expect(result.items).toMatchObject([{ ...identity, allowedRegions: ['서울특별시'], complete: true }, { number: 'FAIL', allowedRegions: null, complete: false, error: 'G2B_UNAVAILABLE' }]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('stops unstarted lookups after quota failure while retaining an in-flight success', async () => {
    let finishKnown!: () => void;
    const knownPending = new Promise<void>(resolve => { finishKnown = resolve; });
    const quotaGuard = guard();
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const number = new URL(String(input)).searchParams.get('bidNtceNo');
      if (number === 'QUOTA') return new Response('', { status: 429 });
      if (number === identity.number) { await knownPending; return response([region]); }
      throw new Error('No more provider work after quota');
    });
    const client = createG2bClient({ serviceKey: 'test', fetcher, quotaGuard });
    const job = client.noticeRegions([{ number: 'QUOTA', revision: '000' }, identity, { number: 'UNSTARTED', revision: '000' }], '용역');
    await vi.waitFor(() => expect(quotaGuard.trip).toHaveBeenCalledTimes(1));
    finishKnown();
    const result = await job;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.retryAfterSeconds).toBe(1800);
    expect(result.items).toMatchObject([
      { number: 'QUOTA', complete: false, allowedRegions: null, error: 'G2B_QUOTA_EXCEEDED' },
      { ...identity, complete: true, allowedRegions: ['서울특별시'] },
      { number: 'UNSTARTED', complete: false, allowedRegions: null, error: 'G2B_QUOTA_EXCEEDED' },
    ]);
  });

  it('caps batch concurrency at two and stops new work when its combined budget expires', async () => {
    let now = 0, active = 0, maximum = 0;
    const pending: Array<() => void> = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => pending.push(resolve));
      active--;
      return response([{ ...region, bidNtceNo: new URL(String(input)).searchParams.get('bidNtceNo') }]);
    });
    const client = createG2bClient({ serviceKey: 'test', fetcher, quotaGuard: guard(), now: () => now });
    const job = client.noticeRegions(['A', 'B', 'C', 'D'].map(number => ({ number, revision: '001' })), '용역');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    now = 40_001; pending.forEach(resolve => resolve());
    const result = await job;
    expect(maximum).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.items.slice(2)).toMatchObject([{ number: 'C', complete: false, error: 'G2B_UNAVAILABLE' }, { number: 'D', complete: false, error: 'G2B_UNAVAILABLE' }]);
  });

  it.each([true, false])('shares only a fully confirmed successful batch with the CDN: complete=%s', async complete => {
    vi.stubEnv('G2B_SERVICE_KEY', `region-header-test-${complete}`);
    vi.stubGlobal('fetch', vi.fn(async () => response([region], complete ? 1 : 2)));
    const headers = new Map<string, string>();
    const res = { statusCode: 0, setHeader: (name: string, value: string) => { headers.set(name, value); }, end: vi.fn() };
    await nodeApiHandler({ method: 'GET', url: `/api/notice-regions?${params()}`, headers: { 'x-forwarded-for': `region-${complete}` } }, res);
    expect(res.statusCode).toBe(200);
    expect(headers.get('Vercel-CDN-Cache-Control')).toBe(complete ? 'public, max-age=300' : undefined);
    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  it('limits region batches independently so hydration cannot consume the normal search burst allowance', async () => {
    vi.stubEnv('G2B_SERVICE_KEY', 'region-burst-test');
    vi.stubGlobal('fetch', vi.fn(async () => response([region])));
    const request = async (url: string) => {
      const headers = new Map<string, string>();
      const res = { statusCode: 0, setHeader: (name: string, value: string) => { headers.set(name, value); }, end: vi.fn() };
      await nodeApiHandler({ method: 'GET', url, headers: { 'x-forwarded-for': 'isolated-region-burst' } }, res);
      return { status: res.statusCode, headers };
    };
    for (let index = 0; index < 40; index++) expect((await request('/api/unknown-for-burst-test')).status).toBe(404);
    for (let index = 0; index < 12; index++) expect((await request(`/api/notice-regions?${params()}`)).status).toBe(200);
    const blockedRegion = await request(`/api/notice-regions?${params()}`);
    expect(blockedRegion.status).toBe(429);
    expect(blockedRegion.headers.get('Retry-After')).toBe('60');
    expect((await request('/api/unknown-for-burst-test')).status).toBe(429);
  });
});
