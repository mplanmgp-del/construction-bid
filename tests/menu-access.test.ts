import { describe, expect, it, vi } from 'vitest';
import { authorizeMenuRequest, menuForApi } from '../server/menu-access';

const userId = '11111111-1111-4111-8111-111111111111';
const settings = (locked = true) => [{ menu_key: 'results', locked, message: '점검 안내' }];
function service(responses: Array<unknown | Response | Error>) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : Response.json(next);
  });
  return { fetcher, options: { url: 'https://test.supabase.co', key: 'sb_publishable_test', fetcher } };
}

describe('menu API access authority', () => {
  it.each(['/api/companies', '/api/company-awards', '/api/company-contracts', '/api/company-history', '/api/company-participation', '/api/archive-page'])('maps %s to MY menu policy', path => { expect(menuForApi(path)).toBe('results'); });
  it.each(['/api/notices', '/api/notices-start', '/api/detail', '/api/results', '/api/related', '/api/notice-regions', '/api/opening-results', '/api/result-summary'])('maps %s to notice policy', path => { expect(menuForApi(path)).toBe('notices'); });
  it('does not assign an unrelated unknown route to a procurement menu', async () => {
    const { fetcher, options } = service([]);
    expect(await authorizeMenuRequest('/api/not-real', undefined, options)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('public unlocked requests do not validate a supplied token or query membership', async () => {
    const { fetcher, options } = service([settings(false)]);
    expect(await authorizeMenuRequest('/api/company-history', 'Bearer anything', options)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([undefined, 'malformed', 'Bearer a b', ['Bearer one', 'Bearer two'], 'Bearer ' + 'x'.repeat(8200)])('rejects missing, ambiguous or malformed authorization: %s', async header => {
    const { fetcher, options } = service([settings()]);
    expect(await authorizeMenuRequest('/api/company-history', header, options)).toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects a remotely invalid token without querying administrator rows', async () => {
    const { fetcher, options } = service([settings(), Response.json({ error: 'bad_jwt' }, { status: 401 })]);
    expect(await authorizeMenuRequest('/api/company-history', 'Bearer forged.jwt.value', options)).toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not trust user_metadata or app_metadata when no owner-provisioned membership exists', async () => {
    const { options } = service([settings(), { id: userId, user_metadata: { admin: true }, app_metadata: { admin: true } }, []]);
    expect(await authorizeMenuRequest('/api/company-history', 'Bearer token', options)).toMatchObject({ status: 403 });
  });
  it('sends a verified token to its own membership query and rejects another user row', async () => {
    const { fetcher, options } = service([settings(), { id: userId }, [{ user_id: '22222222-2222-4222-8222-222222222222' }]]);
    expect(await authorizeMenuRequest('/api/company-history', 'Bearer verified-token', options)).toMatchObject({ status: 403 });
    const [url, init] = fetcher.mock.calls[2];
    expect(new URL(String(url)).searchParams.get('user_id')).toBe(`eq.${userId}`);
    expect(init?.headers).toMatchObject({ apikey: 'sb_publishable_test', Authorization: 'Bearer verified-token' });
  });
  it.each([[], [{ menu_key: 'notices', locked: false, message: '' }], [{ menu_key: 'results', locked: 'false', message: '' }], null])('fails closed on absent or malformed menu rows: %s', async rows => {
    const { options } = service([rows]);
    expect(await authorizeMenuRequest('/api/company-history', undefined, options)).toMatchObject({ status: 503 });
  });
  it('fails closed if Auth or membership validation is unavailable', async () => {
    for (const responses of [[settings(), new Error('Auth offline')], [settings(), { id: userId }, new Error('DB offline')]]) {
      const { options } = service(responses);
      expect(await authorizeMenuRequest('/api/company-history', 'Bearer token', options)).toMatchObject({ status: 503 });
    }
  });
  it('rechecks settings on every request so a new lock is effective immediately', async () => {
    const { fetcher, options } = service([settings(false), settings(true)]);
    expect(await authorizeMenuRequest('/api/company-history', undefined, options)).toBeNull();
    expect(await authorizeMenuRequest('/api/company-history', undefined, options)).toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init?.cache === 'no-store')).toBe(true);
  });
  it.each(['sb_secret_bad', 'a.' + Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') + '.c'])('rejects an accidentally configured privileged key before network traffic', async key => {
    const { fetcher, options } = service([]);
    expect(await authorizeMenuRequest('/api/company-history', undefined, { ...options, key })).toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
