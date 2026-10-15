import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { indexedSearchDateError, normalizeIndexedSearch } from '../src/live/indexed-notice-search';
import { LiveSearch } from '../src/live/LiveSearch';
const query = { type: '공사·용역' as const, from: '2026-04-15', to: '2027-04-15', keyword: '' };
it('accepts multi-year deadline searches within official date boundaries without the old 367-day cap', () => {
  expect(normalizeIndexedSearch({ ...query, from: '1995-10-01', to: '2100-12-31' })).toMatchObject({ from: '1995-10-01', to: '2100-12-31', limit: 50 });
  expect(indexedSearchDateError('1995-09-30', '2026-10-15')).toBeTruthy(); expect(indexedSearchDateError('2026-10-15', '2101-01-01')).toBeTruthy();
  expect(indexedSearchDateError('2026-02-30', '2026-10-15')).toBeTruthy();
});
it('labels deadline dates and offers symmetric month, year and full indexed-range controls', () => {
  const html = renderToStaticMarkup(<LiveSearch query={query} loading={false} onSearch={() => {}} onRefresh={() => {}} />);
  for (const text of ['입찰서 제출마감', '전후 1개월', '전후 3개월', '전후 6개월', '전후 1년', '전후 3년', '전체 보관 범위']) expect(html).toContain(text);
  expect(html).toContain('min="1995-10-01"'); expect(html).toContain('max="2100-12-31"'); expect(html).not.toContain('367일');
  expect(html).not.toContain('이전 90일'); expect(html).toContain('공고명 검색 (비우면 전체)');
  expect(html.match(/<input[^>]*name="keyword"[^>]*>/)?.[0]).not.toContain('required');
  expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toContain('disabled');
});
