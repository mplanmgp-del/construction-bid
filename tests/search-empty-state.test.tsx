import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SearchEmptyState } from '../src/ui/SearchEmptyState';
const actions = { onReset: () => {}, onBrowse: () => {}, onRetry: () => {} };
it('keeps loading distinct from empty results and offers no destructive reset while waiting', () => {
  const html = renderToStaticMarkup(<SearchEmptyState loading {...actions} />);
  expect(html).toContain('공고를 불러오는 중입니다');
  expect(html).not.toContain('조건에 맞는 공고가 없습니다');
  expect(html).not.toContain('<button');
});
it('preserves search context on failure and exposes a retry rather than a reset', () => {
  const html = renderToStaticMarkup(<SearchEmptyState error {...actions} />);
  expect(html).toContain('다시 조회'); expect(html).toContain('검색 조건은 유지됩니다');
  expect(html).not.toContain('조건 초기화');
});
it('separates first-time saved interests from an ordinary empty search', () => {
  const saved = renderToStaticMarkup(<SearchEmptyState firstBookmark {...actions} />);
  expect(saved).toContain('아직 저장한 관심공고가 없습니다');
  expect(saved).toContain('입찰공고 둘러보기');
  const search = renderToStaticMarkup(<SearchEmptyState {...actions} />);
  expect(search).toContain('조건에 맞는 공고가 없습니다'); expect(search).toContain('검색 조건 초기화');
});
