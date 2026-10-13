import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HighlightTitle, NoticeList, noticeState } from '../src/components/NoticeList';
import { NOTICES, DEMO_PROFILES } from '../src/data';
import type { G2bResultSummary } from '../src/g2b-types';
describe('notice list presentation', () => {
  it('highlights literal queries safely without treating input as markup or regex', () => {
    expect(renderToStaticMarkup(<HighlightTitle title="[철거] 철거공사" keyword="[철거]" />)).toBe('<mark>[철거]</mark> 철거공사');
    expect(renderToStaticMarkup(<HighlightTitle title="<script>철거</script>" keyword="철거" />)).toBe('&lt;script&gt;<mark>철거</mark>&lt;/script&gt;');
  });
  it('shows opening completion only when confirmed and cancellation takes precedence', () => {
    const bid = { ...NOTICES[0], status: '마감' as const };
    const result = { result: '개찰완료' } as G2bResultSummary;
    expect(noticeState(bid).label).toBe('마감');
    expect(noticeState(bid, result).label).toBe('개찰 완료');
    expect(noticeState({ ...bid, status: '취소' }, result).label).toBe('취소');
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
