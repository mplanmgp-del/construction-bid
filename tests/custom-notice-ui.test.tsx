import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CustomNoticeResults, CustomNoticeSearch } from '../src/live/CustomNoticeSearch';
import { DEFAULT_ALERT_SETTINGS, type AlertNotice } from '../src/alerts/types';
import { NOTICES, DEMO_PROFILES } from '../src/data';
import type { useCustomNotices } from '../src/live/useCustomNotices';

const now = Date.parse('2026-10-15T03:00:00Z');
const settings = { ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: false,
  filter: { ...structuredClone(DEFAULT_ALERT_SETTINGS.filter), keywords: ['철거'], types: ['공사'] as ['공사'], regions: [], licenses: [], useCompanyRegion: false } };
const bid: AlertNotice = { ...NOTICES[0], title: '학교 철거 공사', source: 'live', sourceUpdatedAt: '',
  deadline: '2026-10-30T18:00:00+09:00', regionComplete: true, licenseComplete: true };
const search: ReturnType<typeof useCustomNotices> = { userId: 'a', items: [bid], loading: false, error: '', hasMore: false,
  candidateCount: 1, checkedCount: 1, apiRequests: 1, fetchedAt: null, search: async () => {}, loadMore: async () => {}, clear: () => {} };
const results = (state: Partial<typeof search> = {}) => renderToStaticMarkup(<CustomNoticeResults search={{ ...search, ...state }} settings={settings}
  profile={DEMO_PROFILES[0]} bookmarks={[bid.id]} onBookmark={() => {}} onOpen={() => {}} now={now} />);

describe('custom lookup result integrity', () => {
  it('shows matching rows and their saved favorite even while automatic notifications are disabled', () => {
    const html = results();
    expect(html).toContain('학교 철거 공사');
    expect(html).toContain('맞춤 조건 일치');
    expect(html).toContain('즐겨찾기 해제');
    expect(html).toContain('게시 기간의 조회를 마쳤습니다');
  });
  it('labels a partial range and keeps a next-range control', () => {
    const html = results({ hasMore: true });
    expect(html).toContain('현재 확인한 범위의 결과');
    expect(html).toContain('공고 더 조회');
    expect(html).not.toContain('게시 기간의 조회를 마쳤습니다');
  });
  it('keeps confirmed rows visible alongside a failed-range warning', () => {
    const html = results({ error: '상세 조회 실패', hasMore: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain('상세 조회 실패');
    expect(html).toContain('학교 철거 공사');
  });
  it('does not represent a failed empty lookup as a completed zero result', () => {
    const html = results({ items: [], error: '연결 실패', hasMore: true });
    expect(html).toContain('공고 조회를 완료하지 못했습니다');
    expect(html).not.toContain('게시 기간의 조회를 마쳤습니다');
  });
  it('explains login and settings failures without issuing a query during rendering', () => {
    const base = { settings: null, profile: DEMO_PROFILES[0], profileReady: true, bookmarks: [], onBookmark: () => {}, onOpen: () => {}, onEditConditions: () => {}, onGeneralSearch: () => {}, onLogin: () => {} };
    expect(renderToStaticMarkup(<CustomNoticeSearch {...base} />)).toContain('로그인하고 맞춤 조회');
    const html = renderToStaticMarkup(<CustomNoticeSearch {...base} userId="a" settingsError="조건 연결 실패" onRetrySettings={() => {}} />);
    expect(html).toContain('조건 연결 실패');
    expect(html).toContain('조건 다시 불러오기');
  });
});
