import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, ExternalLink, Info, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { CompanyParticipation } from '../company-types';
import type { NoticeOpeningResults, OpeningResultGroup, OpeningParticipant } from '../opening-result-types';
import { fetchApi } from './client';
import './opening-results.css';

const number = (value: number) => value.toLocaleString('ko-KR');
const money = (value: number | null | undefined) => value == null ? '-' : `${number(value)}원`;
const businessNumber = (value: string) => value.replace(/^(\d{3})(\d{2})(\d{5})$/, '$1-$2-$3');
type OpeningNotice = Pick<CompanyParticipation, 'number' | 'revision' | 'type' | 'title'>;

function openingTime(value: string) {
  if (!value) return '-';
  const normalized = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value) ? `${value.replace(' ', 'T')}+09:00` : value;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return '-';
  const korean = new Date(timestamp + 9 * 60 * 60 * 1000).toISOString();
  return `${korean.slice(0, 10).replaceAll('-', '.')} ${korean.slice(11, 16)}`;
}

export function OpeningResultsPanel({ row, activeBusinessNumber = '', onClose, onCompany, autoFocus = true, embedded = false }: {
  row: OpeningNotice; activeBusinessNumber?: string; onClose?: () => void; onCompany?: (value: string) => void; autoFocus?: boolean; embedded?: boolean;
}) {
  const [data, setData] = useState<NoticeOpeningResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [groupId, setGroupId] = useState('all');
  const heading = useRef<HTMLHeadingElement | null>(null);
  const headingId = useId();

  useEffect(() => {
    if (!autoFocus) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }, [autoFocus]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null); setGroupId('all');
    const params = new URLSearchParams({ number: row.number, revision: row.revision, type: row.type });
    if (refresh > 0) params.set('refresh', '1');
    void fetchApi<NoticeOpeningResults>(`/api/opening-results?${params}`, controller.signal)
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '투찰업체 정보를 조회하지 못했습니다.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [row.number, row.revision, row.type, refresh]);

  const visibleGroups = data?.groups.filter(group => groupId === 'all' || group.id === groupId) ?? [];
  const original = `https://www.g2b.go.kr/link/PNPE027_01/?${new URLSearchParams({ bidPbancNo: row.number, bidPbancOrd: row.revision })}`;

  return <section className={`company-opening-panel${embedded ? ' is-embedded' : ''}`} aria-labelledby={headingId} onKeyDown={event => { if (event.key === 'Escape' && onClose) { event.stopPropagation(); onClose(); } }}>
    <header className="company-opening-heading">
      <div><span className="company-eyebrow">OPENING RESULTS</span><h3 id={headingId} tabIndex={-1} ref={heading}>투찰업체·개찰 순위</h3><p>{row.title || row.number}</p><small>{row.type} · 공고 {row.number} · 차수 {row.revision}</small></div>
      {onClose && <button className="company-opening-close" aria-label="투찰업체 상세 닫기" onClick={onClose}><X size={21} /></button>}
    </header>
    <div className="company-opening-toolbar"><p><Info size={15} />개찰 순위와 최종 낙찰 여부를 각각 확인하세요.</p><div><button disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />다시 조회</button><a href={original} target="_blank" rel="noreferrer">나라장터 원문<ExternalLink size={14} /></a></div></div>
    {loading && <div className="company-opening-loading" role="status"><LoaderCircle className="company-spin" size={24} /><div><strong>투찰업체와 개찰 결과를 조회하고 있습니다.</strong><span>입찰분류와 재입찰 회차별로 공개 결과를 확인합니다.</span></div></div>}
    {error && <div className="company-opening-message is-warning" role="alert"><Info size={17} /><div><strong>투찰업체 정보를 조회하지 못했습니다.</strong><p>{error}</p></div></div>}
    {data && <>
      {(!data.complete || data.warnings.length > 0) && <div className="company-opening-message is-warning" role="status"><Info size={17} /><div><strong>{data.complete ? '공개 정보 확인 안내' : '일부 조회된 결과입니다.'}</strong>{!data.complete && <p>현재 확인된 자료만 표시합니다. 전체 업체와 결과는 조회가 완료된 뒤 다시 확인해 주세요.</p>}{data.warnings.map((warning, index) => <p key={`${warning}-${index}`}>{warning}</p>)}</div></div>}
      <div className="company-opening-scope"><div><strong>조회된 업체 {number(data.participantCount)}행</strong><span>입찰분류·재입찰 회차 {number(data.groups.length)}개</span><small>{openingTime(data.fetchedAt)} 조회</small></div>{data.groups.length > 1 && <label>입찰분류·회차<select value={groupId} onChange={event => setGroupId(event.target.value)}><option value="all">전체 분류·회차</option>{data.groups.map(group => <option key={group.id} value={group.id}>입찰분류 {group.classification || '-'} · 재입찰 회차 {group.rebid || '-'}</option>)}</select></label>}</div>
      {visibleGroups.length ? <div className="company-opening-groups">{visibleGroups.map(group => <OpeningGroup key={group.id} group={group} activeBusinessNumber={activeBusinessNumber} onCompany={onCompany} />)}</div> : <div className="company-section-empty">현재 공개된 투찰업체 내역이 없습니다.</div>}
    </>}
  </section>;
}

function OpeningGroup({ group, activeBusinessNumber, onCompany }: { group: OpeningResultGroup; activeBusinessNumber: string; onCompany?: (value: string) => void }) {
  const [page, setPage] = useState(1);
  const groupHeading = useRef<HTMLElement | null>(null);
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(group.participants.length / pageSize));
  const currentPage = Math.min(page, pages);
  const first = (currentPage - 1) * pageSize;
  const participants = group.participants.slice(first, first + pageSize);
  function changePage(next: number) {
    setPage(next);
    groupHeading.current?.focus({ preventScroll: true });
    groupHeading.current?.scrollIntoView({ block: 'start' });
  }
  const matchesActive = (participant: OpeningParticipant) => Boolean(participant.businessNumber) && participant.businessNumber.replace(/[\s-]/g, '') === activeBusinessNumber.replace(/[\s-]/g, '');
  return <section className="company-opening-group" aria-label={`입찰분류 ${group.classification || '-'} 재입찰 회차 ${group.rebid || '-'}`}>
    <header ref={groupHeading} tabIndex={-1}><div><span>입찰분류 <b>{group.classification || '-'}</b></span><span>재입찰 회차 <b>{group.rebid || '-'}</b></span>{group.status && <strong>{group.status}</strong>}</div><p>{group.agency || '-'} · 개찰 {openingTime(group.openingAt)}</p></header>
    <dl className="company-opening-summary"><div><dt>전체 참가업체</dt><dd>{group.participantCount == null ? '-' : `${number(group.participantCount)}개`}<small>조회 {number(group.participants.length)}행</small></dd></div><div><dt>개찰 1순위</dt><dd>{group.firstCompany || '-'}</dd></div><div className={group.winnerBusinessNumber ? 'has-winner' : ''}><dt>최종 낙찰업체</dt><dd>{group.winnerCompany || (group.winnerBusinessNumber ? businessNumber(group.winnerBusinessNumber) : '-')}<small>낙찰금액 {money(group.winningAmount)}</small></dd></div></dl>
    <p className="company-opening-rank-note">1순위만으로 최종 낙찰업체로 분류하지 않습니다. 낙찰정보에서 확인된 업체에만 ‘낙찰’을 표시합니다.</p>
    {(group.reason || group.deadline) && <div className="company-opening-reason">{group.reason && <p><strong>공개 사유</strong>{group.reason}</p>}{group.deadline && <p><strong>재입찰 마감</strong>{openingTime(group.deadline)}</p>}</div>}
    {group.participants.length ? <><div className="company-opening-desktop company-table-scroll"><table><thead><tr><th scope="col">개찰 순위</th><th scope="col">업체 / 사업자등록번호</th><th scope="col">투찰금액</th><th scope="col">투찰률</th><th scope="col">투찰일시</th><th scope="col">최종 낙찰</th><th scope="col">공개 결과 / 비고</th></tr></thead><tbody>{participants.map(participant => <tr key={participant.id} className={matchesActive(participant) ? 'is-active-company' : ''}><td><span className={`company-opening-rank${participant.rank === '1' ? ' is-first' : ''}`}>{participant.rank || '-'}</span></td><td><OpeningCompany participant={participant} active={matchesActive(participant)} onCompany={onCompany} /></td><td className="company-amount">{money(participant.bidAmount)}</td><td>{participant.bidRate == null ? '-' : `${participant.bidRate}%`}</td><td>{openingTime(participant.biddingAt)}</td><td><OpeningAward awarded={participant.awarded} /></td><td className="company-opening-result"><span>{participant.result || '-'}</span>{participant.remarks && <small>{participant.remarks}</small>}</td></tr>)}</tbody></table></div><div className="company-opening-mobile">{participants.map(participant => <article key={participant.id} className={matchesActive(participant) ? 'is-active-company' : ''}><div className="company-opening-card-top"><span>개찰 순위 <strong>{participant.rank || '-'}</strong></span><OpeningAward awarded={participant.awarded} /></div><OpeningCompany participant={participant} active={matchesActive(participant)} onCompany={onCompany} /><dl><div><dt>투찰금액</dt><dd>{money(participant.bidAmount)}</dd></div><div><dt>투찰률</dt><dd>{participant.bidRate == null ? '-' : `${participant.bidRate}%`}</dd></div><div><dt>투찰일시</dt><dd>{openingTime(participant.biddingAt)}</dd></div><div><dt>공개 결과</dt><dd>{participant.result || '-'}</dd></div></dl>{participant.remarks && <p>{participant.remarks}</p>}</article>)}</div></> : <div className="company-section-empty">이 분류·회차의 투찰업체 내역은 현재 조회되지 않았습니다.</div>}
    {group.participants.length > 0 && <footer className="company-opening-pagination"><p>{number(first + 1)}–{number(Math.min(first + pageSize, group.participants.length))} / {number(group.participants.length)}행 <span>50행씩 표시</span></p>{pages > 1 && <nav aria-label={`입찰분류 ${group.classification || '-'} 재입찰 회차 ${group.rebid || '-'} 투찰업체 페이지`}><button disabled={currentPage <= 1} onClick={() => changePage(currentPage - 1)}><ChevronLeft size={15} />이전</button><span>{number(currentPage)} / {number(pages)}</span><button disabled={currentPage >= pages} onClick={() => changePage(currentPage + 1)}>다음<ChevronRight size={15} /></button></nav>}</footer>}
  </section>;
}

function OpeningCompany({ participant, active, onCompany }: { participant: OpeningParticipant; active: boolean; onCompany?: (value: string) => void }) {
  const bizno = participant.businessNumber.replace(/[\s-]/g, '');
  const displayNumber = /^\d{10}$/.test(bizno) ? businessNumber(bizno) : participant.businessNumber || '-';
  const title = participant.companyName || displayNumber;
  return <div className="company-opening-company">{/^\d{10}$/.test(bizno) && !active && onCompany ? <button onClick={() => onCompany(bizno)}>{title}<ArrowRight size={12} /></button> : <strong>{title}</strong>}<small>{displayNumber}{active && <span>조회 중인 업체</span>}</small></div>;
}

function OpeningAward({ awarded }: { awarded: boolean | null }) {
  return awarded === true ? <span className="company-outcome is-won">낙찰</span> : awarded === false ? <span className="company-outcome is-lost">미낙찰</span> : <span className="company-opening-unknown">-</span>;
}
