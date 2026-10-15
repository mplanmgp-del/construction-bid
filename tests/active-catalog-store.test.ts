import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActiveCatalogStore } from '../server/active-catalog-store';

afterEach(() => vi.useRealTimers());
describe('catalog storage request boundary', () => {
  it('does not send a storage request after the handler deadline', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-15T00:00:00Z'));
    const fetcher = vi.fn<typeof fetch>();
    const store = createActiveCatalogStore({ url: 'https://example.supabase.co', key: 'sb_publishable_test', token: 'a'.repeat(64), fetcher });
    store.setDeadline(Date.now() - 1);
    await expect(store.page()).rejects.toMatchObject({ code: 'CATALOG_STORAGE_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('allows the handler to replace the collector deadline before scanning alerts', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ groups: [], nextCursor: null }));
    const store = createActiveCatalogStore({ url: 'https://example.supabase.co', key: 'sb_publishable_test', token: 'a'.repeat(64), fetcher });
    store.setDeadline(Date.now() - 1);
    store.setDeadline(Date.now() + 5_000);
    await store.page({ changedSince: '2026-10-15T00:00:00Z', changedThrough: '2026-10-15T00:10:00Z' });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ p_action: 'page', p_payload: { changedSince: '2026-10-15T00:00:00Z', changedThrough: '2026-10-15T00:10:00Z' } });
    expect(fetcher.mock.calls[0][1]?.signal).toBeDefined();
  });
});
