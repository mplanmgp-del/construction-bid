import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createG2bClient } from '../server/g2b';
import { handleG2bRequest, nodeApiHandler, type NodeResponse } from '../server/http';
import { ProviderQuotaError } from '../server/provider-quota';

const archive = vi.hoisted(() => ({ search: vi.fn(), company: vi.fn(), profile: vi.fn(), watch: vi.fn(), combinedHistory: vi.fn() }));
vi.mock('../server/company-history', async importOriginal => ({ ...await importOriginal<typeof import('../server/company-history')>(),
  createCompanyArchiveReader: () => archive }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn(), getCache: vi.fn() }));

const biz = '8488802470';
const stamp = '2026-10-14T06:00:00.000Z';
const company = { businessNumber: biz, name: '주식회사 함께하는개발', representative: '', address: '', phone: '',
  registrationDate: '2023-12-27 09:59:20', companyType: '공사', licenses: [], products: [], updatedAt: stamp };
const history = { company, items: [], totalCount: 0, page: 1, pageSize: 30,
  coverage: { status: 'collecting', from: null, to: null, updatedAt: null, message: '아직 수집 중' } };
let serial = 0;
beforeEach(() => {
  archive.search.mockReset().mockResolvedValue([]);
  archive.profile.mockReset().mockResolvedValue({ company: null, warnings: [] });
  archive.company.mockReset().mockResolvedValue(null);
  archive.watch.mockReset().mockResolvedValue(true);
  archive.combinedHistory.mockReset().mockResolvedValue(history);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(stamp));
  vi.stubEnv('G2B_SERVICE_KEY', `indexed-http-test-${++serial}`);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function request(path: string, params: Record<string, string>) {
  const headers: Record<string, string> = {};
  let body = '';
  const res: NodeResponse = { statusCode: 0, setHeader: (name, value) => { headers[name] = value; }, end: value => { body = value || ''; } };
  await nodeApiHandler({ method: 'GET', url: `${path}?${new URLSearchParams(params)}`, headers: { 'x-forwarded-for': `indexed-http-${serial}` } }, res);
  return { status: res.statusCode, headers, body: JSON.parse(body) };
}
const api = () => createG2bClient({ serviceKey: 'injected-test-key', fetcher: async () => { throw new Error('Unexpected provider call'); } });

describe('indexed MY HTTP routes', () => {
  it('reads unlimited-date history from the database, including independent contract and award pages', async () => {
    const client = api();
    const provider = vi.spyOn(client, 'companyParticipation');
    const result = await handleG2bRequest('/api/company-history', new URLSearchParams({ businessNumber: '848-88-02470',
      from: '1990-01-01', to: '2026-10-14', page: '2', contractsPage: '3', awardsPage: '4', outcome: 'lost' }), client);
    expect(result).toEqual({ status: 200, body: history });
    expect(archive.combinedHistory).toHaveBeenCalledExactlyOnceWith({ businessNumber: biz, from: '1990-01-01', to: '2026-10-14',
      page: 2, contractsPage: 3, awardsPage: 4, outcome: 'lost' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('dispatches the consolidated history rewrite to the index and leaves changing coverage uncached', async () => {
    const result = await request('/api/company-data', { _companyAction: 'history', businessNumber: biz });
    expect(result.status).toBe(200);
    expect(result.body.coverage.status).toBe('collecting');
    expect(archive.combinedHistory).toHaveBeenCalledOnce();
    expect(result.headers['Cache-Control']).toBe('no-store');
    expect(result.headers['Vercel-CDN-Cache-Control']).toBeUndefined();
  });

  it('validates indexed pages and dates before any database work', async () => {
    const result = await handleG2bRequest('/api/company-history', new URLSearchParams({ businessNumber: biz, contractsPage: '0' }), api());
    expect(result.status).toBe(400);
    expect(archive.combinedHistory).not.toHaveBeenCalled();
  });

  it('uses stored name candidates before any official year scan', async () => {
    archive.search.mockResolvedValue([company]);
    const client = api(), names = vi.spyOn(client, 'companyNames');
    const result = await handleG2bRequest('/api/companies', new URLSearchParams({ q: ' 함께 ' }), client);
    expect(result).toMatchObject({ status: 200, body: { items: [company], source: 'index' } });
    expect(archive.search).toHaveBeenCalledWith('함께');
    expect(names).not.toHaveBeenCalled();
  });

  it('falls back to one explicitly bounded official registration year and states the limitation', async () => {
    const client = api(), names = vi.spyOn(client, 'companyNames').mockResolvedValue({ items: [company], year: 2023, page: 1, hasMore: false, totalCount: 1 });
    const result = await handleG2bRequest('/api/companies', new URLSearchParams({ q: '함께', year: '2023' }), client);
    expect(names).toHaveBeenCalledExactlyOnceWith('함께', 2023, 1);
    expect(result).toMatchObject({ status: 200, body: { items: [company], source: 'official', message: expect.stringContaining('2023년') } });
  });

  it('allows an explicit older-year official continuation even when indexed candidates exist', async () => {
    archive.search.mockResolvedValue([company]);
    const client = api(), names = vi.spyOn(client, 'companyNames').mockResolvedValue({ items: [], year: 2023, page: 2, hasMore: false, totalCount: 100 });
    const result = await handleG2bRequest('/api/companies', new URLSearchParams({ q: '함께', source: 'official', year: '2023', page: '2' }), client);
    expect(names).toHaveBeenCalledExactlyOnceWith('함께', 2023, 2);
    expect(archive.search).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 200, body: { year: 2023, page: 2, source: 'official' } });
  });

  it('uses the cached official profile and queues only the selected business number', async () => {
    archive.profile.mockResolvedValue({ company, warnings: ['공급품목은 일부입니다.'] });
    const client = api(), official = vi.spyOn(client, 'company');
    const result = await handleG2bRequest('/api/companies', new URLSearchParams({ q: '848-88-02470' }), client);
    expect(result).toMatchObject({ status: 200, body: { items: [company], message: '공급품목은 일부입니다.' } });
    expect(official).not.toHaveBeenCalled();
    expect(archive.watch).toHaveBeenCalledExactlyOnceWith(biz);
  });

  it('looks up a genuinely unindexed company directly and never writes provider payload from a client request', async () => {
    const client = api(), official = vi.spyOn(client, 'company').mockResolvedValue({ company, warnings: [] });
    const result = await handleG2bRequest('/api/companies', new URLSearchParams({ q: biz }), client);
    expect(result.status).toBe(200);
    expect(official).toHaveBeenCalledExactlyOnceWith(biz);
    expect(archive.watch).toHaveBeenCalledExactlyOnceWith(biz);
  });

  it('opens a company with stored history immediately even when official profile requests would hit quota', async () => {
    const basic = { ...company, registrationDate: '' };
    archive.company.mockResolvedValue(basic);
    const client = api(), official = vi.spyOn(client, 'company').mockRejectedValue(new ProviderQuotaError(137));
    const result = await handleG2bRequest('/api/companies', new URLSearchParams({ q: biz }), client);
    expect(result).toMatchObject({ status: 200, body: { items: [basic], message: expect.stringContaining('이력은 바로 조회') } });
    expect(archive.company).toHaveBeenCalledExactlyOnceWith(biz);
    expect(archive.watch).toHaveBeenCalledExactlyOnceWith(biz);
    expect(official).not.toHaveBeenCalled();
  });

  it('honors an explicit profile refresh instead of silently substituting cached basic information', async () => {
    archive.company.mockResolvedValue(company);
    archive.profile.mockResolvedValue({ company, warnings: [] });
    const client = api(), official = vi.spyOn(client, 'company').mockRejectedValue(new ProviderQuotaError(137));
    const result = await handleG2bRequest('/api/companies', new URLSearchParams({ q: biz, refresh: '1' }), client);
    expect(result.status).toBe(429);
    expect(official).toHaveBeenCalledExactlyOnceWith(biz);
    expect(archive.company).not.toHaveBeenCalled();
    expect(archive.profile).not.toHaveBeenCalled();
  });

  it('retains bounded direct source routes for collector compatibility, without triggering a national scan', async () => {
    const client = api();
    const participation = vi.spyOn(client, 'companyParticipation').mockResolvedValue({} as never);
    const result = await handleG2bRequest('/api/company-participation', new URLSearchParams({ businessNumber: biz, type: '용역', day: '2026-10-13', page: '2' }), client);
    expect(result.status).toBe(200);
    expect(participation).toHaveBeenCalledExactlyOnceWith({ businessNumber: biz, type: '용역', day: '2026-10-13', page: 2 });
    expect(archive.combinedHistory).not.toHaveBeenCalled();
  });

  it('dispatches new contract and profile collection through the existing archive function', async () => {
    const client = api();
    const contracts = vi.spyOn(client, 'contractArchivePage').mockResolvedValue({} as never);
    const profile = vi.spyOn(client, 'companyArchive').mockResolvedValue({ company, warnings: [] });
    expect((await handleG2bRequest('/api/archive-page', new URLSearchParams({ source: 'contracts', type: '공사', from: '2026-10-01', to: '2026-10-14', page: '2' }), client)).status).toBe(200);
    expect(contracts).toHaveBeenCalledExactlyOnceWith({ type: '공사', from: '2026-10-01', to: '2026-10-14', page: 2 });
    expect((await handleG2bRequest('/api/archive-page', new URLSearchParams({ source: 'company', businessNumber: biz }), client)).status).toBe(200);
    expect(profile).toHaveBeenCalledExactlyOnceWith(biz);
    expect((await handleG2bRequest('/api/archive-page', new URLSearchParams({ source: 'unknown' }), client)).status).toBe(400);
  });

  it('does not hide official quota failure when no cached profile exists', async () => {
    const client = api();
    vi.spyOn(client, 'company').mockRejectedValue(new ProviderQuotaError(137));
    const result = await handleG2bRequest('/api/companies', new URLSearchParams({ q: biz }), client);
    expect(result).toMatchObject({ status: 429, retryAfterSeconds: 137, body: { error: { code: 'G2B_QUOTA_EXCEEDED' } } });
    expect(archive.watch).not.toHaveBeenCalled();
  });
});
