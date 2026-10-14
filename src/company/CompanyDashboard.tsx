import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BarChart3, Building2, CalendarDays, ChevronLeft, ChevronRight, Download, ExternalLink, FileCheck2, Info, ListOrdered, LoaderCircle, MapPin, Phone, RefreshCw, Search, Trophy, Users, X } from 'lucide-react';
import type { CompanyProfile } from '../types';
import type { CompanyGroupSummary, CompanyParticipation, PublicCompany } from '../company-types';
import { OpeningResultsPanel } from '../live/OpeningResultsPanel';
import { CompanyIndexedRecords } from './CompanyIndexedRecords';
import { useCompanyHistory } from './useCompanyHistory';
import { collectedCount, collectedWinningAmount, mergeCompanyProfile, type CompanyIndexFilter } from './company-index';
import { koreanToday } from '../live/client';
import { fetchCompanyApi } from './company-request';
import './company-dashboard.css';

const initialFilter: CompanyIndexFilter = { from: '', to: '', outcome: 'all', page: 1, awardsPage: 1, contractsPage: 1 };
type CompanySearchResponse = { items: PublicCompany[]; message?: string; source?: string; year?: number; page?: number; hasMore?: boolean };
type OfficialSearchCursor = { query: string; year: number; page: number };
const number = (value: number) => value.toLocaleString('ko-KR');
const money = (value: number | null | undefined) => value == null ? '-' : `${number(value)}원`;
const businessNumber = (value: string) => value.replace(/^(\d{3})(\d{2})(\d{5})$/, '$1-$2-$3');
const date = (value?: string | null) => !value ? '-' : /^\d{8}(?:$|[^\d])/.test(value) ? `${value.slice(0, 4)}.${value.slice(4, 6)}.${value.slice(6, 8)}` : value.slice(0, 10).replaceAll('-', '.');
const rate = (wins: number, total: number) => total ? `${(wins / total * 100).toFixed(1)}%` : '-';
const compactMoney = (value: number) => value >= 100_000_000 ? `${number(Math.round(value / 1_000_000) / 100)}억` : value >= 10_000 ? `${number(Math.round(value / 10_000))}만` : number(value);

function exportPage(rows: CompanyParticipation[], company: PublicCompany) {
  const cell = (value: unknown) => {
    const text = value == null ? '-' : String(value);
    return `"${(/^[\s]*[=+\-@]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
  };
  const header = ['공고명', '공고번호', '차수', '업무', '수요기관', '개찰일시', '순위', '참가업체수', '투찰금액', '투찰률', '낙찰여부', '낙찰금액', '계약방법'];
  const csv = [header, ...rows.map(row => [row.title, row.number, row.revision, row.type, row.agency, row.openingAt, row.rank, row.participantCount, row.bidAmount == null ? null : number(row.bidAmount), row.bidRate == null ? null : `${row.bidRate}%`, row.awarded === true ? '낙찰' : row.awarded === false ? '미낙찰' : '-', row.winningAmount == null ? null : number(row.winningAmount), row.method])].map(row => row.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url; link.download = `${company.name || company.businessNumber}_입찰이력_현재페이지.csv`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function CompanyDashboard({ profile, onProfile }: { profile: CompanyProfile; onProfile: () => void }) {
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<PublicCompany[]>([]);
  const [searchMessage, setSearchMessage] = useState('');
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [officialCursor, setOfficialCursor] = useState<OfficialSearchCursor | null>(null);
  const [selected, setSelected] = useState<PublicCompany | null>(null);
  const [filter, setFilter] = useState<CompanyIndexFilter>(initialFilter);
  const [dates, setDates] = useState({ from: '', to: '' });
  const [dateError, setDateError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [openingRow, setOpeningRow] = useState<CompanyParticipation | null>(null);
  const searchController = useRef<AbortController | null>(null);
  const searchSequence = useRef(0);
  const composing = useRef(false);
  const searchPanel = useRef<HTMLDivElement | null>(null);
  const officialYearInput = useRef<HTMLInputElement | null>(null);
  const openingTrigger = useRef<HTMLButtonElement | null>(null);
  const indexed = useCompanyHistory(selected, filter, refresh);
  const history = indexed.history;
  const loading = indexed.loading;
  const historyError = indexed.error;

  function selectCompany(company: PublicCompany) {
    setOpeningRow(null);
    setSelected(company); setDates({ from: '', to: '' });
    setFilter({ ...initialFilter }); setDateError(''); setMatches([]); setSearchMessage('');
  }

  function cancelSearch() {
    ++searchSequence.current; searchController.current?.abort(); searchController.current = null;
    setSearching(false); setSuggesting(false);
  }

  function updateSearch(value: string) {
    cancelSearch();
    setOfficialCursor(null);
    setSearch(value); setMatches([]); setSearchError(''); setSearchMessage('');
  }

  async function findMoreOfficialCompanies() {
    if (!officialCursor) return;
    const year = Number(officialYearInput.current?.value || officialCursor.year);
    if (!Number.isInteger(year) || year < 1900 || year > Number(koreanToday().slice(0, 4))) { setSearchError('공식 업체 등록 연도를 확인해 주세요.'); return; }
    const cursor = { ...officialCursor, year, page: year === officialCursor.year ? officialCursor.page : 1 };
    cancelSearch();
    const controller = new AbortController(); searchController.current = controller;
    const sequence = ++searchSequence.current;
    setSearching(true); setSuggesting(true); setSearchError('');
    try {
      const response = await fetchCompanyApi<CompanySearchResponse>(`/api/companies?${new URLSearchParams({ q: cursor.query, source: 'official', year: String(cursor.year), page: String(cursor.page) })}`, controller.signal);
      if (controller.signal.aborted || sequence !== searchSequence.current) return;
      if (response.year !== cursor.year || response.page !== cursor.page) throw new Error('요청한 업체 등록 연도와 응답이 일치하지 않습니다.');
      setMatches(previous => [...new Map([...previous, ...response.items].map(item => [item.businessNumber, item])).values()]);
      setOfficialCursor(response.hasMore ? { ...cursor, page: cursor.page + 1 } : cursor.year > 1900 ? { ...cursor, year: cursor.year - 1, page: 1 } : null);
      setSearchMessage([`${cursor.year}년 등록 업체 ${number(response.items.length)}곳 확인 · 후보를 선택하거나 이전 등록 업체를 더 찾을 수 있습니다.`, response.message].filter(Boolean).join(' '));
    } catch (cause) {
      if (!controller.signal.aborted && sequence === searchSequence.current) setSearchError(cause instanceof Error ? cause.message : '공식 업체 후보를 불러오지 못했습니다.');
    } finally { if (sequence === searchSequence.current) { setSearching(false); setSuggesting(false); } }
  }

  async function findCompanies(value: string) {
    const query = value.trim();
    cancelSearch();
    if (!query) { setSearchError('업체명 또는 사업자등록번호를 입력해 주세요.'); return; }
    const direct = /^\d{10}$/.test(query.replace(/[\s-]/g, ''));
    setOfficialCursor(null);
    setOpeningRow(null); setSearch(query); setSelected(null); setMatches([]); setSearchError(''); setSearchMessage('');
    const controller = new AbortController(); searchController.current = controller;
    const sequence = ++searchSequence.current;
    setSearching(true); setSuggesting(!direct); setSearchError(''); setSearchMessage(''); setMatches([]);
    try {
      const response = await fetchCompanyApi<CompanySearchResponse>(`/api/companies?${new URLSearchParams({ q: query })}`, controller.signal);
      if (controller.signal.aborted || sequence !== searchSequence.current) return;
      if (response.items.length === 1 && direct) {
        if (response.items[0].businessNumber !== query.replace(/[\s-]/g, '')) throw new Error('조회한 사업자등록번호와 응답이 일치하지 않습니다.');
        selectCompany(response.items[0]);
      }
      else setMatches(response.items);
      if (!direct) setOfficialCursor(response.source === 'official' && response.year && response.page
        ? response.hasMore ? { query, year: response.year, page: response.page + 1 } : response.year > 1900 ? { query, year: response.year - 1, page: 1 } : null
        : { query, year: Number(koreanToday().slice(0, 4)), page: 1 });
      const message = response.items.length === 0 ? '조회된 공개 업체 정보가 없습니다. 정확한 사업자등록번호로 다시 검색해 주세요.'
        : !direct || response.items.length > 1 ? `업체 후보 ${number(response.items.length)}곳 · 조회할 업체를 선택해 주세요.` : '';
      setSearchMessage([message, response.message].filter(Boolean).join(' '));
    } catch (cause) {
      if (!controller.signal.aborted && sequence === searchSequence.current) setSearchError(cause instanceof Error ? cause.message : '업체 정보를 불러오지 못했습니다.');
    } finally { if (sequence === searchSequence.current) { setSearching(false); setSuggesting(false); } }
  }

  useEffect(() => () => { ++searchSequence.current; searchController.current?.abort(); }, []);
  useEffect(() => { setOpeningRow(null); }, [selected, filter, refresh]);
  useEffect(() => {
    if (!history) return;
    setFilter(previous => {
      const page = Math.min(previous.page, Math.max(1, Math.ceil(history.totalCount / history.pageSize)));
      const awardsPage = history.awards ? Math.min(previous.awardsPage, Math.max(1, Math.ceil(history.awards.totalCount / history.awards.pageSize))) : previous.awardsPage;
      const contractsPage = history.contracts ? Math.min(previous.contractsPage, Math.max(1, Math.ceil(history.contracts.totalCount / history.contracts.pageSize))) : previous.contractsPage;
      return page === previous.page && awardsPage === previous.awardsPage && contractsPage === previous.contractsPage ? previous : { ...previous, page, awardsPage, contractsPage };
    });
  }, [history]);

  const company = mergeCompanyProfile(selected, history?.company);
  const available = history && history.coverage.status !== 'unavailable';
  const summary = available && collectedCount(history.summary.participationCount, history.coverage) != null ? history.summary : null;
  const complete = history?.coverage.status === 'ready';
  const winningAmount = collectedWinningAmount(summary, history?.coverage);
  const pageCount = history ? Math.max(1, Math.ceil(history.totalCount / history.pageSize)) : 1;
  const pageGroup = Math.floor(((history?.page || filter.page) - 1) / 10) * 10;
  const pages = Array.from({ length: Math.max(0, Math.min(10, pageCount - pageGroup)) }, (_, index) => pageGroup + index + 1);
  const chartMax = Math.max(1, ...(history?.monthly.map(month => month.participationCount) ?? []));
  function openResults(row: CompanyParticipation, trigger: HTMLButtonElement) {
    openingTrigger.current = trigger;
    setOpeningRow(row);
  }
  function closeResults() {
    setOpeningRow(null);
    window.requestAnimationFrame(() => openingTrigger.current?.focus());
  }

  return <section className="company-dashboard" aria-label="MY입찰관리">
    <header className="company-dashboard-heading">
      <div><span className="company-eyebrow">COMPANY BID INSIGHTS</span><h1>MY입찰관리</h1><p>내 업체부터 다른 업체까지, 공개 입찰 이력을 한눈에 확인하세요.</p></div>
      <button className="button button-secondary" onClick={() => {
        const value = profile.businessNumber || (profile.id !== 'guest' ? profile.companyName : '');
        if (value) void findCompanies(value); else onProfile();
      }} disabled={searching && !suggesting}><Building2 size={17} />내 업체 조회</button>
    </header>

    <div className="company-search-panel panel" ref={searchPanel}>
      <form className="company-search-form" onSubmit={event => { event.preventDefault(); if (!composing.current) void findCompanies(search); }}>
        <label htmlFor="company-search">업체 검색</label>
        <div className="company-search-input"><Search size={22} /><input id="company-search" autoComplete="off" value={search} onChange={event => updateSearch(event.target.value)} onCompositionStart={() => { composing.current = true; cancelSearch(); }} onCompositionEnd={event => { composing.current = false; updateSearch(event.currentTarget.value); }} onKeyDown={event => { if (event.key === 'Escape') { cancelSearch(); setMatches([]); setSearchMessage(''); setSearchError(''); } }} aria-describedby="company-search-help" placeholder="업체명 또는 사업자등록번호를 입력하세요" />{search && <button className="company-search-clear" type="button" aria-label="업체 검색어 지우기" onClick={() => updateSearch('')}><X size={17} /></button>}<button type="submit" disabled={searching && !suggesting}>{searching ? <LoaderCircle className="company-spin" size={18} /> : <Search size={18} />}<span>{searching && !suggesting ? '조회 중' : '업체 조회'}</span></button></div>
      </form>
      <p className="company-search-help" id="company-search-help">업체명을 입력하고 조회하면 후보를 찾습니다. 업체를 선택하면 공개 정보와 입찰 이력을 조회합니다. 사업자등록번호로도 바로 조회할 수 있습니다.</p>
      {searching && suggesting && <p className="company-search-message" role="status">업체명에 맞는 후보를 찾고 있습니다.</p>}
      {searchError && <p className="company-error" role="alert">{searchError}</p>}
      {searchMessage && <p className="company-search-message" role="status">{searchMessage}</p>}
      {officialCursor && <div className="company-search-actions"><label>공식 등록 연도<input ref={officialYearInput} key={`${officialCursor.query}-${officialCursor.year}`} type="number" min="1900" max={koreanToday().slice(0, 4)} defaultValue={officialCursor.year} disabled={searching} /></label><button type="button" disabled={searching} onClick={() => void findMoreOfficialCompanies()}>{searching ? <LoaderCircle size={15} className="company-spin" /> : <Search size={15} />}공식 업체 더 찾기{officialCursor.page > 1 && ` · ${officialCursor.page}쪽`}</button></div>}
      {matches.length > 0 && <div className="company-search-matches" aria-label="조회할 업체 후보">{matches.map(match => <button key={match.businessNumber} onClick={() => void findCompanies(match.businessNumber)}><span className="company-match-icon"><Building2 size={20} /></span><span><strong>{match.name || businessNumber(match.businessNumber)}</strong><small>{businessNumber(match.businessNumber)}{match.representative && ` · 대표 ${match.representative}`}{match.address && ` · ${match.address}`}</small></span><ArrowRight size={18} /></button>)}</div>}
    </div>

    {!company && !searching && matches.length === 0 && <div className="company-start panel"><span className="company-start-icon"><BarChart3 size={35} /></span><h2>업체의 입찰 흐름을 살펴보세요</h2><p>업체를 검색하면 수집된 참여·낙찰 이력과 계약을 바로 확인할 수 있습니다.<br />기간을 지정하지 않으면 업체 등록일부터 현재까지 조회하며, 등록일이 확인되지 않은 업체는 저장된 자료를 먼저 표시합니다.</p><div className="company-start-features"><span><Users size={17} />공개 업체 조회</span><span><Trophy size={17} />낙찰·계약 구분</span><span><CalendarDays size={17} />조회 일수 제한 없음</span></div></div>}
    {searching && !suggesting && <div className="company-loading panel" role="status"><LoaderCircle className="company-spin" size={25} /><span>공개 업체 정보를 조회하고 있습니다.</span></div>}

    {company && <>
      <article className="company-profile-card panel">
        <div className="company-profile-top"><div className="company-profile-symbol"><Building2 size={30} /></div><div><span className="company-public-badge">나라장터 공개 업체</span><h2>{company.name || businessNumber(company.businessNumber)}</h2><p>사업자등록번호 <strong>{businessNumber(company.businessNumber)}</strong>{company.companyType && <span>{company.companyType}</span>}</p></div></div>
        <dl className="company-basic-info"><div><dt>대표자</dt><dd>{company.representative || '-'}</dd></div><div><dt><Phone size={13} />연락처</dt><dd>{company.phone || '-'}</dd></div><div><dt>조달업체 등록일</dt><dd>{date(company.registrationDate)}</dd></div><div className="company-address-field"><dt><MapPin size={13} />소재지</dt><dd>{company.address || '-'}</dd></div></dl>
        <details className="company-qualifications"><summary>보유 면허·공급 품목 <span>면허 {company.licenses.length ? `${number(company.licenses.length)}개` : '-'} · 품목 {company.products.length ? `${number(company.products.length)}개` : '-'}</span></summary><div><h3>면허·업종</h3><div className="company-tag-list">{company.licenses.length ? company.licenses.map((license, index) => <span key={`${license}-${index}`}>{license}</span>) : <p>-</p>}</div><h3>공급 품목</h3><div className="company-tag-list">{company.products.length ? company.products.map((product, index) => <span key={`${product}-${index}`}>{product}</span>) : <p>-</p>}</div></div></details>
      </article>

      <form className="company-period panel" onSubmit={event => {
        event.preventDefault();
        if (dates.from && dates.to && dates.from > dates.to) { setDateError('종료일은 시작일 이후로 선택해 주세요.'); return; }
        setDateError(''); setFilter({ ...filter, ...dates, page: 1, awardsPage: 1, contractsPage: 1 });
      }}><div className="company-period-label"><CalendarDays size={19} /><div><strong>조회 기간</strong><span>참여·낙찰은 개찰일 · 계약은 계약일 기준</span></div></div><label>시작일<input type="date" value={dates.from} onChange={event => setDates({ ...dates, from: event.target.value })} /></label><span className="company-date-separator">~</span><label>종료일<input type="date" value={dates.to} onChange={event => setDates({ ...dates, to: event.target.value })} /></label><button className="button button-primary">적용</button><button type="button" className={`button button-secondary${!filter.from && !filter.to ? ' is-selected' : ''}`} disabled={loading} onClick={() => { setDates({ from: '', to: '' }); setDateError(''); setFilter({ ...filter, from: '', to: '', page: 1, awardsPage: 1, contractsPage: 1 }); }}>전체 기간</button><button type="button" className="company-refresh" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} />새로고침</button>{dateError && <p className="company-error" role="alert">{dateError}</p>}</form>

      <div className={`company-coverage${historyError || !complete ? ' is-warning' : ''}`} role="status"><Info size={17} /><div><strong>{history?.coverage.status === 'unavailable' ? '수집된 이력 연결을 확인하고 있습니다.' : complete ? '수집이 완료된 범위의 참여 이력' : '현재 수집된 참여 이력 기준'}</strong><p>{history?.coverage.message || (historyError ? '저장된 공개 이력을 확인하지 못했습니다.' : '저장된 공개 이력을 불러오고 있습니다.')}</p>{historyError && <p className="company-index-error">{historyError}{history && ' 기존 조회 결과를 유지하고 있습니다.'}</p>}<small>수집 범위 {date(history?.coverage.from)} ~ {date(history?.coverage.to)} · 개찰일 기준{history?.coverage.updatedAt && ` · 자료 갱신 ${date(history.coverage.updatedAt)}`}</small><small>수집되지 않은 기간의 이력은 추가될 수 있습니다. 입찰 참여 통계와 계약 이력은 각각 구분해 집계합니다.</small></div><span className="company-index-refresh">{indexed.refreshing ? <><LoaderCircle size={14} className="company-spin" />갱신 중</> : <><RefreshCw size={14} />자동 갱신</>}</span></div>

          {openingRow && <OpeningResultsPanel key={`${openingRow.type}-${openingRow.number}-${openingRow.revision}`} row={openingRow} activeBusinessNumber={company.businessNumber} onClose={closeResults} onCompany={value => { void findCompanies(value); searchPanel.current?.scrollIntoView({ block: 'start' }); }} />}

      {loading ? <div className="company-metric-grid" aria-label="입찰 실적 불러오는 중">{Array.from({ length: 4 }, (_, index) => <div key={index} className="company-metric-skeleton panel"><span /><strong /><span /></div>)}</div> : <div className="company-metric-grid">
        <article className="company-metric panel"><span className="company-metric-icon"><FileCheck2 size={21} /></span><p>입찰 참여</p><strong>{summary ? <>{number(summary.participationCount)}<small>건</small></> : '-'}</strong><span>수집된 참여 이력 기준</span></article>
        <article className="company-metric panel"><span className="company-metric-icon is-green"><Trophy size={21} /></span><p>참여 중 확인된 낙찰</p><strong>{summary && (summary.winCount > 0 || (complete && summary.pendingCount === 0)) ? <>{number(summary.winCount)}<small>건</small></> : '-'}</strong><span>수집 범위 내 낙찰률 {complete && summary && summary.pendingCount === 0 ? rate(summary.winCount, summary.participationCount) : '-'}</span></article>
        <article className="company-metric panel"><span className="company-metric-icon is-purple"><BarChart3 size={21} /></span><p>공개된 낙찰금액</p><strong className="company-metric-money">{winningAmount == null ? '-' : <>{number(winningAmount)}<small>원</small></>}</strong><span>수집된 참여의 공개 금액 합계</span></article>
        <article className="company-metric panel"><span className="company-metric-icon is-amber"><Users size={21} /></span><p>평균 투찰률</p><strong>{summary?.averageBidRate == null ? '-' : <>{number(Math.round(summary.averageBidRate * 1000) / 1000)}<small>%</small></>}</strong><span>결과 확인 전 {summary ? `${number(summary.pendingCount)}건` : '-'}</span></article>
      </div>}

      {!loading && available && <>
        <div className="company-analysis-grid">
          <section className="company-monthly panel"><header className="company-section-heading"><div><h2>월별 입찰 실적</h2><p>개찰일 기준 · 수집된 참여 이력 집계</p></div><div className="company-chart-legend"><span><i />참여</span><span><i />확인된 낙찰</span></div></header>
            {history.monthly.length ? <><div className="company-chart-scroll"><div className="company-monthly-chart" role="img" aria-label="월별 참여 및 낙찰 건수. 상세 수치는 아래 월별 집계 표에서 확인할 수 있습니다.">{history.monthly.map(month => <div key={month.month} className="company-chart-month"><div className="company-chart-bars"><span className="company-chart-bar participation" style={{ height: `${Math.max(2, month.participationCount / chartMax * 145)}px` }} title={`참여 ${number(month.participationCount)}건`} /><span className="company-chart-bar wins" style={{ height: `${month.winCount ? Math.max(2, month.winCount / chartMax * 145) : 0}px` }} title={`낙찰 ${number(month.winCount)}건`} /></div><small>{month.month}</small></div>)}</div></div><details className="company-monthly-details"><summary>월별 집계표 보기</summary><div className="company-table-scroll"><table><thead><tr><th scope="col">월</th><th scope="col">참여</th><th scope="col">낙찰</th><th scope="col">낙찰금액</th></tr></thead><tbody>{history.monthly.map(month => <tr key={month.month}><th scope="row">{month.month}</th><td>{number(month.participationCount)}건</td><td>{number(month.winCount)}건</td><td>{money(month.winningAmount)}</td></tr>)}</tbody></table></div></details></> : <div className="company-section-empty">집계할 월별 이력이 없습니다.</div>}
          </section>
          <section className="company-agencies panel"><header className="company-section-heading"><div><h2>수요기관별 실적</h2><p>참여 기관과 낙찰 성과를 비교하세요.</p></div><Building2 size={22} /></header>{history.agencies.length ? <div className="company-table-scroll"><table><thead><tr><th scope="col">수요기관</th><th scope="col">참여 / 낙찰</th><th scope="col">낙찰금액</th></tr></thead><tbody>{history.agencies.map(agency => <tr key={agency.name}><th scope="row">{agency.name || '-'}</th><td>{number(agency.participationCount)} / <strong>{number(agency.winCount)}</strong><small>{complete && summary?.pendingCount === 0 ? rate(agency.winCount, agency.participationCount) : '-'}</small></td><td title={money(agency.winningAmount)}>{agency.winningAmount == null ? '-' : `${compactMoney(agency.winningAmount)}원`}</td></tr>)}</tbody></table></div> : <div className="company-section-empty">집계할 수요기관 이력이 없습니다.</div>}</section>
        </div>

        {(Boolean(history.businessTypes?.length) || Boolean(history.methods?.length)) && <div className="company-analysis-grid company-grouped-statistics">
          {Boolean(history.businessTypes?.length) && <GroupStatistics title="업무별 입찰 실적" description="공사·용역별 참여와 낙찰 현황" rows={history.businessTypes!} />}
          {Boolean(history.methods?.length) && <GroupStatistics title="계약방법별 입찰 실적" description="참여 비중과 공개 낙찰 실적" rows={history.methods!} />}
        </div>}

        {Boolean(history.competitors?.length) && <section className="company-competitors panel">
          <header className="company-section-heading"><div><h2>함께 입찰한 업체</h2><p>같은 공고·차수 참여 기준 · 공동 참여가 많은 최대 20개 업체입니다. 업체를 선택하면 공개 이력을 조회합니다.</p></div><Users size={22} /></header>
          <div className="company-competitor-list">{history.competitors!.map(competitor => <button key={competitor.businessNumber} aria-label={`${competitor.name || businessNumber(competitor.businessNumber)} 업체 조회`} onClick={() => {
            void findCompanies(competitor.businessNumber); searchPanel.current?.scrollIntoView({ block: 'start' });
          }}><span className="company-competitor-symbol"><Building2 size={19} /></span><span className="company-competitor-name"><strong>{competitor.name || businessNumber(competitor.businessNumber)}</strong><small>{businessNumber(competitor.businessNumber)}</small></span><span className="company-competitor-count"><strong>{number(competitor.sharedCount)}<small>건 함께 참여</small></strong><span>해당 공고 낙찰 {number(competitor.winCount)}건</span></span><ChevronRight size={17} /></button>)}</div>
        </section>}

        <section className="company-history panel"><header className="company-section-heading"><div><h2>입찰 참여 이력 <span>{collectedCount(history.totalCount, history.coverage) == null ? '-' : `${number(history.totalCount)}건`}</span></h2><p>{!filter.from && !filter.to ? (company.registrationDate ? `${date(company.registrationDate)} ~ 현재 · 업체 등록일 기준` : '저장된 전체 기간 · 업체 등록일 확인 중') : `${date(filter.from) === '-' ? '처음' : date(filter.from)} ~ ${date(filter.to) === '-' ? '현재' : date(filter.to)}`} · 수집된 참여 이력</p></div><button className="button button-secondary" disabled={!history.items.length} onClick={() => exportPage(history.items, company)}><Download size={16} />현재 페이지 CSV</button></header><div className="company-history-tabs" role="group" aria-label="입찰 이력 결과 필터"><button aria-pressed={filter.outcome === 'all'} className={filter.outcome === 'all' ? 'active' : ''} onClick={() => setFilter({ ...filter, outcome: 'all', page: 1 })}>전체 참여</button><button aria-pressed={filter.outcome === 'won'} className={filter.outcome === 'won' ? 'active' : ''} onClick={() => setFilter({ ...filter, outcome: 'won', page: 1 })}>낙찰 이력</button><button aria-pressed={filter.outcome === 'lost'} className={filter.outcome === 'lost' ? 'active' : ''} onClick={() => setFilter({ ...filter, outcome: 'lost', page: 1 })}>미낙찰</button><button aria-pressed={filter.outcome === 'pending'} className={filter.outcome === 'pending' ? 'active' : ''} onClick={() => setFilter({ ...filter, outcome: 'pending', page: 1 })}>확인 중</button></div>
          {history.items.length ? <><div className="company-history-desktop company-table-scroll"><table><thead><tr><th scope="col">공고명 / 수요기관</th><th scope="col">결과</th><th scope="col">순위 / 참가업체</th><th scope="col">투찰금액</th><th scope="col">투찰률</th><th scope="col">낙찰금액</th><th scope="col">개찰일</th></tr></thead><tbody>{history.items.map(row => <tr key={row.id}><td className="company-history-title"><small>{row.type} · {row.number}-{row.revision}</small><NoticeTitle row={row} /><span>{row.agency || '-'}{row.method && ` · ${row.method}`}</span>{row.number && <button className="company-opening-trigger" onClick={event => openResults(row, event.currentTarget)}><ListOrdered size={14} />투찰업체·순위 보기</button>}</td><td><Outcome row={row} /></td><td>{row.rank || '-'} / {row.participantCount == null ? '-' : number(row.participantCount)}</td><td className="company-amount">{money(row.bidAmount)}</td><td>{row.bidRate == null ? '-' : `${row.bidRate}%`}</td><td className="company-amount">{money(row.winningAmount)}</td><td>{date(row.openingAt)}</td></tr>)}</tbody></table></div><div className="company-history-mobile">{history.items.map(row => <article key={row.id}><div><span>{row.type} · {date(row.openingAt)}</span><Outcome row={row} /></div><NoticeTitle row={row} /><p>{row.agency || '-'}</p><dl><div><dt>순위 / 참가업체</dt><dd>{row.rank || '-'} / {row.participantCount == null ? '-' : number(row.participantCount)}</dd></div><div><dt>투찰률</dt><dd>{row.bidRate == null ? '-' : `${row.bidRate}%`}</dd></div><div><dt>투찰금액</dt><dd>{money(row.bidAmount)}</dd></div><div><dt>낙찰금액</dt><dd>{money(row.winningAmount)}</dd></div></dl>{row.number && <button className="company-opening-trigger" onClick={event => openResults(row, event.currentTarget)}><ListOrdered size={15} />투찰업체·순위 보기<ChevronRight size={14} /></button>}</article>)}</div></> : <div className="company-section-empty">{complete ? '확인된 수집 범위에서 선택한 조건의 참여 이력이 없습니다.' : '아직 수집된 참여 이력이 없습니다. 추가 자료를 확인하는 중이며 실제 참여 이력이 없다는 의미는 아닙니다.'}</div>}
          <footer className="company-history-footer"><p>{history.totalCount ? `${number((history.page - 1) * history.pageSize + 1)}–${number(Math.min(history.page * history.pageSize, history.totalCount))} / ` : ''}{collectedCount(history.totalCount, history.coverage) == null ? '-' : `${number(history.totalCount)}건`}</p><nav aria-label="업체 입찰 이력 페이지" className="company-pagination"><button disabled={pageGroup === 0} aria-label="이전 10개 페이지" onClick={() => setFilter({ ...filter, page: pageGroup })}><ChevronLeft size={17} /></button>{pages.map(page => <button key={page} className={page === history.page ? 'active' : ''} aria-current={page === history.page ? 'page' : undefined} onClick={() => setFilter({ ...filter, page })}>{page}</button>)}<button disabled={pageGroup + 10 >= pageCount} aria-label="다음 10개 페이지" onClick={() => setFilter({ ...filter, page: pageGroup + 11 })}><ChevronRight size={17} /></button></nav></footer>
        </section>
      </>}
      {history && <CompanyIndexedRecords history={history} onAwardPage={page => setFilter({ ...filter, awardsPage: page })} onContractPage={page => setFilter({ ...filter, contractsPage: page })} onOpening={openResults} />}
    </>}
  </section>;
}

function Outcome({ row }: { row: CompanyParticipation }) {
  return <span className={`company-outcome ${row.awarded === true ? 'is-won' : row.awarded === false ? 'is-lost' : 'is-pending'}`}>{row.awarded === true ? '낙찰' : row.awarded === false ? '미낙찰' : '확인 전'}</span>;
}

function NoticeTitle({ row }: { row: CompanyParticipation }) {
  if (!row.number) return <span className="company-notice-title">{row.title || '-'}</span>;
  return <a className="company-notice-title" href={`/notice-detail.html?${new URLSearchParams({ number: row.number, revision: row.revision, type: row.type })}`} target="_blank" rel="noreferrer">{row.title || row.number}<ExternalLink size={13} /></a>;
}

function GroupStatistics({ title, description, rows }: { title: string; description: string; rows: CompanyGroupSummary[] }) {
  const participationTotal = rows.reduce((sum, row) => sum + row.participationCount, 0);
  return <section className="company-group-stats panel"><header className="company-section-heading"><div><h2>{title}</h2><p>{description}</p></div><BarChart3 size={22} /></header><div className="company-group-bars">{rows.map((row, index) => <div className="company-group-row" key={row.name}><div><strong>{row.name || '-'}</strong><span>참여 {number(row.participationCount)}건 <b>{participationTotal ? `${(row.participationCount / participationTotal * 100).toFixed(1)}%` : '-'}</b></span></div><div className="company-group-track" aria-hidden="true"><span className={index % 2 ? 'is-secondary' : ''} style={{ width: `${participationTotal ? row.participationCount / participationTotal * 100 : 0}%` }} /></div><p><span>확인된 낙찰 <strong>{number(row.winCount)}건</strong></span><span>{money(row.winningAmount)}</span></p></div>)}</div></section>;
}
