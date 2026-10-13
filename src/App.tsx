import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Bookmark, Building2, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ClipboardList, ExternalLink, FileSearch, Info, MapPin, PanelLeftOpen, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Star, UserRound, X } from 'lucide-react';
import { CATEGORIES, type BidNotice, type CompanyProfile, type SearchFilters } from './types';
import { DEFAULT_FILTERS, DEMO_PROFILES, DEMO_TODAY, NOTICES } from './data';
import { assessRegion, buildBidCsv, daysUntil, filterNotices, formatAmountInput, formatDateTime, formatPrice } from './domain';
import { loadPrototypeState, savePrototypeState, type PrototypeState } from './storage';
import { FilterPanel } from './components/FilterPanel';
import { ProfileView } from './components/ProfileView';
import { BidDetail } from './components/BidDetail';
import { ExportButton, type ExportFormat } from './components/ExportButton';
import './components/SupportingViews.css';
import { useMemberWorkspace } from './member/useMemberWorkspace';
import { MemberAccess, BidPreparation } from './member/MemberAccess';
import { mergeNoticeDetail } from './member/workspace';
import type { G2bNoticeDetail } from './g2b-types';
import { useLiveNotices } from './live/useLiveNotices';
import { LiveSearch } from './live/LiveSearch';
import { PublicResults } from './live/PublicResults';
import { currentNotice, koreanToday, mergeById } from './live/client';

type View = 'notices' | 'bookmarks' | 'profile' | 'results';
const PAGE_SIZE = 8;
const REGION_LABELS = { matched: '지역 일치', review: '확인 필요', excluded: '지역 제외' } as const;
const SHORT_PROVINCES: Record<string, string> = { 서울특별시: '서울', 경기도: '경기', 부산광역시: '부산', 인천광역시: '인천', 대구광역시: '대구', 대전광역시: '대전', 광주광역시: '광주', 울산광역시: '울산', 세종특별자치시: '세종', 강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남', 전북특별자치도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주' };

function saveDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Deadline({ bid }: { bid: BidNotice }) {
  const days = daysUntil(bid.deadline, bid.source === 'live' ? koreanToday() : DEMO_TODAY);
  return <div className="deadline-cell"><span>{formatDateTime(bid.deadline)}</span><span className={`deadline-badge ${days >= 0 && days <= 3 ? 'urgent' : ''} ${bid.status === '마감' || bid.status === '취소' ? 'past' : ''}`}>{bid.status === '마감' ? '마감' : bid.status === '취소' ? '취소' : !Number.isFinite(days) ? '확인 필요' : days < 0 ? '마감' : days === 0 ? 'D-day' : `D-${days}`}</span></div>;
}

export default function App() {
  const [mode, setMode] = useState<'live' | 'demo'>('live');
  const member = useMemberWorkspace();
  const live = useLiveNotices(mode === 'live');
  const [loaded] = useState(() => loadPrototypeState(DEMO_PROFILES));
  const [state, setState] = useState<PrototypeState>(loaded.state);
  const [storageWarning, setStorageWarning] = useState(loaded.warning);
  const guestProfile: CompanyProfile = { id: 'guest', companyName: '업체 정보 미등록', province: '', district: '', address: '', licenses: [], contactName: '', email: '' };
  const profile = mode === 'live' ? member.workspace?.profile ?? guestProfile : state.profiles.find(item => item.id === state.activeProfileId) ?? state.profiles[0];
  const [view, setView] = useState<View>('notices');
  const [filters, setFilters] = useState<SearchFilters>(() => ({ ...DEFAULT_FILTERS, category: '전체', status: '전체', autoRegion: true }));
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileFilters, setMobileFilters] = useState(false);
  const [selectedBid, setSelectedBid] = useState<BidNotice | null>(null);
  const [toast, setToast] = useState('');
  const noticeFiltersRef = useRef(filters);
  const bookmarks = mode === 'live' ? member.workspace?.bookmarks ?? [] : state.bookmarks[profile.id] ?? [];
  const preferredAutoRegion = mode === 'live' ? member.workspace?.preferences.autoRegion ?? true : state.preferences[profile.id]?.autoRegion ?? true;
  const availableNotices = mode === 'live' ? live.items : NOTICES;

  useEffect(() => { if (mode === 'live') { setSelectedBid(null); setPage(1); setFilters(previous => ({ ...previous, autoRegion: view === 'bookmarks' ? false : preferredAutoRegion })); } }, [member.user?.id, mode, preferredAutoRegion]);
  useEffect(() => {
    if (member.recoveryMode) { setMode('live'); setView('profile'); setSelectedBid(null); setMobileFilters(false); }
  }, [member.recoveryMode]);

  useEffect(() => { if (view === 'notices') noticeFiltersRef.current = filters; }, [filters, view]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 3500); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!mobileFilters) return;
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const media = window.matchMedia('(max-width: 1000px)');
    const onSizeChange = (event: MediaQueryListEvent) => { if (!event.matches) setMobileFilters(false); };
    if (!media.matches) setMobileFilters(false);
    media.addEventListener('change', onSizeChange);
    return () => { document.body.style.overflow = previous; media.removeEventListener('change', onSizeChange); };
  }, [mobileFilters]);

  function persist(next: PrototypeState) {
    setState(next);
    if (!savePrototypeState(next)) setStorageWarning('브라우저 저장을 사용할 수 없습니다. 현재 화면의 변경은 유지되지만 새로 열면 복원되지 않습니다.');
    else setStorageWarning(null);
  }

  function updateFilter<K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) {
    setFilters(previous => ({ ...previous, [key]: value })); setPage(1);
    if (key === 'autoRegion') {
      if (mode === 'live') { if (member.ready) member.updateWorkspace(current => ({ ...current, preferences: { autoRegion: value as boolean } })); }
      else persist({ ...state, preferences: { ...state.preferences, [profile.id]: { autoRegion: value as boolean } } });
    }
  }

  function resetFilters() {
    setFilters({ ...DEFAULT_FILTERS, ...(mode === 'live' ? { category: '전체', status: '전체' } : {}), ...(view === 'bookmarks' ? { category: '전체', status: '전체', autoRegion: false } : { autoRegion: preferredAutoRegion }) });
    setSearchInput(''); setPage(1);
  }

  function navigate(next: View) {
    if (view === next) return;
    setSelectedBid(null); setMobileFilters(false); setPage(1);
    if (next === 'bookmarks') { setFilters({ ...DEFAULT_FILTERS, category: '전체', status: '전체', autoRegion: false }); setSearchInput(''); }
    if (next === 'notices') { const saved = { ...noticeFiltersRef.current, autoRegion: preferredAutoRegion }; setFilters(saved); setSearchInput(saved.keyword); }
    setView(next);
  }

  function switchProfile(id: string) {
    persist({ ...state, activeProfileId: id }); setSelectedBid(null); setPage(1);
    setFilters(previous => ({ ...previous, autoRegion: view === 'bookmarks' ? false : state.preferences[id]?.autoRegion ?? true, regionView: 'all' }));
    setToast('테스트 업체를 전환했습니다. 업체 정보와 관심공고를 각각 확인해 보세요.');
  }

  function toggleBookmark(id: string) {
    const exists = bookmarks.includes(id);
    if (mode === 'live') {
      if (!member.ready) { setView('profile'); setToast('로그인 후 관심공고를 회원별로 저장할 수 있습니다.'); return; }
      const bid = availableNotices.find(item => item.id === id) ?? selectedBid ?? member.workspace?.noticeSnapshots[id];
      member.updateWorkspace(current => {
        const snapshot = { ...current.noticeSnapshots };
        if (exists) delete snapshot[id]; else if (bid) snapshot[id] = bid;
        return { ...current, bookmarks: exists ? current.bookmarks.filter(item => item !== id) : [...current.bookmarks, id], noticeSnapshots: snapshot };
      });
      setToast(exists ? '관심공고에서 해제했습니다.' : '관심공고를 추가했습니다. 클라우드 저장 상태를 확인하세요.'); return;
    }
    persist({ ...state, bookmarks: { ...state.bookmarks, [profile.id]: exists ? bookmarks.filter(item => item !== id) : [...bookmarks, id] } });
    setToast(exists ? '관심공고에서 해제했습니다.' : '관심공고에 저장했습니다.');
  }

  function saveProfile(saved: CompanyProfile) {
    if (mode === 'live') {
      if (member.ready) member.updateWorkspace(current => ({ ...current, profile: saved }));
      setToast('업체 정보를 적용했습니다. 클라우드 저장 상태를 확인하세요.'); setPage(1); return;
    }
    persist({ ...state, profiles: state.profiles.map(item => item.id === saved.id ? saved : item) });
    setToast('업체 정보를 저장했습니다. 새 소재지 기준으로 지역조건을 비교합니다.'); setPage(1);
  }

  function applyNoticeDetail(id: string, detail: G2bNoticeDetail) {
    live.applyDetail(id, detail);
    setSelectedBid(current => current?.id === id ? mergeNoticeDetail(current, detail) : current);
    const saved = member.workspace?.noticeSnapshots[id];
    if (mode !== 'live' || !member.ready || !saved || !member.workspace?.bookmarks.includes(id) || mergeNoticeDetail(saved, detail) === saved) return;
    member.updateWorkspace(current => {
      const existing = current.noticeSnapshots[id];
      if (!existing || !current.bookmarks.includes(id)) return current;
      return { ...current, noticeSnapshots: { ...current.noticeSnapshots, [id]: mergeNoticeDetail(existing, detail) } };
    });
  }

  const sourceNotices = useMemo(() => view === 'bookmarks'
    ? mergeById(mode === 'live' ? Object.values(member.workspace?.noticeSnapshots ?? {}).map(bid => currentNotice(bid)) : [], availableNotices).filter(bid => bookmarks.includes(bid.id))
    : availableNotices, [view, mode, member.workspace?.noticeSnapshots, availableNotices, bookmarks]);
  const baseResults = useMemo(() => filterNotices(sourceNotices, { ...filters, autoRegion: false, regionView: 'all' }, profile), [sourceNotices, filters, profile]);
  const counts = useMemo(() => baseResults.reduce((total, bid) => { total[assessRegion(bid, profile).status]++; return total; }, { matched: 0, review: 0, excluded: 0 }), [baseResults, profile]);
  const filtered = useMemo(() => filterNotices(sourceNotices, filters, profile), [sourceNotices, filters, profile]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const visibleNotices = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const allCount = filters.autoRegion ? counts.matched + counts.review : baseResults.length;

  async function exportResults(format: ExportFormat) {
    try {
      if (format === 'csv') {
        saveDownload(new Blob([buildBidCsv(filtered)], { type: 'text/csv;charset=utf-8' }), mode === 'live' ? '입찰공고_목록.csv' : '입찰공고_예시목록.csv');
      } else {
        const { buildBidWorkbook, getExcelFilename } = await import('./excel-export');
        const generatedAt = new Date();
        const workbook = buildBidWorkbook(filtered, profile, generatedAt, mode);
        const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
        saveDownload(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), getExcelFilename(generatedAt));
      }
      setToast(`현재 검색 결과 ${filtered.length}건을 ${format === 'xlsx' ? '서식이 적용된 엑셀' : 'CSV'} 파일로 다운로드했습니다.`);
    } catch {
      setToast('다운로드 파일을 만들지 못했습니다. 다시 시도해 주세요.');
    }
  }

  const chips: { label: string; remove: () => void }[] = [];
  if (filters.category !== '전체') chips.push({ label: filters.category, remove: () => updateFilter('category', '전체') });
  if (filters.keyword) chips.push({ label: `검색: ${filters.keyword}`, remove: () => { updateFilter('keyword', ''); setSearchInput(''); } });
  if (filters.type !== '전체') chips.push({ label: filters.type, remove: () => updateFilter('type', '전체') });
  if (filters.siteProvince !== '전체') chips.push({ label: `위치: ${filters.siteProvince}`, remove: () => updateFilter('siteProvince', '전체') });
  if (filters.status !== '전체') chips.push({ label: filters.status, remove: () => updateFilter('status', '전체') });
  if (filters.license !== '전체') chips.push({ label: filters.license, remove: () => updateFilter('license', '전체') });
  if (filters.contractMethod !== '전체') chips.push({ label: filters.contractMethod, remove: () => updateFilter('contractMethod', '전체') });
  if (filters.minAmount || filters.maxAmount) chips.push({ label: `추정가격 ${filters.minAmount ? formatAmountInput(filters.minAmount) : '0'} ~ ${filters.maxAmount ? formatAmountInput(filters.maxAmount) + '원' : '전체'}`, remove: () => { updateFilter('minAmount', ''); updateFilter('maxAmount', ''); } });
  if (filters.deadlineFrom || filters.deadlineTo) chips.push({ label: `마감 ${filters.deadlineFrom || '시작'} ~ ${filters.deadlineTo || '전체'}`, remove: () => { updateFilter('deadlineFrom', ''); updateFilter('deadlineTo', ''); } });
  if (filters.excludeKeyword) chips.push({ label: `제외: ${filters.excludeKeyword}`, remove: () => updateFilter('excludeKeyword', '') });

  return <div className="app-shell">
    <header className="app-header"><div className="header-inner">
      <button className="brand" onClick={() => navigate('notices')} aria-label="공사입찰 검색 홈"><span className="brand-mark"><span /><span /><span /></span><span>공사입찰 <b>검색</b></span></button>
      <nav className="main-nav" aria-label="주 메뉴"><button className={view === 'notices' ? 'active' : ''} onClick={() => navigate('notices')}><ClipboardList size={17} /><span>입찰공고</span></button><button className={view === 'bookmarks' ? 'active' : ''} onClick={() => navigate('bookmarks')}><Bookmark size={17} /><span>관심공고</span>{bookmarks.length > 0 && <span className="nav-count">{bookmarks.length}</span>}</button><button className={view === 'profile' ? 'active' : ''} onClick={() => navigate('profile')}><UserRound size={17} /><span>내 정보</span></button>{mode === 'live' && <button className={view === 'results' ? 'active' : ''} onClick={() => navigate('results')}><FileSearch size={17} /><span>개찰결과</span></button>}</nav>
      <div className="header-account">{mode === 'live' ? <button className="button button-secondary" onClick={() => navigate('profile')}>{member.user ? '내 계정' : '로그인'}</button> : <div className="account-select"><span className="account-avatar">{profile.companyName[0] || '업'}</span><label className="sr-only" htmlFor="demo-profile-switch">테스트 업체 전환</label><select id="demo-profile-switch" value={profile.id} onChange={event => switchProfile(event.target.value)}>{state.profiles.map(item => <option key={item.id} value={item.id}>{item.companyName}</option>)}</select><ChevronDown size={15} /></div>}</div>
    </div></header>

    <main className="main-container">
      {mode === 'demo' && storageWarning && <div className="storage-warning" role="status"><Info size={16} />{storageWarning}<button className="icon-button" onClick={() => setStorageWarning(null)} aria-label="안내 닫기"><X size={15} /></button></div>}
      {mode === 'live' && <div className="live-member-status" role="status">{member.user ? `회원 저장: ${member.saveStatus === 'saved' ? '클라우드 저장 완료' : member.saveStatus === 'saving' ? '저장 중' : member.saveStatus === 'error' ? '저장 실패 — 내 정보에서 재시도' : member.loading ? '불러오는 중' : '준비'}` : '로그인하면 내 업체·관심공고·투찰 준비 기록을 기기 간에 이어서 사용할 수 있습니다.'}</div>}
      {view === 'profile' ? <>{mode === 'live' && <MemberAccess member={member} />}{(mode === 'demo' || member.ready) && <ProfileView key={profile.id} profile={profile} onSave={saveProfile} persistence={mode === 'live' ? 'cloud' : 'browser'} />}</> : view === 'results' ? <PublicResults /> : <>
        <section className="search-intro"><div><div className="eyebrow"><span className="eyebrow-line" />공공입찰을 더 명확하게</div><h1>{view === 'bookmarks' ? '관심공고' : '철거·공사 입찰공고'}</h1><p>{view === 'bookmarks' ? '저장한 공고를 모아보고, 다음 입찰을 준비하세요.' : '우리 업체의 지역조건에 맞는 공고를 한곳에서 확인하세요.'}</p></div><div className="intro-note"><span className="small-dot" />{mode === 'live' ? '나라장터 공공데이터 연동' : '나라장터 공고 · 예시 데이터'}<span className="intro-date">{mode === 'live' ? `한국시간 ${koreanToday().replaceAll('-', '.')}` : `예시 기준일 ${DEMO_TODAY.replaceAll('-', '.')}`}</span></div></section>

        {mode === 'live' && view === 'notices' && <LiveSearch key={`${live.query.type}-${live.query.from}-${live.query.to}-${live.query.keyword}`} query={live.query} loading={live.loading} onSearch={query => { live.setQuery(query); resetFilters(); }} onRefresh={live.refresh} />}
        <form className="search-bar" onSubmit={event => { event.preventDefault(); updateFilter('keyword', searchInput.trim()); }}><Search size={23} strokeWidth={1.7} /><label className="sr-only" htmlFor="bid-search">공고 검색</label><input id="bid-search" value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder={mode === 'live' ? '불러온 공고에서 공고명·번호·발주기관 검색' : '공고명, 공고번호, 발주기관을 검색해 보세요'} autoComplete="off" /><span className="search-shortcut">{mode === 'live' ? '불러온 공고 검색' : '공고 통합검색'}</span>{searchInput && <button type="button" className="icon-button" aria-label="검색어 지우기" onClick={() => { setSearchInput(''); updateFilter('keyword', ''); }}><X size={17} /></button>}<button className="button button-primary search-submit" type="submit">검색<ArrowRight size={18} /></button></form>

        <div className="category-tabs" aria-label="작업 분야">{(['전체', ...CATEGORIES] as const).map(category => <button key={category} className={filters.category === category ? 'active' : ''} onClick={() => updateFilter('category', category)}>{category}</button>)}</div>

        <section className="company-strip" aria-label="내 업체 지역 자동필터"><div className="company-strip-info"><span className="company-icon"><Building2 size={20} /></span><div><div className="company-name">{profile.companyName || '업체 정보 미등록'}<span>내 업체</span></div><div className="company-address"><MapPin size={12} />본점 {profile.province} {profile.district}</div></div><button className="company-edit" aria-label="업체 정보 수정" onClick={() => navigate('profile')}><Settings2 size={14} /><span>업체 정보 수정</span></button></div><div className="auto-filter-control"><div><label className="switch-label"><input type="checkbox" checked={filters.autoRegion} onChange={event => { updateFilter('autoRegion', event.target.checked); updateFilter('regionView', 'all'); }} /><span className="switch-track" /><strong>내 지역 조건에 맞는 공고</strong></label><p>{filters.autoRegion ? '지역 불일치는 제외하고, 확인이 필요한 공고는 함께 표시합니다.' : '지역조건에 관계없이 모든 공고를 표시하고 있습니다.'}</p></div><span className="filter-state">{filters.autoRegion ? '자동필터 ON' : '자동필터 OFF'}</span></div></section>

        <div className={`search-workspace ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          {(!sidebarCollapsed || mobileFilters) && <FilterPanel filters={filters} onChange={updateFilter} onReset={resetFilters} onCollapse={() => { setSidebarCollapsed(true); setMobileFilters(false); }} mobileOpen={mobileFilters} onMobileClose={() => setMobileFilters(false)} />}
          <section className="results-panel panel" aria-label="입찰공고 검색 결과">
            {mode === 'live' && view === 'notices' && <div className="live-scope"><strong>{live.query.type} · {live.query.from} ~ {live.query.to}{live.query.keyword && ` · 공고명: ${live.query.keyword}`}</strong><p>원본 {live.meta?.totalCount.toLocaleString('ko-KR') ?? '—'}건 중 {live.items.length.toLocaleString('ko-KR')}건 불러옴 · 아래 조건과 내보내기는 불러온 공고에 적용됩니다.</p>{live.meta && <p>최근 조회 {formatDateTime(live.meta.fetchedAt)} · 첫 100건은 화면을 보는 동안 5분마다 갱신합니다.</p>}{live.loading && <p role="status">나라장터 공고를 불러오는 중입니다.</p>}{live.error && <p className="live-error" role="alert">{live.error}<button className="text-button" onClick={live.refresh}>다시 조회</button></p>}{live.meta?.warnings?.map(warning => <p className="live-warning" key={warning}>{warning}</p>)}</div>}{mode === 'live' && view === 'bookmarks' && <p className="live-scope">저장 시점의 공고와 현재 조회 자료를 표시합니다. 정정·취소와 최신 참가조건은 나라장터 원문에서 확인하세요.</p>}
            <div className="results-toolbar"><div className="results-heading-group"><button className="button button-secondary show-filter-button" aria-label="상세 검색 열기" onClick={() => { if (window.matchMedia('(max-width: 1000px)').matches) setMobileFilters(true); else setSidebarCollapsed(false); }}><PanelLeftOpen size={16} /><span>상세 검색</span></button><h2>{view === 'bookmarks' ? '저장한 공고' : '검색 결과'} <strong>{filtered.length}</strong><span>건</span></h2></div><div className="results-actions"><ExportButton onExport={exportResults} /><label className="sr-only" htmlFor="sort-order">공고 정렬</label><select id="sort-order" className="sort-select" value={filters.sort} onChange={event => updateFilter('sort', event.target.value as SearchFilters['sort'])}><option value="deadline">마감 임박순</option><option value="newest">최신 공고순</option><option value="amountDesc">추정가격 높은순</option><option value="amountAsc">추정가격 낮은순</option></select></div></div>
            <div className="result-filter-line"><div className="result-state-tabs" aria-label="지역 판정 필터"><button className={filters.regionView === 'all' ? 'active' : ''} onClick={() => updateFilter('regionView', 'all')}>전체 <span>{allCount}</span></button><button className={filters.regionView === 'matched' ? 'active' : ''} onClick={() => updateFilter('regionView', 'matched')}><span className="state-dot green" />지역 일치 <span>{counts.matched}</span></button><button className={filters.regionView === 'review' ? 'active' : ''} onClick={() => updateFilter('regionView', 'review')}><span className="state-dot amber" />확인 필요 <span>{counts.review}</span></button></div><button className={`excluded-button ${filters.regionView === 'excluded' ? 'active' : ''}`} onClick={() => updateFilter('regionView', filters.regionView === 'excluded' ? 'all' : 'excluded')}>{filters.regionView === 'excluded' ? '기본 목록으로 돌아가기' : `지역 제외 ${counts.excluded}건 보기`}<ChevronRight size={13} /></button></div>
            <div className="chips-line"><div className="filter-chips">{chips.map(chip => <button key={chip.label} onClick={chip.remove}>{chip.label}<X size={12} /></button>)}{filters.autoRegion && <span className="automatic-chip"><ShieldCheck size={13} />내 지역 자동필터</span>}{chips.length === 0 && !filters.autoRegion && <span className="muted">모든 조건의 공고를 표시합니다.</span>}</div><button className="text-button reset-results" onClick={resetFilters}>조건 초기화</button></div>
            {filters.regionView === 'excluded' && <div className="excluded-notice"><Info size={15} />등록한 업체 소재지와 지역조건이 맞지 않는 공고입니다. 공고 상세에서 제외 사유를 확인할 수 있습니다.</div>}

            {visibleNotices.length > 0 ? <>
              <div className="bid-table-wrap"><table className="bid-table"><thead><tr><th className="bookmark-column"><Star size={16} aria-label="관심공고" /></th><th className="title-column">공고명 / 발주기관</th><th>공사 위치</th><th>참가 가능 지역</th><th>지역 판정</th><th>계약방법</th><th className="price-column">추정가격</th><th className="deadline-column">제출 마감</th><th className="detail-column"><span className="sr-only">상세</span></th></tr></thead><tbody>{visibleNotices.map(bid => { const region = assessRegion(bid, profile); const saved = bookmarks.includes(bid.id); return <tr key={bid.id} onClick={() => setSelectedBid(bid)}><td className="bookmark-column"><button className={`icon-button bookmark-button ${saved ? 'saved' : ''}`} aria-label={`${bid.title} ${saved ? '관심공고 해제' : '관심공고 저장'}`} aria-pressed={saved} onClick={event => { event.stopPropagation(); toggleBookmark(bid.id); }}><Star size={18} fill={saved ? 'currentColor' : 'none'} strokeWidth={1.6} /></button></td><td className="title-cell"><div className="bid-title-line"><span className={`bid-status status-${bid.status}`}>{bid.status}</span>{bid.revised && <span className="amendment-badge">정정</span>}<span className="bid-kind">{bid.type}</span>{mode === 'live' && member.workspace?.preparations[bid.id] && <span className="preparation-chip">{member.workspace.preparations[bid.id].stage}</span>}</div><button className="bid-title" onClick={event => { event.stopPropagation(); setSelectedBid(bid); }}>{bid.title}</button><div className="bid-agency">{bid.agency}<span>·</span>{bid.number}</div></td><td><div className="table-region"><span>{SHORT_PROVINCES[bid.province] ?? bid.province}</span><span>{bid.district}</span></div></td><td><span className={`allowed-region ${!bid.allowedRegions?.length ? 'muted' : ''}`}>{bid.allowedRegions?.map(area => SHORT_PROVINCES[area] ?? area).join(' · ') || '원문 확인'}</span></td><td><span className={`badge ${region.status === 'matched' ? 'badge-green' : region.status === 'review' ? 'badge-amber' : 'badge-gray'}`} title={region.reason}>{region.status === 'matched' && <Check size={11} />}{REGION_LABELS[region.status]}</span></td><td><span className="contract-method">{bid.contractMethod}</span></td><td className={`price-cell ${bid.estimatedPrice === null ? 'price-missing' : ''}`}><strong>{formatPrice(bid.estimatedPrice)}</strong></td><td><Deadline bid={bid} /></td><td className="detail-column"><button className="icon-button row-detail" aria-label={`${bid.title} 상세보기`} onClick={event => { event.stopPropagation(); setSelectedBid(bid); }}><ChevronRight size={17} /></button></td></tr>; })}</tbody></table></div>
              <div className="bid-mobile-list">{visibleNotices.map(bid => { const region = assessRegion(bid, profile); const saved = bookmarks.includes(bid.id); return <article className="bid-mobile-card" key={bid.id}><div className="mobile-card-top"><div><span className={`bid-status status-${bid.status}`}>{bid.status}</span>{bid.revised && <span className="amendment-badge">정정</span>}<span className={`badge ${region.status === 'matched' ? 'badge-green' : region.status === 'review' ? 'badge-amber' : 'badge-gray'}`}>{REGION_LABELS[region.status]}</span>{mode === 'live' && member.workspace?.preparations[bid.id] && <span className="preparation-chip">{member.workspace.preparations[bid.id].stage}</span>}</div><button className={`icon-button bookmark-button ${saved ? 'saved' : ''}`} aria-label={`${bid.title} ${saved ? '관심공고 해제' : '관심공고 저장'}`} aria-pressed={saved} onClick={() => toggleBookmark(bid.id)}><Star size={19} fill={saved ? 'currentColor' : 'none'} /></button></div><button className="mobile-bid-title" onClick={() => setSelectedBid(bid)}>{bid.title}</button><p className="mobile-agency">{bid.agency}</p><div className="mobile-bid-meta"><span>공사 위치 <strong>{SHORT_PROVINCES[bid.province] ?? bid.province} {bid.district}</strong></span><span>참가 지역 <strong>{bid.allowedRegions?.map(area => SHORT_PROVINCES[area] ?? area).join(' · ') || '원문 확인'}</strong></span><span>계약방법 <strong>{bid.contractMethod}</strong></span></div><div className="mobile-card-bottom"><div><span>추정가격</span><strong>{formatPrice(bid.estimatedPrice)}</strong></div><Deadline bid={bid} /></div><button className="mobile-detail-button" onClick={() => setSelectedBid(bid)}>공고 상세보기<ArrowRight size={15} /></button></article>; })}</div>
            </> : <div className="empty-state"><div className="empty-icon">{view === 'bookmarks' && bookmarks.length === 0 ? <Bookmark size={30} /> : <FileSearch size={32} />}</div><h3>{mode === 'live' && live.loading ? '공고를 불러오는 중입니다' : mode === 'live' && live.error && view === 'notices' ? '나라장터 연결을 확인해 주세요' : view === 'bookmarks' && bookmarks.length === 0 ? '아직 저장한 관심공고가 없습니다' : '조건에 맞는 공고가 없습니다'}</h3><p>{view === 'bookmarks' && bookmarks.length === 0 ? '공고 옆 별표를 누르면 이 업체의 관심공고에 저장됩니다.' : '검색어를 바꾸거나 선택한 조건을 조금 넓혀보세요.'}</p><button className="button button-primary" onClick={view === 'bookmarks' && bookmarks.length === 0 ? () => navigate('notices') : resetFilters}>{view === 'bookmarks' && bookmarks.length === 0 ? '입찰공고 둘러보기' : '검색 조건 초기화'}<ArrowRight size={16} /></button></div>}

            {filtered.length > 0 && <div className="results-bottom"><span className="result-range">전체 {filtered.length}건 중 {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)}건</span><nav className="pagination" aria-label="검색 결과 페이지"><button aria-label="이전 페이지" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}><ChevronLeft size={15} /></button>{Array.from({ length: pages }, (_, index) => index + 1).map(number => <button key={number} aria-label={`${number}페이지`} aria-current={safePage === number ? 'page' : undefined} className={safePage === number ? 'active' : ''} onClick={() => setPage(number)}>{number}</button>)}<button aria-label="다음 페이지" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}><ChevronRight size={15} /></button></nav><span className="page-size-label">8개씩 보기</span></div>}
            {mode === 'live' && view === 'notices' && live.meta?.hasMore && <button className="button button-secondary live-more" disabled={live.loading} onClick={live.loadMore}>나라장터 공고 100건 더 불러오기</button>}
          </section>
        </div>
        <div className="notice-guidance"><Info size={15} /><span>지역 일치는 소재지 조건만 비교한 결과입니다. 면허·실적·공동수급 등 전체 참가자격은 공고 상세와 원문을 확인하세요.</span></div>
      </>}
      <footer className="app-footer"><div><span className="footer-brand">공사입찰 검색</span><span>내 업체에 맞는 공고, 더 간편하게.</span></div><div className="footer-links"><span>{mode === 'live' ? '공개 공고·결과 조회 및 회원별 입찰 준비 관리' : '화면·공고·업체 정보는 테스트용 예시입니다.'}</span><a href="https://www.g2b.go.kr" target="_blank" rel="noreferrer">나라장터<ExternalLink size={12} /></a></div></footer>
    </main>
    {selectedBid && <BidDetail bid={selectedBid} profile={profile} assessment={assessRegion(selectedBid, profile)} isBookmarked={bookmarks.includes(selectedBid.id)} onClose={() => setSelectedBid(null)} onToggleBookmark={() => toggleBookmark(selectedBid.id)} onEnriched={detail => applyNoticeDetail(selectedBid.id, detail)} preparation={mode === 'live' ? <BidPreparation bidId={selectedBid.id} bid={selectedBid} member={member} /> : undefined} />}
    <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite">{toast && <><span><Check size={15} /></span>{toast}</>}</div>
  </div>;
}
