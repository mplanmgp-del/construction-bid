import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UnifiedNoticeSearch } from '../src/live/UnifiedNoticeSearch';
import { noticeSearchKind, planUnifiedNoticeSearch, reconcileUnifiedSearchDraft } from '../src/live/unified-notice-search';
import type { NoticeQuery } from '../src/live/notice-search';

const query: NoticeQuery = { type: '공사·용역', from: '2026-04-15', to: '2027-04-15', keyword: '' };
const actions = { onSearch: () => {}, bookmarks: [], onOpen: () => {}, onBookmark: () => {}, onLogin: () => {}, onResultModeChange: () => {} };

describe('unified notice search routing', () => {
  it.each(['철거', 'school', 'CONCRETE', 'ABC_DEF', '', 'R26BK01359594 철거'])('keeps %j in title search when automatic detection is selected', input => {
    expect(noticeSearchKind(input, 'auto')).toBe('title');
  });

  it.each(['R26BK01359594', ' r26bk01359594-0 ', '20160235560', '20160235560-00'])('recognizes the known modern or legacy number %j', input => {
    expect(noticeSearchKind(input, 'auto')).toBe('number');
  });

  it('lets the explicit target disambiguate number-shaped titles and unusual accepted identifiers', () => {
    expect(noticeSearchKind('R26BK01359594', 'title')).toBe('title');
    expect(planUnifiedNoticeSearch('ABC_DEF12-2', 'number', query)).toEqual({ kind: 'number', input: 'ABC_DEF12-2', type: '공사·용역' });
  });

  it('keeps the exact title and selected business and dates in the indexed query', () => {
    expect(planUnifiedNoticeSearch('  school 철거  ', 'auto', { ...query, type: '용역' })).toEqual({
      kind: 'title', query: { type: '용역', from: '2026-04-15', to: '2027-04-15', keyword: 'school 철거' },
    });
  });

  it('allows an empty title and preserves the full indexed archival date range', () => {
    expect(planUnifiedNoticeSearch('', 'auto', { ...query, from: '1995-10-01', to: '2100-12-31' })).toEqual({
      kind: 'title', query: { type: '공사·용역', from: '1995-10-01', to: '2100-12-31', keyword: '' },
    });
  });

  it('excludes invalid dates from number lookup while keeping the requested revision', () => {
    expect(planUnifiedNoticeSearch(' R26BK01359594-000 ', 'auto', { ...query, from: '', to: 'invalid' })).toEqual({
      kind: 'number', input: 'R26BK01359594-000', type: '공사·용역',
    });
    expect(() => planUnifiedNoticeSearch('철거', 'auto', { ...query, from: '', to: 'invalid' })).toThrow('제출마감');
  });

  it.each(['R26BK01359594-0000', 'R26BK01359594-ABC', '20160235560-'])('shows a number validation error for malformed known number %j', input => {
    expect(() => planUnifiedNoticeSearch(input, 'auto', query)).toThrow('공고번호');
  });

  it('rejects malformed explicit identities instead of sending them to title search', () => {
    expect(() => planUnifiedNoticeSearch('invalid number', 'number', query)).toThrow('공고번호');
  });
});

describe('unified search draft ownership and synchronization', () => {
  it('synchronizes committed query changes without overwriting edits awaiting submit', () => {
    const draft = { query: { ...query, keyword: '아직 제출하지 않은 검색어', to: '2028-01-01' }, target: 'title' as const, owner: 'a', resetKey: 0 };
    expect(reconcileUnifiedSearchDraft(draft, query, { ...query, type: '용역', from: '2026-01-01', keyword: '외부 조건' }, 'a', 0)).toEqual({
      query: { type: '용역', from: '2026-01-01', to: '2028-01-01', keyword: '아직 제출하지 않은 검색어' }, target: 'title', owner: 'a', resetKey: 0,
    });
  });

  it('clears the search text and target when a new reset key overrides a dirty number draft', () => {
    const draft = { query: { ...query, keyword: 'R26BK01359594-000', from: '' }, target: 'number' as const, owner: 'a', resetKey: 0 };
    expect(reconcileUnifiedSearchDraft(draft, query, query, 'a', 1)).toEqual({ query, target: 'auto', owner: 'a', resetKey: 1 });
  });

  it('clears private number input immediately for another account while retaining the business and period', () => {
    const draft = { query: { ...query, type: '용역' as const, keyword: 'R26BK01359594' }, target: 'auto' as const, owner: 'a', resetKey: 0 };
    expect(reconcileUnifiedSearchDraft(draft, query, query, 'b', 0)).toEqual({
      query: { ...query, type: '용역' }, target: 'auto', owner: 'b', resetKey: 0,
    });
    expect(reconcileUnifiedSearchDraft(draft, query, query, null, 0).query.keyword).toBe('');
  });

  it('retains public title edits when account membership changes', () => {
    const draft = { query: { ...query, keyword: 'school 철거' }, target: 'title' as const, owner: 'a' };
    expect(reconcileUnifiedSearchDraft(draft, query, query, null)).toEqual({ ...draft, owner: null });
  });

  it('keeps an unsubmitted guest number during the login handoff', () => {
    const draft = { query: { ...query, keyword: 'R26BK01359594-000' }, target: 'number' as const, owner: null, resetKey: 0 };
    expect(reconcileUnifiedSearchDraft(draft, query, query, 'a', 0)).toEqual({ ...draft, owner: 'a' });
  });
});

describe('unified notice search form', () => {
  const render = (patch: Partial<Parameters<typeof UnifiedNoticeSearch>[0]> = {}) => renderToStaticMarkup(<UnifiedNoticeSearch query={query} loading={false} {...actions} {...patch} />);

  it('presents one text input, one business selector and explicit search targets', () => {
    const html = render();
    expect(html.match(/role="search"/g)).toHaveLength(1);
    expect(html.match(/name="keyword"/g)).toHaveLength(1);
    expect(html.match(/name="type"/g)).toHaveLength(1);
    expect(html).not.toContain('name="noticeNumber"');
    for (const label of ['자동', '공고명', '공고번호', '공사·용역']) expect(html).toContain(label);
    expect(html).toContain('입찰서 제출마감 시작일');
    expect(html).toContain('전체 보관 범위');
    expect(html.match(/<input[^>]*name="keyword"[^>]*>/)?.[0]).not.toContain('required');
  });

  it('keeps the applied deadline window visible while date editing starts collapsed', () => {
    const html = render();
    expect(html.match(/<details[^>]*class="unified-search-period-details"[^>]*>/)?.[0]).not.toContain('open');
    expect(html).toContain('제출마감 기간 · 2026.04.15 – 2027.04.15');
    expect(html).toContain('name="from"');
    expect(html).toContain('name="to"');
    expect(html).not.toContain('공고명과 공고번호를 한곳에서 검색하세요');
  });

  it('uses the dispatcher for date validation so collapsed date fields cannot block error feedback', () => {
    const html = render({ query: { ...query, from: '', to: '' } });
    expect(html.match(/<form[^>]*>/)?.[0]).toMatch(/novalidate/i);
  });

  it('disables date controls and allows number submit while title results are loading', () => {
    const html = render({ query: { ...query, keyword: 'R26BK01359594-000', from: '', to: '' }, userId: 'a', loading: true, refreshBlocked: true });
    expect(html.match(/<fieldset[^>]*class="unified-search-period"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html.match(/<input[^>]*name="from"[^>]*>/)?.[0]).not.toContain('required');
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(html).toContain('번호 조회에는 기간과 상세 조건을 적용하지 않습니다');
    expect(html).not.toContain('공고번호로 최신 차수와 전체 이력을 확인하고 있습니다');
  });

  it('keeps the title submit blocked during its own request', () => {
    const html = render({ query: { ...query, keyword: 'school' }, loading: true });
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html.match(/<fieldset[^>]*class="unified-search-period"[^>]*>/)?.[0]).not.toContain('disabled');
  });

  it('preserves the cooldown only for an unchanged title search', () => {
    expect(render({ refreshBlocked: true }).match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it('offers login for number lookup without exposing member-specific results', () => {
    const html = render({ query: { ...query, keyword: '20160235560-00' } });
    expect(html).toContain('로그인 후 조회');
    expect(html).toContain('로그인 후 공고번호로 전체 차수 이력을 확인할 수 있습니다');
    expect(html).not.toContain('notice-number-results');
  });

  it('restores an unsubmitted title after menu remount and lets it replace an older loading query', () => {
    const html = render({ loading: true, refreshBlocked: true, initialDraft: {
      query: { ...query, keyword: '다음 철거공사' }, target: 'title', owner: null,
    } });
    expect(html).toContain('value="다음 철거공사"');
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toContain('disabled');
    expect(html).not.toContain('조회 중');
  });

  it('restores a guest number after login without starting a number lookup during render', () => {
    const html = render({ userId: 'a', initialDraft: {
      query: { ...query, keyword: 'R26BK01359594-000' }, target: 'number', owner: null,
    } });
    expect(html).toContain('value="R26BK01359594-000"');
    expect(html.match(/<details[^>]*>/)?.[0]).toContain('hidden=""');
    expect(html).not.toContain('공고번호로 최신 차수와 전체 이력을 확인하고 있습니다');
  });

  it('does not restore a previous member number for another member or after a reset', () => {
    const initialDraft = { query: { ...query, keyword: 'R26BK01359594-000' }, target: 'number' as const, owner: 'a', resetKey: 0 };
    expect(render({ userId: 'b', resetKey: 0, initialDraft })).not.toContain('value="R26BK01359594-000"');
    expect(render({ userId: 'a', resetKey: 1, initialDraft })).not.toContain('value="R26BK01359594-000"');
  });
});
