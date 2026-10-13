import { createHash } from 'node:crypto';
import { getCache } from '@vercel/functions';

// This is a retry suppression interval, not a promise about the provider's quota reset.
export const PROVIDER_QUOTA_COOLDOWN_MS = 30 * 60_000;
const MAX_LOCAL_BLOCKS = 256;
const SCHEMA = 1;

export class ProviderQuotaError extends Error {
  readonly status = 429;
  readonly code = 'G2B_QUOTA_EXCEEDED';
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('나라장터 호출 한도로 신규 조회를 일시 중단했습니다. 저장된 결과가 있으면 표시합니다. 잠시 후 다시 확인해 주세요.');
    this.name = 'ProviderQuotaError';
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export interface ProviderQuotaCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options: { ttl: number }): Promise<unknown>;
}

interface QuotaBlock { schema: number; blockedUntil: number }
let runtimeCache: ProviderQuotaCache | undefined;
const unavailableCache: ProviderQuotaCache = { get: async () => undefined, set: async () => undefined };
function defaultCache(): ProviderQuotaCache {
  // Runtime Cache is regional and ephemeral. Explicitly namespace this project on Hobby teams.
  // Keep the full credential/service SHA-256 instead of the SDK's default shorter hash.
  try { return runtimeCache ??= getCache({ namespace: 'construction-bid:provider-quota-v1', keyHashFunction: key => key }); }
  catch { return unavailableCache; }
}

function quotaKey(serviceKey: string, base: string): string {
  return `v${SCHEMA}:${createHash('sha256').update(JSON.stringify([serviceKey, base.replace(/\/+$/, '')])).digest('hex')}`;
}

function activeBlock(value: unknown, now: number): value is QuotaBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as QuotaBlock;
  return block.schema === SCHEMA && Number.isSafeInteger(block.blockedUntil)
    && block.blockedUntil > now && block.blockedUntil <= now + PROVIDER_QUOTA_COOLDOWN_MS;
}

/** Share known quota failures by credential and service, never by individual search or operation. */
export function createProviderQuotaGuard(options: { cache?: ProviderQuotaCache; now?: () => number } = {}) {
  const localBlocks = new Map<string, QuotaBlock>();
  const clock = options.now ?? Date.now;
  const cache = () => options.cache ?? defaultCache();
  const remember = (key: string, block: QuotaBlock, now: number) => {
    for (const [oldKey, oldBlock] of localBlocks) {
      if (oldBlock.blockedUntil <= now) localBlocks.delete(oldKey);
    }
    localBlocks.delete(key);
    localBlocks.set(key, block);
    while (localBlocks.size > MAX_LOCAL_BLOCKS) localBlocks.delete(localBlocks.keys().next().value!);
  };
  const read = async (key: string, now: number): Promise<QuotaBlock | undefined> => {
    const local = localBlocks.get(key);
    if (activeBlock(local, now)) return local;
    localBlocks.delete(key);
    let shared: unknown;
    try { shared = await cache().get(key); } catch { /* A cache outage must not disable otherwise available service. */ }
    if (!activeBlock(shared, now)) return undefined;
    remember(key, shared, now);
    return shared;
  };

  return {
    async assertAvailable(serviceKey: string, base: string, now: () => number = clock): Promise<void> {
      const block = await read(quotaKey(serviceKey, base), now());
      if (block && block.blockedUntil > now()) throw new ProviderQuotaError((block.blockedUntil - now()) / 1000);
    },
    async trip(serviceKey: string, base: string, now: () => number = clock): Promise<void> {
      const key = quotaKey(serviceKey, base);
      if (await read(key, now())) return; // Repeated failures cannot postpone the existing retry time.
      const time = now(), block: QuotaBlock = { schema: SCHEMA, blockedUntil: time + PROVIDER_QUOTA_COOLDOWN_MS };
      remember(key, block, time);
      try { await cache().set(key, block, { ttl: PROVIDER_QUOTA_COOLDOWN_MS / 1000 }); }
      catch { /* Keep local suppression when the shared cache is unavailable. */ }
    },
  };
}

const guard = createProviderQuotaGuard();
export const checkProviderQuota = (serviceKey: string, base: string, now?: () => number) => guard.assertAvailable(serviceKey, base, now);
export const recordProviderQuota = (serviceKey: string, base: string, now?: () => number) => guard.trip(serviceKey, base, now);
