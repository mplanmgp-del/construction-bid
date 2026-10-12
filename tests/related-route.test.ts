import { describe, expect, it, vi } from 'vitest';
import { createG2bClient } from '../server/g2b';
import { handleG2bRequest } from '../server/http';

describe('related notice route', () => {
  it.each([
    { number: '' }, { number: 'https://example.com' }, { revision: '-1' },
    { revision: '1000' }, { type: '물품' },
  ])('rejects invalid notice identities before provider access: %o', async change => {
    const fetcher = vi.fn();
    const result = await handleG2bRequest('/api/related', new URLSearchParams({ number: 'R26BK01764541', revision: '000', type: '공사', ...change }), createG2bClient({ serviceKey: 'test', fetcher }));
    expect(result).toMatchObject({ status: 400, body: { error: { code: 'INVALID_QUERY' } } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('normalizes the revision and forwards only the validated notice identity', async () => {
    const client = createG2bClient({ serviceKey: 'test' });
    const value = { number: 'R26BK01764541', revision: '000', type: '공사' as const, fetchedAt: '', groups: [], warnings: [] };
    const related = vi.spyOn(client, 'related').mockResolvedValue(value);
    const result = await handleG2bRequest('/api/related', new URLSearchParams({ number: value.number, revision: '0', type: value.type, agencyCode: 'ARBITRARY', url: 'https://example.com' }), client);
    expect(related).toHaveBeenCalledExactlyOnceWith(value.number, '000', '공사');
    expect(result).toEqual({ status: 200, body: value });
  });
});
