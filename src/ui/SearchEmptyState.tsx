import { ArrowRight, Bookmark, FileSearch, LoaderCircle, RefreshCw } from 'lucide-react';

export function SearchEmptyState({ loading = false, error = false, firstBookmark = false, onReset, onBrowse, onRetry }: {
  loading?: boolean; error?: boolean; firstBookmark?: boolean; onReset: () => void; onBrowse: () => void; onRetry: () => void;
}) {
  return <div className="empty-state" aria-busy={loading || undefined}>
    <div className="empty-icon">{loading ? <LoaderCircle size={28} /> : firstBookmark ? <Bookmark size={28} /> : <FileSearch size={28} />}</div>
    <h3>{loading ? '공고를 불러오는 중입니다' : error ? '공고를 조회하지 못했습니다' : firstBookmark ? '아직 저장한 관심공고가 없습니다' : '조건에 맞는 공고가 없습니다'}</h3>
    <p>{loading ? '검색 조건을 확인하고 있습니다. 잠시만 기다려 주세요.' : error ? '검색 조건은 유지됩니다. 연결 상태를 확인하고 다시 조회해 주세요.' : firstBookmark ? '공고의 즐겨찾기를 누르면 이곳에서 모아볼 수 있습니다.' : '검색어를 바꾸거나 지역·면허·금액 조건을 넓혀보세요.'}</p>
    {!loading && <button className="button button-primary" onClick={error ? onRetry : firstBookmark ? onBrowse : onReset}>{error ? <><RefreshCw size={16} />다시 조회</> : firstBookmark ? <>입찰공고 둘러보기<ArrowRight size={16} /></> : '검색 조건 초기화'}</button>}
  </div>;
}
