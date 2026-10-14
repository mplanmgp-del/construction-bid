import { expect, it, vi } from 'vitest';
import { loadCompanyAwards, type AwardCache } from '../server/company-award-cache';
import type { CompanyAwardPage } from '../src/company-award-types';

const now = Date.parse('2026-10-14T05:00:00Z');
const query = { businessNumber: '8488802470', type: '공사' as const, from: '2026-09-01', to: '2026-09-30' };
const page = (): CompanyAwardPage => ({ ...query, items: [], totalCount: 0, complete: true, warnings: [], source: '나라장터', fetchedAt: new Date(now).toISOString() });
function fixture() {
  const values = new Map<string, unknown>();
  const cache: AwardCache = { get: vi.fn(async key => values.get(key)), set: vi.fn(async (key, value) => { values.set(key, value); }) };
  return { cache, now: () => now };
}
it('shares a complete company-period response without another upstream call', async () => {
  const options = fixture(), loader = vi.fn(async () => page());
  expect((await loadCompanyAwards(query, loader, options)).status).toBe('MISS');
  expect((await loadCompanyAwards(query, loader, options)).status).toBe('HIT');
  expect(loader).toHaveBeenCalledOnce();
  const other = { ...query, businessNumber: '3028128785' };
  await loadCompanyAwards(other, async () => ({ ...page(), ...other }), options);
  expect(options.cache.set).toHaveBeenCalledTimes(2);
});
it('never persists partial responses or a mismatched company response', async () => {
  const options = fixture();
  const partial = { ...page(), complete: false, warnings: ['불완전'] };
  expect((await loadCompanyAwards(query, async () => partial, options)).body).toEqual(partial);
  expect(options.cache.set).not.toHaveBeenCalled();
  await expect(loadCompanyAwards(query, async () => ({ ...page(), businessNumber: '0000000000' }), options)).rejects.toThrow();
  expect(options.cache.set).not.toHaveBeenCalled();
});
it('deduplicates simultaneous public queries', async () => {
  const options = fixture(); let finish!: (value: CompanyAwardPage) => void;
  const loader = vi.fn(() => new Promise<CompanyAwardPage>(resolve => { finish = resolve; }));
  const a = loadCompanyAwards(query, loader, options), b = loadCompanyAwards(query, loader, options);
  await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce()); finish(page());
  await Promise.all([a, b]);
});
it('uses a timestamped successful snapshot when a forced refresh fails', async () => {
  const options = fixture(); await loadCompanyAwards(query, async () => page(), options);
  const result = await loadCompanyAwards(query, async () => { throw new Error('serviceKey=secret'); }, { ...options, force: true });
  expect(result.status).toBe('STALE'); expect(result.body.fetchedAt).toBe(page().fetchedAt);
  expect(result.body.warnings.length).toBeGreaterThan(0); expect(JSON.stringify(result)).not.toContain('secret');
});
it('refreshes the current period after three minutes but retains older complete months', async () => {
  const options = fixture(); const current = { ...query, from: '2026-10-01', to: '2026-10-14' };
  const loader = vi.fn(async () => ({ ...page(), ...current }));
  await loadCompanyAwards(current, loader, options);
  await loadCompanyAwards(current, loader, { ...options, now: () => now + 181_000 });
  expect(loader).toHaveBeenCalledTimes(2);
  await loadCompanyAwards(query, async () => page(), options);
  const oldLoader = vi.fn(async () => page());
  expect((await loadCompanyAwards(query, oldLoader, { ...options, now: () => now + 181_000 })).status).toBe('HIT');
  expect(oldLoader).not.toHaveBeenCalled();
});

it('keeps quota errors actionable instead of masking them with a stale snapshot', async () => {
  const options = fixture(); await loadCompanyAwards(query, async () => page(), options);
  const error = Object.assign(new Error('quota reached'), { status: 429 });
  await expect(loadCompanyAwards(query, async () => { throw error; }, { ...options, force: true })).rejects.toBe(error);
});
