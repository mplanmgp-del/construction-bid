import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HighlightTitle, NoticeList, noticeState } from '../src/components/NoticeList';
import { NOTICES, DEMO_PROFILES } from '../src/data';
describe('notice list presentation', () => {
  it('highlights literal queries safely without treating input as markup or regex', () => {
    expect(renderToStaticMarkup(<HighlightTitle title="[철거] 철거공사" keyword="[철거]" />)).toBe('<mark>[철거]</mark> 철거공사');
    expect(renderToStaticMarkup(<HighlightTitle title="<script>철거</script>" keyword="철거" />)).toBe('&lt;script&gt;<mark>철거</mark>&lt;/script&gt;');
  });
  it('uses the announced opening time for completion and keeps cancellation unclassified', () => {
    const bid = { ...NOTICES[0], status: '마감' as const, deadline: '2026-10-13T10:00:00+09:00', openingAt: '2026-10-13T11:00:00+09:00' };
    expect(noticeState(bid, Date.parse('2026-10-13T10:30:00+09:00')).label).toBe('진행중');
    expect(noticeState(bid, Date.parse('2026-10-13T11:00:00+09:00')).label).toBe('개찰 완료');
    expect(noticeState({ ...bid, status: '취소' }, Date.parse('2026-10-13T11:00:00+09:00')).label).toBe('-');
  });
  it('renders schedule-based completion immediately while result companies have not loaded', () => {
    const bid = { ...NOTICES[0], source: 'live' as const, status: '접수중' as const, openingAt: '2026-10-13T11:00:00+09:00' };
    const html = renderToStaticMarkup(<NoticeList bids={[bid]} now={Date.parse('2026-10-13T11:00:00+09:00')} keyword="" profile={DEMO_PROFILES[0]} bookmarks={[]} selected={[]} onSelect={() => {}} onOpen={() => {}} onBookmark={() => {}} />);
    expect(html).toContain('>개찰 완료</span>');
    expect(html).toContain('공고에 기재된 개찰일시 기준입니다.');
    expect(html).toMatch(/data-label="1순위 업체"[^>]*>-<\/td>/);
    expect(html).toMatch(/data-label="낙찰업체"[^>]*>-<\/td>/);
  });
  it('shows reference columns, revision and demand agency, with missing companies as dashes', () => {
    const bid = { ...NOTICES[0], source: 'demo' as const, demandAgency: '실제 수요기관', noticeKind: '등록공고', revision: '002' };
    const html = renderToStaticMarkup(<NoticeList bids={[bid]} keyword="철거" profile={DEMO_PROFILES[0]} bookmarks={[]} selected={[]} onSelect={() => {}} onOpen={() => {}} onBookmark={() => {}} />);
    expect(html).toContain('1순위 업체'); expect(html).toContain('낙찰업체');
    expect(html).toContain('실제 수요기관'); expect(html).toContain(`${bid.number}-002`);
    expect(html).toContain('현재 페이지 공고 전체 선택');
    expect(html).toContain('자료 기준">-</td>');
  });
});
