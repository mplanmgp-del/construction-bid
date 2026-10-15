import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAlertStore } from '../server/alert-store';

afterEach(() => vi.restoreAllMocks());
describe('absolute worker storage deadline', () => {
  it('clips each RPC to the remaining total worker time rather than starting another full timeout', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    const store = createAlertStore({ url: 'https://example.supabase.co', key: 'public', fetcher });
    store.setDeadline(1500);
    await store.claim();
    expect(timeout).toHaveBeenCalledWith(500);
  });
  it('does not start another database request after its overall deadline', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    const store = createAlertStore({ url: 'https://example.supabase.co', key: 'public', fetcher });
    store.setDeadline(Date.now() - 1);
    await expect(store.commit('lease', { finish: true })).rejects.toMatchObject({ code: 'ALERT_STORAGE_DEADLINE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
