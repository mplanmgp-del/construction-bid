import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Search, Settings2, Sparkles } from 'lucide-react';
import type { BidNotice, CompanyProfile } from '../types';
import type { AlertFilter, AlertNotice, AlertSettings } from '../alerts/types';
import { matchAlertNotice } from '../alerts/domain';
import { buildBidCsv, formatDateTime, formatPrice } from '../domain';
import { NoticeList } from '../components/NoticeList';
import { ExportButton, type ExportFormat } from '../components/ExportButton';
import { dateRangeError, koreanToday, recentDates } from './client';
import { useCustomNotices } from './useCustomNotices';
import { CUSTOM_ACTIVE_MAX_DAYS, CUSTOM_NOTICE_MAX_DAYS, type CustomNoticeQuery } from './custom-notice-search';
import { NoticeNumberLookup } from './NoticeNumberLookup';
import './custom-notice-search.css';

export function customConditionLabels(filter: AlertFilter): string[] {
  const basis = { auto: '업무별 기본', site: '현장 위치', participation: '참가 가능 지역', either: '현장·참가 중 하나', both: '현장·참가 모두' };
  return [filter.types.join('·'), filter.keywords.length ? `검색어 ${filter.keywords.join(', ')}` : '',
    filter.excludeKeywords.length ? `제외 ${filter.excludeKeywords.join(', ')}` : '', filter.categories.join('·'),
    filter.regions.length ? `${filter.regions.join(', ')} · ${basis[filter.regionBasis ?? 'auto']}` : '',
    filter.licenses.length ? `면허 ${filter.licenses.join(', ')}` : '',
    filter.useCompanyRegion ? '내 업체 참가 지역' : '', filter.useCompanyLicenses ? '내 업체 보유 면허' : '',
    filter.agencies?.length ? `기관 ${filter.agencies.join(', ')}` : '', filter.contractMethods?.join('·') ?? '',
    filter.minAmount !== null || filter.maxAmount !== null ? `추정가격 ${filter.minAmount === null ? '제한 없음' : formatPrice(filter.minAmount)} ~ ${filter.maxAmount === null ? '제한 없음' : formatPrice(filter.maxAmount)}` : '',
    filter.minDaysUntilDeadline == null ? '' : `마감 ${filter.minDaysUntilDeadline}일 이상`, filter.includeUnknown ? '미확인 정보 포함' : '미확인 정보 제외'].filter(Boolean);
}

type SearchAccess = ReturnType<typeof useCustomNotices>;
export function customLookupAction(applied: CustomNoticeQuery | null, next: CustomNoticeQuery, hasMore: boolean): 'search' | 'more' {
  const key = (query: CustomNoticeQuery) => JSON.stringify([query.basis ?? 'posted', query.from, query.to, query.settings.filter, query.profile]);
  return applied && hasMore && key(applied) === key(next) ? 'more' : 'search';
}
export function futureNoticeDates(days: number, now = new Date()): { from: string; to: string } {
  return { from: koreanToday(now), to: koreanToday(new Date(now.getTime() + (days - 1) * 86_400_000)) };
}
export function CustomNoticeResults({ search, settings, profile, bookmarks, onBookmark, onOpen, basis, now = Date.now() }: {
  search: SearchAccess; settings: AlertSettings; profile: CompanyProfile; bookmarks: string[];
  basis?: CustomNoticeQuery['basis'];
  onBookmark: (notice: AlertNotice) => void; onOpen: (notice: BidNotice) => void; now?: number;
}) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [exportError, setExportError] = useState('');
  const lookupSettings = { ...settings, enabled: true };
  const rows = search.items.filter(notice => matchAlertNotice(notice, lookupSettings, profile, now).matched)
    .sort((a, b) => (Date.parse(a.deadline) || Infinity) - (Date.parse(b.deadline) || Infinity) || b.postedAt.localeCompare(a.postedAt));
  const pages = Math.max(1, Math.ceil(rows.length / 30)), safePage = Math.min(page, pages);
  const visible = rows.slice((safePage - 1) * 30, safePage * 30);
  const byId = new Map(rows.map(notice => [notice.id, notice]));
  const selectedRows = rows.filter(notice => selected.includes(notice.id));
  const needsReview = rows.filter(notice => matchAlertNotice(notice, lookupSettings, profile, now).needsReview).length;
  async function download(format: ExportFormat) {
    setExportError('');
    try {
      const exported = selectedRows.length ? selectedRows : rows;
      let blob: Blob;
      if (format === 'csv') blob = new Blob(['\uFEFF', buildBidCsv(exported)], { type: 'text/csv;charset=utf-8' });
      else { const { buildBidWorkbook } = await import('../excel-export'); const workbook = buildBidWorkbook(exported, profile, new Date(), 'live'); blob = new Blob([new Uint8Array(await workbook.xlsx.writeBuffer())], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); }
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `맞춤공고_${koreanToday()}.${format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setExportError(error instanceof Error ? error.message : '다운로드하지 못했습니다. 다시 시도해 주세요.'); }
  }
  return <section className="custom-results panel" aria-label="맞춤 조회 결과">
    <div className="custom-results-heading"><div><h2>조건에 맞는 공고 <strong>{rows.length}</strong>건</h2><p>{search.loading ? '확인된 공고부터 표시하고 있습니다.' : search.hasMore ? '현재 확인한 범위의 결과입니다. 더 조회하면 다음 공고를 확인합니다.' : search.error ? '조회하지 못한 범위가 있습니다.' : basis === 'opening' ? '선택한 개찰 예정 기간의 조회를 마쳤습니다.' : '선택한 게시 기간의 조회를 마쳤습니다.'}</p></div>{rows.length > 0 && <ExportButton onExport={download} />}</div>
    <div className="custom-progress" role="status">{search.loading && <LoaderCircle size={15} className="alerts-spinning" />}<span>후보 {search.candidateCount}건 · 조건 확인 {search.checkedCount}건</span>{search.fetchedAt && <span>조회 {formatDateTime(search.fetchedAt)}</span>}</div>
    {search.error && <div className="custom-search-error" role="alert"><CircleAlert size={16} /><span>{search.error}</span></div>}
    {exportError && <div className="custom-search-error" role="alert">{exportError}</div>}
    {needsReview > 0 && <p className="custom-review">미확인 정보가 포함된 공고 {needsReview}건이 있습니다. 표시된 비교 사유와 공고 원문을 확인해 주세요.</p>}
    {!!search.excludedItems?.length && <div className="custom-status-changes"><h3>취소·마감 이력 확인 {search.excludedItems.length}건</h3><p>검색된 공고의 최신 차수에서 상태 변경이 확인됐습니다. 진행 공고 목록에서 제외했으며, 상세 이력은 확인할 수 있습니다.</p>{search.excludedItems.slice(0, 10).map(notice => <div key={notice.id}><span className="custom-cancel-badge">{notice.status === '취소' ? '취소' : '마감'}</span><button type="button" onClick={() => onOpen(notice)}>{notice.title}</button><small>{notice.number}-{notice.revision}</small></div>)}{search.excludedItems.length > 10 && <p>나머지 공고는 위 공고번호 검색으로 확인할 수 있습니다.</p>}</div>}
    {selectedRows.length > 0 && <div className="selection-summary">{selectedRows.length}건 선택 · 다운로드에 선택한 공고를 반영합니다.<button type="button" onClick={() => setSelected([])}>선택 해제</button></div>}
    {rows.length > 0 ? <NoticeList bids={visible} keyword={settings.filter.keywords.join(' ')} profile={profile} bookmarks={bookmarks} selected={selected} onSelect={setSelected} onOpen={onOpen}
      onBookmark={id => { const notice = byId.get(id); if (notice) onBookmark(notice); }} now={now}
      customAssessment={bid => matchAlertNotice(bid as AlertNotice, lookupSettings, profile, now)} /> : <div className="custom-empty"><Search size={28} /><h3>{search.loading ? '조건에 맞는 공고를 찾고 있습니다' : search.error ? '공고 조회를 완료하지 못했습니다' : search.hasMore ? '확인한 범위에 조건에 맞는 공고가 없습니다' : '조건에 맞는 공고가 없습니다'}</h3><p>{search.loading ? '기관·지역·면허 등 필요한 조건을 함께 확인하고 있습니다.' : search.hasMore ? '다음 공고를 더 조회하거나 조건을 조정해 보세요.' : basis === 'opening' ? '개찰 예정 기간을 넓히거나 위 공고번호 검색으로 확인해 보세요.' : '게시 기간을 넓히거나 저장한 조건을 확인해 보세요.'}</p></div>}
    {pages > 1 && <nav className="custom-pagination" aria-label="맞춤 조회 결과 페이지"><button type="button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}><ChevronLeft size={15} />이전</button><span>{safePage} / {pages}</span><button type="button" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>다음<ChevronRight size={15} /></button></nav>}
    {search.hasMore && <div className="custom-load-more"><button type="button" className="button button-secondary" disabled={search.loading} onClick={() => { void search.loadMore(); }}>{search.loading ? '조건 확인 중' : '공고 더 조회'}<ChevronRight size={16} /></button></div>}
    {rows.length > 0 && <p className="custom-result-note">다운로드에는 현재 확인한 공고만 포함됩니다. 최종 참가 자격과 제출 일정은 공고 원문에서 확인해 주세요.</p>}
  </section>;
}

export function CustomNoticeSearch({ userId, settings, profile, profileReady, initialSettings, settingsError, onRetrySettings, bookmarks, onBookmark, onOpen, onEditConditions, onGeneralSearch, onLogin, now }: {
  userId?: string; settings: AlertSettings | null; profile: CompanyProfile; profileReady: boolean; initialSettings?: AlertSettings | null;
  settingsError?: string; onRetrySettings?: () => void;
  bookmarks: string[]; onBookmark: (notice: AlertNotice) => void; onOpen: (notice: BidNotice) => void;
  onEditConditions: () => void; onGeneralSearch: () => void; onLogin: () => void; now?: number;
}) {
  const search = useCustomNotices(userId);
  const [basis, setBasis] = useState<'opening' | 'posted'>('opening');
  const [dates, setDates] = useState(() => futureNoticeDates(365));
  const [error, setError] = useState('');
  const [applied, setApplied] = useState<CustomNoticeQuery | null>(null);
  const initialRequested = useRef(false);
  const lookupSettings = initialSettings ?? settings;
  const settingsKey = JSON.stringify(lookupSettings?.filter);
  const currentQuery = lookupSettings ? { settings: lookupSettings, profile, ...dates, ...(basis === 'opening' ? { basis: 'opening' as const } : {}) } : null;
  const sameQuery = !!currentQuery && customLookupAction(applied, currentQuery, true) === 'more';
  const continues = sameQuery && search.hasMore;
  const submitting = sameQuery && search.loading;
  function changeBasis(next: 'opening' | 'posted') {
    if (next === basis) return;
    search.clear(); setApplied(null); setBasis(next); setDates(next === 'opening' ? futureNoticeDates(365) : recentDates(7)); setError('');
  }
  function run() {
    if (!lookupSettings || !userId || !profileReady) return;
    const message = dateRangeError(dates.from, dates.to, basis === 'opening' ? CUSTOM_ACTIVE_MAX_DAYS : CUSTOM_NOTICE_MAX_DAYS);
    if (message) { setError(message); return; }
    const next: CustomNoticeQuery = { settings: lookupSettings, profile, ...dates, ...(basis === 'opening' ? { basis: 'opening' as const } : {}) };
    setError('');
    if (customLookupAction(applied, next, search.hasMore) === 'more') { void search.loadMore(); return; }
    setApplied(structuredClone(next)); void search.search(next);
  }
  useEffect(() => {
    if (initialRequested.current || !userId || !profileReady || !lookupSettings) return;
    initialRequested.current = true; run();
    return () => { initialRequested.current = false; };
  }, [userId, profileReady, settingsKey]);
  if (!userId) return <section className="custom-search-page"><h1>맞춤 조회</h1><div className="custom-login panel"><Sparkles size={30} /><h2>내 조건으로 공고를 바로 찾아보세요.</h2><p>로그인하면 저장한 조건과 업체 정보로 조회할 수 있습니다.</p><button className="button button-primary" onClick={onLogin}>로그인하고 맞춤 조회</button></div></section>;
  return <section className="custom-search-page">
    <div className="custom-page-heading"><div><div className="eyebrow">내 업체에 맞는 공고를 바로</div><h1>맞춤 조회</h1><p>오래전에 게시된 진행 공고도 찾고, 최신 차수의 상태를 확인합니다.</p></div><button type="button" className="button button-secondary" onClick={onGeneralSearch}><ArrowLeft size={15} />일반 검색</button></div>
    <NoticeNumberLookup userId={userId} bookmarks={bookmarks} onOpen={onOpen} onBookmark={notice => onBookmark({ ...notice, sourceUpdatedAt: notice.postedAt, regionComplete: false, licenseComplete: false })} />
    <div className="custom-query-panel panel"><form onSubmit={event => { event.preventDefault(); run(); }}>
      <div className="custom-basis-selector" role="group" aria-label="조회 기준">
        <button type="button" aria-pressed={basis === 'opening'} onClick={() => changeBasis('opening')}>진행 공고 찾기</button>
        <button type="button" aria-pressed={basis === 'posted'} onClick={() => changeBasis('posted')}>게시 기간으로 찾기</button>
      </div>
      <p className="custom-basis-description">{basis === 'opening' ? '게시일과 관계없이 선택한 개찰 예정 기간의 미마감 공고를 찾습니다. 오래전에 게시된 공고도 포함합니다.' : '선택한 기간에 게시된 공고 중 내 조건에 맞는 미마감 공고를 찾습니다.'}</p>
      <div className="custom-period-presets" role="group" aria-label={basis === 'opening' ? '개찰 예정 기간 빠른 선택' : '공고 게시 기간 빠른 선택'}>
        {(basis === 'opening' ? [30, 90, 365] : [7, 30, CUSTOM_NOTICE_MAX_DAYS]).map(days => <button type="button" key={days} aria-pressed={JSON.stringify(dates) === JSON.stringify(basis === 'opening' ? futureNoticeDates(days) : recentDates(days))} onClick={() => { setDates(basis === 'opening' ? futureNoticeDates(days) : recentDates(days)); setError(''); }}>{basis === 'opening' ? days === 365 ? '앞으로 1년' : `앞으로 ${days}일` : `최근 ${days}일`}</button>)}
      </div>
      <div className="custom-query-dates">
        <label>{basis === 'opening' ? '개찰 예정일 시작' : '공고 게시일 시작'}<input name="from" className="field" type="date" required value={dates.from} onChange={event => { setDates(value => ({ ...value, from: event.target.value })); setError(''); }} /></label><span>~</span>
        <label>{basis === 'opening' ? '개찰 예정일 종료' : '공고 게시일 종료'}<input name="to" className="field" type="date" required value={dates.to} onChange={event => { setDates(value => ({ ...value, to: event.target.value })); setError(''); }} /></label>
        <button type="submit" className="button button-primary" aria-describedby={error ? 'custom-period-error' : undefined} disabled={!lookupSettings || !profileReady || submitting}><span className="custom-query-symbol" aria-hidden="true">{submitting ? <LoaderCircle size={16} className="alerts-spinning" /> : <Sparkles size={16} />}</span><span>{submitting ? '조회 중' : continues ? '계속 조회' : '맞춤 조회'}</span></button>
      </div>
      <p className="custom-query-help">{basis === 'opening' ? `개찰 예정일 기준 · 기본 앞으로 1년 · 한 번에 최대 ${CUSTOM_ACTIVE_MAX_DAYS}일. 개찰일이 없거나 선택 기간 밖인 공고는 위 공고번호 검색으로 확인할 수 있습니다.` : `공고 게시일 기준 · 한 번에 최대 ${CUSTOM_NOTICE_MAX_DAYS}일. 일반 검색의 입찰 개시일과는 조회 범위가 다릅니다.`}</p>
      {continues && !search.loading && <p className="custom-query-help">아직 확인하지 않은 범위가 있습니다. 파란색 ‘계속 조회’ 버튼으로 이어서 확인할 수 있습니다.</p>}
    </form>
      {error && <p id="custom-period-error" className="custom-search-error" role="alert">{error}</p>}
      <div className="custom-conditions"><div><strong>{initialSettings ? '입력한 조건' : '저장한 조건'}</strong><button type="button" onClick={onEditConditions}><Settings2 size={14} />조건 수정</button></div><div className="custom-condition-tags">{(applied?.settings ?? lookupSettings) ? customConditionLabels((applied?.settings ?? lookupSettings)!.filter).map(label => <span key={label}>{label}</span>) : <p role="status">조건을 불러오는 중입니다.</p>}</div></div>
    </div>
    {applied ? <><p className="custom-applied-period">{applied.basis === 'opening' ? '개찰 예정일' : '공고 게시일'} {applied.from} ~ {applied.to} · 알림 수신 여부와 관계없이 조회합니다.</p><CustomNoticeResults basis={applied.basis} search={search} settings={applied.settings} profile={applied.profile ?? profile} bookmarks={bookmarks} onBookmark={onBookmark} onOpen={onOpen} now={now} /></> : settingsError ? <div className="custom-search-error" role="alert"><span>{settingsError}</span>{onRetrySettings && <button type="button" className="button button-secondary" onClick={onRetrySettings}>조건 다시 불러오기</button>}</div> : <p className="custom-waiting" role="status">{!profileReady ? '업체 정보를 불러오고 있습니다.' : !lookupSettings ? '저장한 조건을 불러오고 있습니다.' : '기간과 조건을 확인한 뒤 맞춤 조회를 눌러주세요.'}</p>}
  </section>;
}
