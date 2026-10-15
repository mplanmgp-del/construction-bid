import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nodeApiHandler, type NodeResponse } from '../server/http';

const provider = vi.hoisted(() => ({ companyAwards: vi.fn(), notices: vi.fn(), noticeRegions: vi.fn() }));
vi.mock('../server/g2b', async original => ({ ...await original<typeof import('../server/g2b')>(), createG2bClient: () => provider }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn(), getCache: vi.fn() }));
const id = '11111111-1111-4111-8111-111111111111';
let locked = true, admin = false, serial = 0;
const fetcher = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith('/bid_menu_settings')) return Response.json([{ menu_key: url.searchParams.get('menu_key')?.slice(3), locked, message: '점검 중' }]);
  if (url.pathname === '/auth/v1/user') return Response.json({ id, user_metadata: { isAdmin: true, role: 'admin' } });
  if (url.pathname.endsWith('/bid_admin_users')) return Response.json(admin ? [{ user_id: id }] : []);
  throw new Error(`Unexpected URL ${url.pathname}`);
});
beforeEach(() => {
  locked = true; admin = false; serial++;
  fetcher.mockClear();
  provider.companyAwards.mockReset().mockResolvedValue({ items: [], totalCount: 0 });
  provider.notices.mockReset().mockResolvedValue({ items: [], totalCount: 0 });
  provider.noticeRegions.mockReset().mockResolvedValue({ items: [{ number: 'R26BK01770711', revision: '000', complete: true, allowedRegions: ['서울특별시'] }] });
  vi.stubGlobal('fetch', fetcher);
  vi.stubEnv('VITE_SUPABASE_URL', 'https://access-test.supabase.co');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function request(url: string, authorization?: string) {
  const headers: Record<string, string> = {}; let body = '';
  const response: NodeResponse = { statusCode: 0, setHeader: (name, value) => { headers[name] = value; }, end: value => { body = value || ''; } };
  await nodeApiHandler({ method: 'GET', url, headers: { 'x-forwarded-for': `access-${serial}`, ...(authorization ? { authorization } : {}) } }, response);
  return { status: response.statusCode, body: JSON.parse(body), headers };
}
const awards = '?businessNumber=8488802470&type=공사&from=2026-10-01&to=2026-10-14';

it.each(['/api/company-awards' + awards, '/api/company-data' + awards + '&_companyAction=awards',
  '/api/company-contracts', '/api/company-history', '/api/company-participation', '/api/companies?q=함께',
  '/api/company-data?_companyAction=history', '/api/company-data?_companyAction=contracts', '/api/company-data?_companyAction=participation',
  '/api/archive-page?source=contracts&type=공사&from=2026-10-01&to=2026-10-14'])('blocks locked MY routes before provider work: %s', async url => {
  expect(await request(url)).toMatchObject({ status: 403, body: { error: { code: 'MENU_LOCKED', message: '점검 중' } } });
  expect(provider.companyAwards).not.toHaveBeenCalled();
});

it('does not treat user-editable role metadata as an administrator', async () => {
  expect((await request('/api/company-awards' + awards, 'Bearer member-token')).status).toBe(403);
  expect(provider.companyAwards).not.toHaveBeenCalled();
});

it('permits an authenticated administrator only after remote identity and own membership verification', async () => {
  admin = true;
  expect((await request('/api/company-awards' + awards, 'Bearer admin-token')).status).toBe(200);
  expect(provider.companyAwards).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.some(([input]) => String(input).includes('/auth/v1/user'))).toBe(true);
});

it('unlocked region APIs stay usable anonymously but never enter public CDN cache', async () => {
  locked = false;
  const result = await request('/api/notice-regions?type=공사&notices=R26BK01770711:000');
  expect(result.status).toBe(200);
  expect(result.headers['Vercel-CDN-Cache-Control']).toBe('private, no-store');
  expect(result.headers['Cache-Control']).toBe('no-store');
});

it('fails closed on an unavailable settings database before provider calls', async () => {
  fetcher.mockRejectedValueOnce(new Error('Offline'));
  expect((await request('/api/company-awards' + awards)).status).toBe(503);
  expect(provider.companyAwards).not.toHaveBeenCalled();
});
