import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BarChart3, Building2, CalendarDays, ChevronLeft, ChevronRight, Download, ExternalLink, FileCheck2, Info, ListOrdered, LoaderCircle, MapPin, Phone, RefreshCw, Search, Trophy, Users } from 'lucide-react';
import type { CompanyProfile } from '../types';
import type { CompanyGroupSummary, CompanyHistory, CompanyParticipation, PublicCompany } from '../company-types';
import { OpeningResultsPanel } from '../live/OpeningResultsPanel';
import { fetchApi } from '../live/client';
import './company-dashboard.css';

type HistoryFilter = { from: string; to: string; outcome: 'all' | 'won'; page: number };
const initialFilter: HistoryFilter = { from: '', to: '', outcome: 'all', page: 1 };
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
  const [selected, setSelected] = useState<PublicCompany | null>(null);
  const [history, setHistory] = useState<CompanyHistory | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>(initialFilter);
  const [dates, setDates] = useState({ from: '', to: '' });
  const [dateError, setDateError] = useState('');
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [openingRow, setOpeningRow] = useState<CompanyParticipation | null>(null);
  const searchController = useRef<AbortController | null>(null);
  const searchSequence = useRef(0);
  const searchPanel = useRef<HTMLDivElement | null>(null);
  const openingTrigger = useRef<HTMLButtonElement | null>(null);

  function selectCompany(company: PublicCompany) {
    setOpeningRow(null);
    setSelected(company); setHistory(null); setHistoryError(''); setDates({ from: '', to: '' });
    setFilter({ ...initialFilter }); setDateError(''); setMatches([]); setSearchMessage('');
  }

  async function findCompanies(value: string) {
    const query = value.trim();
    if (!query) { setSearchError('업체명 또는 사업자등록번호를 입력해 주세요.'); return; }
    searchController.current?.abort();
    const controller = new AbortController(); searchController.current = controller;
    const sequence = ++searchSequence.current;
    setOpeningRow(null);
    setSearch(query); setSearching(true); setSearchError(''); setSearchMessage(''); setMatches([]); setSelected(null); setHistory(null);
    try {
      const response = await fetchApi<{ items: PublicCompany[]; message?: string }>(`/api/companies?${new URLSearchParams({ q: query })}`, controller.signal);
      if (sequence !== searchSequence.current) return;
      if (response.items.length === 1 && !/^\d{10}$/.test(query.replace(/[\s-]/g, ''))) {
        await findCompanies(response.items[0].businessNumber);
        return;
      }
      if (response.items.length === 1) selectCompany(response.items[0]);
      else setMatches(response.items);
      setSearchMessage(response.message || (response.items.length === 0 ? '조회된 공개 업체 정보가 없습니다. 정확한 사업자등록번호로 다시 검색해 주세요.' : response.items.length > 1 ? '조회할 업체를 선택해 주세요.' : ''));
    } catch (cause) {
      if (!controller.signal.aborted && sequence === searchSequence.current) setSearchError(cause instanceof Error ? cause.message : '업체 정보를 불러오지 못했습니다.');
    } finally { if (sequence === searchSequence.current) setSearching(false); }
  }

  useEffect(() => () => { ++searchSequence.current; searchController.current?.abort(); }, []);
  useEffect(() => {
    setOpeningRow(null);
    if (!selected) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setHistoryError(''); setHistory(null);
    const params = new URLSearchParams({ businessNumber: selected.businessNumber, page: String(filter.page), outcome: filter.outcome });
    if (filter.from) params.set('from', filter.from);
    if (filter.to) params.set('to', filter.to);
    void fetchApi<CompanyHistory>(`/api/company-history?${params}`, controller.signal)
      .then(result => { if (!controller.signal.aborted) setHistory(result); })
      .catch(cause => { if (!controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : '업체 입찰 이력을 불러오지 못했습니다.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selected, filter, refresh]);

  const company = selected ?? history?.company;
  const available = history && history.coverage.status !== 'unavailable';
  const summary = available && (history.summary.participationCount > 0 || history.coverage.status === 'ready') ? history.summary : null;
  const pageCount = history ? Math.max(1, Math.ceil(history.totalCount / history.pageSize)) : 1;
  const pageGroup = Math.floor((filter.page - 1) / 10) * 10;
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
      }} disabled={searching}><Building2 size={17} />내 업체 조회</button>
    </header>

    <div className="company-search-panel panel" ref={searchPanel}>
      <form className="company-search-form" onSubmit={event => { event.preventDefault(); void findCompanies(search); }}>
        <label htmlFor="company-search">업체 검색</label>
        <div className="company-search-input"><Search size={22} /><input id="company-search" autoComplete="off" value={search} onChange={event => setSearch(event.target.value)} placeholder="업체명 또는 사업자등록번호를 입력하세요" /><button type="submit" disabled={searching}>{searching ? <LoaderCircle className="company-spin" size={18} /> : <Search size={18} />}<span>{searching ? '조회 중' : '업체 조회'}</span></button></div>
      </form>
      <p className="company-search-help">다른 업체도 조회할 수 있습니다. 사업자등록번호로 검색하면 동명이인을 구분할 수 있습니다.</p>
      {searchError && <p className="company-error" role="alert">{searchError}</p>}
      {searchMessage && <p className="company-search-message" role="status">{searchMessage}</p>}
      {matches.length > 0 && <div className="company-search-matches">{matches.map(match => <button key={match.businessNumber} onClick={() => void findCompanies(match.businessNumber)}><span className="company-match-icon"><Building2 size={20} /></span><span><strong>{match.name || businessNumber(match.businessNumber)}</strong><small>{businessNumber(match.businessNumber)}{match.address && ` · ${match.address}`}</small></span><ArrowRight size={18} /></button>)}</div>}
    </div>

    {!company && !searching && matches.length === 0 && <div className="company-start panel"><span className="company-start-icon"><BarChart3 size={35} /></span><h2>업체의 입찰 흐름을 살펴보세요</h2><p>업체를 검색하면 참여 이력, 낙찰 실적과 수요기관별 현황을 확인할 수 있습니다.<br />기간을 선택하지 않으면 저장된 전체 이력을 조회합니다.</p><div className="company-start-features"><span><Users size={17} />공개 업체 조회</span><span><Trophy size={17} />낙찰 실적</span><span><CalendarDays size={17} />조회 일수 제한 없음</span></div></div>}
    {searching && <div className="company-loading panel" role="status"><LoaderCircle className="company-spin" size={25} /><span>공개 업체 정보를 조회하고 있습니다.</span></div>}

    {company && <>
      <article className="company-profile-card panel">
        <div className="company-profile-top"><div className="company-profile-symbol"><Building2 size={30} /></div><div><span className="company-public-badge">나라장터 공개 업체</span><h2>{company.name || businessNumber(company.businessNumber)}</h2><p>사업자등록번호 <strong>{businessNumber(company.businessNumber)}</strong>{company.companyType && <span>{company.companyType}</span>}</p></div></div>
        <dl className="company-basic-info"><div><dt>대표자</dt><dd>{company.representative || '-'}</dd></div><div><dt><Phone size={13} />연락처</dt><dd>{company.phone || '-'}</dd></div><div><dt>조달업체 등록일</dt><dd>{date(company.registrationDate)}</dd></div><div className="company-address-field"><dt><MapPin size={13} />소재지</dt><dd>{company.address || '-'}</dd></div></dl>
        <details className="company-qualifications"><summary>보유 면허·공급 품목 <span>면허 {company.licenses.length ? `${number(company.licenses.length)}개` : '-'} · 품목 {company.products.length ? `${number(company.products.length)}개` : '-'}</span></summary><div><h3>면허·업종</h3><div className="company-tag-list">{company.licenses.length ? company.licenses.map((license, index) => <span key={`${license}-${index}`}>{license}</span>) : <p>-</p>}</div><h3>공급 품목</h3><div className="company-tag-list">{company.products.length ? company.products.map((product, index) => <span key={`${product}-${index}`}>{product}</span>) : <p>-</p>}</div></div></details>
      </article>

      <form className="company-period panel" onSubmit={event => {
        event.preventDefault();
        if (dates.from && dates.to && dates.from > dates.to) { setDateError('종료일은 시작일 이후로 선택해 주세요.'); return; }
        setDateError(''); setFilter({ ...filter, ...dates, page: 1 });
      }}><div className="company-period-label"><CalendarDays size={19} /><div><strong>개찰일 기준</strong><span>일수 제한 없이 조회</span></div></div><label>시작일<input type="date" value={dates.from} onChange={event => setDates({ ...dates, from: event.target.value })} /></label><span className="company-date-separator">~</span><label>종료일<input type="date" value={dates.to} onChange={event => setDates({ ...dates, to: event.target.value })} /></label><button className="button button-primary" disabled={loading}>적용</button><button type="button" className={`button button-secondary${!filter.from && !filter.to ? ' is-selected' : ''}`} disabled={loading} onClick={() => { setDates({ from: '', to: '' }); setDateError(''); setFilter({ ...filter, from: '', to: '', page: 1 }); }}>전체 기간</button><button type="button" className="company-refresh" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} />새로고침</button>{dateError && <p className="company-error" role="alert">{dateError}</p>}</form>

      <div className={`company-coverage${history?.coverage.status === 'unavailable' || historyError ? ' is-warning' : ''}`} role="status"><Info size={17} /><div><strong>{loading ? '업체 입찰 이력을 불러오고 있습니다.' : historyError ? '입찰 이력을 조회하지 못했습니다.' : history?.coverage.status === 'ready' ? '공개 자료 조회 현황' : '수집된 이력 기준'}</strong><p>{historyError || history?.coverage.message || '공개된 데이터를 확인한 뒤 조회 범위를 표시합니다.'}</p>{history?.coverage && <small>수집 범위 {date(history.coverage.from)} ~ {date(history.coverage.to)}{history.coverage.updatedAt && ` · 최근 반영 ${date(history.coverage.updatedAt)}`}</small>}</div>{historyError && <button className="button button-secondary" onClick={() => setRefresh(value => value + 1)}>다시 조회</button>}</div>

      {loading ? <div className="company-metric-grid" aria-label="입찰 실적 불러오는 중">{Array.from({ length: 4 }, (_, index) => <div key={index} className="company-metric-skeleton panel"><span /><strong /><span /></div>)}</div> : <div className="company-metric-grid">
        <article className="company-metric panel"><span className="company-metric-icon"><FileCheck2 size={21} /></span><p>입찰 참여</p><strong>{summary ? number(summary.participationCount) : '-'}<small>건</small></strong><span>{filter.from || filter.to ? '선택한 기간' : '저장된 전체 기간'} 기준</span></article>
        <article className="company-metric panel"><span className="company-metric-icon is-green"><Trophy size={21} /></span><p>낙찰 실적</p><strong>{summary ? number(summary.winCount) : '-'}<small>건</small></strong><span>낙찰률 {summary ? rate(summary.winCount, summary.participationCount) : '-'}</span></article>
        <article className="company-metric panel"><span className="company-metric-icon is-purple"><BarChart3 size={21} /></span><p>총 낙찰금액</p><strong className="company-metric-money">{summary?.winningAmount == null ? '-' : number(summary.winningAmount)}<small>원</small></strong><span>공개 낙찰금액 합계</span></article>
        <article className="company-metric panel"><span className="company-metric-icon is-amber"><Users size={21} /></span><p>평균 투찰률</p><strong>{summary?.averageBidRate == null ? '-' : number(Math.round(summary.averageBidRate * 1000) / 1000)}<small>%</small></strong><span>결과 확인 전 {summary ? number(summary.pendingCount) : '-'}건</span></article>
      </div>}

      {!loading && available && <>
        <div className="company-analysis-grid">
          <section className="company-monthly panel"><header className="company-section-heading"><div><h2>월별 입찰 실적</h2><p>공개 개찰일 기준 · 수집된 이력 집계</p></div><div className="company-chart-legend"><span><i />참여</span><span><i />낙찰</span></div></header>
            {history.monthly.length ? <><div className="company-chart-scroll"><div className="company-monthly-chart" role="img" aria-label="월별 참여 및 낙찰 건수. 상세 수치는 아래 월별 집계 표에서 확인할 수 있습니다.">{history.monthly.map(month => <div key={month.month} className="company-chart-month"><div className="company-chart-bars"><span className="company-chart-bar participation" style={{ height: `${Math.max(2, month.participationCount / chartMax * 145)}px` }} title={`참여 ${number(month.participationCount)}건`} /><span className="company-chart-bar wins" style={{ height: `${month.winCount ? Math.max(2, month.winCount / chartMax * 145) : 0}px` }} title={`낙찰 ${number(month.winCount)}건`} /></div><small>{month.month}</small></div>)}</div></div><details className="company-monthly-details"><summary>월별 집계표 보기</summary><div className="company-table-scroll"><table><thead><tr><th scope="col">월</th><th scope="col">참여</th><th scope="col">낙찰</th><th scope="col">낙찰금액</th></tr></thead><tbody>{history.monthly.map(month => <tr key={month.month}><th scope="row">{month.month}</th><td>{number(month.participationCount)}건</td><td>{number(month.winCount)}건</td><td>{money(month.winningAmount)}</td></tr>)}</tbody></table></div></details></> : <div className="company-section-empty">집계할 월별 이력이 없습니다.</div>}
          </section>
          <section className="company-agencies panel"><header className="company-section-heading"><div><h2>수요기관별 실적</h2><p>참여 기관과 낙찰 성과를 비교하세요.</p></div><Building2 size={22} /></header>{history.agencies.length ? <div className="company-table-scroll"><table><thead><tr><th scope="col">수요기관</th><th scope="col">참여 / 낙찰</th><th scope="col">낙찰금액</th></tr></thead><tbody>{history.agencies.map(agency => <tr key={agency.name}><th scope="row">{agency.name || '-'}</th><td>{number(agency.participationCount)} / <strong>{number(agency.winCount)}</strong><small>{rate(agency.winCount, agency.participationCount)}</small></td><td title={money(agency.winningAmount)}>{agency.winningAmount == null ? '-' : `${compactMoney(agency.winningAmount)}원`}</td></tr>)}</tbody></table></div> : <div className="company-section-empty">집계할 수요기관 이력이 없습니다.</div>}</section>
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

        <section className="company-history panel"><header className="company-section-heading"><div><h2>입찰 참여 이력 <span>{number(history.totalCount)}건</span></h2><p>{!filter.from && !filter.to ? '전체 기간' : `${date(filter.from) === '-' ? '처음' : date(filter.from)} ~ ${date(filter.to) === '-' ? '현재' : date(filter.to)}`} · 수집된 공개 이력</p></div><button className="button button-secondary" disabled={!history.items.length} onClick={() => exportPage(history.items, company)}><Download size={16} />현재 페이지 CSV</button></header><div className="company-history-tabs" role="group" aria-label="입찰 이력 결과 필터"><button aria-pressed={filter.outcome === 'all'} className={filter.outcome === 'all' ? 'active' : ''} onClick={() => setFilter({ ...filter, outcome: 'all', page: 1 })}>전체 참여</button><button aria-pressed={filter.outcome === 'won'} className={filter.outcome === 'won' ? 'active' : ''} onClick={() => setFilter({ ...filter, outcome: 'won', page: 1 })}>낙찰 이력</button></div>
          {openingRow && <OpeningResultsPanel key={`${openingRow.type}-${openingRow.number}-${openingRow.revision}`} row={openingRow} activeBusinessNumber={company.businessNumber} onClose={closeResults} onCompany={value => { void findCompanies(value); searchPanel.current?.scrollIntoView({ block: 'start' }); }} />}
          {history.items.length ? <><div className="company-history-desktop company-table-scroll"><table><thead><tr><th scope="col">공고명 / 수요기관</th><th scope="col">결과</th><th scope="col">순위 / 참가업체</th><th scope="col">투찰금액</th><th scope="col">투찰률</th><th scope="col">낙찰금액</th><th scope="col">개찰일</th></tr></thead><tbody>{history.items.map(row => <tr key={row.id}><td className="company-history-title"><small>{row.type} · {row.number}-{row.revision}</small><NoticeTitle row={row} /><span>{row.agency || '-'}{row.method && ` · ${row.method}`}</span>{row.number && <button className="company-opening-trigger" onClick={event => openResults(row, event.currentTarget)}><ListOrdered size={14} />투찰업체·순위 보기</button>}</td><td><Outcome row={row} /></td><td>{row.rank || '-'} / {row.participantCount == null ? '-' : number(row.participantCount)}</td><td className="company-amount">{money(row.bidAmount)}</td><td>{row.bidRate == null ? '-' : `${row.bidRate}%`}</td><td className="company-amount">{money(row.winningAmount)}</td><td>{date(row.openingAt)}</td></tr>)}</tbody></table></div><div className="company-history-mobile">{history.items.map(row => <article key={row.id}><div><span>{row.type} · {date(row.openingAt)}</span><Outcome row={row} /></div><NoticeTitle row={row} /><p>{row.agency || '-'}</p><dl><div><dt>순위 / 참가업체</dt><dd>{row.rank || '-'} / {row.participantCount == null ? '-' : number(row.participantCount)}</dd></div><div><dt>투찰률</dt><dd>{row.bidRate == null ? '-' : `${row.bidRate}%`}</dd></div><div><dt>투찰금액</dt><dd>{money(row.bidAmount)}</dd></div><div><dt>낙찰금액</dt><dd>{money(row.winningAmount)}</dd></div></dl>{row.number && <button className="company-opening-trigger" onClick={event => openResults(row, event.currentTarget)}><ListOrdered size={15} />투찰업체·순위 보기<ChevronRight size={14} /></button>}</article>)}</div></> : <div className="company-section-empty">선택한 조건에 해당하는 수집 이력이 없습니다.</div>}
          <footer className="company-history-footer"><p>{history.totalCount ? `${number((history.page - 1) * history.pageSize + 1)}–${number(Math.min(history.page * history.pageSize, history.totalCount))} / ` : ''}{number(history.totalCount)}건</p><nav aria-label="업체 입찰 이력 페이지" className="company-pagination"><button disabled={pageGroup === 0} aria-label="이전 10개 페이지" onClick={() => setFilter({ ...filter, page: pageGroup })}><ChevronLeft size={17} /></button>{pages.map(page => <button key={page} className={page === filter.page ? 'active' : ''} aria-current={page === filter.page ? 'page' : undefined} onClick={() => setFilter({ ...filter, page })}>{page}</button>)}<button disabled={pageGroup + 10 >= pageCount} aria-label="다음 10개 페이지" onClick={() => setFilter({ ...filter, page: pageGroup + 11 })}><ChevronRight size={17} /></button></nav></footer>
        </section>
      </>}
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
  return <section className="company-group-stats panel"><header className="company-section-heading"><div><h2>{title}</h2><p>{description}</p></div><BarChart3 size={22} /></header><div className="company-group-bars">{rows.map((row, index) => <div className="company-group-row" key={row.name}><div><strong>{row.name || '-'}</strong><span>참여 {number(row.participationCount)}건 <b>{participationTotal ? `${(row.participationCount / participationTotal * 100).toFixed(1)}%` : '-'}</b></span></div><div className="company-group-track" aria-hidden="true"><span className={index % 2 ? 'is-secondary' : ''} style={{ width: `${participationTotal ? row.participationCount / participationTotal * 100 : 0}%` }} /></div><p><span>낙찰 <strong>{number(row.winCount)}건</strong></span><span>{money(row.winningAmount)}</span></p></div>)}</div></section>;
}
