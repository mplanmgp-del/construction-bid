import { BookmarkButton } from './BookmarkButton';
import { assessRegion, assessSearchRegions, formatPrice } from '../domain';
import type { BidNotice, CompanyProfile, NoticeStatus, SearchFilters, SearchRegion } from '../types';
import { StatusFilter } from './StatusFilter';
import { noticeState } from '../notice-status';
export { noticeState } from '../notice-status';
import { needsResult, resultKey, useResultSummaries } from '../live/useResultSummaries';
import { needsNoticeRegions, noticeRegionKey } from '../live/notice-regions';
import './NoticeList.css';

export function HighlightTitle({ title, keyword }: { title: string; keyword: string }) {
  const words = [...new Set(keyword.trim().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!words.length) return <>{title}</>;
  const pattern = new RegExp(`(${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <>{title.split(pattern).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}

export function NoticeList({ bids, keyword, profile, bookmarks, selected, onSelect, onOpen, onBookmark, now = Date.now(), searchProvince = '전체', resultsPaused = false, status = '전체', onStatusChange, statuses, onStatusesChange, searchRegions, regionLookup }: {
  bids: BidNotice[]; keyword: string; profile: CompanyProfile; bookmarks: string[];
  selected: string[]; onSelect: (ids: string[]) => void; onOpen: (bid: BidNotice) => void; onBookmark: (id: string) => void;
  now?: number;
  searchProvince?: string;
  resultsPaused?: boolean;
  status?: SearchFilters['status'];
  onStatusChange?: (status: SearchFilters['status']) => void;
  statuses?: NoticeStatus[];
  onStatusesChange?: (statuses: NoticeStatus[]) => void;
  searchRegions?: SearchRegion[];
  regionLookup?: { pendingKeys: ReadonlySet<string>; failedKeys: ReadonlySet<string>; loading: boolean; retry: () => void; retryAt: number };
}) {
  const { entries, refresh } = useResultSummaries(bids, !resultsPaused);
  const checked = bids.length > 0 && bids.every(bid => selected.includes(bid.id));
  const loading = bids.some(bid => needsResult(bid) && !entries[resultKey(bid)]);
  const incomplete = bids.some(bid => needsResult(bid) && (entries[resultKey(bid)]?.error || entries[resultKey(bid)]?.data?.complete === false));
  const selectedStatuses = statuses ?? (status === '전체' ? [] : [status]);
  const selectedRegions = searchRegions ?? (searchProvince === '전체' ? [] : [{ province: searchProvince }]);
  const changeStatuses = onStatusesChange ?? (onStatusChange ? (values: NoticeStatus[]) => onStatusChange(values.at(-1) ?? '전체') : undefined);
  function select(id: string) { onSelect(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]); }
  return <div className="notice-list">
    <table className="notice-grid"><caption className="sr-only">공고별 상태, 수요기관 및 공개 개찰 결과</caption>
      <thead><tr><th className="nl-select"><input type="checkbox" aria-label="현재 페이지 공고 전체 선택" checked={checked} disabled={!bids.length} ref={input => { if (input) input.indeterminate = !checked && bids.some(bid => selected.includes(bid.id)); }} onChange={() => onSelect(checked ? selected.filter(id => !bids.some(bid => bid.id === id)) : [...new Set([...selected, ...bids.map(bid => bid.id)])])} /></th><th className="nl-title">공고명</th><th className="nl-status">{changeStatuses ? <StatusFilter compact values={selectedStatuses} onChange={changeStatuses} /> : '상태'}</th><th className="nl-agency">수요기관</th><th className="nl-company">1순위 업체</th><th className="nl-company">낙찰업체</th><th className="nl-price">추정가격</th></tr></thead>
      <tbody>{bids.map(bid => {
        const entry = entries[resultKey(bid)];
        const result = entry?.data;
        const state = noticeState(bid, now);
        const region = assessRegion(bid, profile);
        const regionPending = needsNoticeRegions(bid) && regionLookup?.pendingKeys.has(noticeRegionKey(bid));
        const regionFailed = needsNoticeRegions(bid) && regionLookup?.failedKeys.has(noticeRegionKey(bid));
        const regionLabel = region.status === 'matched' ? '지역 일치' : region.status === 'excluded' ? '지역 제외'
          : regionPending ? '지역 조회 중' : regionFailed ? '지역 조회 실패' : '지역 확인 필요';
        const searchRegion = selectedRegions.length ? assessSearchRegions(bid, selectedRegions) : null;
        const saved = bookmarks.includes(bid.id);
        const resultHint = entry?.error ? '공개 결과 조회 실패 — 아래 결과 다시 조회 버튼을 이용하세요.' : needsResult(bid) && !entry ? '공개 결과 조회 중' : result?.complete === false ? '일부 공개 결과만 조회됨' : '현재 조회된 공개 자료 기준';
        return <tr key={bid.id} className={selected.includes(bid.id) ? 'is-selected' : ''}>
          <td className="nl-select"><input type="checkbox" aria-label={`${bid.title} 선택`} checked={selected.includes(bid.id)} onChange={() => select(bid.id)} /></td>
          <td className="nl-title"><div className="nl-meta"><span>{bid.type} · {bid.noticeKind || (bid.revised ? '정정공고' : '-')} · {bid.number}-{bid.revision}</span><BookmarkButton noticeTitle={bid.title} saved={saved} onToggle={() => onBookmark(bid.id)} /></div><button className="nl-title-button" onClick={() => onOpen(bid)}><HighlightTitle title={bid.title} keyword={keyword} /></button><span className={`nl-region is-${region.status}`} title={regionPending ? '참가 가능 지역을 조회하고 있습니다.' : region.reason}>{regionLabel}</span>{!regionPending && !regionFailed && searchRegion && (searchRegion.status === 'review' || bid.type === '용역') && <span className={`nl-service-region is-${searchRegion.status}`} title={searchRegion.reason}>{searchRegion.status === 'review' ? bid.type === '용역' ? '참가 가능 지역 확인 필요' : '현장 세부 지역 확인 필요' : `참가 가능 지역 · ${bid.allowedRegions?.join(' · ')}`}</span>}</td>
          <td className="nl-status" data-label="상태"><span className={`nl-state is-${state.tone}`} title={state.description}>{state.label}</span></td>
          <td className="nl-agency" data-label="수요기관">{bid.demandAgency || '-'}</td>
          <td className="nl-company" data-label="1순위 업체" title={resultHint}>{result?.firstCompanies.join(' · ') || '-'}</td>
          <td className="nl-company" data-label="낙찰업체" title={resultHint}>{result?.winnerCompanies.join(' · ') || '-'}</td>
          <td className="nl-price" data-label="추정가격">{bid.estimatedPrice === null ? '-' : formatPrice(bid.estimatedPrice)}</td>
        </tr>;
      })}</tbody>
    </table>
    {bids.some(needsResult) && <div className="nl-results-note"><span role="status">{resultsPaused ? '지역 조건 확인 후 공개 개찰·낙찰 결과를 조회합니다.' : loading ? '공개 개찰·낙찰 결과를 확인하고 있습니다.' : incomplete ? '일부 공개 결과를 확인하지 못했습니다. 다시 조회하거나 공고 상세에서 확인해 주세요.' : '1순위 업체와 최종 낙찰업체는 다를 수 있습니다. 공개 결과가 없는 항목은 -로 표시합니다.'}</span><button type="button" onClick={refresh} disabled={loading || resultsPaused}>결과 다시 조회</button></div>}
  </div>;
}
