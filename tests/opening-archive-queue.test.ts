import { expect, it, vi } from 'vitest';
import { queueOpeningArchive } from '../server/opening-archive-queue';
const query = { number: 'R26BK01731386', revision: '000', type: '공사' as const };
it('sends only a validated public notice identity, never client-provided bid data', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('true', { status: 200 }));
  expect(await queueOpeningArchive(query, { url: 'https://project.supabase.co', key: 'public-key', fetcher })).toBe(true);
  expect(String(fetcher.mock.calls[0][0])).toBe('https://project.supabase.co/rest/v1/rpc/bid_queue_opening_notice');
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ p_type: '공사', p_number: 'R26BK01731386', p_revision: '000' });
});
it('rejects invalid identifiers and does not break detail viewing when the queue is unavailable', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('secret'); });
  expect(await queueOpeningArchive({ ...query, number: 'bad/number' }, { url: 'https://project.supabase.co', key: 'public-key', fetcher })).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await queueOpeningArchive(query, { url: 'https://project.supabase.co', key: 'public-key', fetcher })).toBe(false);
});
