import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Building2, Calculator, ChevronRight, Clock3, Copy, FileText, Info, ListOrdered, LoaderCircle, MapPin, RefreshCw } from 'lucide-react';
import type { G2bNoticeDetail } from '../g2b-types';
import type { BidNotice } from '../types';
import { formatDateTime } from '../domain';
import { currentNotice, fetchApi, safeG2bUrl } from './client';
import { CompleteNoticeDetails, type CompleteNoticeDetailsHandle } from './CompleteNoticeDetails';
import { noticeState } from '../notice-status';
import { OpeningResultsPanel } from './OpeningResultsPanel';
import { useMemberWorkspace, type MemberWorkspaceAccess } from '../member/useMemberWorkspace';
import type { MemberWorkspace } from '../member/workspace';
import { toggleNoticeBookmark } from '../member/bookmarks';
import { BookmarkButton } from '../components/BookmarkButton';
import { FloatingQuickLinks } from '../components/FloatingQuickLinks';
import { useMenuAccess } from '../admin/useMenuAccess';
import { LockedMenu } from '../admin/AdminPage';
import { menuIsLocked } from '../admin/navigation';
import { browserNoticeNumberRepository, buildNoticeNumberResult, type NoticeNumberRepository } from './notice-number-search';
import { noticeSubmissionMessage } from '../components/notice-schedule';
import { buildBidHelperSeed, storePendingBidHelperSeed } from '../bid-helper/notice-seed';
import '../components/detail-remake.css';

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

export type NoticeDetailRevisionVerification = { status: 'checking' | 'unavailable' } | { status: 'verified'; latest: BidNotice };

/** A detail response is one revision; only a complete number lookup can establish its current state. */
export async function verifyNoticeDetailRevision(query: { number: string; revision: string; type: string }, signal: AbortSignal,
  repository: NoticeNumberRepository = browserNoticeNumberRepository): Promise<NoticeDetailRevisionVerification> {
  try {
    if (query.type !== '공사' && query.type !== '용역') return { status: 'unavailable' };
    const page = await repository(query.number, query.type, signal);
    const result = buildNoticeNumberResult(page, query, query.type);
    return result?.requested ? { status: 'verified', latest: result.latest } : { status: 'unavailable' };
  } catch { return { status: 'unavailable' }; }
}

function latestRevisionLabel(notice: BidNotice, now: number): string {
  if (notice.status === '취소' || notice.noticeKind?.includes('취소')) return '취소공고';
  if (notice.status === '마감') return '입찰 마감';
  return notice.noticeKind || noticeState(currentNotice(notice, new Date(now)), now).label;
}

export function noticeDetailDisplayState(bid: BidNotice, verification: NoticeDetailRevisionVerification, now = Date.now()) {
  if (verification.status !== 'verified') return { label: verification.status === 'checking' ? '최신 차수 확인 중' : '상태 확인 필요',
    tone: 'unknown', description: '최신 차수를 확인하기 전에는 현재 진행 상태를 확정할 수 없습니다.' };
  const latest = verification.latest;
  if (Number(latest.revision) > Number(bid.revision)) return { label: `이전 ${bid.revision}차수`, tone: 'unknown',
    description: `최신 ${latest.revision}차수 · ${latestRevisionLabel(latest, now)}` };
  if (latest.status === '취소' || latest.noticeKind?.includes('취소')) return { label: '취소공고', tone: 'unknown', description: '취소된 공고입니다.' };
  if (latest.status === '마감') return { label: '입찰 마감', tone: 'opened', description: '최신 차수에서 마감된 공고로 확인했습니다.' };
  return noticeState(currentNotice(latest, new Date(now)), now);
}

export function NoticeDetailRevisionNotice({ bid, verification, now = Date.now() }: {
  bid: BidNotice; verification: NoticeDetailRevisionVerification; now?: number;
}) {
  if (verification.status === 'verified') {
    const latest = verification.latest;
    if (Number(latest.revision) <= Number(bid.revision)) return null;
    const latestUrl = `/notice-detail.html?${new URLSearchParams({ number: bid.number, revision: latest.revision, type: bid.type })}`;
    return <aside className="fnd-data-warning" role="note" aria-label="이전 차수 공고 안내"><Info size={18} /><div>
      <strong>이전 {bid.revision}차수 · 최신 {latest.revision}차수 · {latestRevisionLabel(latest, now)}</strong>
      <ul><li>이 화면의 일정과 참가조건은 이전 차수의 기록입니다. 현재 공고 상태는 최신 {latest.revision}차수를 기준으로 확인해 주세요.</li>
        <li><a href={latestUrl}>최신 차수 보기 <ArrowUpRight size={14} /></a></li></ul>
    </div></aside>;
  }
  return <aside className="fnd-data-warning" role="status"><Info size={18} /><div>
    <strong>{verification.status === 'checking' ? '최신 차수를 확인하고 있습니다' : '최신 차수를 확인하지 못했습니다'}</strong>
    <ul><li>{verification.status === 'checking' ? '요청한 차수의 공고 상세는 먼저 표시합니다. 현재 진행 상태는 최신 차수 조회가 끝나면 표시합니다.'
      : '요청한 차수의 기록을 표시하고 있습니다. 다시 조회하거나 나라장터에서 최신 변경·취소 여부를 확인해 주세요.'}</li></ul>
  </div></aside>;
}

export function toggleDetailBookmark(current: MemberWorkspace, bid: BidNotice, userId: string): MemberWorkspace {
  if (current.profile.id !== userId || !bid.title.trim()) return current;
  return toggleNoticeBookmark(current, bid);
}

type DetailBookmarkMember = Pick<MemberWorkspaceAccess, 'user' | 'workspace' | 'ready' | 'loading' | 'saveStatus' | 'error' | 'updateWorkspace' | 'retrySave' | 'retryLoad'>;

export function NoticeDetailBookmark({ bid, member, available = true }: { bid: BidNotice; member: DetailBookmarkMember; available?: boolean }) {
  const userId = member.user?.id;
  const workspace = userId && member.workspace?.profile.id === userId ? member.workspace : null;
  const saved = Boolean(workspace?.bookmarks.includes(bid.id));
  const unavailable = !available || !bid.title.trim();
  const disabled = unavailable || member.loading || Boolean(userId && (!member.ready || !workspace || member.saveStatus === 'saving'));

  function toggle() {
    if (!userId) { window.location.assign('/#account'); return; }
    if (disabled) return;
    member.updateWorkspace(current => toggleDetailBookmark(current, bid, userId));
  }

  return <div className="fnd-bookmark-tools">
    <div className="fnd-bookmark-actions"><BookmarkButton noticeTitle={bid.title || '이 공고'} saved={saved} onToggle={toggle} disabled={disabled} className="fnd-bookmark-button" />{userId && <a href="/#bookmarks">관심공고 모아보기 <ChevronRight size={15} /></a>}</div>
    {unavailable ? <p role="status">공고 기본정보를 확인한 뒤 즐겨찾기에 저장할 수 있습니다.</p>
      : !userId ? <p role="status">{member.loading ? '로그인 상태를 확인 중입니다.' : <><a href="/#account">로그인</a>하면 투찰할 공고를 관심공고에 모아둘 수 있습니다.</>}</p>
      : member.error ? <div className="fnd-bookmark-feedback" role="alert"><span>{member.error}</span>{member.ready && member.saveStatus === 'error' ? <button type="button" onClick={() => void member.retrySave()}>다시 저장</button> : !workspace ? <button type="button" onClick={() => void member.retryLoad()}>다시 불러오기</button> : <a href="/#account">계정에서 확인</a>}</div>
      : !member.ready || !workspace ? <p role="status">관심공고를 불러오는 중입니다.</p>
      : member.saveStatus === 'saving' ? <p role="status">관심공고를 계정에 저장 중입니다.</p>
      : saved && member.saveStatus === 'saved' ? <p role="status">클라우드 저장 완료 · 관심공고에서 투찰할 공고를 비교해 보세요.</p>
      : member.saveStatus === 'recovery' ? <p role="status">미저장 변경이 있습니다. <a href="/#account">계정에서 저장 상태 확인</a></p>
      : <p>투찰을 검토할 공고를 즐겨찾기에 저장하세요.</p>}
  </div>;
}

export function NoticeDetailPage() {
  const member = useMemberWorkspace();
  const access = useMenuAccess(member.user?.id);
  const locked = menuIsLocked('notices', access.ready, access.isAdmin, access.settings);
  const [query] = useState(queryNotice);
  const [detail, setDetail] = useState<G2bNoticeDetail | null>(null);
  const [loading, setLoading] = useState(query.valid);
  const [error, setError] = useState(query.valid ? '' : '공고번호 또는 차수가 올바르지 않습니다. 입찰공고 목록에서 공고를 다시 선택해 주세요.');
  const [retry, setRetry] = useState(0);
  const [toast, setToast] = useState('');
  const [statusNow, setStatusNow] = useState(() => Date.now());
  const [showOpeningResults, setShowOpeningResults] = useState(() => window.location.hash === '#results');
  const [revisionVerification, setRevisionVerification] = useState<NoticeDetailRevisionVerification>({ status: 'checking' });
  const printRef = useRef<CompleteNoticeDetailsHandle>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const requestedUrl = safeG2bUrl(`https://www.g2b.go.kr/link/PNPE027_01/?${new URLSearchParams({ bidPbancNo: query.number, bidPbancOrd: query.revision })}`);
  const sourceUrl = safeG2bUrl(detail?.sourceUrl || detail?.notice?.detailUrl) || (query.valid ? requestedUrl : undefined);
  const bid = detail ? currentNotice(detail.notice ?? emptyNotice(detail, query.type)) : null;
  const state = bid ? noticeDetailDisplayState(bid, revisionVerification, statusNow) : null;

  useEffect(() => {
    const update = () => setStatusNow(Date.now());
    const timer = window.setInterval(update, 60_000);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, []);

  useEffect(() => {
    if (!query.valid || locked) { setDetail(null); setLoading(false); return; }
    const abort = new AbortController();
    setLoading(true); setError('');
    fetchApi<G2bNoticeDetail>(`/api/detail?${new URLSearchParams({ number: query.number, revision: query.revision, type: query.type })}`, abort.signal)
      .then(value => { if (!abort.signal.aborted) { setDetail(value); setLoading(false); } })
      .catch(reason => { if (!abort.signal.aborted) { setError(reason instanceof Error ? reason.message : '공고 상세정보를 불러오지 못했습니다.'); setLoading(false); } });
    return () => abort.abort();
  }, [query, retry, locked]);

  useEffect(() => {
    if (!query.valid || locked) return;
    const abort = new AbortController();
    setRevisionVerification({ status: 'checking' });
    void verifyNoticeDetailRevision(query, abort.signal).then(value => {
      if (!abort.signal.aborted) setRevisionVerification(value);
    });
    return () => abort.abort();
  }, [query, retry, locked]);

  useEffect(() => { document.title = bid?.title ? `${bid.title} | 공사입찰 검색` : '공고 상세 | 공사입찰 검색'; }, [bid?.title]);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(''), 3000); return () => clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    if (detail && showOpeningResults && window.location.hash === '#results') resultsRef.current?.scrollIntoView({ block: 'start' });
  }, [detail, showOpeningResults]);

  async function copyNumber() {
    try { await navigator.clipboard.writeText(`${query.number}-${query.revision}`); setToast('공고번호를 복사했습니다.'); }
    catch { setToast('공고번호를 복사하지 못했습니다. 번호를 선택해 직접 복사해 주세요.'); }
  }

  function openBidHelper() {
    if (!bid || !detail) return;
    if (!storePendingBidHelperSeed(buildBidHelperSeed(bid, detail))) {
      setToast('공고값을 전달하지 못했습니다. 브라우저 저장 설정을 확인해 주세요.');
      return;
    }
    window.location.assign('/#bid-helper');
  }

  if (locked) return <div className="fnd-page"><main className="fnd-page-main"><LockedMenu menu="notices" setting={access.settings.find(setting => setting.menu_key === 'notices')} loading={!access.ready && !access.error} onLogin={() => window.location.assign('/#account')} onRetry={() => { void access.refresh(); }} /></main></div>;

  return <div className="fnd-page">
    <header className="fnd-page-header"><div className="fnd-page-header-inner"><a className="fnd-brand" href="/"><span className="fnd-brand-icon"><Building2 size={24} /></span><span>공사입찰 <b>검색</b></span></a><span className="fnd-header-caption">나라장터 공고 상세</span></div></header>
    <main className="fnd-page-main">
      <div className="fnd-breadcrumb"><span>입찰공고</span><ChevronRight size={14} /><span>공고 상세</span><span className="fnd-live-source"><span />나라장터 공개 데이터</span></div>
      <div className="fnd-page-actions"><a className="fnd-secondary-button" href="/"><ArrowLeft size={17} />공고 목록으로</a>{sourceUrl && <a className="fnd-primary-button" href={sourceUrl} target="_blank" rel="noopener noreferrer">나라장터 원문 보기 <ArrowUpRight size={18} /></a>}</div>
      {loading && !detail ? <section className="fnd-load-state" role="status"><LoaderCircle className="fnd-spin" size={30} /><h1>공고 상세정보를 불러오고 있습니다</h1><p>일반 정보, 참가조건, 일정과 금액 정보를 확인합니다.</p><span>{query.number}-{query.revision}</span></section> : null}
      {error && <section className="fnd-error-state" role="alert"><Info size={25} /><div><h2>공고 상세 조회를 완료하지 못했습니다</h2><p>{error}</p></div>{query.valid && <button type="button" className="fnd-secondary-button" onClick={() => setRetry(value => value + 1)} disabled={loading}><RefreshCw size={16} />다시 조회</button>}</section>}
      {detail && bid && <>
        <section className="fnd-hero" aria-labelledby="fnd-notice-title">
          <div className="fnd-hero-top"><div className="fnd-badges"><span className={`fnd-status is-${state?.tone}`} title={state?.description}>{state?.label}</span><span>{bid.type}</span>{bid.contractMethod && <span>{bid.contractMethod}</span>}</div><div className="fnd-hero-actions"><button type="button" onClick={copyNumber} aria-label="공고번호 복사" title="공고번호 복사"><Copy size={18} /></button></div></div>
          <h1 id="fnd-notice-title">{bid.title || '-'}</h1>
          <div className="fnd-hero-meta"><span><Building2 size={16} />{bid.agency || '-'}</span><span className="fnd-notice-number">{bid.number}-{bid.revision}</span></div>
          {revisionVerification.status === 'verified' && Number(revisionVerification.latest.revision) === Number(bid.revision) && noticeSubmissionMessage(revisionVerification.latest, statusNow) && <p className="detail-submission-status">{noticeSubmissionMessage(revisionVerification.latest, statusNow)}</p>}
          <NoticeDetailBookmark bid={bid} member={member} available={Boolean(detail.notice)} />
          <div className="fnd-hero-bottom"><div><MapPin size={16} /><span><b>참가 가능 지역</b> {detail.allowedRegions?.join(' · ') || '-'}</span></div><div><FileText size={16} /><span><b>업종</b> {detail.licenses.join(' · ') || '-'}</span></div></div>
        </section>
        <NoticeDetailRevisionNotice bid={bid} verification={revisionVerification} now={statusNow} />
        <div className="fnd-opening-launch"><button type="button" onClick={openBidHelper}><Calculator size={17} />투찰 도우미로 계산</button><span>공개된 금액을 확인하고 가정값으로 계산합니다.</span></div>
        {detail.warnings.length > 0 && <aside className="fnd-data-warning"><Info size={18} /><div><strong>일부 상세 항목은 확인이 필요합니다</strong><ul>{detail.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div></aside>}
        <div ref={resultsRef} className="fnd-opening-launch" id="results"><button type="button" aria-expanded={showOpeningResults} aria-controls="fnd-opening-results" onClick={() => setShowOpeningResults(value => !value)}><ListOrdered size={17} />{showOpeningResults ? '개찰·낙찰 결과 닫기' : '개찰·낙찰 결과 보기'}</button><span>개찰 1순위와 최종 낙찰업체를 구분해 확인합니다.</span></div>
        {showOpeningResults && <div id="fnd-opening-results"><OpeningResultsPanel key={`${bid.type}-${bid.number}-${bid.revision}`} row={bid} onClose={() => setShowOpeningResults(false)} autoFocus={false} /></div>}
        <CompleteNoticeDetails detail={detail} bid={bid} printRef={printRef} />
        <footer className="fnd-data-footer"><div><Clock3 size={16} /><span>조회 시각 {formatDateTime(detail.fetchedAt)} (한국시간)</span><button type="button" onClick={() => setRetry(value => value + 1)} disabled={loading}><RefreshCw size={14} className={loading ? 'fnd-spin' : undefined} />{loading ? '조회 중' : '다시 조회'}</button></div><p>공개된 항목을 기준으로 표시합니다. 세부 참가자격과 변경 사항은 최신 공고 원문을 확인해 주세요.</p></footer>
      </>}
    </main>
    {toast && <div className="fnd-toast" role="status">{toast}</div>}
    {member.ready && member.workspace && <FloatingQuickLinks key={member.workspace.profile.id} profile={member.workspace.profile} />}
  </div>;
}
