import { describe, expect, it, vi } from 'vitest';
import { NOTICES } from '../src/data';
import type { BidNotice } from '../src/types';
import type { G2bNoticePage } from '../src/g2b-types';
import {
  NoticeNumberController, browserNoticeNumberRepository, buildNoticeNumberResult,
  parseNoticeNumberInput, visibleNoticeNumberSearch,
} from '../src/live/notice-number-search';
import { fetchApi } from '../src/live/client';

vi.mock('../src/live/client', async original => ({ ...await original<typeof import('../src/live/client')>(), fetchApi: vi.fn() }));
const number = 'R26BK01359594';
const notice = (revision: string, patch: Partial<BidNotice> = {}): BidNotice => ({ ...NOTICES[0],
  id: `g2b:공사:${number}:${revision}`, number, revision, source: 'live', type: '공사',
  status: revision === '001' ? '취소' : '접수중', deadline: '2027-03-04T10:00:00+09:00',
  postedAt: '2026-02-26T17:23:00+09:00', ...patch,
});
const page = (items: BidNotice[], patch: Partial<G2bNoticePage> = {}): G2bNoticePage => ({ items,
  totalCount: items.length, page: 1, pageSize: 999, hasMore: false, fetchedAt: '2026-10-15T07:00:00Z', source: '나라장터', ...patch,
});
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('notice number parsing and complete revision results', () => {
  it('normalizes the base number and optional revision without restricting publication age', () => {
    expect(parseNoticeNumberInput(' r26bk01359594-0 ')).toEqual({ number, revision: '000' });
    expect(parseNoticeNumberInput(number)).toEqual({ number, revision: null });
    expect(parseNoticeNumberInput('20160235560-00')).toEqual({ number: '20160235560', revision: '000' });
  });
  it.each(['', 'R26BK01359594-ABC', 'R26BK01359594-0000', 'R26BK 01359594', 'R26BK01359594\n000', '<script>', 'A'.repeat(41)])('rejects an invalid input %s', input => {
    expect(() => parseNoticeNumberInput(input)).toThrow('공고번호');
  });
  it('selects the cancellation as latest and keeps the requested original in history', () => {
    const group = buildNoticeNumberResult(page([notice('000'), notice('001')]), { number, revision: '000' }, '공사');
    expect(group?.latest.revision).toBe('001'); expect(group?.latest.status).toBe('취소');
    expect(group?.history.map(item => item.revision)).toEqual(['001', '000']);
    expect(group?.requested?.revision).toBe('000');
  });
  it('deduplicates revisions while preserving the newest representation', () => {
    const group = buildNoticeNumberResult(page([notice('001'), notice('000'), notice('001', { title: '최신 응답', postedAt: '2026-02-27T12:00:00+09:00' })]), { number, revision: null }, '공사');
    expect(group?.history).toHaveLength(2); expect(group?.latest.title).toBe('최신 응답');
  });
  it('does not substitute another revision when the requested revision is absent', () => {
    const group = buildNoticeNumberResult(page([notice('001')]), { number, revision: '002' }, '공사');
    expect(group?.requested).toBeNull(); expect(group?.latest.revision).toBe('001');
    expect(buildNoticeNumberResult(page([]), { number, revision: null }, '공사')).toBeNull();
  });
  it.each([page([notice('000')], { hasMore: true }), page([notice('000')], { totalCount: 2 }),
    page([notice('000', { number: 'R26BK99999999' })]), page([notice('000', { type: '용역' })]),
    page([notice('bad')]), page([], { quotaExceeded: true })])('rejects incomplete or mismatched revision responses', response => {
    expect(() => buildNoticeNumberResult(response, { number, revision: null }, '공사')).toThrow();
  });
});

describe('account-scoped explicit number lookup', () => {
  it('makes no automatic requests and asks both business types only on submit', async () => {
    const load = vi.fn(async (_number: string, type: '공사' | '용역') => page(type === '공사' ? [notice('001')] : []));
    const controller = new NoticeNumberController(load); controller.setUser('a');
    expect(load).not.toHaveBeenCalled();
    await controller.search(number + '-000', '공사·용역');
    expect(load.mock.calls.map(call => call.slice(0, 2))).toEqual([[number, '공사'], [number, '용역']]);
    expect(controller.getSnapshot()).toMatchObject({ loading: false, attempted: true, errors: [], groups: [{ latest: { revision: '001' } }] });
  });
  it('retains successful results while naming the business type that failed', async () => {
    const controller = new NoticeNumberController(async (_number, type) => {
      if (type === '용역') throw new Error('요청 제한'); return page([notice('001')]);
    }); controller.setUser('a'); await controller.search(number, '공사·용역');
    expect(controller.getSnapshot().groups).toHaveLength(1);
    expect(controller.getSnapshot().errors).toEqual([{ type: '용역', message: '요청 제한' }]);
  });
  it('cancels and hides previous results when the account changes, including an unresolved request', async () => {
    const pending = deferred<G2bNoticePage>(); let signal: AbortSignal | undefined;
    const controller = new NoticeNumberController(async (_number, _type, requestSignal) => { signal = requestSignal; return pending.promise; });
    controller.setUser('a'); const running = controller.search(number, '공사');
    expect(visibleNoticeNumberSearch(controller.getSnapshot(), 'b').loading).toBe(false);
    expect(visibleNoticeNumberSearch(controller.getSnapshot(), 'b').groups).toEqual([]);
    controller.setUser('b'); expect(signal?.aborted).toBe(true);
    pending.resolve(page([notice('001')])); await running;
    expect(controller.getSnapshot()).toMatchObject({ userId: 'b', groups: [], attempted: false, loading: false });
  });
  it('ignores an old search that completes after a new number search', async () => {
    const pending = deferred<G2bNoticePage>();
    const controller = new NoticeNumberController(async requested => requested === number ? pending.promise : page([]));
    controller.setUser('a'); const old = controller.search(number, '공사');
    await controller.search('R26BK01700000', '공사'); pending.resolve(page([notice('001')])); await old;
    expect(controller.getSnapshot()).toMatchObject({ query: { number: 'R26BK01700000' }, groups: [], attempted: true });
  });
  it('clears in-flight results immediately on input changes and avoids requests for invalid input', async () => {
    const pending = deferred<G2bNoticePage>(); const load = vi.fn(async () => pending.promise);
    const controller = new NoticeNumberController(load); controller.setUser('a'); const old = controller.search(number, '공사');
    controller.clear(); pending.resolve(page([notice('001')])); await old;
    expect(controller.getSnapshot()).toMatchObject({ groups: [], attempted: false, loading: false });
    await controller.search('invalid number', '공사');
    expect(load).toHaveBeenCalledTimes(1); expect(controller.getSnapshot().error).toContain('공고번호');
  });
  it('uses the authenticated same-origin wrapper and sends the base number without a date filter', async () => {
    vi.mocked(fetchApi).mockResolvedValueOnce(page([])); const signal = new AbortController().signal;
    await browserNoticeNumberRepository(number, '공사', signal);
    expect(fetchApi).toHaveBeenCalledWith('/api/notices?mode=number&type=%EA%B3%B5%EC%82%AC&number=R26BK01359594', signal);
  });
});
