import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NOTICES } from '../src/data';
import type { G2bNoticePage } from '../src/g2b-types';
import type { BidNotice } from '../src/types';
import {
  NoticeDetailRevisionNotice, noticeDetailDisplayState, verifyNoticeDetailRevision,
} from '../src/live/NoticeDetailPage';

const now = Date.parse('2026-10-15T12:00:00+09:00');
const original: BidNotice = { ...NOTICES[0], id: 'g2b:공사:R26BK01359594:000', number: 'R26BK01359594', revision: '000',
  type: '공사', source: 'live', status: '접수중', noticeKind: '등록공고', deadline: '2027-03-04T10:00:00+09:00',
  openingAt: '2027-03-04T11:00:00+09:00', biddingStartAt: '2026-02-27T10:00:00+09:00' };
const latest: BidNotice = { ...original, id: 'g2b:공사:R26BK01359594:001', revision: '001', status: '취소', noticeKind: '취소공고' };
const query = { number: original.number, revision: original.revision, type: original.type };
function page(items: BidNotice[], patch: Partial<G2bNoticePage> = {}): G2bNoticePage {
  return { items, totalCount: items.length, page: 1, pageSize: 999, hasMore: false, source: '나라장터', fetchedAt: '', ...patch };
}

describe('standalone detail latest revision verification', () => {
  it('keeps the requested old record and links to the higher cancelled revision instead of displaying it as active', async () => {
    const repository = vi.fn().mockResolvedValue(page([original, latest]));
    const signal = new AbortController().signal;
    const verification = await verifyNoticeDetailRevision(query, signal, repository);
    expect(repository).toHaveBeenCalledWith(original.number, '공사', signal);
    expect(noticeDetailDisplayState(original, verification, now)).toMatchObject({ label: '이전 000차수', tone: 'unknown' });
    const html = renderToStaticMarkup(<NoticeDetailRevisionNotice bid={original} verification={verification} now={now} />);
    expect(html).toContain('최신 001차수 · 취소공고');
    expect(html).toContain('이전 차수의 기록');
    expect(html).toContain('revision=001');
    expect(html).toContain('최신 차수 보기');
    expect(original.revision).toBe('000'); expect(original.status).toBe('접수중');
    expect(original.deadline).toBe('2027-03-04T10:00:00+09:00');
  });

  it('shows the normal schedule status only after confirming this is the latest revision', async () => {
    const verification = await verifyNoticeDetailRevision(query, new AbortController().signal,
      async () => page([original]));
    expect(noticeDetailDisplayState(original, verification, now)).toMatchObject({ label: '진행중', tone: 'active' });
    expect(renderToStaticMarkup(<NoticeDetailRevisionNotice bid={original} verification={verification} now={now} />)).toBe('');
  });

  it('identifies cancellation on the latest revision even if the requested detail still has a stale active status', async () => {
    const cancelled = { ...original, noticeKind: '취소공고' };
    const verification = await verifyNoticeDetailRevision(query, new AbortController().signal,
      async () => page([cancelled]));
    expect(noticeDetailDisplayState(original, verification, now)).toMatchObject({ label: '취소공고', tone: 'unknown' });
  });

  it('does not show a current active status when latest-revision lookup fails', async () => {
    const verification = await verifyNoticeDetailRevision(query, new AbortController().signal,
      async () => { throw new Error('upstream unavailable'); });
    expect(verification.status).toBe('unavailable');
    expect(noticeDetailDisplayState(original, verification, now)).toMatchObject({ label: '상태 확인 필요', tone: 'unknown' });
    const html = renderToStaticMarkup(<NoticeDetailRevisionNotice bid={original} verification={verification} now={now} />);
    expect(html).toContain('최신 차수를 확인하지 못했습니다');
    expect(html).not.toContain('진행중');
  });

  it.each([
    page([original], { hasMore: true, totalCount: 2 }),
    page([original], { quotaExceeded: true }),
    page([]),
    page([latest]),
  ])('keeps incomplete or missing requested-revision histories unverified', async value => {
    const verification = await verifyNoticeDetailRevision(query, new AbortController().signal, async () => value);
    expect(verification.status).toBe('unavailable');
    expect(noticeDetailDisplayState(original, verification, now).tone).toBe('unknown');
  });

  it('keeps an already loaded detail available with a neutral badge during asynchronous revision verification', () => {
    expect(noticeDetailDisplayState(original, { status: 'checking' }, now)).toMatchObject({ label: '최신 차수 확인 중', tone: 'unknown' });
    const html = renderToStaticMarkup(<NoticeDetailRevisionNotice bid={original} verification={{ status: 'checking' }} now={now} />);
    expect(html).toContain('공고 상세는 먼저 표시합니다');
    expect(html).not.toContain('진행중');
  });
});
