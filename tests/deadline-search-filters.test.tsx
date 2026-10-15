import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilterPanel } from '../src/components/FilterPanel';
import { DEFAULT_FILTERS, DEMO_PROFILES, NOTICES } from '../src/data';
import { filterNotices } from '../src/domain';
import { filtersForIndexedSearch } from '../src/live/notice-search';
const filters = { ...DEFAULT_FILTERS, category: '전체' as const, status: '전체' as const, deadlineFrom: '2020-01-01', deadlineTo: '2020-12-31' };
const props = { filters, onChange: () => {}, onReset: () => {}, onCollapse: () => {}, mobileOpen: false, onMobileClose: () => {} };
it('shows only the authoritative top deadline range during a live indexed main search', () => {
  const html = renderToStaticMarkup(<FilterPanel {...props} showDeadlineRange={false} />);
  expect(html).not.toContain('type="date"');
  expect(html).toContain('제출마감 기간은 상단 공고 검색에서 변경합니다');
});
it('retains local deadline filters for saved interests and demo searches', () => {
  const html = renderToStaticMarkup(<FilterPanel {...props} />);
  expect(html.match(/type="date"/g)).toHaveLength(2);
  expect(html).toContain('value="2020-01-01"'); expect(html).toContain('value="2020-12-31"');
  expect(filtersForIndexedSearch(filters, false)).toBe(filters);
});
it('ignores hidden stale date filters so they cannot remove a current indexed match', () => {
  const bid = { ...NOTICES[0], deadline: '2026-10-20T18:00:00+09:00' };
  expect(filterNotices([bid], filters, DEMO_PROFILES[0])).toEqual([]);
  const effective = filtersForIndexedSearch(filters, true);
  expect(filterNotices([bid], effective, DEMO_PROFILES[0])).toEqual([bid]);
  expect(effective).toMatchObject({ deadlineFrom: '', deadlineTo: '' });
  expect(filters.deadlineFrom).toBe('2020-01-01');
});
