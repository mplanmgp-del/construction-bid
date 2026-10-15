import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoticeList } from '../src/components/NoticeList';
import { BidDetail } from '../src/components/BidDetail';
import { BookmarkButton } from '../src/components/BookmarkButton';
import { DEMO_PROFILES, NOTICES } from '../src/data';

const notice = { ...NOTICES[0], source: 'demo' as const };

describe('visible notice bookmark controls', () => {
  it('supports disabled controls without submitting enclosing forms or exposing title markup', () => {
    const html = renderToStaticMarkup(<form><BookmarkButton noticeTitle={'<script>notice</script>'} saved={false} onToggle={() => {}} disabled /></form>);
    expect(html).toContain('type="button"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('&lt;script&gt;notice&lt;/script&gt; 즐겨찾기 저장');
    expect(html).not.toContain('<script>');
  });

  it('shows a named bookmark control and its saved state in search results', () => {
    const props = { bids: [notice], keyword: '', profile: DEMO_PROFILES[0], selected: [], onSelect: () => {}, onOpen: () => {}, onBookmark: () => {} };
    const empty = renderToStaticMarkup(<NoticeList {...props} bookmarks={[]} />);
    expect(empty).toContain(`${notice.title} 즐겨찾기 저장`);
    expect(empty).toContain('aria-pressed="false"');
    expect(empty).toContain('<span>즐겨찾기</span>');
    const saved = renderToStaticMarkup(<NoticeList {...props} bookmarks={[notice.id]} />);
    expect(saved).toContain(`${notice.title} 즐겨찾기 해제`);
    expect(saved).toContain('aria-pressed="true"');
    expect(saved).toContain('<span>저장됨</span>');
  });

  it('keeps the same visible saved control in the detail drawer', () => {
    const html = renderToStaticMarkup(<BidDetail bid={notice} profile={DEMO_PROFILES[0]} assessment={{ status: 'review', reason: '' }} isBookmarked onClose={() => {}} onToggleBookmark={() => {}} />);
    expect(html).toContain(`${notice.title} 즐겨찾기 해제`);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('<span>저장됨</span>');
  });
});
