import { BookmarkButton } from './BookmarkButton';
import { assessRegion, assessSearchRegions, formatDateTime, formatPrice } from '../domain';
import type { BidNotice, CompanyProfile, NoticeStatus, SearchFilters, SearchRegion } from '../types';
import { noticeState } from '../notice-status';
export { noticeState } from '../notice-status';
import { needsNoticeRegions, noticeRegionKey } from '../live/notice-regions';
import { noticeSubmissionMessage } from './notice-schedule';
import './NoticeList.css';

export function HighlightTitle({ title, keyword }: { title: string; keyword: string }) {
  const words = [...new Set(keyword.trim().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!words.length) return <>{title}</>;
  const pattern = new RegExp(`(${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <>{title.split(pattern).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}

export function NoticeList({ bids, keyword, profile, bookmarks, selected, onSelect, onOpen, onBookmark, now = Date.now(), searchProvince = '전체', searchRegions, regionLookup }: {
  bids: BidNotice[]; keyword: string; profile: CompanyProfile; bookmarks: string[];
  selected: string[]; onSelect: (ids: string[]) => void; onOpen: (bid: BidNotice) => void; onBookmark: (id: string) => void;
  now?: number;
  searchProvince?: string;
  resultsPaused?: boolean;
  fetchPublicResults?: boolean;
  status?: SearchFilters['status'];
  onStatusChange?: (status: SearchFilters['status']) => void;
  statuses?: NoticeStatus[];
  onStatusesChange?: (statuses: NoticeStatus[]) => void;
  searchRegions?: SearchRegion[];
  regionLookup?: { pendingKeys: ReadonlySet<string>; failedKeys: ReadonlySet<string>; loading: boolean; retry: () => void; retryAt: number };
}) {
  const checked = bids.length > 0 && bids.every(bid => selected.includes(bid.id));
  const selectedRegions = searchRegions ?? (searchProvince === '전체' ? [] : [{ province: searchProvince }]);
  function select(id: string) { onSelect(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]); }
  return <div className="notice-list">
    <table className="notice-grid"><caption className="sr-only">공고별 제출 마감, 진행 상태, 수요기관, 지역 및 추정가격</caption>
      <thead><tr><th className="nl-select" scope="col"><label className="nl-checkbox"><input type="checkbox" aria-label="현재 페이지 공고 전체 선택" checked={checked} disabled={!bids.length} ref={input => { if (input) input.indeterminate = !checked && bids.some(bid => selected.includes(bid.id)); }} onChange={() => onSelect(checked ? selected.filter(id => !bids.some(bid => bid.id === id)) : [...new Set([...selected, ...bids.map(bid => bid.id)])])} /></label></th><th className="nl-title" scope="col">공고명 · 지역</th><th className="nl-agency" scope="col">수요기관</th><th className="nl-deadline" scope="col">제출 마감<small>한국시간</small></th><th className="nl-status" scope="col">상태</th><th className="nl-price" scope="col">추정가격</th></tr></thead>
      <tbody>{bids.map(bid => {
        const state = noticeState(bid, now);
        const submission = noticeSubmissionMessage(bid, now);
        const deadline = formatDateTime(bid.deadline, { includeYear: true });
        const region = assessRegion(bid, profile);
        const regionPending = needsNoticeRegions(bid) && regionLookup?.pendingKeys.has(noticeRegionKey(bid));
        const regionFailed = needsNoticeRegions(bid) && regionLookup?.failedKeys.has(noticeRegionKey(bid));
        const regionLabel = region.status === 'matched' ? '지역 일치' : region.status === 'excluded' ? '지역 제외'
          : regionPending ? '지역 조회 중' : regionFailed ? '지역 조회 실패' : '지역 확인 필요';
        const searchRegion = selectedRegions.length ? assessSearchRegions(bid, selectedRegions) : null;
        const saved = bookmarks.includes(bid.id);
        const resultHref = `/notice-detail.html?${new URLSearchParams({ number: bid.number, revision: bid.revision, type: bid.type })}#results`;
        return <tr key={bid.id} className={selected.includes(bid.id) ? 'is-selected' : ''}>
          <td className="nl-select"><label className="nl-checkbox"><input type="checkbox" aria-label={`${bid.title} 선택`} checked={selected.includes(bid.id)} onChange={() => select(bid.id)} /></label></td>
          <td className="nl-title"><div className="nl-meta"><span>{bid.type} · {bid.noticeKind || (bid.revised ? '정정공고' : '-')} · {bid.number}-{bid.revision}</span><BookmarkButton noticeTitle={bid.title} saved={saved} onToggle={() => onBookmark(bid.id)} /></div><button type="button" className="nl-title-button" onClick={() => onOpen(bid)}><HighlightTitle title={bid.title} keyword={keyword} /></button><div className="nl-region-line"><span className={`nl-region is-${region.status}`} title={regionPending ? '참가 가능 지역을 조회하고 있습니다.' : region.reason}>{regionLabel}</span>{[bid.province, bid.district].filter(Boolean).length > 0 && <span className="nl-site-region">현장 {[bid.province, bid.district].filter(Boolean).join(' ')}</span>}</div>{!regionPending && !regionFailed && searchRegion && (searchRegion.status === 'review' || bid.type === '용역') && <span className={`nl-service-region is-${searchRegion.status}`} title={searchRegion.reason}>{searchRegion.status === 'review' ? bid.type === '용역' ? '참가 가능 지역 확인 필요' : '현장 세부 지역 확인 필요' : `참가 가능 지역 · ${bid.allowedRegions?.join(' · ')}`}</span>}{bid.source === 'live' && <a className="nl-results-link" href={resultHref} target="_blank" rel="noopener noreferrer" aria-label={`${bid.title} 개찰·낙찰 결과 새 탭에서 보기`}>개찰·낙찰 결과 <span aria-hidden="true">↗</span></a>}</td>
          <td className="nl-agency" data-label="수요기관">{bid.demandAgency || '-'}</td>
          <td className="nl-deadline" data-label="제출 마감">{deadline === '일정 미제공' ? <span className="nl-missing">제출 마감일 확인 필요</span> : <time dateTime={bid.deadline}>{deadline}</time>}{submission && submission !== '취소된 공고' && deadline !== '일정 미제공' && <small className="nl-submission">{submission}</small>}</td>
          <td className="nl-status" data-label="상태"><span className={`nl-state is-${state.tone}`} title={state.description}>{state.label}</span>{submission === '취소된 공고' && <small className="nl-cancelled">{submission}</small>}</td>
          <td className="nl-price" data-label="추정가격">{bid.estimatedPrice === null ? '-' : formatPrice(bid.estimatedPrice)}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
