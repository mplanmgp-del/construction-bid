import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Building2, ChevronRight, Clock3, Copy, ExternalLink, FileText, Info, LoaderCircle, MapPin, Printer, RefreshCw } from 'lucide-react';
import type { G2bNoticeDetail } from '../g2b-types';
import type { BidNotice } from '../types';
import { formatDateTime } from '../domain';
import { currentNotice, fetchApi, safeG2bUrl } from './client';
import { CompleteNoticeDetails, type CompleteNoticeDetailsHandle } from './CompleteNoticeDetails';
import { noticeState } from '../notice-status';

function queryNotice() {
  const params = new URLSearchParams(window.location.search);
  const number = params.get('number') || '';
  const revision = params.get('revision') || '000';
  const type = params.get('type') || '공사';
  return { number, revision: revision.padStart(3, '0'), type, valid: /^[a-zA-Z0-9_-]{1,40}$/.test(number) && /^\d{1,3}$/.test(revision) && (type === '공사' || type === '용역') };
}

function emptyNotice(detail: G2bNoticeDetail, type: string): BidNotice {
  return { id: `${detail.number}-${detail.revision}`, number: detail.number, revision: detail.revision, title: '', agency: '', type: type === '용역' ? '용역' : '공사', category: '기타', province: '', district: '', allowedRegions: detail.allowedRegions, estimatedPrice: null, contractMethod: '', status: '확인필요', postedAt: '', deadline: '', openingAt: '', registrationDeadline: '', licenses: detail.licenses, duration: '', description: '', requirements: [], documents: [], revised: false, source: 'live', detailUrl: detail.sourceUrl };
}

export function NoticeDetailPage() {
  const [query] = useState(queryNotice);
  const [detail, setDetail] = useState<G2bNoticeDetail | null>(null);
  const [loading, setLoading] = useState(query.valid);
  const [error, setError] = useState(query.valid ? '' : '공고번호 또는 차수가 올바르지 않습니다. 입찰공고 목록에서 공고를 다시 선택해 주세요.');
  const [retry, setRetry] = useState(0);
  const [toast, setToast] = useState('');
  const [statusNow, setStatusNow] = useState(() => Date.now());
  const printRef = useRef<CompleteNoticeDetailsHandle>(null);
  const requestedUrl = safeG2bUrl(`https://www.g2b.go.kr/link/PNPE027_01/?${new URLSearchParams({ bidPbancNo: query.number, bidPbancOrd: query.revision })}`);
  const sourceUrl = safeG2bUrl(detail?.sourceUrl || detail?.notice?.detailUrl) || (query.valid ? requestedUrl : undefined);
  const bid = detail ? currentNotice(detail.notice ?? emptyNotice(detail, query.type)) : null;
  const state = bid ? noticeState(bid, statusNow) : null;

  useEffect(() => {
    const update = () => setStatusNow(Date.now());
    const timer = window.setInterval(update, 60_000);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, []);

  useEffect(() => {
    if (!query.valid) return;
    const abort = new AbortController();
    setLoading(true); setError('');
    fetchApi<G2bNoticeDetail>(`/api/detail?${new URLSearchParams({ number: query.number, revision: query.revision, type: query.type })}`, abort.signal)
      .then(value => { if (!abort.signal.aborted) { setDetail(value); setLoading(false); } })
      .catch(reason => { if (!abort.signal.aborted) { setError(reason instanceof Error ? reason.message : '공고 상세정보를 불러오지 못했습니다.'); setLoading(false); } });
    return () => abort.abort();
  }, [query, retry]);

  useEffect(() => { document.title = bid?.title ? `${bid.title} | 공사입찰 검색` : '공고 상세 | 공사입찰 검색'; }, [bid?.title]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(''), 3000); return () => clearTimeout(timeout); }, [toast]);

  async function copyNumber() {
    try { await navigator.clipboard.writeText(`${query.number}-${query.revision}`); setToast('공고번호를 복사했습니다.'); }
    catch { setToast('공고번호를 복사하지 못했습니다. 번호를 선택해 직접 복사해 주세요.'); }
  }

  return <div className="fnd-page">
    <header className="fnd-page-header"><div className="fnd-page-header-inner"><a className="fnd-brand" href="/"><span className="fnd-brand-icon"><Building2 size={24} /></span><span>공사입찰 <b>검색</b></span></a><span className="fnd-header-caption">나라장터 공고 상세</span><a className="fnd-back" href="/"><ArrowLeft size={16} /><span>공고 목록</span></a>{sourceUrl && <a className="fnd-header-original" href={sourceUrl} target="_blank" rel="noopener noreferrer">나라장터 원문 <ExternalLink size={16} /></a>}</div></header>
    <main className="fnd-page-main">
      <div className="fnd-breadcrumb"><a href="/">입찰공고</a><ChevronRight size={14} /><span>공고 상세</span><span className="fnd-live-source"><span />나라장터 공개 데이터</span></div>
      {loading && !detail ? <section className="fnd-load-state" role="status"><LoaderCircle className="fnd-spin" size={30} /><h1>공고 상세정보를 불러오고 있습니다</h1><p>일반 정보, 참가조건, 일정과 금액 정보를 확인합니다.</p><span>{query.number}-{query.revision}</span></section> : null}
      {error && <section className="fnd-error-state" role="alert"><Info size={25} /><div><h2>공고 상세 조회를 완료하지 못했습니다</h2><p>{error}</p></div>{query.valid && <button type="button" className="fnd-secondary-button" onClick={() => setRetry(value => value + 1)} disabled={loading}><RefreshCw size={16} />다시 조회</button>}{sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer">나라장터 원문 <ExternalLink size={16} /></a>}</section>}
      {detail && bid && <>
        <section className="fnd-hero" aria-labelledby="fnd-notice-title">
          <div className="fnd-hero-top"><div className="fnd-badges"><span className={`fnd-status is-${state?.tone}`} title={state?.description}>{state?.label}</span><span>{bid.type}</span>{bid.contractMethod && <span>{bid.contractMethod}</span>}</div><div className="fnd-hero-actions"><button type="button" onClick={copyNumber} aria-label="공고번호 복사" title="공고번호 복사"><Copy size={18} /></button><button type="button" onClick={() => printRef.current?.openPrint()} aria-label="공고 상세 인쇄" title="인쇄용 PDF 만들기"><Printer size={18} /></button></div></div>
          <h1 id="fnd-notice-title">{bid.title || '-'}</h1>
          <div className="fnd-hero-meta"><span><Building2 size={16} />{bid.agency || '-'}</span><span className="fnd-notice-number">{bid.number}-{bid.revision}</span></div>
          <div className="fnd-hero-bottom"><div><MapPin size={16} /><span><b>참가 가능 지역</b> {detail.allowedRegions?.join(' · ') || '-'}</span></div><div><FileText size={16} /><span><b>업종</b> {detail.licenses.join(' · ') || '-'}</span></div></div>
        </section>
        {detail.warnings.length > 0 && <aside className="fnd-data-warning"><Info size={18} /><div><strong>일부 상세 항목은 확인이 필요합니다</strong><ul>{detail.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div></aside>}
        <CompleteNoticeDetails detail={detail} bid={bid} printRef={printRef} />
        <footer className="fnd-data-footer"><div><Clock3 size={16} /><span>조회 시각 {formatDateTime(detail.fetchedAt)} (한국시간)</span><button type="button" onClick={() => setRetry(value => value + 1)} disabled={loading}><RefreshCw size={14} className={loading ? 'fnd-spin' : undefined} />{loading ? '조회 중' : '다시 조회'}</button></div><p>공개된 항목을 기준으로 표시합니다. 세부 참가자격과 변경 사항은 최신 공고 원문을 확인해 주세요.</p></footer>
      </>}
      <div className="fnd-page-end"><a className="fnd-secondary-button" href="/"><ArrowLeft size={17} />공고 목록으로</a>{sourceUrl && <a className="fnd-primary-button" href={sourceUrl} target="_blank" rel="noopener noreferrer">나라장터 원문 보기 <ArrowUpRight size={18} /></a>}</div>
    </main>
    {sourceUrl && <div className="fnd-mobile-bottom"><a href="/" className="fnd-mobile-back" aria-label="공고 목록으로"><ArrowLeft size={21} /></a><a className="fnd-primary-button" href={sourceUrl} target="_blank" rel="noopener noreferrer">나라장터 원문 보기 <ArrowUpRight size={19} /></a></div>}
    {toast && <div className="fnd-toast" role="status">{toast}</div>}
  </div>;
}
