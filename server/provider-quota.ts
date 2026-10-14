/** A current upstream quota failure; never an application-imposed cooldown. */
export class ProviderQuotaError extends Error {
  readonly status = 429;
  readonly code = 'G2B_QUOTA_EXCEEDED';
  readonly retryAfterSeconds?: number;

  constructor(retryAfterSeconds?: number) {
    super('나라장터에서 호출 한도 초과 응답을 받았습니다. 저장된 결과가 있으면 표시합니다. 다시 조회하여 현재 상태를 확인할 수 있습니다.');
    this.name = 'ProviderQuotaError';
    if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      this.retryAfterSeconds = Math.ceil(retryAfterSeconds);
    }
  }
}

/** Preserve only an actual provider delay. Missing or invalid headers have no fallback. */
export function providerRetryAfter(value: string | null, now: number): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const seconds = /^\d+$/.test(raw) ? Number(raw)
    : /^[A-Za-z]{3},\s/.test(raw) ? (Date.parse(raw) - now) / 1000 : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}
