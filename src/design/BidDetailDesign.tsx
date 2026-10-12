import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowUpRight, Bookmark, Building2, CalendarClock, Check, CheckCheck, ChevronDown, ChevronRight, ClipboardCheck, Copy, ExternalLink, FileCheck2, FileSpreadsheet, FileText, Info, ListChecks, MapPin, Printer, ShieldCheck, Wallet, X } from 'lucide-react';
import { detailSections, referenceDocuments, type DetailSectionData } from './detailFixture';

const NOTICE_NUMBER = 'R26BK01764541-000';
const ORIGINAL_URL = 'https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01764541&bidPbancOrd=000';
const sectionIcons: Record<string, ReactNode> = { general: <Building2 />, schedule: <CalendarClock />, eligibility: <ShieldCheck />, pricing: <Wallet />, qualification: <FileCheck2 />, fees: <ClipboardCheck /> };
const navItems = [{ id: 'summary', label: '핵심 요약' }, { id: 'general', label: '공고 일반' }, { id: 'schedule', label: '입찰 일정' }, { id: 'eligibility', label: '참가조건' }, { id: 'pricing', label: '금액 정보' }, { id: 'qualification', label: '적격심사' }, { id: 'fees', label: '보증금' }, { id: 'documents', label: '첨부서류', count: 4 }, { id: 'review', label: '업체 검토' }, { id: 'preparation', label: '준비 체크' }];

function InformationSection({ section, index, open, onToggle }: { section: DetailSectionData; index: number; open: boolean; onToggle: () => void }) {
  return <section id={section.id} className={`bd-section ${open ? 'is-open' : ''}`} aria-labelledby={`${section.id}-heading`}>
    <h2 id={`${section.id}-heading`}><button type="button" className="bd-section-toggle" onClick={onToggle} aria-expanded={open} aria-controls={`${section.id}-body`}>
      <span className="bd-section-icon">{sectionIcons[section.id]}</span><span><span className="bd-section-kicker">{String(index).padStart(2, '0')} · {section.kicker}</span><span className="bd-section-label">{section.label}</span></span><span className="bd-section-count">{section.fields.length}개 항목</span><ChevronDown className="bd-chevron" size={18} />
    </button></h2>
    <div id={`${section.id}-body`} hidden={!open} className="bd-section-body"><dl className="bd-fields">{section.fields.map(field => <div key={field.label} className={`bd-field ${field.wide ? 'is-wide' : ''} ${field.emphasis ? 'is-emphasis' : ''}`}><dt>{field.label}</dt><dd className={field.value === '미기재' ? 'is-unknown' : ''}>{field.value}{field.note && <small>{field.note}</small>}</dd></div>)}</dl></div>
  </section>;
}

export function BidDetailDesign() {
  const [bookmarked, setBookmarked] = useState(false);
  const [toast, setToast] = useState('');
  const [activeSection, setActiveSection] = useState('summary');
  const [openSections, setOpenSections] = useState(() => new Set(detailSections.map(section => section.id)));
  const [region, setRegion] = useState('화성시');
  const [checked, setChecked] = useState<string[]>([]);
  const [memo, setMemo] = useState('');
  const [savedMemo, setSavedMemo] = useState('');
  const [showContact, setShowContact] = useState(false);
  const contactDialog = useRef<HTMLDialogElement>(null);
  const contactTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const targets = navItems.map(item => document.getElementById(item.id)).filter((item): item is HTMLElement => Boolean(item));
    const observer = new IntersectionObserver(entries => {
      const entry = entries.find(item => item.isIntersecting);
      if (entry) setActiveSection(entry.target.id);
    }, { rootMargin: '-130px 0px -60% 0px', threshold: 0 });
    targets.forEach(item => observer.observe(item));
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (showContact) contactDialog.current?.showModal();
    else if (contactDialog.current?.open) contactDialog.current.close();
  }, [showContact]);

  function toggleBookmark() { setBookmarked(value => !value); setToast(bookmarked ? '시안의 관심공고에서 해제했습니다.' : '시안의 관심공고에 추가했습니다.'); }
  async function copy(text: string, message: string) {
    try { await navigator.clipboard.writeText(text); setToast(message); }
    catch { setToast('복사를 지원하지 않는 환경입니다. 화면의 텍스트를 선택해 복사해 주세요.'); }
  }
  function jumpTo(id: string) {
    if (detailSections.some(section => section.id === id)) {
      setOpenSections(current => new Set([...current, id]));
    }
    setActiveSection(id);
    window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }));
  }
  const match = region === '화성시';
  const allOpen = detailSections.every(section => openSections.has(section.id));

  return <div className="bd-app">
    <a className="bd-skip" href="#summary">공고 내용 바로가기</a>
    <header className="bd-header"><div className="bd-header-inner">
      <a href="/" className="bd-brand"><span className="bd-brand-symbol" aria-hidden="true"><i /><i /><i /></span><span>공사입찰 <b>검색</b></span></a>
      <nav className="bd-primary-nav" aria-label="서비스 메뉴"><a href="/" className="is-active">입찰공고</a><a href="#preparation" onClick={event => { event.preventDefault(); jumpTo('preparation'); }}>투찰 준비</a></nav>
      <span className="bd-preview-label"><span />상세페이지 시안</span><a href="/" className="bd-header-link">서비스로 이동<ArrowUpRight size={15} /></a>
    </div></header>

    <main className="bd-container">
      <div className="bd-breadcrumb"><a href="/"><ArrowLeft size={15} /><span>공고 목록</span></a><ChevronRight size={13} /><span>공사</span><ChevronRight size={13} /><strong>공고 상세</strong><span className="bd-source-note">참고 화면 기준 · 2026.10.12</span></div>

      <section id="summary" className="bd-hero" aria-labelledby="notice-title">
        <div className="bd-hero-topline"><div className="bd-badges"><span className="bd-badge bd-blue">접수예정</span><span className="bd-badge">공사</span><span className="bd-badge">수의계약</span><span className="bd-badge bd-purple">지역제한</span></div><div className="bd-hero-tools"><button className="bd-icon-button" aria-label="공고번호 복사" title="공고번호 복사" onClick={() => void copy(NOTICE_NUMBER, '공고번호를 복사했습니다.')}><Copy size={17} /></button><button className="bd-icon-button bd-print" aria-label="공고 정보 인쇄" title="공고 정보 인쇄" onClick={() => window.print()}><Printer size={17} /></button><button className={`bd-icon-button ${bookmarked ? 'is-saved' : ''}`} aria-label={bookmarked ? '관심공고 해제' : '관심공고 저장'} aria-pressed={bookmarked} onClick={toggleBookmark}><Bookmark size={19} fill={bookmarked ? 'currentColor' : 'none'} /></button></div></div>
        <h1 id="notice-title">향남읍 송곡리 403번지 일원<br className="bd-title-break" /> 우수관로 정비공사</h1>
        <div className="bd-hero-meta"><span><Building2 size={15} />경기도 화성시 맑은물사업소</span><i /><span className="bd-mono">{NOTICE_NUMBER}</span><span className="bd-notice-type">실공고</span></div>

        <div className="bd-key-metrics">
          <div className="bd-price-metric"><span>추정가격 <span className="bd-vat">기준 금액</span></span><strong>57,836,364<span>원</span></strong><small>검색·비교의 기준 금액</small></div>
          <div><span>입찰서 제출 마감 <b className="bd-dday">D−4</b></span><strong className="bd-date">10.16 <span>금요일</span><em>10:00</em></strong><small>2026년 · 한국시간 기준</small></div>
          <div><span>투찰하한율</span><strong>89.745<span>%</span></strong><small>예가변동폭 <b>97 ~ 103</b></small></div>
        </div>
        <div className="bd-hero-foot"><span><MapPin size={15} /><b>참가 가능 지역</b> 경기도 화성시</span><span><ShieldCheck size={15} /><b>요구 업종</b> 상·하수도설비공사업 <span className="bd-code">4996</span></span></div>
      </section>

      <nav className="bd-section-nav" aria-label="공고 상세 구역 바로가기"><div>{navItems.map(item => <button key={item.id} aria-current={activeSection === item.id ? 'location' : undefined} className={activeSection === item.id ? 'is-active' : ''} onClick={() => jumpTo(item.id)}>{item.label}{item.count && <span>{item.count}</span>}</button>)}</div><button className="bd-expand-button" onClick={() => setOpenSections(allOpen ? new Set() : new Set(detailSections.map(section => section.id)))}><ListChecks size={15} />{allOpen ? '상세 접기' : '전체 펼치기'}</button></nav>

      <div className="bd-layout">
        <div className="bd-content">
          <section className="bd-dates-card" aria-label="주요 입찰 일정"><div className="bd-small-heading"><CalendarClock size={18} /><h2>놓치지 말아야 할 일정</h2><span>2026년 10월</span></div><ol className="bd-timeline">
            <li><span className="bd-timeline-node" /><span>입찰 개시</span><strong>10.13 <small>화</small></strong><em>10:00</em></li>
            <li><span className="bd-timeline-node" /><span>참가자격 등록 마감</span><strong>10.15 <small>목</small></strong><em>18:00</em></li>
            <li className="is-highlight"><span className="bd-timeline-node" /><span>입찰서 제출 마감</span><strong>10.16 <small>금</small></strong><em>10:00</em></li>
            <li><span className="bd-timeline-node" /><span>개찰</span><strong>10.16 <small>금</small></strong><em>11:00</em></li>
          </ol><div className="bd-timeline-note"><Info size={14} /><span>참가자격 등록은 입찰서 제출 마감보다 하루 먼저 마감됩니다.</span></div></section>

          <div className="bd-content-caption"><span>공고 상세정보</span><small>빈 항목은 ‘미기재’로 표시합니다.</small></div>
          {detailSections.map((section, index) => <InformationSection key={section.id} section={section} index={index + 1} open={openSections.has(section.id)} onToggle={() => setOpenSections(current => { const next = new Set(current); if (next.has(section.id)) next.delete(section.id); else next.add(section.id); return next; })} />)}

          <section id="documents" className="bd-section bd-documents" aria-labelledby="documents-heading"><div className="bd-documents-header"><span className="bd-section-icon"><FileText /></span><div><span className="bd-section-kicker">07 · DOCUMENTS</span><h2 id="documents-heading">첨부서류 <span>4</span></h2></div><a className="bd-link" href={ORIGINAL_URL} target="_blank" rel="noopener noreferrer">원문 첨부 확인<ExternalLink size={14} /></a></div>
            <p className="bd-documents-note">공내역서부터 공고문까지, 입찰 준비에 필요한 서류입니다.</p>
            <div className="bd-file-list">{referenceDocuments.map((file, index) => <div className="bd-file" key={file.name}><span className={`bd-file-icon is-${file.extension.toLowerCase()}`}>{file.extension === 'XLSX' ? <FileSpreadsheet size={21} /> : <FileText size={21} />}<b>{file.extension}</b></span><div><span className="bd-file-kind">{file.kind}</span><p>{file.name}</p><small>참고 화면의 첨부 목록 · 파일 크기 미제공</small></div><button className="bd-icon-button" aria-label={`${index + 1}번 첨부 파일명 복사`} title="파일명 복사" onClick={() => void copy(file.name, '첨부 파일명을 복사했습니다.')}><Copy size={16} /></button></div>)}</div>
            <div className="bd-subtle-note"><Info size={15} /><p>시안에서는 파일 목록을 확인할 수 있습니다. 실제 파일은 나라장터 원문의 첨부서류에서 확인해 주세요.</p></div>
          </section>
          <div className="bd-bottom-note"><ShieldCheck size={17} /><p>참가자격과 금액·일정은 최신 공고 원문을 기준으로 확인하세요.<br /><span>이 화면은 제공해주신 이미지로 구성한 디자인 시안입니다. 실시간 공고 조회 결과가 아닙니다.</span></p></div>
        </div>

        <aside className="bd-sidebar" aria-label="입찰 검토 도구"><div className="bd-sidebar-sticky">
          <section id="review" className="bd-review-card" aria-labelledby="review-heading"><div className="bd-small-heading"><ShieldCheck size={18} /><h2 id="review-heading">우리 업체로 검토하기</h2></div><p className="bd-sidebar-description">지역조건을 먼저 확인하세요.</p><label className="bd-field-label" htmlFor="design-region">업체 소재지 <span>시안 체험</span></label><select id="design-region" value={region} onChange={event => setRegion(event.target.value)}><option value="화성시">경기도 화성시 (예시)</option><option value="서울">서울특별시 (예시)</option><option value="미등록">소재지 미등록</option></select>
            <div className={`bd-region-result ${match ? 'is-match' : region === '서울' ? 'is-excluded' : 'is-review'}`}><span>{match ? <CheckCheck size={20} /> : <Info size={20} />}</span><div><strong>{match ? '지역조건 일치' : region === '서울' ? '지역조건 확인 필요' : '업체 소재지를 등록하세요'}</strong><p>{match ? '등록한 본점과 공고의 지역이 일치해요.' : region === '서울' ? '본점 지역이 다릅니다. 지사 허용 여부는 원문 확인이 필요해요.' : '소재지를 선택하면 예시 판정을 볼 수 있어요.'}</p></div></div>
            <dl className="bd-review-facts"><div><dt>참가 가능 지역</dt><dd>경기도 화성시</dd></div><div><dt>요구 업종</dt><dd>상·하수도설비공사업</dd></div><div><dt>지사 투찰</dt><dd className="bd-muted">미기재 · 원문 확인</dd></div></dl><p className="bd-review-disclaimer">지역 일치만으로 참가자격이 확정되지는 않습니다. 면허·실적·공동수급 조건을 확인하세요.</p>
            <button className={`bd-button bd-button-light ${bookmarked ? 'is-saved' : ''}`} onClick={toggleBookmark} aria-pressed={bookmarked}><Bookmark size={17} fill={bookmarked ? 'currentColor' : 'none'} />{bookmarked ? '관심공고 저장됨' : '관심공고 저장'}</button><a href={ORIGINAL_URL} target="_blank" rel="noopener noreferrer" className="bd-button bd-button-primary">나라장터 원문<ArrowUpRight size={17} /></a><button ref={contactTrigger} className="bd-contact-link" onClick={() => setShowContact(true)}>공고 담당자 확인<ChevronRight size={14} /></button>
          </section>
          <section id="preparation" className="bd-preparation-card" aria-labelledby="preparation-heading"><div className="bd-small-heading"><ListChecks size={18} /><h2 id="preparation-heading">투찰 준비 체크</h2><span>{checked.length}/3</span></div><p className="bd-sidebar-description">시안에서 체크해 보세요.</p><div className="bd-progress"><span style={{ width: `${checked.length / 3 * 100}%` }} /></div><div className="bd-checklist">{['참가자격·면허 확인', '공고문·첨부서류 확인', '등록·제출 마감일 확인'].map(item => <label key={item}><input type="checkbox" checked={checked.includes(item)} onChange={event => setChecked(current => event.target.checked ? [...current, item] : current.filter(value => value !== item))} /><span>{item}</span></label>)}</div><label className="bd-field-label" htmlFor="design-memo">검토 메모</label><textarea id="design-memo" rows={3} maxLength={2000} value={memo} onChange={event => setMemo(event.target.value)} placeholder="확인할 내용을 적어두세요." /><div className="bd-memo-footer"><small>{savedMemo && savedMemo === memo ? '이 화면에 저장됨' : '현재 화면에서만 유지됩니다.'}</small><button onClick={() => { setSavedMemo(memo); setToast('시안 메모를 이 화면에 저장했습니다. 새로고침하면 초기화됩니다.'); }}>메모 저장</button></div></section>
          <div className="bd-sidebar-footnote"><span className="bd-small-dot" />공고번호 {NOTICE_NUMBER}<p>참고 화면의 게시일 2026.10.12 15:25</p></div>
        </div></aside>
      </div>
      <footer className="bd-footer"><a className="bd-footer-brand" href="/">공사입찰 검색</a><span>공고의 모든 정보, 더 명확하게.</span><a href="#summary" onClick={event => { event.preventDefault(); jumpTo('summary'); }}>맨 위로<ArrowDown size={14} /></a></footer>
    </main>

    <div className="bd-mobile-actions"><button className={`bd-mobile-save ${bookmarked ? 'is-saved' : ''}`} aria-label={bookmarked ? '관심공고 해제' : '관심공고 저장'} aria-pressed={bookmarked} onClick={toggleBookmark}><Bookmark size={20} fill={bookmarked ? 'currentColor' : 'none'} /><span>{bookmarked ? '저장됨' : '관심공고'}</span></button><a href={ORIGINAL_URL} target="_blank" rel="noopener noreferrer" className="bd-button bd-button-primary">나라장터 원문 확인<ArrowUpRight size={17} /></a></div>
    <div className={`bd-toast ${toast ? 'is-visible' : ''}`} role="status" aria-live="polite">{toast && <><Check size={17} />{toast}</>}</div>
    <dialog ref={contactDialog} className="bd-contact-dialog" onCancel={() => setShowContact(false)} onClose={() => { setShowContact(false); contactTrigger.current?.focus(); }} aria-labelledby="contact-heading"><div className="bd-dialog-heading"><h2 id="contact-heading">공고 담당자</h2><button className="bd-icon-button" aria-label="담당자 정보 닫기" onClick={() => setShowContact(false)}><X size={20} /></button></div><p>경기도 화성시 맑은물사업소</p><dl><div><dt>집행관</dt><dd>이민숙</dd></div><div><dt>입회관·담당자</dt><dd>이민숙</dd></div><div><dt>연락처</dt><dd>참고 화면에 미기재</dd></div></dl><a href={ORIGINAL_URL} target="_blank" rel="noopener noreferrer" className="bd-button bd-button-primary">나라장터에서 연락처 확인<ExternalLink size={16} /></a></dialog>
  </div>;
}
