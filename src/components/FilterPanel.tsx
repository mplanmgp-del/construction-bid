import { useEffect, useRef } from 'react';
import { ChevronDown, RotateCcw, PanelLeftClose, X, SlidersHorizontal } from 'lucide-react';
import { LICENSES, PROVINCES } from '../data';
import { getPriceRangeError } from '../domain';
import type { SearchFilters } from '../types';

interface Props {
  filters: SearchFilters;
  onChange: <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => void;
  onReset: () => void;
  onCollapse: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

function Group({ label, summary, children, open = false }: { label: string; summary: string; children: React.ReactNode; open?: boolean }) {
  return <details className="filter-group" open={open || undefined}><summary><span>{label}</span><span className="filter-summary">{summary}<ChevronDown size={15} /></span></summary><div className="filter-group-body">{children}</div></details>;
}

export function FilterPanel({ filters, onChange, onReset, onCollapse, mobileOpen, onMobileClose }: Props) {
  const amountError = getPriceRangeError(filters.minAmount, filters.maxAmount);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onMobileClose);
  useEffect(() => { closeRef.current = onMobileClose; }, [onMobileClose]);
  useEffect(() => {
    if (!mobileOpen || !panelRef.current) return;
    const panel = panelRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')).filter(element => element.getClientRects().length > 0);
    panel.querySelector<HTMLElement>('.mobile-filter-close')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0]; const last = elements[elements.length - 1];
      if (!first || !last) { event.preventDefault(); panel.focus(); return; }
      if (!panel.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [mobileOpen]);
  return <>
    {mobileOpen && <button className="filter-backdrop" aria-label="상세 검색 닫기" onClick={onMobileClose} />}
    <aside ref={panelRef} className={`filter-panel panel ${mobileOpen ? 'mobile-open' : ''}`} aria-label="상세 검색" role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen || undefined} tabIndex={mobileOpen ? -1 : undefined}>
      <div className="filter-heading"><h2><SlidersHorizontal size={17} />상세 검색</h2><div className="filter-heading-actions"><button className="icon-button collapse-filter" title="상세 검색 접기" aria-label="상세 검색 접기" onClick={onCollapse}><PanelLeftClose size={17} /></button><button className="icon-button mobile-filter-close" aria-label="상세 검색 닫기" onClick={onMobileClose}><X size={19} /></button></div></div>
      <div className="filter-top-line"><span>필요한 조건으로 좁혀보세요</span><button className="text-button" onClick={onReset}><RotateCcw size={12} />초기화</button></div>
      <Group label="공고 구분" summary={filters.type === '전체' ? '공사 · 용역' : filters.type} open><div className="segmented-control">{(['전체', '공사', '용역'] as const).map(value => <button className={filters.type === value ? 'selected' : ''} key={value} onClick={() => onChange('type', value)}>{value}</button>)}</div></Group>
      <Group label="공사 위치" summary={filters.siteProvince} open><label className="sr-only" htmlFor="site-province">공사 위치</label><select id="site-province" className="field" value={filters.siteProvince} onChange={event => onChange('siteProvince', event.target.value)}><option value="전체">전국 모든 지역</option>{PROVINCES.map(province => <option key={province}>{province}</option>)}</select></Group>
      <Group label="참가 가능 지역" summary={filters.autoRegion ? '내 업체 기준' : '모든 지역'}><p className="filter-description">상단의 지역 자동필터가 등록한 업체 소재지와 공고 조건을 비교합니다. 정보가 부족한 공고는 ‘확인 필요’로 표시합니다.</p></Group>
      <Group label="요구 업종·면허" summary={filters.license} ><label className="sr-only" htmlFor="license-filter">요구 업종·면허</label><select id="license-filter" className="field" value={filters.license} onChange={event => onChange('license', event.target.value)}><option value="전체">전체 업종·면허</option>{LICENSES.map(license => <option key={license}>{license}</option>)}</select></Group>
      <Group label="추정가격" summary={filters.minAmount || filters.maxAmount ? '범위 선택' : '전체'} open><div className="amount-fields"><label><span className="sr-only">최소 추정가격</span><input className="field" type="number" min="0" step="1" placeholder="최소 금액" value={filters.minAmount} onChange={event => onChange('minAmount', event.target.value)} /><span className="amount-unit">원</span></label><span>~</span><label><span className="sr-only">최대 추정가격</span><input className="field" type="number" min="0" step="1" placeholder="최대 금액" value={filters.maxAmount} onChange={event => onChange('maxAmount', event.target.value)} /><span className="amount-unit">원</span></label></div><div className="price-presets"><button onClick={() => { onChange('minAmount', ''); onChange('maxAmount', '100000000'); }}>1억 이하</button><button onClick={() => { onChange('minAmount', '100000000'); onChange('maxAmount', '500000000'); }}>1억 ~ 5억</button></div>{amountError && <p className="field-error" role="alert">{amountError}</p>}</Group>
      <Group label="진행 상태" summary={filters.status}><label className="sr-only" htmlFor="status-filter">진행 상태</label><select id="status-filter" className="field" value={filters.status} onChange={event => onChange('status', event.target.value as SearchFilters['status'])}>{['전체', '접수중', '접수예정', '마감', '취소'].map(status => <option key={status}>{status}</option>)}</select></Group>
      <Group label="계약방법" summary={filters.contractMethod}><label className="sr-only" htmlFor="contract-filter">계약방법</label><select id="contract-filter" className="field" value={filters.contractMethod} onChange={event => onChange('contractMethod', event.target.value)}>{['전체', '제한경쟁', '일반경쟁', '수의계약'].map(method => <option key={method}>{method}</option>)}</select></Group>
      <Group label="제출 마감일" summary={filters.deadlineFrom || filters.deadlineTo ? '기간 선택' : '전체'}><label className="date-field"><span>시작일</span><input className="field" type="date" value={filters.deadlineFrom} onChange={event => onChange('deadlineFrom', event.target.value)} /></label><label className="date-field"><span>종료일</span><input className="field" type="date" value={filters.deadlineTo} onChange={event => onChange('deadlineTo', event.target.value)} /></label></Group>
      <Group label="제외 검색어" summary={filters.excludeKeyword || '없음'}><label className="sr-only" htmlFor="exclude-keyword">제외 검색어</label><input className="field" id="exclude-keyword" placeholder="예: 설계, 감리" value={filters.excludeKeyword} onChange={event => onChange('excludeKeyword', event.target.value)} /><p className="filter-description">쉼표로 여러 검색어를 구분할 수 있습니다.</p></Group>
      <div className="filter-source"><span>공고 출처</span><strong><span className="source-dot" />나라장터</strong></div>
      <div className="filter-footnote">선택 조건은 패널을 접어도 유지됩니다.</div>
    </aside>
  </>;
}
