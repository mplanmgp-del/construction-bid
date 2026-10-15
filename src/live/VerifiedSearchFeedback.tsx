import type { VerifiedNoticeSearchPage, VerifiedNoticeSearchView } from './active-catalog-types';
import { formatDateTime } from '../domain';
import './notice-search.css';

export function VerifiedSearchFeedback({ page, loading, stale, error, onRestart }: {
  page: VerifiedNoticeSearchPage | VerifiedNoticeSearchView | null; loading: boolean; stale: boolean; error: string; onRestart: () => void;
}) {
  const metadata = stale ? null : page && ('status' in page ? page.status : page);
  const statusLoading = page && 'statusLoading' in page && page.statusLoading;
  const statusError = page && 'statusError' in page ? page.statusError : '';
  const current = metadata?.currentCoverage?.scope === 'demolition-title-v1' ? metadata.currentCoverage : null;
  const currentThrough = current?.syncedThrough ?? current?.requiredThrough;
  return <div className="live-scope verified-search-status">
    {loading && <p role="status">공고를 불러오고 있습니다.</p>}
    {stale && <div className="verified-search-stale" role="alert"><p>조회 기준 시각이 지났거나 공고가 변경되었습니다.{page ? ' 이전 조회 결과를 표시합니다.' : ''} 현재 기준으로 다시 검색해 주세요.</p><button type="button" className="button button-secondary" disabled={loading} onClick={onRestart}>처음부터 다시 검색</button></div>}
    {error && !stale && <div className="live-error" role="alert"><p>{error}</p>{page && <button type="button" className="button button-secondary" disabled={loading} onClick={onRestart}>다시 검색</button>}</div>}
    {page && !metadata && !stale && <p role="status">{statusLoading ? '검색 결과를 표시했습니다. 수집·검증 상태를 불러오는 중입니다.' : statusError ? `${statusError} 검색 결과는 계속 볼 수 있습니다. 전체 수집 여부는 아직 확인하지 못했습니다.` : '수집·검증 상태를 아직 확인하지 못했습니다. 결과 0건으로 전체 공고가 없다고 판단할 수 없습니다.'}</p>}
    {page && metadata && <>
      {current && <p className="live-current-coverage" role="status"><strong>관심 분야 투찰 가능 공고 확인 {current.complete ? '완료' : '중'}</strong> · 철거·해체·석면·건설폐기물{!current.complete && ` · 확인 ${current.checked}구간 · 남은 ${current.pending}구간 · 조건 확인 대기 ${current.verificationPending}건`}{current.complete && currentThrough && ` · 기준 ${formatDateTime(currentThrough, { includeYear: true })} KST`}</p>}
      <div className={`search-data-summary ${metadata.indexCoverage.complete && metadata.pendingCount === 0 && metadata.conditionPendingCount === 0 ? 'is-complete' : ''}`}><span>{!metadata.indexCoverage.complete || metadata.pendingCount > 0 || metadata.conditionPendingCount > 0 ? '자료 수집·확인 중 · 일부 공고가 검색에서 빠질 수 있습니다.' : '수집·확인된 공고를 표시합니다.'}</span><span>자료 기준 {formatDateTime(page.asOf, { includeYear: true })} KST</span></div>
      {metadata.storage.full && <p className="verified-search-storage-full" role="status">수집 공간 한도 도달 · 추가 수집이 제한됩니다.</p>}
      <details className="search-data-details"><summary>자료 확인 상태</summary>
      <p>{metadata.indexCoverage.complete ? '공통 색인 최초 수집 완료' : `공통 색인 최초 수집 중 · 확인 ${metadata.indexCoverage.checked}구간 · 남은 ${metadata.indexCoverage.pending}구간`}. 화면은 선택한 제출마감 구간만 조회합니다.</p>
      <p>검증된 색인 {metadata.verifiedCount.toLocaleString('ko-KR')}건 · 검증 대기 {metadata.pendingCount.toLocaleString('ko-KR')}건 · <span title="현재 선택한 지역·면허 조건을 판정하지 못한 공고 수입니다.">선택조건 판정 대기 {metadata.conditionPendingCount.toLocaleString('ko-KR')}건</span></p>
      <p>자료 기준 {formatDateTime(page.asOf, { includeYear: true })} · {metadata.sourceSyncedThrough ? `원천 변경 확인 ${formatDateTime(metadata.sourceSyncedThrough, { includeYear: true })}` : '원천 동기화 확인 전'}</p>
      {!metadata.indexCoverage.complete || metadata.pendingCount > 0 || metadata.conditionPendingCount > 0 ? <p>수집·검증이 끝나지 않은 공고가 있습니다. 결과 0건은 전체 원천에 해당 공고가 없다는 뜻이 아닙니다.</p> : null}
      <p className={metadata.storage.full ? 'verified-search-storage-full' : undefined}>{metadata.storage.full ? '수집 공간 한도 도달 · ' : '색인 저장 공간 '}{(metadata.storage.bytes / 1_048_576).toFixed(2)} / {(metadata.storage.ceiling / 1_048_576).toFixed(2)} MiB</p>
      {metadata.sourceError && <p className="live-error">원천 동기화: {metadata.sourceError}</p>}
      {metadata.warnings?.map(warning => <p className="live-warning" key={warning}>{warning}</p>)}
      </details>
      {metadata.sourceError && <p className="live-error" role="status">최신 변경 내용을 확인하지 못해, 확인된 자료만 표시합니다.</p>}
    </>}
  </div>;
}

export function VerifiedSearchPagination({ total, count, pageNumber, hasNext, hasPrevious, loading, stale, onNext, onPrevious }: {
  total: number; count: number; pageNumber: number; hasNext: boolean; hasPrevious: boolean; loading: boolean; stale: boolean;
  onNext: () => void; onPrevious: () => void;
}) {
  const first = count ? (pageNumber - 1) * 50 + 1 : 0, last = count ? first + count - 1 : 0;
  return <div className="results-bottom verified-search-pagination"><span className="result-range">전체 검색 결과 {total.toLocaleString('ko-KR')}건 중 {first}–{last}건</span>
    <nav className="pagination" aria-label="검색 결과 페이지"><button type="button" className="button button-secondary" disabled={!hasPrevious || loading || stale} onClick={onPrevious}>이전</button><span aria-live="polite">{pageNumber} / {Math.max(1, Math.ceil(total / 50))}</span><button type="button" className="button button-secondary" disabled={!hasNext || loading || stale} onClick={onNext}>다음</button></nav><span className="page-size-label">50개씩 보기</span>
  </div>;
}
