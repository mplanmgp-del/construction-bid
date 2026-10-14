import { expect, it, vi } from 'vitest';
import { createG2bClient, type SearchQuery } from '../server/g2b';
import { ProviderQuotaError } from '../server/provider-quota';

const clock = () => Date.parse('2026-10-13T03:00:00Z');
const query: SearchQuery = { type: '공사', from: '2026-10-07', to: '2026-10-13', keyword: '철거', page: 1, pageSize: 100 };
const notice = { bidNtceNo: 'R26BK00000001', bidNtceOrd: '000', bidNtceNm: '철거공사', bidBeginDt: '2026-10-07 09:00:00' };
const response = (items: unknown[] = [], totalCount = items.length) => Response.json({ response: { header: { resultCode: '00' }, body: { totalCount, items } } });

it.each([
  ['JSON response 22', () => Response.json({ response: { header: { resultCode: '22' } } })],
  ['JSON gateway 23', () => Response.json({ OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: '23' } } })],
  ['XML gateway 22', () => new Response('<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>22</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>')],
  ['XML response 23', () => new Response('<response><header><resultCode>23</resultCode></header></response>')],
  ['HTTP 429', () => new Response('serviceKey=SECRET', { status: 429 })],
] as const)('reports %s without automatic retries and immediately permits a new explicit query', async (name, failure) => {
  let failed = false;
  const fetcher = vi.fn(async () => {
    if (!failed) { failed = true; return failure(); }
    return response();
  });
  const client = createG2bClient({ serviceKey: `recover-${name}`, fetcher, now: clock });
  await expect(client.startNotices(query, 0)).rejects.toMatchObject({ status: 429, code: 'G2B_QUOTA_EXCEEDED', retryAfterSeconds: undefined });
  expect(fetcher).toHaveBeenCalledOnce();
  expect((await client.startNotices(query, 0)).totalCount).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('allows another server instance to query immediately after a provider quota error', async () => {
  const first = createG2bClient({ serviceKey: 'cross-instance-recovery', fetcher: async () => new Response('', { status: 429 }), now: clock });
  await expect(first.startNotices(query, 0)).rejects.toBeInstanceOf(ProviderQuotaError);
  const other = createG2bClient({ serviceKey: 'cross-instance-recovery', fetcher: async () => response([notice]), now: clock });
  expect((await other.detail(notice.bidNtceNo, '000', '공사')).notice?.title).toBe('철거공사');
});

it.each([
  ['120', 120], ['Tue, 13 Oct 2026 03:02:00 GMT', 120], ['not-a-delay', undefined], ['-5', undefined], ['0', undefined],
] as const)('forwards only a valid provider Retry-After value %j without blocking the next query', async (header, expected) => {
  let failed = false;
  const fetcher = vi.fn(async () => {
    if (!failed) { failed = true; return new Response('serviceKey=SECRET', { status: 429, headers: { 'Retry-After': header } }); }
    return response();
  });
  const client = createG2bClient({ serviceKey: `header-${header}`, fetcher, now: clock });
  const error = await client.startNotices(query, 0).catch(error => error);
  expect(error).toMatchObject({ status: 429, code: 'G2B_QUOTA_EXCEEDED', retryAfterSeconds: expected });
  expect(String(error)).not.toContain('SECRET');
  expect((await client.startNotices(query, 0)).totalCount).toBe(0);
});

it('keeps a successful cached search available after a different query hits the provider limit', async () => {
  const fetcher = vi.fn(async (input: URL | Request | string) => new URL(String(input)).searchParams.get('bidNtceNm') === '철거'
    ? response() : new Response('', { status: 429 }));
  const client = createG2bClient({ serviceKey: 'cached-quota-test', fetcher, now: clock });
  const complete = await client.startNotices(query, 0);
  await expect(client.startNotices({ ...query, keyword: '도로' }, 0)).rejects.toBeInstanceOf(ProviderQuotaError);
  expect(await client.startNotices(query, 0)).toEqual(complete);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('loads list rows without requesting regional, license or detail enrichment', async () => {
  const fetcher = vi.fn(async (input: URL | Request | string) => String(input).includes('PrtcptPsblRgn')
    ? new Response('', { status: 429 }) : response([notice]));
  const client = createG2bClient({ serviceKey: 'auxiliary-quota-test', fetcher, now: clock });
  const complete = await client.startNotices(query, 0);
  expect(complete.totalCount).toBe(1); expect(complete.hasMore).toBe(false);
  expect(complete.items[0].allowedRegions).toBeNull(); expect(complete.warnings).toEqual([]);
  expect(await client.startNotices(query, 0)).toEqual(complete);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe('/1230000/ad/BidPublicInfoService/getBidPblancListInfoCnstwkPPSSrch');
});

it('reuses successful general detail and retries failed auxiliary data immediately on another detail lookup', async () => {
  let recovered = false;
  const fetcher = vi.fn(async (input: URL | Request | string) => new URL(String(input)).pathname.endsWith('getBidPblancListInfoCnstwk')
    ? response([notice]) : recovered ? response() : new Response('', { status: 429 }));
  const client = createG2bClient({ serviceKey: 'detail-quota-test', fetcher, now: clock });
  const initial = await client.detail(notice.bidNtceNo, '000', '공사');
  expect(initial.notice?.title).toBe('철거공사'); expect(initial.warnings.join(' ')).toContain('호출 한도');
  recovered = true;
  const retried = await client.detail(notice.bidNtceNo, '000', '공사');
  expect(retried.notice?.title).toBe('철거공사'); expect(retried.warnings).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(7);
});

it('stops unstarted search pages when an in-flight page reports quota without abandoning successful concurrent requests', async () => {
  let finishRemaining!: () => void;
  const remaining = new Promise<void>(resolve => { finishRemaining = resolve; });
  const requested: number[] = [];
  const fetcher = vi.fn(async (input: URL | Request | string) => {
    const page = Number(new URL(String(input)).searchParams.get('pageNo'));
    requested.push(page);
    if (page === 1) return response([notice], 1000);
    if (page === 2) return new Response('', { status: 429 });
    await remaining;
    return response([{ ...notice, bidNtceNo: `PAGE${page}` }], 1000);
  });
  const client = createG2bClient({ serviceKey: 'stop-page-work', fetcher, now: clock });
  await expect(client.startNotices(query, 0)).rejects.toBeInstanceOf(ProviderQuotaError);
  finishRemaining();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(requested).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

it.each(['', '  '])('rejects blank start-date search %j before any provider call', async keyword => {
  const fetcher = vi.fn(async () => response());
  const client = createG2bClient({ serviceKey: 'keyword-quota-test', fetcher });
  await expect(client.startNotices({ ...query, keyword }, 0)).rejects.toMatchObject({ status: 400, code: 'KEYWORD_REQUIRED' });
  expect(fetcher).not.toHaveBeenCalled();
});
