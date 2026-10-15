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
  for (const text of ['공통 색인 최초 수집 중', '검증 대기 7건', '선택조건 판정 대기 2건', '수집 공간 한도 도달', '원천 동기화 확인 전']) expect(html).toContain(text);
  expect(html).not.toContain('모든 공고 조회 완료');
});
it('labels condition uncertainty as selected-filter pending even when zero while source verification is incomplete', () => {
  const html = renderToStaticMarkup(<VerifiedSearchFeedback page={{ ...page, verifiedCount: 20, pendingCount: 3876, conditionPendingCount: 0 }} loading={false} stale={false} error="" onRestart={() => {}} />);
  expect(html).toContain('선택조건 판정 대기 0건');
  expect(html).toContain('현재 선택한 지역·면허 조건을 판정하지 못한 공고 수입니다.');
  expect(html).not.toContain('참가조건 미확인');
  expect(html).toContain('검증 대기 3,876건');
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
  expect(summary).not.toHaveBeenCalled();
});

it('separates focused actionable coverage from the unfinished historical archive', () => {
  const currentCoverage = { scope: 'demolition-title-v1', cutoff: page.asOf, checked: 746, pending: 0, verificationPending: 0, complete: true };
  const html = renderToStaticMarkup(<VerifiedSearchFeedback page={{ ...page, currentCoverage }} loading={false} stale={false} error="" onRestart={() => {}} />);
  expect(html).toContain('관심 분야 투찰 가능 공고 확인 완료');
  expect(html).toContain('철거·해체·석면·건설폐기물');
  expect(html).toContain('공통 색인 최초 수집 중');
  expect(html).not.toContain('모든 공고 조회 완료');
});
it('keeps focused coverage pending until source and participant checks complete', () => {
  const currentCoverage = { scope: 'demolition-title-v1', cutoff: page.asOf, checked: 20, pending: 726, verificationPending: 67, complete: false };
  const html = renderToStaticMarkup(<VerifiedSearchFeedback page={{ ...page, currentCoverage }} loading={false} stale={false} error="" onRestart={() => {}} />);
  expect(html).toContain('관심 분야 투찰 가능 공고 확인 중');
  expect(html).toContain('남은 726구간');
  expect(html).toContain('조건 확인 대기 67건');
  expect(html).not.toContain('관심 분야 투찰 가능 공고 확인 완료');
});
it('shows a separate status-loading message without claiming collection completion after fast results arrive', () => {
  const html = renderToStaticMarkup(<VerifiedSearchFeedback page={{ ...page, status: null, statusLoading: true, statusError: '' }} loading={false} stale={false} error="" onRestart={() => {}} />);
  expect(html).toContain('검색 결과를 표시했습니다. 수집·검증 상태를 불러오는 중입니다.');
  expect(html).not.toContain('최초 수집 완료'); expect(html).not.toContain('수집 공간 한도 도달');
});
it('keeps result availability distinct from failed aggregate metadata', () => {
  const html = renderToStaticMarkup(<VerifiedSearchFeedback page={{ ...page, status: null, statusLoading: false, statusError: '상태 연결 실패' }} loading={false} stale={false} error="" onRestart={() => {}} />);
  expect(html).toContain('상태 연결 실패'); expect(html).toContain('검색 결과는 계속 볼 수 있습니다.');
  expect(html).toContain('전체 수집 여부는 아직 확인하지 못했습니다.'); expect(html).not.toContain('확인 완료');
});
it('never labels stale aggregate metadata as currently complete', () => {
  const currentCoverage = { scope: 'demolition-title-v1', cutoff: page.asOf, checked: 746, pending: 0, verificationPending: 0, complete: true };
  const html = renderToStaticMarkup(<VerifiedSearchFeedback page={{ ...page, status: { ...page, currentCoverage }, statusLoading: false, statusError: '' }} loading={false} stale error="" onRestart={() => {}} />);
  expect(html).toContain('이전 조회 결과'); expect(html).not.toContain('관심 분야 투찰 가능 공고 확인 완료');
});
