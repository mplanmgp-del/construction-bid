import { expect, it, vi } from 'vitest';
import { createG2bClient, type SearchQuery } from '../server/g2b';
import { createProviderQuotaGuard, ProviderQuotaError, type ProviderQuotaCache } from '../server/provider-quota';

const clock = () => Date.parse('2026-10-13T03:00:00Z');
const query: SearchQuery = { type: '공사', from: '2026-10-07', to: '2026-10-13', keyword: '철거', page: 1, pageSize: 100 };
const notice = { bidNtceNo: 'R26BK00000001', bidNtceOrd: '000', bidNtceNm: '철거공사', bidBeginDt: '2026-10-07 09:00:00' };
const response = (items: unknown[] = []) => Response.json({ response: { header: { resultCode: '00' }, body: { totalCount: items.length, items } } });
function sharedGuard() {
  const values = new Map<string, unknown>();
  const cache: ProviderQuotaCache = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
  const make = () => createProviderQuotaGuard({ cache, now: clock });
  return { guard: make(), make };
}

it.each([
  ['JSON response 22', () => Response.json({ response: { header: { resultCode: '22' } } })],
  ['JSON gateway 23', () => Response.json({ OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: '23' } } })],
  ['XML gateway 22', () => new Response('<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>22</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>')],
  ['XML response 23', () => new Response('<response><header><resultCode>23</resultCode></header></response>')],
  ['HTTP 429', () => new Response('Too many requests', { status: 429 })],
] as const)('trips on %s without retrying and blocks different queries, operations and client instances', async (_name, failure) => {
  const f = sharedGuard(), fetcher = vi.fn(async () => failure());
  const client = createG2bClient({ serviceKey: 'isolated-quota-test', fetcher: fetcher as typeof fetch, now: clock, quotaGuard: f.guard });
  await expect(client.startNotices(query, 0)).rejects.toBeInstanceOf(ProviderQuotaError);
  expect(fetcher).toHaveBeenCalledOnce();
  await expect(client.startNotices({ ...query, keyword: '도로' }, 1)).rejects.toMatchObject({ code: 'G2B_QUOTA_EXCEEDED', retryAfterSeconds: 1800 });
  await expect(client.notices({ ...query, type: '용역' })).rejects.toBeInstanceOf(ProviderQuotaError);
  const other = createG2bClient({ serviceKey: 'isolated-quota-test', fetcher: fetcher as typeof fetch, now: clock, quotaGuard: f.make() });
  await expect(other.detail(notice.bidNtceNo, '000', '공사')).rejects.toBeInstanceOf(ProviderQuotaError);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('continues serving a complete cached search after a different search hits the provider limit', async () => {
  const f = sharedGuard(), fetcher = vi.fn(async (input: URL | Request | string) => {
    return new URL(String(input)).searchParams.get('bidNtceNm') === '철거' ? response() : new Response('', { status: 429 });
  });
  const client = createG2bClient({ serviceKey: 'cached-quota-test', fetcher: fetcher as typeof fetch, now: clock, quotaGuard: f.guard });
  const complete = await client.startNotices(query, 0);
  await expect(client.startNotices({ ...query, keyword: '도로' }, 0)).rejects.toBeInstanceOf(ProviderQuotaError);
  expect(await client.startNotices(query, 0)).toEqual(complete);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('preserves complete core notices with unknown regions when optional region enrichment hits quota', async () => {
  const f = sharedGuard(), fetcher = vi.fn(async (input: URL | Request | string) => String(input).includes('PrtcptPsblRgn')
    ? new Response('', { status: 429 }) : response([notice]));
  const client = createG2bClient({ serviceKey: 'auxiliary-quota-test', fetcher: fetcher as typeof fetch, now: clock, quotaGuard: f.guard });
  const complete = await client.startNotices(query, 0);
  expect(complete.totalCount).toBe(1); expect(complete.hasMore).toBe(false);
  expect(complete.items[0].allowedRegions).toBeNull(); expect(complete.warnings?.join(' ')).toContain('호출 한도');
  expect(await client.startNotices(query, 0)).toEqual(complete);
  await expect(client.startNotices(query, 1)).rejects.toBeInstanceOf(ProviderQuotaError);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('keeps meaningful cached general detail while suppressing unavailable auxiliary requests', async () => {
  const f = sharedGuard(), fetcher = vi.fn(async (input: URL | Request | string) => new URL(String(input)).pathname.endsWith('getBidPblancListInfoCnstwk')
    ? response([notice]) : new Response('', { status: 429 }));
  const client = createG2bClient({ serviceKey: 'detail-quota-test', fetcher: fetcher as typeof fetch, now: clock, quotaGuard: f.guard });
  const initial = await client.detail(notice.bidNtceNo, '000', '공사');
  expect(initial.notice?.title).toBe('철거공사'); expect(initial.warnings.join(' ')).toContain('호출 한도');
  const calls = fetcher.mock.calls.length;
  const cached = await client.detail(notice.bidNtceNo, '000', '공사');
  expect(cached.notice?.title).toBe('철거공사'); expect(fetcher).toHaveBeenCalledTimes(calls);
});

it('does not block a distinct provider service when bidding-notice service quota is exhausted', async () => {
  const f = sharedGuard(), fetcher = vi.fn(async (input: URL | Request | string) => String(input).includes('BidPublicInfoService')
    ? new Response('', { status: 429 }) : response());
  const client = createG2bClient({ serviceKey: 'service-quota-test', fetcher: fetcher as typeof fetch, now: clock, quotaGuard: f.guard });
  await expect(client.startNotices(query, 0)).rejects.toBeInstanceOf(ProviderQuotaError);
  expect((await client.results(query)).totalCount).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each(['', '  '])('rejects blank start-date search %j before any provider call', async keyword => {
  const fetcher = vi.fn(async () => response()), quotaGuard = { assertAvailable: vi.fn(async () => {}), trip: vi.fn(async () => {}) };
  const client = createG2bClient({ serviceKey: 'keyword-quota-test', fetcher: fetcher as typeof fetch, quotaGuard });
  await expect(client.startNotices({ ...query, keyword }, 0)).rejects.toMatchObject({ status: 400, code: 'KEYWORD_REQUIRED' });
  expect(fetcher).not.toHaveBeenCalled(); expect(quotaGuard.assertAvailable).not.toHaveBeenCalled();
});
