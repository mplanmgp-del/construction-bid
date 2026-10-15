import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VerifiedSearchFeedback, VerifiedSearchPagination } from '../src/live/VerifiedSearchFeedback';
import type { VerifiedNoticeSearchPage } from '../src/live/active-catalog-types';
import { NoticeList } from '../src/components/NoticeList';
import { DEMO_PROFILES, NOTICES } from '../src/data';
const summary = vi.hoisted(() => vi.fn(() => ({ entries: {}, refresh: () => {} })));
vi.mock('../src/live/useResultSummaries', async original => ({ ...await original<typeof import('../src/live/useResultSummaries')>(), useResultSummaries: summary }));
const page: VerifiedNoticeSearchPage = { items: [], totalCount: 0, hasMore: false, page: 1, pageSize: 50, fetchedAt: '2026-10-15T03:00:00Z', source: '색인', nextCursor: null, snapshotVersion: 'one', asOf: '2026-10-15T03:00:00Z',
  indexCoverage: { complete: false, pending: 746, checked: 0 }, sourceSyncedThrough: null, verifiedCount: 100, pendingCount: 7, conditionPendingCount: 2, storage: { bytes: 1024, ceiling: 1024, full: true } };
it('distinguishes global collection coverage, pending verification and storage ceiling from a completed empty query', () => {
  const html = renderToStaticMarkup(<VerifiedSearchFeedback page={page} loading={false} stale={false} error="" onRestart={() => {}} />);
  for (const text of ['공통 색인 최초 수집 중', '검증 대기 7건', '참가조건 미확인 2건', '수집 공간 한도 도달', '원천 동기화 확인 전']) expect(html).toContain(text);
  expect(html).not.toContain('모든 공고 조회 완료');
});
it('keeps the old page explicitly stale with a manual restart action', () => {
  const html = renderToStaticMarkup(<VerifiedSearchFeedback page={page} loading={false} stale error="공고 변경" onRestart={() => {}} />);
  expect(html).toContain('이전 조회 결과'); expect(html).toContain('처음부터 다시 검색');
});
it('announces global totals and a 50-item cursor page rather than local 30-item pagination', () => {
  const html = renderToStaticMarkup(<VerifiedSearchPagination total={501} count={50} pageNumber={2} hasNext hasPrevious loading={false} stale={false} onNext={() => {}} onPrevious={() => {}} />);
  expect(html).toContain('501건 중 51–100건'); expect(html).toContain('2 / 11'); expect(html).toContain('50개씩 보기');
});
it('disables per-notice public result hydration in the ordinary server index list', () => {
  renderToStaticMarkup(<NoticeList bids={[NOTICES[0]]} keyword="" profile={DEMO_PROFILES[0]} bookmarks={[]} selected={[]} onSelect={() => {}} onOpen={() => {}} onBookmark={() => {}} fetchPublicResults={false} />);
  expect(summary).toHaveBeenLastCalledWith([NOTICES[0]], false);
});
