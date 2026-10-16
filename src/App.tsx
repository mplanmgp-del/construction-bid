import { NoticeList } from './components/NoticeList';
import { pageGroup } from './pagination';
import { selectedRegions, selectedStatuses, regionKey, regionLabel } from './search-filters';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Bookmark, Building2, Calculator, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ClipboardList, ExternalLink, FileSearch, Info, LockKeyhole, MapPin, PanelLeftOpen, Search, Settings2, ShieldCheck, SlidersHorizontal, Star, UserRound, X } from 'lucide-react';
import { CATEGORIES, type BidNotice, type CompanyProfile, type SearchFilters } from './types';
import { DEFAULT_FILTERS, DEMO_PROFILES, DEMO_TODAY, NOTICES } from './data';
import { assessRegion, assessSearchRegions, buildBidCsv, daysUntil, filterNotices, formatAmountInput, formatDateTime, formatPrice } from './domain';
import { loadPrototypeState, savePrototypeState, type PrototypeState } from './storage';
import { FilterPanel } from './components/FilterPanel';
import { ProfileView } from './components/ProfileView';
import { BidDetail } from './components/BidDetail';
import { ExportButton, type ExportFormat } from './components/ExportButton';
import { useMemberWorkspace } from './member/useMemberWorkspace';
import { MemberAccess, BidPreparation } from './member/MemberAccess';
import { mergeNoticeDetail } from './member/workspace';
import { toggleNoticeBookmark } from './member/bookmarks';
import type { G2bNoticeDetail } from './g2b-types';
import { useLiveNotices } from './live/useLiveNotices';
import { useCachedNoticeRegions, useNoticeRegions } from './live/useNoticeRegions';
import { seedNoticeDetailRegions, selectNoticeRegionTargets } from './live/notice-regions';
import { UnifiedNoticeSearch } from './live/UnifiedNoticeSearch';
import type { UnifiedSearchDraft } from './live/unified-notice-search';
import { SearchEmptyState } from './ui/SearchEmptyState';
import { readSearchSession, writeSearchSession } from './ui/search-session';
import { deadlineMonthWindow } from './notice-deadline-window';
import { isCatalogNotice } from './notice-deadline-window';
import { VerifiedSearchFeedback, VerifiedSearchPagination } from './live/VerifiedSearchFeedback';
import { filtersForIndexedSearch } from './live/notice-search';
import { CompanyDashboard } from './company/CompanyDashboard';
import { FloatingQuickLinks } from './components/FloatingQuickLinks';
import { currentNotice, koreanToday, mergeById } from './live/client';
import { useMenuAccess } from './admin/useMenuAccess';
import { AdminPage, LockedMenu } from './admin/AdminPage';
import { APP_MENUS, type MenuKey } from './admin/types';
import { appViewFromHash, appViewHash, menuIsLocked, type AppView } from './admin/navigation';
import { BidHelper } from './bid-helper/BidHelper';
import type { BidHelperSeed } from './bid-helper/notice-seed';
import { AlertsPage } from './alerts/AlertsPage';
import { AlertMenu } from './alerts/AlertsPopover';
import { alertFilterFromSearch, useAlerts } from './alerts/useAlerts';
import type { AlertFilter } from './alerts/types';

type View = AppView;
const PAGE_SIZE = 30;

function saveDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}


export default function App() {
  const [mode, setMode] = useState<'live' | 'demo'>('live');
  const member = useMemberWorkspace();
  const alerts = useAlerts(member.user?.id, mode === 'live');
  const access = useMenuAccess(member.user?.id);
  const [view, setView] = useState<View>(() => appViewFromHash(window.location.hash));
  const menuDisabled = mode === 'live' && menuIsLocked(view, access.ready, access.isAdmin, access.settings);
  const [loaded] = useState(() => loadPrototypeState(DEMO_PROFILES));
  const [state, setState] = useState<PrototypeState>(loaded.state);
  const [storageWarning, setStorageWarning] = useState(loaded.warning);
  const guestProfile: CompanyProfile = { id: 'guest', companyName: '업체 정보 미등록', province: '', district: '', address: '', licenses: [], contactName: '', email: '' };
  const profile = mode === 'live' ? member.workspace?.profile ?? guestProfile : state.profiles.find(item => item.id === state.activeProfileId) ?? state.profiles[0];
  const [searchSession] = useState(() => readSearchSession());
  const [localFilters, setFilters] = useState<SearchFilters>(() => view === 'notices' && searchSession ? { ...searchSession.filters, type: '전체' } : ({ ...DEFAULT_FILTERS, category: '전체', status: '전체', autoRegion: false }));
  const filters = useMemo(() => filtersForIndexedSearch(localFilters, mode === 'live' && view === 'notices'), [localFilters, mode, view]);
  const serverSearch = mode === 'live' && view === 'notices';
  const [resultMode, setResultMode] = useState<'title' | 'number'>('title');
  const [unifiedDraft, setUnifiedDraft] = useState<UnifiedSearchDraft>();
  const [searchResetKey, setSearchResetKey] = useState(0);
  const showNumberResults = serverSearch && resultMode === 'number';
  const live = useLiveNotices(serverSearch && !menuDisabled && !showNumberResults, filters, { province: profile.province, district: profile.district }, searchSession?.query);
  const [searchInput, setSearchInput] = useState(live.query.keyword);
  const [page, setPage] = useState(1);
  const [selectedNoticeIds, setSelectedNoticeIds] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileFilters, setMobileFilters] = useState(false);
  const [selectedBid, setSelectedBid] = useState<BidNotice | null>(null);
  const [bidHelperSeed, setBidHelperSeed] = useState<BidHelperSeed>();
  const [bidHelperLaunch, setBidHelperLaunch] = useState(0);
  const [toast, setToast] = useState('');
  const [existingAlertRequest, setExistingAlertRequest] = useState<{ userId: string; sequence: number } | null>(null);
  const [alertSeed, setAlertSeed] = useState<{ userId: string; filter: AlertFilter } | null>(null);
  const [statusNow, setStatusNow] = useState(() => Date.now());
  const noticeFiltersRef = useRef<SearchFilters>(searchSession ? { ...searchSession.filters, type: '전체' } : filters);
  const viewRef = useRef(view);
  const viewScroll = useRef<Partial<Record<View, number>>>({});
  const pendingScroll = useRef(false);
  const bookmarks = mode === 'live' ? member.workspace?.bookmarks ?? [] : state.bookmarks[profile.id] ?? [];
  const availableNotices = mode === 'live' ? live.items : NOTICES;

  useEffect(() => { if (view !== 'alerts') setExistingAlertRequest(null); }, [view]);
  useEffect(() => { setExistingAlertRequest(null); }, [member.user?.id, mode]);
  useEffect(() => { if (serverSearch) writeSearchSession(live.query, localFilters); }, [serverSearch, live.query, localFilters]);
  useEffect(() => {
    if (!pendingScroll.current || view === 'notices' && live.loading || (view === 'bookmarks' || view === 'profile') && member.loading) return;
    const frame = window.requestAnimationFrame(() => { window.scrollTo(0, viewScroll.current[view] ?? 0); pendingScroll.current = false; });
    return () => window.cancelAnimationFrame(frame);
  }, [view, live.loading, member.loading]);

  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash === '#custom-search') window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      const next = appViewFromHash(window.location.hash);
      if (next === viewRef.current) return;
      viewScroll.current[viewRef.current] = window.scrollY;
      pendingScroll.current = true;
      if (next === 'notices') { setFilters(noticeFiltersRef.current); }
      viewRef.current = next; setView(next); setSelectedBid(null); setMobileFilters(false); setPage(1);
    };
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('popstate', onHashChange);
    return () => { window.removeEventListener('hashchange', onHashChange); window.removeEventListener('popstate', onHashChange); };
  }, []);
  useEffect(() => { if (menuDisabled) { setSelectedBid(null); setMobileFilters(false); } }, [menuDisabled]);

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
    if (member.recoveryMode) { setMode('live'); setView('account'); setSelectedBid(null); setMobileFilters(false); }
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
    setSearchResetKey(value => value + 1);
    if (serverSearch) { setResultMode('title'); live.search({ type: '공사·용역', ...deadlineMonthWindow(6), keyword: '' }); }
  }

  function searchLocalNotices(keyword: string) {
    updateFilter('keyword', keyword.trim());
  }

  function navigate(next: View) {
    if (view === next) return;
    viewScroll.current[view] = serverSearch && live.pageNumber > 1 ? 0 : window.scrollY;
    pendingScroll.current = true;
    setSelectedBid(null); setMobileFilters(false); setPage(1);
    if (next === 'bookmarks') { setFilters({ ...DEFAULT_FILTERS, category: '전체', status: '전체', autoRegion: false }); setSearchInput(''); }
    if (next === 'notices') { const saved = noticeFiltersRef.current; setFilters(saved); setSearchInput(mode === 'live' ? live.query.keyword : saved.keyword); }
    viewRef.current = next; setView(next);
    window.history.pushState(null, '', `${window.location.pathname}${window.location.search}${appViewHash(next)}`);
  }

  function openBidHelper(seed?: BidHelperSeed) {
    setBidHelperSeed(seed);
    setBidHelperLaunch(value => value + 1);
    navigate('bid-helper');
  }

  function openExistingAlerts() {
    const userId = member.user?.id;
    if (!userId) return;
    setExistingAlertRequest(previous => ({ userId, sequence: previous?.userId === userId ? previous.sequence + 1 : 1 }));
    navigate('alerts');
  }

  function switchProfile(id: string) {
    persist({ ...state, activeProfileId: id }); setSelectedBid(null); setPage(1);
    setFilters(previous => ({ ...previous, autoRegion: false, regionView: 'all' }));
    setToast('테스트 업체를 전환했습니다. 업체 정보와 관심공고를 각각 확인해 보세요.');
  }

  function prepareCurrentSearchAlert() {
    if (mode !== 'live') return;
    if (!member.user) { navigate('account'); setToast('로그인 후 검색 조건을 알림으로 저장할 수 있습니다.'); return; }
    setAlertSeed({ userId: member.user.id, filter: alertFilterFromSearch(filters, live.query) });
    navigate('alerts');
  }

  function toggleBookmark(id: string, suppliedNotice?: BidNotice) {
    const exists = bookmarks.includes(id);
    if (mode === 'live') {
      if (!member.ready) { if (!member.loading) navigate('account'); setToast(member.loading ? '회원 정보를 불러오는 중입니다. 잠시 후 다시 저장해 주세요.' : member.user ? '내 계정에서 회원 저장 상태를 확인해 주세요.' : '로그인 후 관심공고를 회원별로 저장할 수 있습니다.'); return; }
      const bid = (suppliedNotice?.id === id ? suppliedNotice : undefined) ?? sourceNotices.find(item => item.id === id) ?? (selectedBid?.id === id ? selectedBid : undefined) ?? member.workspace?.noticeSnapshots[id];
      if (!bid) { setToast('공고 정보를 확인한 뒤 즐겨찾기에 저장해 주세요.'); return; }
      member.updateWorkspace(current => toggleNoticeBookmark(current, bid));
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
    const original = rawSourceNotices.find(bid => bid.id === id) ?? (selectedBid?.id === id ? selectedBid : undefined);
    if (original) seedNoticeDetailRegions(original, detail);
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

  useEffect(() => { setSelectedNoticeIds([]); setPage(1); }, [live.selectionKey]);

  const rawSourceNotices = useMemo(() => (view === 'bookmarks'
    ? mergeById(mode === 'live' ? Object.values(member.workspace?.noticeSnapshots ?? {}).map(bid => currentNotice(bid)) : [], availableNotices).filter(bid => bookmarks.includes(bid.id))
    : availableNotices).filter(bid => serverSearch || mode !== 'live' || isCatalogNotice(bid, statusNow)), [view, mode, serverSearch, member.workspace?.noticeSnapshots, availableNotices, bookmarks, statusNow]);
  const activeRegions = selectedRegions(filters);
  const activeStatuses = selectedStatuses(filters);
  const regionCandidates = useMemo(() => serverSearch ? rawSourceNotices : filterNotices(rawSourceNotices,
    { ...filters, siteProvince: '전체', regions: [], autoRegion: false, regionView: 'all' }, profile, statusNow), [rawSourceNotices, filters, profile, statusNow, serverSearch]);
  const companyRegionFilter = !!profile.province && !!profile.district && (filters.autoRegion || filters.regionView !== 'all');
  const regionFilterEnabled = mode === 'live' && !menuDisabled && view === 'bookmarks'
    && (companyRegionFilter || (filters.type !== '공사' && activeRegions.length > 0));
  const cachedLocalNotices = useCachedNoticeRegions(serverSearch ? [] : regionCandidates);
  const sourceNotices = serverSearch ? live.items : cachedLocalNotices;
  const baseResults = useMemo(() => serverSearch ? sourceNotices : filterNotices(sourceNotices, { ...filters, autoRegion: false, regionView: 'all' }, profile, statusNow), [sourceNotices, filters, profile, statusNow, serverSearch]);
  const counts = useMemo(() => baseResults.reduce((total, bid) => { total[assessRegion(bid, profile).status]++; return total; }, { matched: 0, review: 0, excluded: 0 }), [baseResults, profile]);
  const filtered = useMemo(() => serverSearch ? sourceNotices : filterNotices(sourceNotices, filters, profile, statusNow), [sourceNotices, filters, profile, statusNow, serverSearch]);
  const unknownSearchRegions = !activeRegions.length ? 0
    : sourceNotices.filter(bid => assessSearchRegions(bid, activeRegions).status === 'review').length;
  const unknownParticipationRegions = companyRegionFilter
    ? sourceNotices.filter(bid => bid.source === 'live' && !bid.allowedRegions?.length).length : unknownSearchRegions;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const pagination = pageGroup(safePage, pages);
  const visibleNotices = serverSearch ? filtered : filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const regionTargets = selectNoticeRegionTargets(regionCandidates, visibleNotices, regionFilterEnabled, companyRegionFilter);
  const regionSearch = useNoticeRegions(regionTargets, mode === 'live' && !menuDisabled && view === 'bookmarks', true, live.queryVersion);
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
  for (const region of activeRegions) chips.push({ label: `지역: ${regionLabel(region)}`, remove: () => updateFilter('regions', activeRegions.filter(item => regionKey(item) !== regionKey(region))) });
  for (const status of activeStatuses) chips.push({ label: status, remove: () => updateFilter('statuses', activeStatuses.filter(item => item !== status)) });
  if (filters.license !== '전체') chips.push({ label: filters.license, remove: () => updateFilter('license', '전체') });
  if (filters.contractMethod !== '전체') chips.push({ label: filters.contractMethod, remove: () => updateFilter('contractMethod', '전체') });
  if (filters.minAmount || filters.maxAmount) chips.push({ label: `추정가격 ${filters.minAmount ? formatAmountInput(filters.minAmount) : '0'} ~ ${filters.maxAmount ? formatAmountInput(filters.maxAmount) + '원' : '전체'}`, remove: () => { updateFilter('minAmount', ''); updateFilter('maxAmount', ''); } });
  if (filters.deadlineFrom || filters.deadlineTo) chips.push({ label: `마감 ${filters.deadlineFrom || '시작'} ~ ${filters.deadlineTo || '전체'}`, remove: () => { updateFilter('deadlineFrom', ''); updateFilter('deadlineTo', ''); } });
  if (filters.excludeKeyword) chips.push({ label: `제외: ${filters.excludeKeyword}`, remove: () => updateFilter('excludeKeyword', '') });

  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>본문 바로가기</a>
    <header className="app-header" inert={mobileFilters || Boolean(selectedBid) || undefined}><div className="header-inner">
      <button className="brand" onClick={() => navigate('notices')} aria-label="공사입찰 검색 홈"><span className="brand-mark"><span /><span /><span /></span><span>공사입찰 <b>검색</b></span></button>
      <nav className="main-nav" aria-label="주 메뉴">{APP_MENUS.filter(menu => mode === 'live' || menu.key !== 'results').map(menu => {
        const locked = mode === 'live' && access.settings.find(setting => setting.menu_key === menu.key)?.locked;
        const Icon = menu.key === 'notices' ? ClipboardList : menu.key === 'bookmarks' ? Bookmark : menu.key === 'profile' ? UserRound : FileSearch;
        return <button key={menu.key} aria-current={view === menu.key ? 'page' : undefined} className={view === menu.key ? 'active' : ''} onClick={() => navigate(menu.key)} title={locked ? access.isAdmin ? '잠금 중 · 관리자 열람 가능' : '현재 점검 중인 메뉴입니다.' : undefined}><Icon size={17} /><span>{menu.label}</span>{locked && <LockKeyhole className="menu-lock-icon" size={12} aria-label="잠금" />}{menu.key === 'bookmarks' && bookmarks.length > 0 && <span className="nav-count">{bookmarks.length}</span>}</button>;
      })}<button aria-current={view === 'bid-helper' ? 'page' : undefined} className={view === 'bid-helper' ? 'active' : ''} onClick={() => openBidHelper()}><Calculator size={17} /><span>투찰 도우미</span></button>{mode === 'live' && access.ready && access.isAdmin && <button className={view === 'admin' ? 'active' : ''} onClick={() => navigate('admin')}><ShieldCheck size={17} /><span>관리자</span></button>}</nav>
      <div className="header-account"><AlertMenu key={`${mode}:${member.user?.id ?? 'guest'}`} alerts={alerts} signedIn={Boolean(member.user)} disabled={mode === 'demo'} contextKey={view} onLogin={() => navigate('account')} onOpenSettings={() => navigate('alerts')} onOpenExisting={openExistingAlerts} bookmarks={bookmarks} onBookmark={notice => toggleBookmark(notice.id, notice)} />{mode === 'live' ? <button className="button button-secondary" onClick={() => navigate('account')}>{member.user ? '내 계정' : '로그인'}</button> : <div className="account-select"><span className="account-avatar">{profile.companyName[0] || '업'}</span><label className="sr-only" htmlFor="demo-profile-switch">테스트 업체 전환</label><select id="demo-profile-switch" value={profile.id} onChange={event => switchProfile(event.target.value)}>{state.profiles.map(item => <option key={item.id} value={item.id}>{item.companyName}</option>)}</select><ChevronDown size={15} /></div>}</div>
    </div></header>

    <main id="main-content" className="main-container" tabIndex={-1} inert={Boolean(selectedBid) || undefined}>
      {mode === 'demo' && storageWarning && <div className="storage-warning" role="status"><Info size={16} />{storageWarning}<button className="icon-button" onClick={() => setStorageWarning(null)} aria-label="안내 닫기"><X size={15} /></button></div>}
      {mode === 'live' && member.user && (member.saveStatus === 'saving' || member.saveStatus === 'error') && <div className={`live-member-status ${member.saveStatus === 'error' ? 'is-error' : ''}`} role="status">{member.saveStatus === 'saving' ? '변경 사항을 저장하고 있습니다.' : '변경 사항을 저장하지 못했습니다.'}{member.saveStatus === 'error' && <button className="text-button" onClick={() => navigate('account')}>저장 상태 확인</button>}</div>}
      {view === 'admin' ? <AdminPage access={access} onLogin={() => navigate('account')} /> : view === 'account' ? <MemberAccess member={member} /> : view === 'bid-helper' ? <BidHelper key={bidHelperLaunch} initialSeed={bidHelperSeed} onSeedConsumed={bidHelperSeed ? () => setBidHelperSeed(undefined) : undefined} /> : view === 'alerts' ? <AlertsPage bookmarks={bookmarks} onBookmark={notice => toggleBookmark(notice.id, notice)} key={member.user?.id ?? 'guest'} openExistingRequest={existingAlertRequest?.userId === member.user?.id ? existingAlertRequest?.sequence : 0} alerts={alerts} signedIn={Boolean(member.user)} profile={profile} onLogin={() => navigate('account')} isAdmin={access.isAdmin} demo={mode === 'demo'} initialFilter={alertSeed?.userId === member.user?.id ? alertSeed?.filter : null} onInitialFilterConsumed={() => setAlertSeed(null)} /> : menuDisabled ? <LockedMenu menu={view as MenuKey} setting={access.settings.find(setting => setting.menu_key === view)} loading={!access.ready && !access.error} onLogin={() => navigate('account')} onRetry={() => { void access.refresh(); }} /> : view === 'profile' ? <>{mode === 'live' && <MemberAccess member={member} />}{(mode === 'demo' || member.ready) && <ProfileView key={profile.id} profile={profile} onSave={saveProfile} persistence={mode === 'live' ? 'cloud' : 'browser'} />}</> : view === 'results' ? <CompanyDashboard key={profile.id} profile={profile} onProfile={() => navigate('profile')} /> : <>
        <section className="search-intro"><div><div className="eyebrow">공고 탐색</div><h1>{view === 'bookmarks' ? '관심공고' : '입찰공고'}</h1>{view === 'bookmarks' && <p>저장한 공고를 확인하고 입찰을 준비하세요.</p>}</div><div className="intro-note"><span className="small-dot" />{mode === 'live' ? '나라장터 공공데이터' : '예시 데이터'}<span className="intro-date">{mode === 'live' ? `한국시간 ${koreanToday().replaceAll('-', '.')}` : `예시 기준일 ${DEMO_TODAY.replaceAll('-', '.')}`}</span></div></section>

        {!showNumberResults && profile.id !== 'guest' && <section className="company-strip" aria-label="내 업체 지역 자동필터"><div className="company-strip-info"><span className="company-icon"><Building2 size={20} /></span><div><div className="company-name">{profile.id === 'guest' ? '내 업체 기준으로 찾기' : profile.companyName}</div><div className="company-address">{profile.province ? <><MapPin size={12} />{profile.province} {profile.district}</> : '업체 소재지를 등록하면 참가 가능 지역을 비교할 수 있습니다.'}</div></div><button className="company-edit" aria-label="업체 정보 수정" onClick={() => navigate('profile')}><Settings2 size={14} /><span>{profile.province ? '업체 수정' : '업체 등록'}</span></button></div>{profile.province && profile.district && <div className="auto-filter-control"><label className="switch-label"><input type="checkbox" checked={filters.autoRegion} onChange={event => { updateFilter('autoRegion', event.target.checked); updateFilter('regionView', 'all'); }} /><span className="switch-track" /><strong>내 지역 일치 공고만</strong></label><span className="filter-state">{filters.autoRegion ? '적용 중' : '미적용'}</span></div>}</section>}

        <div className={`search-workspace ${sidebarCollapsed || showNumberResults ? 'sidebar-collapsed' : ''}`}>
          {!showNumberResults && (!sidebarCollapsed || mobileFilters) && <FilterPanel filters={filters} showType={!serverSearch} showDeadlineRange={!serverSearch} onChange={updateFilter} onReset={resetFilters} onCollapse={() => { setSidebarCollapsed(true); setMobileFilters(false); }} mobileOpen={mobileFilters} onMobileClose={() => setMobileFilters(false)} />}
          <section className="results-panel panel" aria-label="입찰공고 검색 결과" inert={mobileFilters || undefined}>
            <div className="results-search-controls">
        {serverSearch && <UnifiedNoticeSearch initialDraft={unifiedDraft} onDraftChange={setUnifiedDraft} query={live.query} loading={live.loading} refreshBlocked={live.retryAt > Date.now()} onSearch={query => { setFilters(previous => ({ ...previous, type: '전체' })); live.search(query); setSearchInput(query.keyword); }} userId={member.user?.id} bookmarks={bookmarks} onOpen={setSelectedBid} onBookmark={notice => toggleBookmark(notice.id, notice)} onLogin={() => navigate('account')} onResultModeChange={setResultMode} resetKey={searchResetKey} />}
        {!(mode === 'live' && view === 'notices') && <form className="search-bar" onSubmit={event => { event.preventDefault(); searchLocalNotices(searchInput); }}><Search size={23} strokeWidth={1.7} /><label className="sr-only" htmlFor="bid-search">공고 검색</label><input id="bid-search" value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="공고명, 공고번호, 발주기관을 검색해 보세요" autoComplete="off" /><span className="search-shortcut">목록 검색</span>{searchInput && <button type="button" className="icon-button" aria-label="검색어 지우기" onClick={() => { setSearchInput(''); searchLocalNotices(''); }}><X size={17} /></button>}<button className="button button-primary search-submit" type="submit">검색<ArrowRight size={18} /></button></form>}

        {!showNumberResults && <div className="category-tabs" aria-label="작업 분야">{(['전체', ...CATEGORIES] as const).map(category => <button key={category} aria-pressed={filters.category === category} className={filters.category === category ? 'active' : ''} onClick={() => updateFilter('category', category)}>{category}</button>)}</div>}

            </div>
            {!showNumberResults && <>
            {serverSearch && <VerifiedSearchFeedback page={live.meta} loading={live.loading} stale={live.stale} error={live.error} onRestart={live.refresh} />}{mode === 'live' && view === 'bookmarks' && <p className="live-scope">저장한 공고 중 진행중·마감 임박·예정 공고를 표시합니다. 개찰 완료·취소 공고는 목록에서 제외되며 저장 기록은 보존됩니다.</p>}
            <div className="results-toolbar"><div className="results-heading-group"><button className="button button-secondary show-filter-button" aria-label="상세 검색 열기" onClick={() => { if (window.matchMedia('(max-width: 1000px)').matches) setMobileFilters(true); else setSidebarCollapsed(false); }}><PanelLeftOpen size={16} /><span>상세 검색</span></button><h2>{view === 'bookmarks' ? '저장한 공고' : '검색 결과'} <strong>{serverSearch && (live.loading || live.error) ? '—' : serverSearch ? live.totalCount : filtered.length}</strong><span>건</span></h2></div><div className="results-actions"><button type="button" className="text-button reset-results" onClick={resetFilters}>조건 초기화</button>{mode === 'live' && view === 'notices' && <button type="button" className="button button-secondary alerts-save-search" disabled={!live.query.keyword.trim()} onClick={prepareCurrentSearchAlert}>이 조건으로 알림 받기</button>}<ExportButton onExport={exportResults} disabled={exportNotices.length === 0 || serverSearch && (live.loading || Boolean(live.error))} /><label className="sr-only" htmlFor="sort-order">공고 정렬</label><select id="sort-order" className="sort-select" value={filters.sort} onChange={event => updateFilter('sort', event.target.value as SearchFilters['sort'])}><option value="deadline">마감 임박순</option><option value="newest">최신 공고순</option><option value="amountDesc">추정가격 높은순</option><option value="amountAsc">추정가격 낮은순</option></select></div></div>
            {profile.province && profile.district && <div className="result-filter-line"><div className="result-state-tabs" aria-label="지역 판정 필터"><button className={filters.regionView === 'all' ? 'active' : ''} onClick={() => updateFilter('regionView', 'all')}>전체 {!serverSearch && <span>{allCount}</span>}</button></div><button className={`excluded-button ${filters.regionView === 'excluded' ? 'active' : ''}`} onClick={() => updateFilter('regionView', filters.regionView === 'excluded' ? 'all' : 'excluded')}>{filters.regionView === 'excluded' ? '기본 목록으로 돌아가기' : serverSearch ? '지역 제외 보기' : `지역 제외 ${counts.excluded}건 보기`}<ChevronRight size={13} /></button></div>}
            {(chips.length > 0 || filters.autoRegion) && <div className="chips-line"><div className="filter-chips">{chips.map(chip => <button key={chip.label} onClick={chip.remove}>{chip.label}<X size={12} /></button>)}{filters.autoRegion && <span className="automatic-chip"><ShieldCheck size={13} />내 지역 자동필터</span>}</div></div>}
            {filters.regionView === 'excluded' && <div className="excluded-notice"><Info size={15} />등록한 업체 소재지와 지역조건이 맞지 않는 공고입니다. 공고 상세에서 제외 사유를 확인할 수 있습니다.</div>}
            {(activeRegions.length > 0 || companyRegionFilter) && <div className="region-search-note" role="status">
              <div><strong>{activeRegions.length ? `${activeRegions.map(regionLabel).join(' · ')} 지역 검색` : '내 업체 참가 가능 지역 확인'}</strong><span>{companyRegionFilter ? '내 업체 소재지와 공고의 참가 가능 지역을 비교합니다.' : '공사: 현장 위치 · 용역: 참가 가능 지역'}</span>
                {serverSearch ? <p>현재 페이지의 지역 정보입니다. 지역·면허·금액 조건은 서버의 전체 검색 결과에 적용합니다.</p> : regionSearch.loading ? <p>참가 가능 지역을 확인 중입니다. {regionSearch.pending}건 남음</p>
                  : companyRegionFilter && unknownParticipationRegions > 0 ? <p>지역 미확인 공고 {unknownParticipationRegions}건은 자동필터를 끄고 확인할 수 있습니다.</p>
                    : unknownSearchRegions > 0 ? <p>세부 지역이 확인되지 않은 공고 {unknownSearchRegions}건은 {filters.includeUnknownRegions ? '함께 표시합니다. 정확한 지역은 원문에서 확인해 주세요.' : '제외했습니다. 상세 검색의 ‘지역 미확인 공고 포함’으로 볼 수 있습니다.'}</p> : null}
                {regionSearch.failed > 0 && <p>일부 지역 정보를 불러오지 못했습니다. 미확인 공고는 원문을 확인해 주세요.</p>}
              </div>
            </div>}

            {(visibleNotices.length > 0 || activeStatuses.length > 0 || activeRegions.length > 0) && <>
              {selectedNotices.length > 0 && <div className="selection-summary"><span>{selectedNotices.length}건 선택 · 다운로드 시 선택한 공고를 내보냅니다.</span><button onClick={() => setSelectedNoticeIds([])}>선택 해제</button></div>}
              <NoticeList fetchPublicResults={!serverSearch} regionLookup={serverSearch ? undefined : regionSearch} bids={visibleNotices} now={statusNow} statuses={activeStatuses} onStatusesChange={value => updateFilter('statuses', value)} searchRegions={activeRegions} resultsPaused={regionSearch.loading} keyword={[filters.keyword, mode === 'live' && view === 'notices' ? live.query.keyword : ''].filter(Boolean).join(' ')} profile={profile} bookmarks={bookmarks} selected={selectedNoticeIds} onSelect={setSelectedNoticeIds} onOpen={setSelectedBid} onBookmark={toggleBookmark} />
            </>}
            {visibleNotices.length === 0 && <SearchEmptyState loading={serverSearch && live.loading} error={serverSearch && Boolean(live.error)} firstBookmark={view === 'bookmarks' && bookmarks.length === 0} onReset={resetFilters} onBrowse={() => navigate('notices')} onRetry={live.refresh} />}

            {!serverSearch && filtered.length > 0 && <div className="results-bottom"><span className="result-range">검색 결과 {filtered.length}건 중 {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)}건</span><nav className="pagination" aria-label="검색 결과 페이지"><button aria-label="이전 10페이지" disabled={pagination.previous === null} onClick={() => pagination.previous !== null && setPage(pagination.previous)}><ChevronLeft size={15} /></button><div className="pagination-numbers">{pagination.items.map(number => <button key={number} aria-label={`${number}페이지`} aria-current={safePage === number ? 'page' : undefined} className={safePage === number ? 'active' : ''} onClick={() => setPage(number)}>{number}</button>)}</div><button aria-label="다음 10페이지" disabled={pagination.next === null} onClick={() => pagination.next !== null && setPage(pagination.next)}><ChevronRight size={15} /></button></nav><span className="page-size-label">30개씩 보기</span></div>}
            {serverSearch && !live.loading && !live.error && <VerifiedSearchPagination total={live.totalCount} count={visibleNotices.length} pageNumber={live.pageNumber} hasNext={live.hasMore} hasPrevious={live.hasPrevious} loading={live.loading} stale={live.stale} onNext={() => { void live.next(); }} onPrevious={() => { void live.previous(); }} />}
            </>}

          </section>
        </div>
        <div className="notice-guidance"><Info size={15} /><span>지역 일치는 소재지 조건만 비교한 결과입니다. 면허·실적·공동수급 등 전체 참가자격은 공고 상세와 원문을 확인하세요.</span></div>
      </>}
      <footer className="app-footer"><div><span className="footer-brand">공사입찰 검색</span><span>내 업체에 맞는 공고, 더 간편하게.</span></div><div className="footer-links"><span>{mode === 'live' ? '공개 공고·결과 조회 및 회원별 입찰 준비 관리' : '화면·공고·업체 정보는 테스트용 예시입니다.'}</span><a href="https://www.g2b.go.kr" target="_blank" rel="noreferrer">나라장터<ExternalLink size={12} /></a></div></footer>
    </main>
    <FloatingQuickLinks key={profile.id} profile={profile} />
    {selectedBid && !menuDisabled && <BidDetail bid={selectedBid} now={statusNow} profile={profile} assessment={assessRegion(selectedBid, profile)} isBookmarked={bookmarks.includes(selectedBid.id)} onClose={() => setSelectedBid(null)} onToggleBookmark={() => toggleBookmark(selectedBid.id)} onEnriched={detail => applyNoticeDetail(selectedBid.id, detail)} onOpenBidHelper={openBidHelper} preparation={mode === 'live' ? <BidPreparation bidId={selectedBid.id} bid={selectedBid} member={member} /> : undefined} />}
    <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite">{toast && <><span><Check size={15} /></span>{toast}</>}</div>
  </div>;
}
