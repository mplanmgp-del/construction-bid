import { NoticeList } from './components/NoticeList';
import { pageGroup } from './pagination';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Bookmark, Building2, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ClipboardList, ExternalLink, FileSearch, Info, MapPin, PanelLeftOpen, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Star, UserRound, X } from 'lucide-react';
import { CATEGORIES, type BidNotice, type CompanyProfile, type SearchFilters } from './types';
import { DEFAULT_FILTERS, DEMO_PROFILES, DEMO_TODAY, NOTICES } from './data';
import { assessRegion, assessSearchRegion, buildBidCsv, daysUntil, filterNotices, formatAmountInput, formatDateTime, formatPrice } from './domain';
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
import { useNoticeRegions } from './live/useNoticeRegions';
import { LiveSearch } from './live/LiveSearch';
import { CompanyDashboard } from './company/CompanyDashboard';
import { currentNotice, koreanToday, mergeById } from './live/client';

type View = 'notices' | 'bookmarks' | 'profile' | 'results';
const PAGE_SIZE = 30;

function saveDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}


export default function App() {
  const [mode, setMode] = useState<'live' | 'demo'>('live');
  const member = useMemberWorkspace();
  const [view, setView] = useState<View>(() => window.location.hash === '#my-bids' ? 'results' : 'notices');
  const live = useLiveNotices(mode === 'live' && (view === 'notices' || view === 'bookmarks'));
  const [loaded] = useState(() => loadPrototypeState(DEMO_PROFILES));
  const [state, setState] = useState<PrototypeState>(loaded.state);
  const [storageWarning, setStorageWarning] = useState(loaded.warning);
  const guestProfile: CompanyProfile = { id: 'guest', companyName: '업체 정보 미등록', province: '', district: '', address: '', licenses: [], contactName: '', email: '' };
  const profile = mode === 'live' ? member.workspace?.profile ?? guestProfile : state.profiles.find(item => item.id === state.activeProfileId) ?? state.profiles[0];
  const [filters, setFilters] = useState<SearchFilters>(() => ({ ...DEFAULT_FILTERS, category: '전체', status: '전체', autoRegion: false }));
  const [searchInput, setSearchInput] = useState(live.query.keyword);
  const [page, setPage] = useState(1);
  const [selectedNoticeIds, setSelectedNoticeIds] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileFilters, setMobileFilters] = useState(false);
  const [selectedBid, setSelectedBid] = useState<BidNotice | null>(null);
  const [toast, setToast] = useState('');
  const [statusNow, setStatusNow] = useState(() => Date.now());
  const noticeFiltersRef = useRef(filters);
  const bookmarks = mode === 'live' ? member.workspace?.bookmarks ?? [] : state.bookmarks[profile.id] ?? [];
  const availableNotices = mode === 'live' ? live.items : NOTICES;

  // Update schedule labels locally; no new notice search or provider request is needed.
  useEffect(() => {
    const update = () => setStatusNow(Date.now());
    const timer = window.setInterval(update, 60_000);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, []);

  // Region filtering is opt-in for each visit, including accounts with an older saved ON preference.
  useEffect(() => { setSelectedNoticeIds([]); setSelectedBid(null); setPage(1); noticeFiltersRef.current = { ...noticeFiltersRef.current, autoRegion: false, regionView: 'all' }; setFilters(previous => ({ ...previous, autoRegion: false, regionView: 'all' })); }, [member.user?.id, mode]);
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
  }

  function resetFilters() {
    setFilters({ ...DEFAULT_FILTERS, ...(mode === 'live' || view === 'bookmarks' ? { category: '전체', status: '전체' } : {}), autoRegion: false });
    setSearchInput(''); setPage(1);
  }

  function searchLocalNotices(keyword: string) {
    updateFilter('keyword', keyword.trim());
  }

  function navigate(next: View) {
    if (view === next) return;
    setSelectedBid(null); setMobileFilters(false); setPage(1);
    if (next === 'bookmarks') { setFilters({ ...DEFAULT_FILTERS, category: '전체', status: '전체', autoRegion: false }); setSearchInput(''); }
    if (next === 'notices') { const saved = noticeFiltersRef.current; setFilters(saved); setSearchInput(mode === 'live' ? live.query.keyword : saved.keyword); }
    setView(next);
  }

  function switchProfile(id: string) {
    persist({ ...state, activeProfileId: id }); setSelectedBid(null); setPage(1);
    setFilters(previous => ({ ...previous, autoRegion: false, regionView: 'all' }));
    setToast('테스트 업체를 전환했습니다. 업체 정보와 관심공고를 각각 확인해 보세요.');
  }

  function toggleBookmark(id: string) {
    const exists = bookmarks.includes(id);
    if (mode === 'live') {
      if (!member.ready) { setView('profile'); setToast('로그인 후 관심공고를 회원별로 저장할 수 있습니다.'); return; }
      const bid = sourceNotices.find(item => item.id === id) ?? selectedBid ?? member.workspace?.noticeSnapshots[id];
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

  const rawSourceNotices = useMemo(() => view === 'bookmarks'
    ? mergeById(mode === 'live' ? Object.values(member.workspace?.noticeSnapshots ?? {}).map(bid => currentNotice(bid)) : [], availableNotices).filter(bid => bookmarks.includes(bid.id))
    : availableNotices, [view, mode, member.workspace?.noticeSnapshots, availableNotices, bookmarks]);
  const regionCandidates = useMemo(() => filterNotices(rawSourceNotices,
    { ...filters, siteProvince: '전체', autoRegion: false, regionView: 'all' }, profile, statusNow), [rawSourceNotices, filters, profile, statusNow]);
  const companyRegionFilter = !!profile.province && !!profile.district && (filters.autoRegion || filters.regionView !== 'all');
  const regionFilterEnabled = mode === 'live' && (view === 'notices' || view === 'bookmarks')
    && (companyRegionFilter || (filters.type !== '공사' && filters.siteProvince !== '전체'));
  const regionSearch = useNoticeRegions(regionCandidates, regionFilterEnabled, companyRegionFilter);
  const sourceNotices = regionSearch.items;
  const baseResults = useMemo(() => filterNotices(sourceNotices, { ...filters, autoRegion: false, regionView: 'all' }, profile, statusNow), [sourceNotices, filters, profile, statusNow]);
  const counts = useMemo(() => baseResults.reduce((total, bid) => { total[assessRegion(bid, profile).status]++; return total; }, { matched: 0, review: 0, excluded: 0 }), [baseResults, profile]);
  const filtered = useMemo(() => filterNotices(sourceNotices, filters, profile, statusNow), [sourceNotices, filters, profile, statusNow]);
  const unknownServiceRegions = filters.siteProvince === '전체' ? 0
    : filtered.filter(bid => bid.type === '용역' && assessSearchRegion(bid, filters.siteProvince).status === 'review').length;
  const unknownParticipationRegions = companyRegionFilter
    ? sourceNotices.filter(bid => bid.source === 'live' && !bid.allowedRegions?.length).length : unknownServiceRegions;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const pagination = pageGroup(safePage, pages);
  const visibleNotices = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const allCount = filters.autoRegion ? counts.matched : baseResults.length;
  const selectedNotices = filtered.filter(bid => selectedNoticeIds.includes(bid.id));
  const exportNotices = selectedNotices.length ? selectedNotices : filtered;

  async function exportResults(format: ExportFormat) {
    try {
      if (format === 'csv') {
        saveDownload(new Blob([buildBidCsv(exportNotices)], { type: 'text/csv;charset=utf-8' }), mode === 'live' ? '입찰공고_목록.csv' : '입찰공고_예시목록.csv');
      } else {
        const { buildBidWorkbook, getExcelFilename } = await import('./excel-export');
        const generatedAt = new Date();
        const workbook = buildBidWorkbook(exportNotices, profile, generatedAt, mode);
        const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
        saveDownload(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), getExcelFilename(generatedAt));
      }
      setToast(`${selectedNotices.length ? '선택한 공고' : '현재 검색 결과'} ${exportNotices.length}건을 ${format === 'xlsx' ? '서식이 적용된 엑셀' : 'CSV'} 파일로 다운로드했습니다.`);
    } catch {
      setToast('다운로드 파일을 만들지 못했습니다. 다시 시도해 주세요.');
    }
  }

  const chips: { label: string; remove: () => void }[] = [];
  if (filters.category !== '전체') chips.push({ label: filters.category, remove: () => updateFilter('category', '전체') });
  if (filters.keyword) chips.push({ label: `검색: ${filters.keyword}`, remove: () => { updateFilter('keyword', ''); setSearchInput(''); } });
  if (filters.type !== '전체') chips.push({ label: filters.type, remove: () => updateFilter('type', '전체') });
  if (filters.siteProvince !== '전체') chips.push({ label: `지역: ${filters.siteProvince}`, remove: () => updateFilter('siteProvince', '전체') });
  if (filters.status !== '전체') chips.push({ label: filters.status, remove: () => updateFilter('status', '전체') });
  if (filters.license !== '전체') chips.push({ label: filters.license, remove: () => updateFilter('license', '전체') });
  if (filters.contractMethod !== '전체') chips.push({ label: filters.contractMethod, remove: () => updateFilter('contractMethod', '전체') });
  if (filters.minAmount || filters.maxAmount) chips.push({ label: `추정가격 ${filters.minAmount ? formatAmountInput(filters.minAmount) : '0'} ~ ${filters.maxAmount ? formatAmountInput(filters.maxAmount) + '원' : '전체'}`, remove: () => { updateFilter('minAmount', ''); updateFilter('maxAmount', ''); } });
  if (filters.deadlineFrom || filters.deadlineTo) chips.push({ label: `마감 ${filters.deadlineFrom || '시작'} ~ ${filters.deadlineTo || '전체'}`, remove: () => { updateFilter('deadlineFrom', ''); updateFilter('deadlineTo', ''); } });
  if (filters.excludeKeyword) chips.push({ label: `제외: ${filters.excludeKeyword}`, remove: () => updateFilter('excludeKeyword', '') });

  return <div className="app-shell">
    <header className="app-header"><div className="header-inner">
      <button className="brand" onClick={() => navigate('notices')} aria-label="공사입찰 검색 홈"><span className="brand-mark"><span /><span /><span /></span><span>공사입찰 <b>검색</b></span></button>
      <nav className="main-nav" aria-label="주 메뉴"><button className={view === 'notices' ? 'active' : ''} onClick={() => navigate('notices')}><ClipboardList size={17} /><span>입찰공고</span></button><button className={view === 'bookmarks' ? 'active' : ''} onClick={() => navigate('bookmarks')}><Bookmark size={17} /><span>관심공고</span>{bookmarks.length > 0 && <span className="nav-count">{bookmarks.length}</span>}</button><button className={view === 'profile' ? 'active' : ''} onClick={() => navigate('profile')}><UserRound size={17} /><span>내 정보</span></button>{mode === 'live' && <button className={view === 'results' ? 'active' : ''} onClick={() => navigate('results')}><FileSearch size={17} /><span>MY입찰관리</span></button>}</nav>
      <div className="header-account">{mode === 'live' ? <button className="button button-secondary" onClick={() => navigate('profile')}>{member.user ? '내 계정' : '로그인'}</button> : <div className="account-select"><span className="account-avatar">{profile.companyName[0] || '업'}</span><label className="sr-only" htmlFor="demo-profile-switch">테스트 업체 전환</label><select id="demo-profile-switch" value={profile.id} onChange={event => switchProfile(event.target.value)}>{state.profiles.map(item => <option key={item.id} value={item.id}>{item.companyName}</option>)}</select><ChevronDown size={15} /></div>}</div>
    </div></header>

    <main className="main-container">
      {mode === 'demo' && storageWarning && <div className="storage-warning" role="status"><Info size={16} />{storageWarning}<button className="icon-button" onClick={() => setStorageWarning(null)} aria-label="안내 닫기"><X size={15} /></button></div>}
      {mode === 'live' && <div className="live-member-status" role="status">{member.user ? `회원 저장: ${member.saveStatus === 'saved' ? '클라우드 저장 완료' : member.saveStatus === 'saving' ? '저장 중' : member.saveStatus === 'error' ? '저장 실패 — 내 정보에서 재시도' : member.loading ? '불러오는 중' : '준비'}` : '로그인하면 내 업체·관심공고·투찰 준비 기록을 기기 간에 이어서 사용할 수 있습니다.'}</div>}
      {view === 'profile' ? <>{mode === 'live' && <MemberAccess member={member} />}{(mode === 'demo' || member.ready) && <ProfileView key={profile.id} profile={profile} onSave={saveProfile} persistence={mode === 'live' ? 'cloud' : 'browser'} />}</> : view === 'results' ? <CompanyDashboard key={profile.id} profile={profile} onProfile={() => navigate('profile')} /> : <>
        <section className="search-intro"><div><div className="eyebrow"><span className="eyebrow-line" />공공입찰을 더 명확하게</div><h1>{view === 'bookmarks' ? '관심공고' : '철거·공사 입찰공고'}</h1><p>{view === 'bookmarks' ? '저장한 공고를 모아보고, 다음 입찰을 준비하세요.' : '우리 업체의 지역조건에 맞는 공고를 한곳에서 확인하세요.'}</p></div><div className="intro-note"><span className="small-dot" />{mode === 'live' ? '나라장터 공공데이터 연동' : '나라장터 공고 · 예시 데이터'}<span className="intro-date">{mode === 'live' ? `한국시간 ${koreanToday().replaceAll('-', '.')}` : `예시 기준일 ${DEMO_TODAY.replaceAll('-', '.')}`}</span></div></section>

        <section className="company-strip" aria-label="내 업체 지역 자동필터"><div className="company-strip-info"><span className="company-icon"><Building2 size={20} /></span><div><div className="company-name">{profile.companyName || '업체 정보 미등록'}<span>내 업체</span></div><div className="company-address"><MapPin size={12} />본점 {profile.province} {profile.district}</div></div><button className="company-edit" aria-label="업체 정보 수정" onClick={() => navigate('profile')}><Settings2 size={14} /><span>업체 정보 수정</span></button></div><div className="auto-filter-control"><div><label className="switch-label"><input type="checkbox" checked={filters.autoRegion} onChange={event => { updateFilter('autoRegion', event.target.checked); updateFilter('regionView', 'all'); }} /><span className="switch-track" /><strong>내 지역 조건에 맞는 공고</strong></label><p>{filters.autoRegion ? '내 업체 지역과 일치하거나 전국인 공고만 표시합니다. 미확인 공고는 자동필터를 끄고 원문을 확인해 주세요.' : '지역조건에 관계없이 모든 공고를 표시하고 있습니다.'}</p></div><span className="filter-state">{filters.autoRegion ? '자동필터 ON' : '자동필터 OFF'}</span></div></section>

        <div className={`search-workspace ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          {(!sidebarCollapsed || mobileFilters) && <FilterPanel filters={filters} onChange={updateFilter} onReset={resetFilters} onCollapse={() => { setSidebarCollapsed(true); setMobileFilters(false); }} mobileOpen={mobileFilters} onMobileClose={() => setMobileFilters(false)} />}
          <section className="results-panel panel" aria-label="입찰공고 검색 결과">
            <div className="results-search-controls">
        {mode === 'live' && view === 'notices' && <LiveSearch key={`${live.query.type}-${live.query.from}-${live.query.to}-${live.query.keyword}`} query={live.query} loading={live.loading || live.refreshing} refreshBlocked={live.retryAt > Date.now()} onSearch={query => { live.search(query); resetFilters(); setSearchInput(query.keyword); }} onRefresh={live.refresh} />}
        {!(mode === 'live' && view === 'notices') && <form className="search-bar" onSubmit={event => { event.preventDefault(); searchLocalNotices(searchInput); }}><Search size={23} strokeWidth={1.7} /><label className="sr-only" htmlFor="bid-search">공고 검색</label><input id="bid-search" value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="공고명, 공고번호, 발주기관을 검색해 보세요" autoComplete="off" /><span className="search-shortcut">목록 검색</span>{searchInput && <button type="button" className="icon-button" aria-label="검색어 지우기" onClick={() => { setSearchInput(''); searchLocalNotices(''); }}><X size={17} /></button>}<button className="button button-primary search-submit" type="submit">검색<ArrowRight size={18} /></button></form>}

        <div className="category-tabs" aria-label="작업 분야">{(['전체', ...CATEGORIES] as const).map(category => <button key={category} className={filters.category === category ? 'active' : ''} onClick={() => updateFilter('category', category)}>{category}</button>)}</div>

            </div>
            {mode === 'live' && view === 'notices' && <div className="live-scope">{live.loading && <p role="status">전체 공고를 자동 조회 중입니다. ({live.progress.done}/{live.progress.total}구간 완료)</p>}{live.refreshing && <p role="status">저장된 전체 결과를 먼저 표시하고 최신 공고를 확인 중입니다.</p>}{live.error && <p className="live-error" role="alert">{live.error}</p>}{live.meta?.warnings?.map(warning => <p className="live-warning" key={warning}>{warning}</p>)}</div>}{mode === 'live' && view === 'bookmarks' && <p className="live-scope">저장 시점의 공고와 현재 조회 자료를 표시합니다. 정정·취소와 최신 참가조건은 나라장터 원문에서 확인하세요.</p>}
            <div className="results-toolbar"><div className="results-heading-group"><button className="button button-secondary show-filter-button" aria-label="상세 검색 열기" onClick={() => { if (window.matchMedia('(max-width: 1000px)').matches) setMobileFilters(true); else setSidebarCollapsed(false); }}><PanelLeftOpen size={16} /><span>상세 검색</span></button><h2>{view === 'bookmarks' ? '저장한 공고' : '검색 결과'} <strong>{filtered.length}</strong><span>건</span></h2></div><div className="results-actions"><ExportButton onExport={exportResults} /><label className="sr-only" htmlFor="sort-order">공고 정렬</label><select id="sort-order" className="sort-select" value={filters.sort} onChange={event => updateFilter('sort', event.target.value as SearchFilters['sort'])}><option value="deadline">마감 임박순</option><option value="newest">최신 공고순</option><option value="amountDesc">추정가격 높은순</option><option value="amountAsc">추정가격 낮은순</option></select></div></div>
            <div className="result-filter-line"><div className="result-state-tabs" aria-label="지역 판정 필터"><button className={filters.regionView === 'all' ? 'active' : ''} onClick={() => updateFilter('regionView', 'all')}>전체 <span>{allCount}</span></button></div><button className={`excluded-button ${filters.regionView === 'excluded' ? 'active' : ''}`} onClick={() => updateFilter('regionView', filters.regionView === 'excluded' ? 'all' : 'excluded')}>{filters.regionView === 'excluded' ? '기본 목록으로 돌아가기' : `지역 제외 ${counts.excluded}건 보기`}<ChevronRight size={13} /></button></div>
            <div className="chips-line"><div className="filter-chips">{chips.map(chip => <button key={chip.label} onClick={chip.remove}>{chip.label}<X size={12} /></button>)}{filters.autoRegion && <span className="automatic-chip"><ShieldCheck size={13} />내 지역 자동필터</span>}{chips.length === 0 && !filters.autoRegion && <span className="muted">모든 조건의 공고를 표시합니다.</span>}</div><button className="text-button reset-results" onClick={resetFilters}>조건 초기화</button></div>
            {filters.regionView === 'excluded' && <div className="excluded-notice"><Info size={15} />등록한 업체 소재지와 지역조건이 맞지 않는 공고입니다. 공고 상세에서 제외 사유를 확인할 수 있습니다.</div>}
            {(filters.siteProvince !== '전체' || companyRegionFilter) && <div className="region-search-note" role="status">
              <div><strong>{filters.siteProvince !== '전체' ? `${filters.siteProvince} 지역 검색` : '내 업체 참가 가능 지역 확인'}</strong><span>{companyRegionFilter ? '내 업체 소재지와 공고의 참가 가능 지역을 비교합니다.' : '공사: 현장 위치 · 용역: 참가 가능 지역'}</span>
                {regionSearch.loading ? <p>참가 가능 지역을 확인 중입니다. {regionSearch.pending}건 남음</p>
                  : companyRegionFilter && unknownParticipationRegions > 0 ? <p>지역 미확인 공고 {unknownParticipationRegions}건은 자동필터를 끄고 확인할 수 있습니다.</p>
                    : unknownServiceRegions > 0 ? <p>지역 미확인 용역 {unknownServiceRegions}건을 함께 표시합니다. 참가 가능으로 확정된 공고는 아닙니다.</p> : null}
                {regionSearch.failed > 0 && <p>일부 지역 정보를 불러오지 못했습니다. 미확인 공고는 원문을 확인해 주세요.</p>}
              </div>
              {(regionSearch.failed > 0 || unknownParticipationRegions > 0) && <button className="button button-secondary" onClick={regionSearch.retry} disabled={regionSearch.loading || regionSearch.retryAt > Date.now()}>{regionSearch.retryAt > Date.now() ? '잠시 후 재조회' : '지역 다시 조회'}</button>}
            </div>}

            {(visibleNotices.length > 0 || filters.status !== '전체') && <>
              {selectedNotices.length > 0 && <div className="selection-summary"><span>{selectedNotices.length}건 선택 · 다운로드 시 선택한 공고를 내보냅니다.</span><button onClick={() => setSelectedNoticeIds([])}>선택 해제</button></div>}
              <NoticeList bids={visibleNotices} now={statusNow} status={filters.status} onStatusChange={value => updateFilter('status', value)} searchProvince={filters.siteProvince} resultsPaused={regionSearch.loading} keyword={[filters.keyword, mode === 'live' && view === 'notices' ? live.query.keyword : ''].filter(Boolean).join(' ')} profile={profile} bookmarks={bookmarks} selected={selectedNoticeIds} onSelect={setSelectedNoticeIds} onOpen={setSelectedBid} onBookmark={toggleBookmark} />
            </>}
            {visibleNotices.length === 0 && <div className="empty-state"><div className="empty-icon">{view === 'bookmarks' && bookmarks.length === 0 ? <Bookmark size={30} /> : <FileSearch size={32} />}</div><h3>{mode === 'live' && view === 'notices' && live.requiresKeyword ? '검색할 공고명을 입력해 주세요' : mode === 'live' && live.loading ? '공고를 불러오는 중입니다' : mode === 'live' && live.error && view === 'notices' ? '현재 조건의 공고를 조회하지 못했습니다' : view === 'bookmarks' && bookmarks.length === 0 ? '아직 저장한 관심공고가 없습니다' : '조건에 맞는 공고가 없습니다'}</h3><p>{mode === 'live' && view === 'notices' && live.requiresKeyword ? '위 검색창에 철거·석면 등 공고명을 입력해 주세요.' : mode === 'live' && view === 'notices' && live.error ? '조회 상태는 위 안내에서 확인할 수 있습니다.' : view === 'bookmarks' && bookmarks.length === 0 ? '공고 옆 별표를 누르면 이 업체의 관심공고에 저장됩니다.' : '검색어를 바꾸거나 선택한 조건을 조금 넓혀보세요.'}</p><button className="button button-primary" onClick={view === 'bookmarks' && bookmarks.length === 0 ? () => navigate('notices') : resetFilters}>{view === 'bookmarks' && bookmarks.length === 0 ? '입찰공고 둘러보기' : '검색 조건 초기화'}<ArrowRight size={16} /></button></div>}

            {filtered.length > 0 && <div className="results-bottom"><span className="result-range">검색 결과 {filtered.length}건 중 {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)}건</span><nav className="pagination" aria-label="검색 결과 페이지"><button aria-label="이전 10페이지" disabled={pagination.previous === null} onClick={() => pagination.previous !== null && setPage(pagination.previous)}><ChevronLeft size={15} /></button><div className="pagination-numbers">{pagination.items.map(number => <button key={number} aria-label={`${number}페이지`} aria-current={safePage === number ? 'page' : undefined} className={safePage === number ? 'active' : ''} onClick={() => setPage(number)}>{number}</button>)}</div><button aria-label="다음 10페이지" disabled={pagination.next === null} onClick={() => pagination.next !== null && setPage(pagination.next)}><ChevronRight size={15} /></button></nav><span className="page-size-label">30개씩 보기</span></div>}

          </section>
        </div>
        <div className="notice-guidance"><Info size={15} /><span>지역 일치는 소재지 조건만 비교한 결과입니다. 면허·실적·공동수급 등 전체 참가자격은 공고 상세와 원문을 확인하세요.</span></div>
      </>}
      <footer className="app-footer"><div><span className="footer-brand">공사입찰 검색</span><span>내 업체에 맞는 공고, 더 간편하게.</span></div><div className="footer-links"><span>{mode === 'live' ? '공개 공고·결과 조회 및 회원별 입찰 준비 관리' : '화면·공고·업체 정보는 테스트용 예시입니다.'}</span><a href="https://www.g2b.go.kr" target="_blank" rel="noreferrer">나라장터<ExternalLink size={12} /></a></div></footer>
    </main>
    {selectedBid && <BidDetail bid={selectedBid} now={statusNow} profile={profile} assessment={assessRegion(selectedBid, profile)} isBookmarked={bookmarks.includes(selectedBid.id)} onClose={() => setSelectedBid(null)} onToggleBookmark={() => toggleBookmark(selectedBid.id)} onEnriched={detail => applyNoticeDetail(selectedBid.id, detail)} preparation={mode === 'live' ? <BidPreparation bidId={selectedBid.id} bid={selectedBid} member={member} /> : undefined} />}
    <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite">{toast && <><span><Check size={15} /></span>{toast}</>}</div>
  </div>;
}
