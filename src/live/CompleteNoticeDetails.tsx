import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { Building2, CalendarClock, ChevronDown, ChevronsDownUp, ChevronsUpDown, ClipboardList, ExternalLink, FileCheck2, FileText, HardHat, Info, Landmark, Paperclip, Phone, Search, ShieldCheck, Wallet, X } from 'lucide-react';
import type { G2bDetailSection, G2bNoticeDetail, G2bRelatedDetail } from '../g2b-types';
import type { BidNotice } from '../types';
import { formatDateTime, formatPrice } from '../domain';
import { safeG2bUrl } from './client';
import { RelatedNoticeDetails } from './RelatedNoticeDetails';
import { NoticePrintDialog } from '../print/NoticePrintDialog';
import './CompleteNoticeDetails.css';

const icons: Record<string, ReactNode> = {
  general: <Building2 />, schedule: <CalendarClock />, eligibility: <ShieldCheck />,
  construction: <HardHat />, pricing: <Wallet />, qualification: <FileCheck2 />,
  fees: <Landmark />, contacts: <Phone />, baseAmount: <Wallet />,
};

function fallbackSections(bid: BidNotice, detail: G2bNoticeDetail): G2bDetailSection[] {
  return [
    { id: 'general', label: '공고 일반', fields: [
      { key: 'number', label: '입찰공고번호', value: `${bid.number}-${bid.revision}` },
      { key: 'agency', label: '공고기관', value: bid.agency || null },
      { key: 'title', label: '공고명', value: bid.title || null, wide: true },
      { key: 'contract', label: '계약방법', value: bid.contractMethod || null },
      { key: 'posted', label: '게시일시', value: bid.postedAt ? formatDateTime(bid.postedAt) : null },
    ] },
    { id: 'schedule', label: '입찰 일정', fields: [
      { key: 'registration', label: '참가자격 등록마감', value: bid.registrationDeadline ? formatDateTime(bid.registrationDeadline) : null },
      { key: 'deadline', label: '입찰서 제출마감', value: bid.deadline ? formatDateTime(bid.deadline) : null },
      { key: 'opening', label: '개찰일시', value: bid.openingAt ? formatDateTime(bid.openingAt) : null },
    ] },
    { id: 'eligibility', label: '투찰 제한', fields: [
      { key: 'regions', label: '참가 가능 지역', value: detail.allowedRegions?.join(', ') || null, wide: true },
      { key: 'licenses', label: '업종 제한', value: detail.licenses.join(', ') || null, wide: true },
    ] },
  ];
}

export interface CompleteNoticeDetailsHandle { openPrint: () => void; }

export function CompleteNoticeDetails({ detail, bid, showSummary = true, printRef }: { detail: G2bNoticeDetail; bid: BidNotice; showSummary?: boolean; printRef?: Ref<CompleteNoticeDetailsHandle> }) {
  const id = useId();
  const sections = useMemo(() => detail.sections?.length ? detail.sections : fallbackSections(bid, detail), [bid, detail]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [printNoticeKey, setPrintNoticeKey] = useState('');
  const [related, setRelated] = useState<G2bRelatedDetail | null>(null);
  const noticeKey = `${bid.type}:${bid.number}:${bid.revision}`;
  useEffect(() => setPrintNoticeKey(''), [noticeKey]);
  const openPrint = () => setPrintNoticeKey(noticeKey);
  useImperativeHandle(printRef, () => ({ openPrint }), [noticeKey]);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const sourceUrl = safeG2bUrl(detail.sourceUrl || bid.detailUrl);
  const search = query.trim().normalize('NFKC').toLocaleLowerCase('ko-KR');
  const matchingSections = sections.map(section => ({
    ...section,
    fields: !search || section.label.toLocaleLowerCase('ko-KR').includes(search) ? section.fields : section.fields.filter(field =>
      `${field.label} ${field.value ?? '미제공'} ${field.note ?? ''}`.normalize('NFKC').toLocaleLowerCase('ko-KR').includes(search)),
  })).filter(section => section.fields.length > 0);
  const totalFields = sections.reduce((total, section) => total + section.fields.length, 0);
  const matchingCount = matchingSections.reduce((total, section) => total + section.fields.length, 0);
  const allCollapsed = sections.every(section => collapsed.has(section.id));
  const documents = detail.notice?.documents ?? bid.documents;

  function jumpTo(sectionId: string) {
    setQuery('');
    setCollapsed(previous => { const next = new Set(previous); next.delete(sectionId); return next; });
    requestAnimationFrame(() => sectionRefs.current[sectionId]?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
  }

  function toggle(sectionId: string) {
    setCollapsed(previous => { const next = new Set(previous); if (next.has(sectionId)) next.delete(sectionId); else next.add(sectionId); return next; });
  }

  return <div className="fnd-complete">
    {showSummary && <div className="fnd-key-summary" aria-label="입찰 핵심 정보">
      <div className="fnd-estimate"><span>추정가격</span><strong>{formatPrice(bid.estimatedPrice)}</strong><small>공고에 공개된 추정가격 기준</small></div>
      <div className="fnd-summary-date"><CalendarClock size={20} /><span>입찰서 제출마감</span><strong>{formatDateTime(bid.deadline)}</strong></div>
      <div className="fnd-summary-date"><FileCheck2 size={20} /><span>개찰일시</span><strong>{formatDateTime(bid.openingAt)}</strong></div>
    </div>}
    <div className="fnd-jumpbar" aria-label="공고 상세 구역 이동">
      <div className="fnd-jump-scroll"><button type="button" className="fnd-related-jump" onClick={() => jumpTo('relatedData')}>계약·진행 이력·기관</button>{sections.map(section => <button type="button" key={section.id} onClick={() => jumpTo(section.id)}>{section.label}</button>)}<button type="button" onClick={() => jumpTo('documents')}>첨부서류 <span>{documents.length}</span></button></div>
    </div>
    <div className="fnd-detail-tools">
      <div className="fnd-detail-heading"><span className="fnd-eyebrow">NOTICE DETAILS</span><h2>공고 상세정보 <span>{totalFields}개 항목</span></h2></div>
      <div className="fnd-tool-actions"><label className="fnd-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="상세 항목 검색" aria-label="공고 상세 항목 검색" />{query && <button type="button" aria-label="상세 검색 초기화" onClick={() => setQuery('')}><X size={16} /></button>}</label><button className="fnd-expand-all" type="button" onClick={() => { setQuery(''); setCollapsed(allCollapsed ? new Set() : new Set(sections.map(section => section.id))); }}>{allCollapsed ? <ChevronsUpDown size={17} /> : <ChevronsDownUp size={17} />}<span>{allCollapsed ? '전체 펼치기' : '전체 접기'}</span></button><button type="button" className="fnd-print-document" onClick={openPrint}><FileText size={17} />인쇄용 문서</button></div>
    </div>
    {search && <p className="fnd-search-status" role="status">“{query}” 검색 결과 {matchingCount}개 항목</p>}
    {!detail.sections?.length && <p className="fnd-section-note"><Info size={16} />기본 조회 정보입니다. 상세 조회를 다시 실행하면 추가 공개 항목을 확인할 수 있습니다.</p>}
    <div className="fnd-section-list">{matchingSections.map(section => {
      const open = Boolean(search) || !collapsed.has(section.id);
      const sectionId = `${id}-${section.id}`;
      const missing = section.fields.some(field => field.value === null || field.value === '');
      return <section className={`fnd-section${open ? ' is-open' : ''}`} key={section.id} ref={element => { sectionRefs.current[section.id] = element; }} aria-labelledby={`${sectionId}-heading`}>
        <h3 id={`${sectionId}-heading`}><button className="fnd-section-toggle" type="button" onClick={() => { if (search) setQuery(''); toggle(section.id); }} aria-expanded={open} aria-controls={`${sectionId}-content`}><span className="fnd-section-icon">{icons[section.id] || <ClipboardList />}</span><span>{section.label}</span><span className="fnd-field-count">{section.fields.length}개 항목</span><ChevronDown className="fnd-chevron" size={20} /></button></h3>
        <div id={`${sectionId}-content`} hidden={!open} className="fnd-section-content"><dl className="fnd-fields">{section.fields.map(field => {
          const absent = field.value === null || field.value === '';
          return <div key={field.key} className={`fnd-field${field.wide ? ' is-wide' : ''}`}><dt>{field.label}</dt><dd className={absent ? 'fnd-missing' : undefined}>{absent ? '미제공' : field.value}{field.note && !absent && <small>{field.note}</small>}</dd></div>;
        })}</dl>{missing && <p className="fnd-section-note"><Info size={15} /><span>미제공 항목은 현재 공개 데이터에 값이 없습니다. 공고 원문과 첨부서류에서 확인해 주세요.{sourceUrl && <> <a href={sourceUrl} target="_blank" rel="noopener noreferrer">원문 확인 <ExternalLink size={12} /></a></>}</span></p>}</div>
      </section>;
    })}</div>
    {search && matchingCount === 0 && <div className="fnd-no-results"><Search size={26} /><strong>일치하는 상세 항목이 없습니다.</strong><button type="button" onClick={() => setQuery('')}>전체 항목 보기</button></div>}
    <section className="fnd-section fnd-documents" ref={element => { sectionRefs.current.documents = element; }} aria-labelledby={`${id}-documents-heading`}>
      <div className="fnd-doc-heading"><h3 id={`${id}-documents-heading`}><span className="fnd-section-icon"><Paperclip /></span>첨부서류 <span className="fnd-document-count">{documents.length}</span></h3>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer">원문에서 확인 <ExternalLink size={15} /></a>}</div>
      {documents.length > 0 ? <ul className="fnd-document-list">{documents.map((document, index) => {
        const url = safeG2bUrl(document.url);
        const extension = /\.([a-z0-9]{1,6})$/i.exec(document.name)?.[1].toUpperCase() || 'FILE';
        return <li key={`${document.name}-${index}`}><span className={`fnd-file-type${extension === 'PDF' ? ' is-pdf' : extension === 'XLSX' || extension === 'XLS' ? ' is-sheet' : ''}`}><FileText size={20} /><b>{extension}</b></span><div className="fnd-file-info"><strong>{document.name}</strong>{document.size && <span>{document.size}</span>}</div>{url ? <a className="fnd-file-open" href={url} target="_blank" rel="noopener noreferrer" aria-label={`${document.name} 원본 열기`}><span>원본 열기</span><ExternalLink size={17} /></a> : sourceUrl ? <a className="fnd-file-open" href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`${document.name} 나라장터 원문에서 확인`}><span>원문 확인</span><ExternalLink size={17} /></a> : <span className="fnd-file-unavailable">링크 미제공</span>}</li>;
      })}</ul> : <p className="fnd-doc-empty">공개 데이터에서 제공된 첨부서류가 없습니다.{sourceUrl && ' 나라장터 원문에서 첨부 여부를 확인해 주세요.'}</p>}
      <p className="fnd-section-note"><Info size={15} />첨부서류는 발주기관이 게시한 나라장터 원본 링크로 열립니다.</p>
    </section>
    {bid.source === 'live' && <div className="fnd-related-anchor" ref={element => { sectionRefs.current.relatedData = element; }}><RelatedNoticeDetails key={noticeKey} bid={bid} onDataChange={setRelated} /></div>}
    {printNoticeKey === noticeKey && <NoticePrintDialog key={noticeKey} bid={bid} detail={detail} related={related?.number === bid.number && related.revision === bid.revision && related.type === bid.type ? related : null} onClose={() => setPrintNoticeKey('')} />}
  </div>;
}
