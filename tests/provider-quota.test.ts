import { expect, it, vi } from 'vitest';
import { createG2bClient } from '../server/g2b';

// Simulate an unexpired record left by the old deployment. A deployed server must
// still contact the provider instead of allowing legacy cache state to lock it out.
vi.mock('@vercel/functions', () => ({ getCache: () => ({
  get: async () => ({ schema: 1, blockedUntil: Date.parse('2026-10-13T03:30:00Z') }),
  set: async () => undefined,
}) }));

it('ignores a legacy shared quota block and returns current provider data', async () => {
  const client = createG2bClient({
    serviceKey: 'legacy-block-test', now: () => Date.parse('2026-10-13T03:00:00Z'),
    fetcher: async () => Response.json({ response: { header: { resultCode: '00' }, body: { items: [], totalCount: 0 } } }),
  });
  const result = await client.notices({ type: '공사', from: '2026-10-07', to: '2026-10-13', keyword: '철거', page: 1, pageSize: 100 });
  expect(result).toMatchObject({ items: [], totalCount: 0, hasMore: false });
});
