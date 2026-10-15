import { afterEach, describe, expect, it, vi } from 'vitest';
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('../src/member/client', () => ({ getMemberClient: () => ({ auth: { getSession } }) }));
import { fetchApi } from '../src/live/client';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('same-origin API session forwarding', () => {
  it('passes the current session to protected application APIs', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'test-session' } }, error: null });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetcher);
    await fetchApi('/api/company-history?businessNumber=1234567890');
    expect(fetcher.mock.calls[0][1]!.headers).toMatchObject({ Authorization: 'Bearer test-session' });
  });
  it('does not transmit the session to an external URL', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'test-session' } }, error: null });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetcher);
    await fetchApi('https://example.org/public-data');
    expect(getSession).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1]!.headers).not.toHaveProperty('Authorization');
  });
  it('leaves guest requests anonymous and respects cancellation before transport', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetcher);
    await fetchApi('/api/notices');
    expect(fetcher.mock.calls[0][1]!.headers).not.toHaveProperty('Authorization');
    fetcher.mockClear(); const controller = new AbortController(); controller.abort();
    await expect(fetchApi('/api/company-awards', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
