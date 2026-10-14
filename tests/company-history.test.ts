import { describe, expect, it, vi } from 'vitest';
import { createCompanyArchiveReader, parseCompanyHistoryQuery } from '../server/company-history';

const params = (extra: Record<string, string> = {}) => new URLSearchParams({ businessNumber: '001-23-45678', ...extra });
const valid = parseCompanyHistoryQuery(params());

describe('permanent company history queries', () => {
  it('accepts all history or multi-decade date ranges without imposing a provider date-span limit', () => {
    expect(valid).toEqual({ businessNumber: '0012345678', from: null, to: null, page: 1, outcome: 'all' });
    expect(parseCompanyHistoryQuery(params({ from: '1995-01-01', to: '2026-10-14', page: '3000', outcome: 'won' }))).toMatchObject({ from: '1995-01-01', to: '2026-10-14', page: 3000, outcome: 'won' });
    expect(parseCompanyHistoryQuery(params({ to: '2020-12-31' })).from).toBeNull();
  });
  it('rejects impossible/reversed dates, invalid company IDs and unsupported pagination/filters', () => {
    const invalidQueries: Record<string, string>[] = [{ from: '2026-02-30' }, { from: '2026-10-14', to: '2026-10-13' }, { businessNumber: 'abc0012345678' }, { page: '0' }, { page: '1.5' }, { outcome: 'unknown' }];
    for (const invalid of invalidQueries) {
      expect(() => parseCompanyHistoryQuery(params(invalid))).toThrow();
    }
  });
  it('does not turn database/network failures into empty company-history success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private network detail'));
    const archive = createCompanyArchiveReader({ url: 'https://project.supabase.co', key: 'test-key', fetcher });
    await expect(archive.history(valid)).rejects.toMatchObject({ status: 503, code: 'ARCHIVE_UNAVAILABLE' });
    fetcher.mockResolvedValueOnce(new Response('private error detail', { status: 403 }));
    await expect(archive.search('공개회사')).rejects.toMatchObject({ status: 503, code: 'ARCHIVE_UNAVAILABLE' });
    await expect(createCompanyArchiveReader({}).history(valid)).rejects.toMatchObject({ status: 503 });
  });
  it('passes exact company/date filters to the index and includes collector interruptions in coverage', async () => {
    const history = { company: null, items: [], totalCount: 0, coverage: { status: 'collecting', message: '아직 수집 중' } };
    const fetcher = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(String(input).includes('/rpc/') ? history : [{ status: 'storage', message: '저장 공간 확장이 필요합니다.' }]), { status: 200 }));
    const archive = createCompanyArchiveReader({ url: 'https://project.supabase.co', key: 'test-key', fetcher });
    const result = await archive.history(parseCompanyHistoryQuery(params({ from: '1995-01-01', to: '2026-10-14', page: '3', outcome: 'won' })));
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe('/rest/v1/rpc/bid_company_history');
    expect(Object.fromEntries(url.searchParams)).toEqual({ bizno: '0012345678', page_no: '3', page_size: '30', outcome: 'won', from_date: '1995-01-01', to_date: '2026-10-14' });
    expect(result.coverage.message).toContain('저장 공간 확장');
  });
  it('allows reading stored history when the optional collector-health endpoint is unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => String(input).includes('/rpc/') ? new Response(JSON.stringify({ items: [], totalCount: 0, coverage: { status: 'collecting', message: '수집 중' } })) : new Response('', { status: 404 }));
    const result = await createCompanyArchiveReader({ url: 'https://project.supabase.co', key: 'test-key', fetcher }).history(valid);
    expect(result).toMatchObject({ totalCount: 0, coverage: { message: '수집 중' } });
  });
});
