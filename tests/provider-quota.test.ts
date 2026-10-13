import { expect, it, vi } from 'vitest';
import { createProviderQuotaGuard, ProviderQuotaError, PROVIDER_QUOTA_COOLDOWN_MS, type ProviderQuotaCache } from '../server/provider-quota';

const start = Date.parse('2026-10-13T03:00:00Z');
const credential = 'test-secret-credential', base = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';
function fixture() {
  let time = start;
  const values = new Map<string, unknown>();
  const cache: ProviderQuotaCache = {
    get: vi.fn(async key => values.get(key)),
    set: vi.fn(async (key, value) => { values.set(key, structuredClone(value)); }),
  };
  const options = { cache, now: () => time };
  return { cache, values, options, advance: (ms: number) => { time += ms; } };
}

it('allows fresh service requests, then shares a quota failure with another server instance', async () => {
  const f = fixture(), first = createProviderQuotaGuard(f.options), second = createProviderQuotaGuard(f.options);
  await expect(second.assertAvailable(credential, base)).resolves.toBeUndefined();
  await first.trip(credential, base);
  await expect(second.assertAvailable(credential, base)).rejects.toMatchObject({
    name: 'ProviderQuotaError', status: 429, code: 'G2B_QUOTA_EXCEEDED', retryAfterSeconds: 1800,
  });
  const reads = vi.mocked(f.cache.get).mock.calls.length;
  await expect(second.assertAvailable(credential, base)).rejects.toBeInstanceOf(ProviderQuotaError);
  expect(f.cache.get).toHaveBeenCalledTimes(reads); // Known local failures do not need another remote read.
});

it('scopes suppression to the service and credential and never stores the secret', async () => {
  const f = fixture(), guard = createProviderQuotaGuard(f.options);
  await guard.trip(credential, `${base}/`);
  await expect(guard.assertAvailable(credential, base)).rejects.toBeInstanceOf(ProviderQuotaError);
  await expect(guard.assertAvailable('different-credential', base)).resolves.toBeUndefined();
  await expect(guard.assertAvailable(credential, 'https://apis.data.go.kr/another-service')).resolves.toBeUndefined();
  const [key, value, options] = vi.mocked(f.cache.set).mock.calls[0];
  expect(key).toMatch(/^v1:[a-f0-9]{64}$/);
  expect(JSON.stringify([key, value])).not.toContain(credential);
  expect(JSON.stringify([key, value])).not.toContain(base);
  expect(options.ttl).toBe(1800);
});

it('does not extend the original deadline when checking or recording an already blocked service', async () => {
  const f = fixture(), first = createProviderQuotaGuard(f.options);
  await first.trip(credential, base);
  f.advance(60_000);
  const other = createProviderQuotaGuard(f.options);
  await expect(first.assertAvailable(credential, base)).rejects.toMatchObject({ retryAfterSeconds: 1740 });
  await other.trip(credential, base);
  await first.trip(credential, base);
  expect(f.cache.set).toHaveBeenCalledOnce();
  f.advance(PROVIDER_QUOTA_COOLDOWN_MS - 60_000);
  // Exercise application expiry even if the backing store retains the stale envelope.
  await expect(first.assertAvailable(credential, base)).resolves.toBeUndefined();
  await expect(other.assertAvailable(credential, base)).resolves.toBeUndefined();
});

it('allows a later provider failure to start a new suppression period after expiry', async () => {
  const f = fixture(), guard = createProviderQuotaGuard(f.options);
  await guard.trip(credential, base);
  f.advance(PROVIDER_QUOTA_COOLDOWN_MS);
  await guard.trip(credential, base);
  expect(f.cache.set).toHaveBeenCalledTimes(2);
  await expect(guard.assertAvailable(credential, base)).rejects.toMatchObject({ retryAfterSeconds: 1800 });
});

it('fails open for cache outages but retains locally observed quota failures', async () => {
  const f = fixture(), guard = createProviderQuotaGuard(f.options);
  vi.mocked(f.cache.get).mockRejectedValue(new Error('cache unavailable'));
  vi.mocked(f.cache.set).mockRejectedValue(new Error('cache unavailable'));
  await expect(guard.assertAvailable(credential, base)).resolves.toBeUndefined();
  await expect(guard.trip(credential, base)).resolves.toBeUndefined();
  await expect(guard.assertAvailable(credential, base)).rejects.toBeInstanceOf(ProviderQuotaError);
  f.advance(PROVIDER_QUOTA_COOLDOWN_MS);
  await expect(guard.assertAvailable(credential, base)).resolves.toBeUndefined();
});

it('ignores malformed, expired, or implausibly distant shared entries', async () => {
  for (const invalid of [null, {}, { schema: 2, blockedUntil: start + 1000 }, { schema: 1, blockedUntil: 'later' },
    { schema: 1, blockedUntil: start }, { schema: 1, blockedUntil: start + PROVIDER_QUOTA_COOLDOWN_MS + 1 }]) {
    const f = fixture(); vi.mocked(f.cache.get).mockResolvedValue(invalid);
    await expect(createProviderQuotaGuard(f.options).assertAvailable(credential, base)).resolves.toBeUndefined();
  }
});

it('bounds the local suppression cache while allowing shared entries to be read again', async () => {
  const f = fixture(), guard = createProviderQuotaGuard(f.options);
  for (let index = 0; index < 257; index++) await guard.trip(`credential-${index}`, base);
  const reads = vi.mocked(f.cache.get).mock.calls.length;
  await expect(guard.assertAvailable('credential-256', base)).rejects.toBeInstanceOf(ProviderQuotaError);
  expect(f.cache.get).toHaveBeenCalledTimes(reads);
  await expect(guard.assertAvailable('credential-0', base)).rejects.toBeInstanceOf(ProviderQuotaError);
  expect(f.cache.get).toHaveBeenCalledTimes(reads + 1);
});
