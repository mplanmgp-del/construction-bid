import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarClock, Check, Download, ExternalLink, FileText, Info, MapPin, ShieldCheck, Star, X } from 'lucide-react';
import { daysUntil, formatDateTime, formatPrice } from '../domain';
import type { BidNotice, CompanyProfile, RegionAssessment } from '../types';

interface BidDetailProps {
  bid: BidNotice;
  profile: CompanyProfile;
  assessment: RegionAssessment;
  isBookmarked: boolean;
  onClose: () => void;
  onToggleBookmark: () => void;
}

type DetailTab = 'overview' | 'terms' | 'documents';
const TABS: { id: DetailTab; label: string }[] = [
  { id: 'overview', label: '공고 개요' },
  { id: 'terms', label: '참가조건' },
  { id: 'documents', label: '첨부서류' },
];

function downloadSampleDocument(bid: BidNotice, documentName: string) {
  const text = [
    '[화면 테스트용 예시 첨부서류]', '',
    `예시 공고명: ${bid.title}`,
    `예시 공고번호: ${bid.number} / ${bid.revision}`,
    `서류명: ${documentName}`, '',
    '이 파일은 프런트엔드 프로토타입의 다운로드 기능을 확인하기 위한 예시 텍스트입니다.',
    '실제 입찰공고, 계약조건, 제출 양식 또는 발주기관이 배포한 문서가 아닙니다.',
    '실제 공고 원문과 첨부서류는 나라장터(https://www.g2b.go.kr)에서 확인하세요.',
  ].join('\r\n');
  const blob = new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${documentName.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*]/g, '_')}(예시).txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BidDetail({ bid, profile, assessment, isBookmarked, onClose, onToggleBookmark }: BidDetailProps) {
  const id = useId();
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const drawer = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeAction = useRef(onClose);
  closeAction.current = onClose;

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => closeButton.current?.focus());
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeAction.current();
        return;
      }
      if (event.key !== 'Tab' || !drawer.current) return;
      const focusable = [...drawer.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        drawer.current.focus();
      } else if (!drawer.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = originalOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => setActiveTab('overview'), [bid.id]);

  const days = daysUntil(bid.deadline);
  const deadlineLabel = bid.status === '취소' ? '취소된 공고' : bid.status === '마감' || days < 0 ? '제출 마감'
    : !Number.isFinite(days) ? '마감일 확인 필요' : days === 0 ? '오늘 마감' : `마감 D-${days}`;
  const regionStatusLabel = assessment.status === 'matched' ? '지역 일치' : assessment.status === 'excluded' ? '지역 제외' : '확인 필요';
  const allowedRegionLabel = bid.allowedRegions?.length ? bid.allowedRegions.join(' · ') : '원문 확인 필요';
  const profileRegionLabel = [profile.province, profile.district].filter(Boolean).join(' ') || '소재지 미등록';

  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, tab: DetailTab) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = TABS.findIndex((item) => item.id === tab);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1
      : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    setActiveTab(TABS[nextIndex].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  };

  return (
    <div className="detail-overlay">
      <button className="detail-backdrop" onClick={onClose} tabIndex={-1} aria-label="공고 상세 닫기" />
      <aside className="detail-drawer" ref={drawer} role="dialog" aria-modal="true" tabIndex={-1}
        aria-labelledby={`${id}-title`} aria-describedby={`${id}-demo`}>
        <div className="detail-topbar">
          <span className="eyebrow">입찰공고 상세</span>
          <button ref={closeButton} className="icon-button detail-close" aria-label="공고 상세 닫기" onClick={onClose}><X size={22} aria-hidden="true" /></button>
        </div>
        <div className="detail-heading">
          <div className="detail-heading-badges">
            <span className={`badge ${bid.status === '접수중' ? 'detail-status-open' : bid.status === '접수예정' ? 'detail-status-upcoming' : 'detail-status-ended'}`}>{bid.status}</span>
            <span className="detail-category">{bid.type} · {bid.category}</span>
            {bid.revised && <span className="badge badge-amber">정정</span>}
          </div>
          <div className="detail-title-row">
            <h2 id={`${id}-title`}>{bid.title}</h2>
            <button className={`icon-button detail-bookmark ${isBookmarked ? 'detail-bookmark-active' : ''}`}
              onClick={onToggleBookmark} aria-label={isBookmarked ? '관심공고 해제' : '관심공고 등록'} aria-pressed={isBookmarked}>
              <Star size={22} fill={isBookmarked ? 'currentColor' : 'none'} aria-hidden="true" />
            </button>
          </div>
          <p className="detail-agency">{bid.agency}</p>
          <p className="detail-notice-number">공고번호 <strong>{bid.number}</strong><span>차수 {bid.revision}</span></p>
          <div className={`detail-region-assessment detail-region-${assessment.status}`}>
            {assessment.status === 'matched' ? <Check size={19} aria-hidden="true" /> : <Info size={19} aria-hidden="true" />}
            <div><strong>{regionStatusLabel}</strong><p>{assessment.reason}</p></div>
          </div>
          <p className="detail-region-caption">비교 업체: {profile.companyName} · {profileRegionLabel}</p>
        </div>

        <div className="detail-tabs" role="tablist" aria-label="공고 상세 정보">
          {TABS.map((tab) => <button key={tab.id} id={`${id}-tab-${tab.id}`} type="button" role="tab"
            className={activeTab === tab.id ? 'detail-tab-active' : ''} tabIndex={activeTab === tab.id ? 0 : -1}
            aria-selected={activeTab === tab.id} aria-controls={`${id}-panel-${tab.id}`}
            onClick={() => setActiveTab(tab.id)} onKeyDown={(event) => navigateTabs(event, tab.id)}>{tab.label}
            {tab.id === 'documents' && <span>{bid.documents.length}</span>}
          </button>)}
        </div>

        <div className="detail-content" role="tabpanel" id={`${id}-panel-${activeTab}`} aria-labelledby={`${id}-tab-${activeTab}`} tabIndex={0}>
          {activeTab === 'overview' && <>
            <div className="detail-price-block"><span>추정가격</span><strong>{formatPrice(bid.estimatedPrice)}</strong><p>{bid.estimatedPrice === null ? '이 예시 공고에는 추정가격이 제공되지 않았습니다.' : '금액 검색 및 정렬에 사용하는 추정가격입니다.'}</p></div>
            <section className="detail-section" aria-labelledby={`${id}-base-info`}>
              <h3 id={`${id}-base-info`}>기본정보</h3>
              <dl className="detail-info-grid">
                <div><dt>계약방법</dt><dd>{bid.contractMethod}</dd></div>
                <div><dt>공고 구분</dt><dd>{bid.type}</dd></div>
                <div><dt><MapPin size={14} aria-hidden="true" />공사 현장 위치</dt><dd>{[bid.province, bid.district].filter(Boolean).join(' ') || '미제공'}</dd></div>
                <div><dt><ShieldCheck size={14} aria-hidden="true" />참가 가능 지역</dt><dd>{allowedRegionLabel}</dd></div>
                <div className="detail-info-wide"><dt>공사·용역 기간</dt><dd>{bid.duration || '원문 확인 필요'}</dd></div>
              </dl>
            </section>
            <section className="detail-section" aria-labelledby={`${id}-timeline`}>
              <div className="detail-section-title"><h3 id={`${id}-timeline`}><CalendarClock size={18} aria-hidden="true" />주요 일정</h3><span className="detail-deadline-badge">{deadlineLabel}</span></div>
              <ol className="detail-timeline">
                <li><span className="detail-timeline-dot" /><span>공고 게시</span><strong>{formatDateTime(bid.postedAt)}</strong></li>
                <li><span className="detail-timeline-dot" /><span>참가자격 등록 마감</span><strong>{formatDateTime(bid.registrationDeadline)}</strong></li>
                <li className="detail-timeline-highlight"><span className="detail-timeline-dot" /><span>입찰서 제출 마감</span><strong>{formatDateTime(bid.deadline)}</strong></li>
                <li><span className="detail-timeline-dot" /><span>개찰</span><strong>{formatDateTime(bid.openingAt)}</strong></li>
              </ol>
            </section>
            <section className="detail-section" aria-labelledby={`${id}-description`}><h3 id={`${id}-description`}>공고 내용</h3><p className="detail-description">{bid.description}</p></section>
          </>}

          {activeTab === 'terms' && <>
            <div className="detail-warning"><Info size={19} aria-hidden="true" /><div><strong>최종 참가자격은 원문을 확인하세요.</strong><p>지역 일치는 참가 가능 여부를 확정하지 않습니다. 면허, 실적, 공동수급, 등록기한 등 공고의 모든 조건을 확인해야 합니다.</p></div></div>
            <section className="detail-section" aria-labelledby={`${id}-allowed-region`}><h3 id={`${id}-allowed-region`}>참가 가능 지역</h3><p className="detail-region-value">{allowedRegionLabel}</p><p className="detail-help">공사 현장 소재지와 입찰 참가 지역은 다를 수 있습니다.</p>{(!bid.allowedRegions?.length || bid.specialRegionCondition) && <p className="detail-unknown-condition">지역조건이 누락되었거나 별도 조건이 있어 원문 확인이 필요합니다.</p>}</section>
            <section className="detail-section" aria-labelledby={`${id}-licenses`}><h3 id={`${id}-licenses`}>요구 업종·면허</h3><div className="detail-license-list">{bid.licenses.length ? bid.licenses.map((license) => <span className="detail-license" key={license}>{license}</span>) : <p className="detail-help">면허조건 미제공 · 원문 확인 필요</p>}</div></section>
            <section className="detail-section" aria-labelledby={`${id}-requirements`}><h3 id={`${id}-requirements`}>참가조건</h3>{bid.requirements.length ? <ul className="detail-requirements">{bid.requirements.map((requirement, index) => <li key={`${index}-${requirement}`}>{requirement}</li>)}</ul> : <p className="detail-help">이 예시에는 세부 참가조건이 제공되지 않았습니다.</p>}</section>
          </>}

          {activeTab === 'documents' && <>
            <div className="detail-document-intro"><FileText size={24} aria-hidden="true" /><div><h3>예시 첨부서류</h3><p>다운로드 기능을 체험하는 예시 텍스트 파일입니다.</p></div></div>
            <div className="detail-document-list">{bid.documents.length ? bid.documents.map((item, index) => <div className="detail-document" key={`${item.name}-${index}`}><span className="detail-document-icon"><FileText size={21} aria-hidden="true" /></span><div className="detail-document-name"><strong>{item.name}</strong><span>예시 문서 · TXT로 다운로드</span></div><button className="button button-secondary detail-download" onClick={() => downloadSampleDocument(bid, item.name)} aria-label={`${item.name} 예시 텍스트 다운로드`}><Download size={16} aria-hidden="true" /><span>다운로드</span></button></div>) : <p className="detail-help">이 예시 공고에는 첨부서류가 없습니다.</p>}</div>
            <div className="detail-warning detail-document-warning"><Info size={18} aria-hidden="true" /><p>실제 발주기관의 문서가 아닙니다. 제출 양식과 실제 첨부서류는 나라장터에서 확인하세요.</p></div>
          </>}
        </div>

        <footer className="detail-footer">
          <p id={`${id}-demo`}>화면 시안 · 예시 공고입니다.<br />지역판정은 최종 참가자격을 의미하지 않습니다.</p>
          <a className="button button-primary" href="https://www.g2b.go.kr" target="_blank" rel="noopener noreferrer">나라장터 열기<ExternalLink size={16} aria-hidden="true" /></a>
        </footer>
      </aside>
    </div>
  );
}
