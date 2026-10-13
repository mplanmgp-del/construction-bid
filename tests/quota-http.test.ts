import { expect, it, vi } from 'vitest';
import { createG2bClient } from '../server/g2b';
import { handleG2bRequest } from '../server/http';
import { ProviderQuotaError } from '../server/provider-quota';

it('rejects a blank full-search keyword before reading any provider data', async () => {
  const api = createG2bClient({ serviceKey: 'unused' });
  const start = vi.spyOn(api, 'startNotices');
  const result = await handleG2bRequest('/api/notices-start', new URLSearchParams({ type: '공사', from: '2026-10-07', to: '2026-10-13', window: '0', keyword: '  ' }), api);
  expect(result).toMatchObject({ status: 400, body: { error: { code: 'KEYWORD_REQUIRED' } } });
  expect(start).not.toHaveBeenCalled();
});

it('keeps service quota status and retry delay across the HTTP boundary', async () => {
  const api = createG2bClient({ serviceKey: 'unused' });
  vi.spyOn(api, 'notices').mockRejectedValue(new ProviderQuotaError(123));
  const result = await handleG2bRequest('/api/notices', new URLSearchParams({ type: '공사', from: '2026-10-07', to: '2026-10-13' }), api);
  expect(result).toMatchObject({ status: 429, retryAfterSeconds: 123, body: { error: { code: 'G2B_QUOTA_EXCEEDED', retryAfterSeconds: 123 } } });
});
