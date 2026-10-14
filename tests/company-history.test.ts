import { describe, expect, it, vi } from 'vitest';
import { createCompanyArchiveReader, parseCompanyHistoryQuery } from '../server/company-history';

const params = (extra: Record<string, string> = {}) => new URLSearchParams({ businessNumber: '001-23-45678', ...extra });
const valid = parseCompanyHistoryQuery(params());

describe('permanent company history queries', () => {
  it('accepts all history or multi-decade date ranges without imposing a provider date-span limit', () => {
    expect(valid).toEqual({ businessNumber: '0012345678', from: null, to: null, page: 1, contractsPage: 1, awardsPage: 1, outcome: 'all' });
    expect(parseCompanyHistoryQuery(params({ from: '1995-01-01', to: '2026-10-14', page: '3000', outcome: 'won' }))).toMatchObject({ from: '1995-01-01', to: '2026-10-14', page: 3000, outcome: 'won' });
    expect(parseCompanyHistoryQuery(params({ to: '2020-12-31' })).from).toBeNull();
  });
  it('rejects impossible/reversed dates, invalid company IDs and unsupported pagination/filters', () => {
    const invalidQueries: Record<string, string>[] = [{ from: '2026-02-30' }, { from: '2026-10-14', to: '2026-10-13' }, { businessNumber: 'abc0012345678' }, { page: '0' }, { page: '1.5' }, { contractsPage: '0' }, { awardsPage: '2.5' }, { outcome: 'unknown' }];
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

  it('combines independent indexed pages and queues only the business identifier', async () => {
    const coverage = { status: 'collecting', from: '2026-10-01', to: '2026-10-14', updatedAt: null, message: '수집 중' };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('bid_watch_company')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ p_business_number: valid.businessNumber });
        return Response.json({ status: 'queued', queued: true });
      }
      if (url.pathname.endsWith('bid_company_contract_history')) return Response.json({ items: [{ businessNumber: valid.businessNumber, id: 'contract' }], totalCount: 90, page: 3, pageSize: 30, coverage });
      if (url.pathname.endsWith('bid_company_history')) return Response.json({ company: null, items: [], totalCount: 0,
        page: Number(url.searchParams.get('page_no')), pageSize: 30, coverage });
      if (url.pathname.endsWith('bid_company_profiles')) return Response.json([{ profile: { businessNumber: valid.businessNumber, name: '공개 업체', registrationDate: '2020-01-02', privateEmail: 'must-not-leak' }, warnings: [] }]);
      return Response.json([]);
    });
    const result = await createCompanyArchiveReader({ url: 'https://project.supabase.co', key: 'test-key', fetcher }).combinedHistory({ ...valid, page: 2, contractsPage: 3, awardsPage: 4 });
    expect(result).toMatchObject({ page: 2, contracts: { page: 3, totalCount: 90 }, awards: { page: 4, source: '수집된 공식 참여 이력 중 낙찰' }, company: { name: '공개 업체', registrationDate: '2020-01-02' } });
    const awardUrl = fetcher.mock.calls.map(([input]) => new URL(String(input))).find(url => url.searchParams.get('outcome') === 'won');
    expect(awardUrl?.searchParams.get('page_no')).toBe('4');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('preserves successful participation while a failed contract source stays explicitly unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.includes('bid_company_contract_history')) return new Response('', { status: 500 });
      if (url.includes('bid_company_history')) return Response.json({ company: null, items: [], totalCount: 0, page: 1, pageSize: 30,
        coverage: { status: 'collecting', message: '미완료', from: null, to: null, updatedAt: null } });
      return Response.json([]);
    });
    const result = await createCompanyArchiveReader({ url: 'https://project.supabase.co', key: 'test-key', fetcher }).combinedHistory(valid);
    expect(result.coverage.status).toBe('collecting');
    expect(result.contracts?.coverage).toMatchObject({ status: 'unavailable', message: expect.stringContaining('0건이라는 의미는 아닙니다') });
  });

  it('rejects malformed storage envelopes and never sends a different company profile or contract', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [], totalCount: 0 }));
    const archive = createCompanyArchiveReader({ url: 'https://project.supabase.co', key: 'test-key', fetcher });
    await expect(archive.history(valid)).rejects.toMatchObject({ code: 'ARCHIVE_UNAVAILABLE' });
    fetcher.mockResolvedValueOnce(Response.json([{ profile: { businessNumber: '9999999999', name: 'Wrong' } }]));
    await expect(archive.profile(valid.businessNumber)).rejects.toMatchObject({ code: 'ARCHIVE_UNAVAILABLE' });
    fetcher.mockResolvedValueOnce(Response.json([{ business_number: '9999999999', name: 'Wrong' }]));
    await expect(archive.company(valid.businessNumber)).rejects.toMatchObject({ code: 'ARCHIVE_UNAVAILABLE' });
    fetcher.mockResolvedValueOnce(Response.json({ items: [{ businessNumber: '9999999999' }], totalCount: 1, coverage: { status: 'ready', message: '' } }));
    await expect(archive.contracts(valid)).rejects.toMatchObject({ code: 'ARCHIVE_UNAVAILABLE' });
  });

  it('does not report a full watch queue as scheduled and validates identifiers before writes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ status: 'queue_full', queued: false }))
      .mockResolvedValueOnce(Response.json({ status: 'current', queued: false }));
    const archive = createCompanyArchiveReader({ url: 'https://project.supabase.co', key: 'test-key', fetcher });
    expect(await archive.watch(valid.businessNumber)).toBe(false);
    expect(await archive.watch(valid.businessNumber)).toBe(true);
    expect(await archive.watch('invalid')).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('runs reads concurrently with the queue and preserves saved history when scheduling is rejected', async () => {
    let resolveWatch!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { resolveWatch = resolve; });
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.includes('bid_watch_company')) return pending;
      if (url.includes('/rpc/')) return Response.json({ company: null, items: [], totalCount: 17, page: 1, pageSize: 30,
        coverage: { status: 'collecting', message: '수집 중', from: null, to: null, updatedAt: null } });
      return Response.json([]);
    });
    let settled = false;
    const reading = createCompanyArchiveReader({ url: 'https://project.supabase.co', key: 'test-key', fetcher }).combinedHistory(valid).then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('bid_company_history'))).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('bid_archive_health'))).toHaveLength(1);
    resolveWatch(Response.json({ status: 'rate_limited', queued: false }));
    const result = await reading;
    expect(result.totalCount).toBe(17);
    expect(result.coverage.message).toContain('수집 신청이 등록되었는지 확인하지 못했습니다');
    expect(result.coverage.message).toContain('저장된 이력만 표시');
  });

  it.each(['queue_full', 'not_found', 'unexpected'])('keeps saved records and explains a rejected or unknown queue response: %s', async status => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      if (String(input).includes('bid_watch_company')) return Response.json({ status, queued: false });
      if (String(input).includes('/rpc/')) return Response.json({ company: null, items: [], totalCount: 17, page: 1, pageSize: 30,
        coverage: { status: 'collecting', message: '부분 이력', from: null, to: null, updatedAt: null } });
      return Response.json([]);
    });
    const result = await createCompanyArchiveReader({ url: 'https://project.supabase.co', key: 'test-key', fetcher }).combinedHistory(valid);
    expect(result.totalCount).toBe(17);
    expect(result.coverage.message).toContain('수집 신청이 등록되었는지 확인하지 못했습니다');
  });
});
