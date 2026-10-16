import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, CirclePause, ExternalLink, FileCheck2, Info, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import type { PublicCompany } from '../company-types';
import type { CompanyContract, CompanyContractPage } from '../company-contract-types';
import { koreanToday } from '../live/client';
import { fetchCompanyApi } from './company-request';
import { normalizeAwardDay, type AwardDateRange } from './company-awards';
import { contractJobKey, createContractJobs, mergeCompanyContracts, restartContractJob, runContractJobs, type ContractJob } from './company-contracts';

const number = (value: number) => value.toLocaleString('ko-KR');
const money = (value: number | null) => value == null ? '-' : `${number(value)}원`;
const day = (value: string) => normalizeAwardDay(value)?.replaceAll('-', '.') || '-';
const messageFor = (error: unknown) => error instanceof Error && /[가-힣]/.test(error.message)
  ? error.message : '계약 자료를 조회하지 못했습니다. 연결 상태를 확인한 뒤 이어서 조회해 주세요.';

export function CompanyContractsPanel({ company, from, to, registrationPending = false, refreshKey = 0 }: {
  company: PublicCompany; from?: string; to?: string; registrationPending?: boolean; refreshKey?: number;
}) {
  const [jobs, setJobs] = useState<ContractJob[]>([]);
  const [running, setRunning] = useState(false);
  const [range, setRange] = useState<AwardDateRange | null>(null);
  const [manualDates, setManualDates] = useState({ from: '', to: to || koreanToday() });
  const [needsStart, setNeedsStart] = useState(false);
  const [message, setMessage] = useState('');
  const [issue, setIssue] = useState('');
  const [page, setPage] = useState(1);
  const run = useRef<{ token: number; controller: AbortController | null }>({ token: 0, controller: null });
  const snapshot = useRef<ContractJob[]>([]);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const automaticStart = normalizeAwardDay(from || company.registrationDate);
  const automaticEnd = normalizeAwardDay(to || koreanToday());
  const waitingForRegistration = registrationPending && !automaticStart;
  const seenRefresh = useRef(refreshKey);

  function publish(next: ContractJob[]) {
    const copy = next.map(job => ({ ...job }));
    snapshot.current = copy; setJobs(copy);
  }
  function stop() {
    ++run.current.token; run.current.controller?.abort(); run.current.controller = null;
    publish(snapshot.current.map(job => job.status === 'loading' ? { ...job, status: 'idle' } : job));
    setRunning(false); setMessage('조회를 중지했습니다. 확인된 계약은 유지되며 남은 구간을 이어서 조회할 수 있습니다.');
  }
  async function execute(initial: ContractJob[]) {
    run.current.controller?.abort();
    const controller = new AbortController(), token = ++run.current.token;
    run.current.controller = controller;
    const current = () => run.current.token === token;
    setRunning(initial.some(job => job.status !== 'complete')); setMessage(''); setIssue('');
    const { jobs: work, quotaMessage } = await runContractJobs(initial, {
      signal: controller.signal,
      load: async (q, signal) => {
        const params = new URLSearchParams({ businessNumber: q.businessNumber, type: q.type, from: q.from, to: q.to, page: String(q.page) });
        return fetchCompanyApi<CompanyContractPage>(`/api/company-contracts?${params}`, signal);
      },
      onUpdate: next => { if (current()) publish(next); },
    });
    if (!current()) return;
    publish(work);
    setRunning(false); run.current.controller = null;
    if (quotaMessage) setMessage(`${quotaMessage} 확인된 계약은 유지했습니다. 남은 구간 이어받기로 계속할 수 있습니다.`);
  }
  function begin(next: AwardDateRange) {
    try {
      const initial = createContractJobs(company.businessNumber, next.from, next.to);
      setRange(next); setNeedsStart(false); setPage(1); void execute(initial);
    } catch (cause) { setNeedsStart(true); setRunning(false); setIssue(messageFor(cause)); }
  }
  useEffect(() => {
    const start = automaticStart, end = automaticEnd;
    seenRefresh.current = refreshKey;
    publish([]); setRange(null); setPage(1); setMessage(''); setIssue('');
    setManualDates({ from: start || '', to: end || koreanToday() });
    if (!start) { setNeedsStart(!waitingForRegistration); setRunning(false); }
    else if (!end) { setNeedsStart(true); setRunning(false); setIssue('계약 조회 종료일을 확인해 주세요.'); }
    else begin({ from: start, to: end });
    return () => { ++run.current.token; run.current.controller?.abort(); run.current.controller = null; };
  }, [company.businessNumber, automaticStart, automaticEnd, waitingForRegistration]);
  useEffect(() => {
    if (seenRefresh.current === refreshKey) return;
    seenRefresh.current = refreshKey;
    refreshLatest();
  }, [refreshKey]);

  const rows = useMemo(() => mergeCompanyContracts(...jobs.flatMap(job => [job.previousItems, job.items]))
    .filter(item => item.businessNumber === company.businessNumber), [jobs, company.businessNumber]);
  const completed = jobs.filter(job => job.status === 'complete').length;
  const allComplete = jobs.length > 0 && completed === jobs.length;
  const remaining = jobs.length - completed;
  const warnings = jobs.filter(job => job.error || job.warnings.length > 0);
  const negotiated = rows.filter(item => item.method.includes('수의')).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / 30)), currentPage = Math.min(page, pageCount);
  const visible = rows.slice((currentPage - 1) * 30, currentPage * 30);
  const pageGroup = Math.floor((currentPage - 1) / 10) * 10;
  const pages = Array.from({ length: Math.min(10, pageCount - pageGroup) }, (_, index) => pageGroup + index + 1);
  function refreshLatest() {
    const month = snapshot.current[0]?.query.from.slice(0, 7);
    if (month) void execute(snapshot.current.map(job => job.query.from.slice(0, 7) === month ? restartContractJob(job) : job));
  }
  function changePage(next: number) {
    setPage(next); heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'start' });
  }

  return <section className="company-contracts panel" aria-label="업체 계약 이력">
    <header className="company-contracts-heading"><span className="company-contracts-symbol"><FileCheck2 size={21} /></span><div><h2 ref={heading} tabIndex={-1}>수주·계약 이력 <span>{rows.length || allComplete ? `${number(rows.length)}건` : '확인 중'}</span></h2><p>수의계약 포함 · 나라장터 공식 계약정보를 확인되는 즉시 표시합니다.</p></div><span className={`company-contracts-state${allComplete ? ' is-complete' : ''}`}>{waitingForRegistration ? <><LoaderCircle size={14} className="company-contracts-spin" />등록일 확인 중</> : running ? <><LoaderCircle size={14} className="company-contracts-spin" />조회 중</> : allComplete ? <><CheckCircle2 size={14} />조회 완료</> : '조회 준비'}</span></header>
    {waitingForRegistration && <p className="company-contracts-message" role="status"><LoaderCircle size={16} className="company-contracts-spin" />전체 기간을 조회하기 위해 공식 업체 등록일을 확인하고 있습니다.</p>}
    {needsStart && !waitingForRegistration ? <form className="company-contracts-start" onSubmit={event => { event.preventDefault(); begin(manualDates); }}><p><Info size={17} />{!automaticStart ? '업체 등록일이 제공되지 않았습니다. 계약 조회 시작일을 입력해 주세요.' : '계약 조회 기간을 확인해 주세요.'}</p><label>계약 시작일<input required type="date" value={manualDates.from} onChange={event => setManualDates({ ...manualDates, from: event.target.value })} /></label><label>계약 종료일<input required type="date" value={manualDates.to} onChange={event => setManualDates({ ...manualDates, to: event.target.value })} /></label><button type="submit"><Play size={15} />계약 이력 조회</button></form> : range && <div className="company-contracts-progress"><div className="company-contracts-progress-top"><div><strong><CalendarDays size={15} />계약일 {day(range.from)} ~ {day(range.to)}</strong><p>{!from && range.from === normalizeAwardDay(company.registrationDate) ? '업체 등록일' : '선택한 시작일'}부터 전체 기간 · 최신 구간부터 확인</p></div><div className="company-contracts-controls">{running ? <button onClick={stop}><CirclePause size={15} />조회 중지</button> : remaining > 0 ? <button onClick={() => { void execute(snapshot.current); }}><Play size={15} />남은 구간 이어받기</button> : <button onClick={refreshLatest}><RefreshCw size={15} />최신 구간 다시 조회</button>}</div></div><div className="company-contracts-track" role="progressbar" aria-label="계약 이력 조회 진행률" aria-valuemin={0} aria-valuemax={jobs.length} aria-valuenow={completed}><span style={{ width: `${jobs.length ? completed / jobs.length * 100 : 0}%` }} /></div><div className="company-contracts-progress-meta"><strong>{number(completed)} / {number(jobs.length)}구간 완료</strong><span>공사·용역 포함 · 받은 계약은 바로 표시</span></div></div>}
    {issue && <p className="company-contracts-message is-error" role="alert"><Info size={16} />{issue}</p>}
    {message && <p className="company-contracts-message" role="status"><Info size={16} />{message}</p>}
    {warnings.length > 0 && <details className="company-contracts-warnings"><summary>일부 구간 확인 안내 {number(warnings.length)}건</summary><ul>{warnings.map(job => <li key={contractJobKey(job)}><strong>{job.query.type} · {day(job.query.from)} ~ {day(job.query.to)}</strong>{job.error && <p>{job.error}</p>}{job.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</li>)}</ul></details>}
    {range && <>
      <div className="company-contracts-list-heading"><p>수의계약 {number(negotiated)}건 포함{!allComplete && ' · 전체 기간 조회 중에는 이력이 추가될 수 있습니다.'}</p></div>
      {rows.length > 0 ? <CompanyContractRecords rows={visible} /> : <div className="company-contracts-empty">{running ? <><LoaderCircle size={24} className="company-contracts-spin" /><strong>계약 이력을 확인하고 있습니다.</strong><p>받은 계약은 바로 표시되며 남은 기간도 계속 확인합니다.</p></> : allComplete ? <><FileCheck2 size={25} /><strong>선택한 계약 기간에 공개된 계약이 없습니다.</strong></> : <><Info size={24} /><strong>계약 이력 확인이 아직 완료되지 않았습니다.</strong><p>남은 구간을 이어서 확인해 주세요.</p></>}</div>}
      {rows.length > 0 && <p className="company-contracts-note"><Info size={14} />공개된 금차 계약금액 기준 · 공동계약 금액은 업체별 수주금액과 다를 수 있습니다.</p>}
      {rows.length > 0 && <footer className="company-contracts-pagination"><p>{number((currentPage - 1) * 30 + 1)}–{number(Math.min(currentPage * 30, rows.length))} / {number(rows.length)}건 · 30건씩 표시</p><nav aria-label="계약 이력 페이지"><button disabled={pageGroup === 0} aria-label="이전 10개 페이지" onClick={() => changePage(pageGroup)}><ChevronLeft size={16} /></button>{pages.map(value => <button key={value} className={currentPage === value ? 'active' : ''} aria-current={currentPage === value ? 'page' : undefined} onClick={() => changePage(value)}>{value}</button>)}<button disabled={pageGroup + 10 >= pageCount} aria-label="다음 10개 페이지" onClick={() => changePage(pageGroup + 11)}><ChevronRight size={16} /></button></nav></footer>}
    </>}
  </section>;
}

export function CompanyContractRecords({ rows }: { rows: CompanyContract[] }) {
  return <><div className="company-contracts-desktop"><table><thead><tr><th scope="col">계약명</th><th scope="col">구분</th><th scope="col">계약기관</th><th scope="col">계약금액</th><th scope="col">계약방식</th><th scope="col">계약일</th></tr></thead><tbody>{rows.map(item => <tr key={item.id}><td><ContractTitle item={item} /></td><td><span className="company-contracts-type">{item.type}</span></td><td>{item.agency || '-'}</td><td className="company-contracts-money">{money(item.contractAmount)}{item.shareRate !== null && item.shareRate < 100 && <small>업체 지분 {number(item.shareRate)}%</small>}</td><td><ContractMethod method={item.method} /></td><td>{day(item.contractDate)}</td></tr>)}</tbody></table></div><div className="company-contracts-mobile">{rows.map(item => <article key={item.id}><div className="company-contracts-card-top"><span className="company-contracts-type">{item.type}</span><ContractMethod method={item.method} /></div><ContractTitle item={item} /><p>{item.agency || '-'}</p><dl><div><dt>계약금액</dt><dd>{money(item.contractAmount)}</dd></div><div><dt>계약일</dt><dd>{day(item.contractDate)}</dd></div>{item.shareRate !== null && item.shareRate < 100 && <div><dt>업체 지분</dt><dd>{number(item.shareRate)}%</dd></div>}</dl></article>)}</div></>;
}

function ContractMethod({ method }: { method: string }) {
  return <span className={method.includes('수의') ? 'company-contracts-negotiated' : ''}>{method || '-'}</span>;
}

function ContractTitle({ item }: { item: CompanyContract }) {
  return <div className="company-contracts-title">{item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.title || '-'}<ExternalLink size={12} /></a> : <strong>{item.title || '-'}</strong>}<small>{item.contractNumber || item.unifiedContractNumber || '-'}</small></div>;
}
