import { describe, expect, it, vi } from 'vitest';
import { createArchivePageLoader } from '../server/company-archive-page';
import type { RelatedRequest } from '../server/g2b-related';

const base = { bidNtceNo: 'R26BK01757822', bidNtceOrd: '000', bsnsDivNm: '공사', bidNtceNm: '공공 공사', ntceInsttNm: '공고기관', dmndInsttNm: '수요기관', opengDate: '2026-10-13', opengTm: '11:00', bidprcCorpBizrno: '0012345678', bidprcCorpNm: '공개회사', bidprcDate: '2026-10-12', bidprcTm: '15:30', bidprcAmt: '1,234,000', bidprcRt: '88.123', opengRank: '1', sucsfYn: 'N', fnlSucsfAmt: '5000000', cntrctCnclsMthdNm: '제한경쟁' };
const query = { type: '공사' as const, day: '2026-10-13', page: 1 };
function request(items: Record<string, unknown>[], totalCount = items.length) { return vi.fn<RelatedRequest>(async () => ({ items, totalCount })); }

describe('company participation archive source pages', () => {
  it('requests 999 rows for exactly one Korean calendar day and returns normalized allowlisted data', async () => {
    const req = request([base]);
    const page = await createArchivePageLoader(req, () => Date.parse('2026-10-14T00:00:00Z'))(query);
    expect(req).toHaveBeenCalledWith('https://apis.data.go.kr/1230000/ao/PubDataOpnStdService/', 'getDataSetOpnStdScsbidInfo', { bsnsDivCd: '3', opengBgnDt: '202610130000', opengEndDt: '202610132359', pageNo: '1', numOfRows: '999' }, 25_000);
    expect(page).toMatchObject({ sourceCount: 1, totalCount: 1, hasMore: false, pageSize: 999 });
    expect(page.notices[0]).toMatchObject({ number: base.bidNtceNo, revision: '000', title: '공공 공사', agency: '수요기관', opening_at: '2026-10-13T11:00:00+09:00', method: '제한경쟁', participant_count: null });
    expect(page.entries[0]).toMatchObject({ business_number: '0012345678', bidding_at: '2026-10-12T15:30:00+09:00', bid_amount: 1234000, bid_rate: 88.123, awarded: false, winning_amount: null });
  });
  it('keeps IDs stable when rank, final award and page position change', async () => {
    const a = await createArchivePageLoader(request([base]))(query);
    const b = await createArchivePageLoader(request([{ ...base, opengRank: '3', sucsfYn: 'Y', fnlSucsfAmt: '1234000', dataBssDate: '2026-10-15' }]))(query);
    expect(a.entries[0].id).toBe(b.entries[0].id);
    expect(a.notices[0].id).toBe(b.notices[0].id);
    expect(b.entries[0]).toMatchObject({ awarded: true, winning_amount: 1234000 });
  });
  it('retains different submissions and excludes mutable ranking from identity', async () => {
    const result = await createArchivePageLoader(request([base, { ...base, bidprcTm: '15:31' }]))(query);
    expect(result.notices).toHaveLength(1);
    expect(new Set(result.entries.map(row => row.id)).size).toBe(2);
    expect(result.companies).toHaveLength(1);
  });
  it('does not treat rank one as a final award or unrecognized flags as false', async () => {
    const result = await createArchivePageLoader(request([{ ...base, sucsfYn: '' }]))(query);
    expect(result.entries[0]).toMatchObject({ rank: '1', awarded: null, winning_amount: null });
  });
  it('retains failed notices without participants and keeps source row counts', async () => {
    const result = await createArchivePageLoader(request([{ ...base, bidprcCorpBizrno: '', bidprcCorpNm: '' }]))(query);
    expect(result.sourceCount).toBe(1);
    expect(result.notices).toHaveLength(1);
    expect(result.entries).toEqual([]);
    expect(result.companies).toEqual([]);
  });
  it('rejects silent page-size fallback instead of claiming ingestion success', async () => {
    await expect(createArchivePageLoader(request([base], 999))(query)).rejects.toMatchObject({ status: 502 });
  });
  it('does not silently discard a malformed notice among otherwise valid rows', async () => {
    for (const bidNtceNo of [undefined, '', 'R26 BK01757822', 'R26/BK01757822', 'A'.repeat(41)]) {
      await expect(createArchivePageLoader(request([base, { ...base, bidNtceNo, bidprcCorpBizrno: '9999999999' }]))(query))
        .rejects.toMatchObject({ status: 502, code: 'G2B_ARCHIVE_INCOMPLETE' });
    }
  });
  it('rejects duplicate participation rows that cannot be distinguished by the source', async () => {
    await expect(createArchivePageLoader(request([base, base]))(query)).rejects.toMatchObject({ status: 502 });
  });
  it('rejects invalid nonempty business IDs and mixed business/date responses', async () => {
    for (const overrides of [{ bidprcCorpBizrno: '123' }, { bsnsDivNm: '용역' }, { opengDate: '2026-10-12' }]) {
      await expect(createArchivePageLoader(request([{ ...base, ...overrides }]))(query)).rejects.toMatchObject({ status: 502 });
    }
  });
  it('validates queries before provider calls and allows normal empty days', async () => {
    const req = request([]);
    const load = createArchivePageLoader(req);
    await expect(load({ ...query, day: '2026-02-30' })).rejects.toMatchObject({ status: 400 });
    await expect(load({ ...query, page: 0 })).rejects.toMatchObject({ status: 400 });
    expect(req).not.toHaveBeenCalled();
    expect(await load(query)).toMatchObject({ sourceCount: 0, totalCount: 0, hasMore: false, entries: [], notices: [] });
  });
  it('detects a provider that ignores page number even when response counts look valid', async () => {
    const rows = Array.from({ length: 999 }, (_, index) => ({ ...base, bidprcCorpBizrno: String(index + 1).padStart(10, '0') }));
    const load = createArchivePageLoader(request(rows, 1998));
    expect((await load(query)).hasMore).toBe(true);
    await expect(load({ ...query, page: 2 })).rejects.toMatchObject({ status: 502 });
    // Retrying the same already seen page is valid; the ingestion store handles idempotency.
    expect((await load(query)).sourceCount).toBe(999);
  });
  it('accepts the exact final page size and selects the service business code', async () => {
    const req = request([{ ...base, bsnsDivNm: '용역' }], 1000);
    const page = await createArchivePageLoader(req)({ ...query, type: '용역', page: 2 });
    expect(page).toMatchObject({ totalCount: 1000, sourceCount: 1, hasMore: false });
    expect(req.mock.calls[0][2]).toMatchObject({ bsnsDivCd: '5', pageNo: '2' });
  });
});
