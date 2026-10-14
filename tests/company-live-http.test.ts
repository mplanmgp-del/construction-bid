import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createG2bClient } from '../server/g2b';
import { handleG2bRequest, nodeApiHandler, type NodeResponse } from '../server/http';
import { ProviderQuotaError } from '../server/provider-quota';

const prohibited = vi.hoisted(() => ({ archive: vi.fn(), cache: vi.fn() }));
vi.mock('../server/company-history', () => ({ createCompanyArchiveReader: prohibited.archive }));
vi.mock('@vercel/functions', () => ({ getCache: prohibited.cache, waitUntil: vi.fn() }));

const biz = '8488802470';
const stamp = '2026-10-14T06:00:00.000Z';
const company = { businessNumber: biz, name: '주식회사 함께하는개발', representative: '', address: '', phone: '',
  registrationDate: '2023-12-27 09:59:20', companyType: '공사', licenses: [], products: [], updatedAt: stamp };
const participationQuery = { businessNumber: biz, type: '공사' as const, day: '2026-10-13', page: 2 };
const contractQuery = { businessNumber: biz, type: '용역' as const, from: '2026-10-01', to: '2026-10-14', page: 3 };
const participation = { ...participationQuery, items: [], pageSize: 999, totalCount: 1000, sourceCount: 1,
  hasMore: false, complete: true, warnings: [], pageFingerprint: 'source-page', source: '나라장터', fetchedAt: stamp };
const contracts = { ...contractQuery, items: [], pageSize: 999, totalCount: 1999, sourceCount: 1,
  hasMore: false, complete: true, warnings: [], sourceFingerprint: 'contract-page', source: '나라장터', fetchedAt: stamp };
const names = { items: [company], year: 2023, page: 2, hasMore: false, totalCount: 101 };

const routes = [
  { path: '/api/company-participation', params: { businessNumber: '848-88-02470', type: '공사', day: '2026-10-13', page: '2' }, loader: 'companyParticipation', args: [participationQuery], output: participation },
  { path: '/api/company-contracts', params: { businessNumber: '848-88-02470', type: '용역', from: '2026-10-01', to: '2026-10-14', page: '3' }, loader: 'companyContracts', args: [contractQuery], output: contracts },
  { path: '/api/companies', params: { q: '  함께  ', year: '2023', page: '2' }, loader: 'companyNames', args: ['함께', 2023, 2], output: names },
  { path: '/api/companies', params: { q: '  848-88-02470  ' }, loader: 'company', args: [biz], output: { items: [company], message: '' } },
] as const;

let serial = 0;
beforeEach(() => {
  prohibited.archive.mockReset().mockImplementation(() => { throw new Error('Archive access is forbidden for live MY requests'); });
  prohibited.cache.mockReset().mockImplementation(() => { throw new Error('Persistent cache access is forbidden for live MY requests'); });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(stamp));
  vi.stubEnv('G2B_SERVICE_KEY', `live-http-test-${++serial}`);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function request(path: string, params: Record<string, string>) {
  const headers: Record<string, string> = {};
  let body = '';
  const res: NodeResponse = { statusCode: 0, setHeader: (name, value) => { headers[name] = value; }, end: value => { body = value || ''; } };
  await nodeApiHandler({ method: 'GET', url: `${path}?${new URLSearchParams(params)}`, headers: { 'x-forwarded-for': `live-http-${serial}` } }, res);
  return { status: res.statusCode, headers, body: JSON.parse(body) };
}
const expectNoStore = (headers: Record<string, string>) => {
  expect(headers['Cache-Control']).toBe('no-store');
  expect(headers['Vercel-CDN-Cache-Control']).toBeUndefined();
  expect(headers['X-Search-Cache']).toBeUndefined();
  expect(prohibited.archive).not.toHaveBeenCalled();
  expect(prohibited.cache).not.toHaveBeenCalled();
};

describe('direct MY HTTP routes', () => {
  it.each(routes)('uses only $loader for $path and normalizes public query identifiers', async route => {
    const fetcher = vi.fn(async () => { throw new Error('An injected route must not fetch'); });
    const api = createG2bClient({ serviceKey: 'injected-test-key', fetcher });
    const loaders = {
      companyParticipation: vi.spyOn(api, 'companyParticipation').mockResolvedValue(participation),
      companyContracts: vi.spyOn(api, 'companyContracts').mockResolvedValue(contracts),
      companyNames: vi.spyOn(api, 'companyNames').mockResolvedValue(names),
      company: vi.spyOn(api, 'company').mockResolvedValue({ company, warnings: [] }),
    };
    const result = await handleG2bRequest(route.path, new URLSearchParams(route.params), api);
    expect(result).toEqual({ status: 200, body: route.output });
    expect(loaders[route.loader]).toHaveBeenCalledExactlyOnceWith(...route.args);
    for (const [name, loader] of Object.entries(loaders)) if (name !== route.loader) expect(loader).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(prohibited.archive).not.toHaveBeenCalled();
    expect(prohibited.cache).not.toHaveBeenCalled();
  });

  it('returns 410 for the retired archive history route without reading a database or provider', async () => {
    const fetcher = vi.fn(async () => { throw new Error('No network for retired history route'); });
    vi.stubGlobal('fetch', fetcher);
    const result = await request('/api/company-history', { businessNumber: biz });
    expect(result.status).toBe(410);
    expect(result.body.error.code).toBe('LIVE_HISTORY_REQUIRED');
    expect(fetcher).not.toHaveBeenCalled();
    expectNoStore(result.headers);
  });

  it('dispatches the rewritten participation entry with its exact public query and no caching', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ response: { header: { resultCode: '00' }, body: { totalCount: 0, items: [] } } }));
    vi.stubGlobal('fetch', fetcher);
    const result = await request('/api/company-data', { _companyAction: 'participation', businessNumber: '848-88-02470',
      type: '용역', day: '2026-10-13', page: '1' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ businessNumber: biz, type: '용역', day: '2026-10-13', page: 1,
      items: [], sourceCount: 0, totalCount: 0, complete: true });
    expect(fetcher).toHaveBeenCalledOnce();
    const upstream = new URL(String(fetcher.mock.calls[0][0]));
    expect(upstream.hostname).toBe('apis.data.go.kr');
    expect(upstream.pathname).toBe('/1230000/ao/PubDataOpnStdService/getDataSetOpnStdScsbidInfo');
    expect(Object.fromEntries(upstream.searchParams)).toMatchObject({ bsnsDivCd: '5', opengBgnDt: '202610130000',
      opengEndDt: '202610132359', pageNo: '1', numOfRows: '999' });
    expectNoStore(result.headers);
  });

  it('keeps rewritten legacy history retired without contacting a database or provider', async () => {
    const fetcher = vi.fn(async () => { throw new Error('No network for retired rewritten history'); });
    vi.stubGlobal('fetch', fetcher);
    const result = await request('/api/company-data', { _companyAction: 'history', businessNumber: biz });
    expect(result.status).toBe(410);
    expect(result.body.error.code).toBe('LIVE_HISTORY_REQUIRED');
    expect(fetcher).not.toHaveBeenCalled();
    expectNoStore(result.headers);
  });

  it('propagates a company-awards loader quota error through HTTP instead of returning a partial success', async () => {
    const params = { businessNumber: biz, type: '공사', from: '2026-10-01', to: '2026-10-14' };
    const api = createG2bClient({ serviceKey: 'injected-test-key' });
    vi.spyOn(api, 'companyAwards').mockRejectedValue(new ProviderQuotaError(137));
    const result = await handleG2bRequest('/api/company-awards', new URLSearchParams(params), api);
    expect(result).toMatchObject({ status: 429, retryAfterSeconds: 137,
      body: { error: { code: 'G2B_QUOTA_EXCEEDED', retryAfterSeconds: 137 } } });
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'Retry-After': '137' } }));
    const http = await request('/api/company-awards', params);
    expect(http.status).toBe(429); expect(http.headers['Retry-After']).toBe('137');
    expectNoStore(http.headers);
  });

  it.each(routes)('starts a fresh official provider request and leaves $loader responses uncached', async route => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('apis.data.go.kr');
      return Response.json({ response: { header: { resultCode: '00' }, body: { totalCount: 0, items: [] } } });
    });
    vi.stubGlobal('fetch', fetcher);
    // Use the first page for genuinely empty source responses.
    const params = { ...route.params, page: '1' };
    const first = await request(route.path, params);
    const next = await request(route.path, params);
    expect(first.status).toBe(200); expect(next.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expectNoStore(first.headers); expectNoStore(next.headers);
  });

  it.each(routes)('preserves official 429 and Retry-After for $loader without a saved-history fallback', async route => {
    vi.stubGlobal('fetch', async () => new Response('serviceKey=test-secret', { status: 429, headers: { 'Retry-After': '137' } }));
    const result = await request(route.path, { ...route.params, page: '1' });
    expect(result.status).toBe(429);
    expect(result.headers['Retry-After']).toBe('137');
    expect(result.body.error).toMatchObject({ code: 'G2B_QUOTA_EXCEEDED', retryAfterSeconds: 137 });
    expect(JSON.stringify(result.body)).not.toContain('test-secret');
    expectNoStore(result.headers);
  });
});
