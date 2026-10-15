import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NOTICES } from '../src/data';
import { NoticeNumberLookup, NoticeNumberResults } from '../src/live/NoticeNumberLookup';
import { buildNoticeNumberResult, type NoticeNumberSnapshot } from '../src/live/notice-number-search';

const number = 'R26BK01359594';
const original = { ...NOTICES[0], id: 'original', number, revision: '000', deadline: '2027-03-04T10:00:00+09:00',
  biddingStartAt: '2026-02-27T10:00:00+09:00', postedAt: '2026-02-26T17:23:00+09:00' };
const cancelled = { ...original, id: 'cancelled', revision: '001', status: '취소' as const, noticeKind: '취소공고' };
const group = buildNoticeNumberResult({ items: [original, cancelled], totalCount: 2, page: 1, pageSize: 999,
  hasMore: false, source: '나라장터', fetchedAt: '2026-10-15T07:00:00Z' }, { number, revision: '000' }, '공사')!;
const snapshot: NoticeNumberSnapshot = { userId: 'a', query: { number, revision: '000' }, loading: false,
  attempted: true, groups: [group], errors: [], error: '' };

describe('number lookup status and history', () => {
  it('exposes an explicit number form without making a request during render', () => {
    const html = renderToStaticMarkup(<NoticeNumberLookup userId="a" bookmarks={[]} onBookmark={() => {}} onOpen={() => {}} />);
    expect(html).toContain('공고번호 조회'); expect(html).toContain('name="noticeNumber"');
    expect(html).toContain('공사·용역'); expect(html).not.toContain('취소공고');
  });
  it('shows the latest cancellation prominently and labels the requested original as history', () => {
    const html = renderToStaticMarkup(<NoticeNumberResults snapshot={snapshot} bookmarks={['cancelled']} onBookmark={() => {}} onOpen={() => {}} />);
    expect(html).toContain('최신 001차수'); expect(html).toContain('취소공고');
    expect(html).toContain('이전 000차수'); expect(html).toContain('현재 진행 공고');
    expect(html).toContain('data-revision="000" data-current="false" data-requested="true"');
    expect(html).toContain('aria-label="R26BK01359594-001 즐겨찾기 해제"');
    expect(html).toContain('2027.');
  });
  it('does not turn a partial type failure into a zero-result success', () => {
    const html = renderToStaticMarkup(<NoticeNumberResults snapshot={{ ...snapshot, groups: [], errors: [{ type: '공사', message: '요청 제한' }] }} bookmarks={[]} onBookmark={() => {}} onOpen={() => {}} />);
    expect(html).toContain('공사 조회 실패'); expect(html).toContain('조회하지 못한 업무');
    expect(html).not.toContain('해당 번호의 공고가 없습니다');
  });
});
