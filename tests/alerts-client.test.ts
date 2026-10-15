import { afterEach, describe, expect, it, vi } from 'vitest';
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('../src/member/client', () => ({ getMemberClient: () => ({ auth: { getSession } }) }));
import { browserAlertRepository } from '../src/alerts/useAlerts';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/types';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('authenticated alert requests', () => {
  it('sends settings to the same-origin alert API using the current session and no caller user ID', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'test-token' } }, error: null });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetcher);
    await browserAlertRepository.mutate('save', { settings: DEFAULT_ALERT_SETTINGS }, new AbortController().signal);
    const [path, options] = fetcher.mock.calls[0];
    expect(path).toBe('/api/alerts?action=save');
    expect(options?.method).toBe('POST'); expect(options?.headers).toMatchObject({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' });
    expect(JSON.parse(options?.body as string)).toEqual({ settings: DEFAULT_ALERT_SETTINGS });
  });
  it('does not issue a request after logout or cancellation during session lookup', async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    await expect(browserAlertRepository.load(0, 0, new AbortController().signal)).rejects.toThrow('로그인');
    const abort = new AbortController();
    getSession.mockImplementationOnce(async () => { abort.abort(); return { data: { session: { access_token: 'late-token' } }, error: null }; });
    await expect(browserAlertRepository.load(0, 0, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects an unsuccessful acknowledgment instead of reporting that settings were saved', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'test-token' } }, error: null });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ ok: false })));
    await expect(browserAlertRepository.mutate('save', { settings: DEFAULT_ALERT_SETTINGS }, new AbortController().signal)).rejects.toThrow('결과를 확인하지 못했습니다');
  });
  it('forwards separate inbox and existing-match pagination offsets', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'test-token' } }, error: null });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ notifications: [] })); vi.stubGlobal('fetch', fetcher);
    await browserAlertRepository.load(50, 100, new AbortController().signal);
    expect(fetcher.mock.calls[0][0]).toBe('/api/alerts?action=overview&offset=50&existingOffset=100');
  });
});
