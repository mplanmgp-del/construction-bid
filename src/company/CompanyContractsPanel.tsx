import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, CirclePause, ExternalLink, FileCheck2, Info, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import type { PublicCompany } from '../company-types';
import type { CompanyContract, CompanyContractPage } from '../company-contract-types';
import { ApiError, koreanToday } from '../live/client';
import { fetchCompanyApi } from './company-request';
import { normalizeAwardDay, type AwardDateRange } from './company-awards';
import { appendContractPage, ContractPageError, contractJobKey, createContractJobs, mergeCompanyContracts, restartContractJob, type ContractJob } from './company-contracts';
import './company-contracts.css';

const number = (value: number) => value.toLocaleString('ko-KR');
const money = (value: number | null) => value == null ? '-' : `${number(value)}원`;
const day = (value: string) => normalizeAwardDay(value)?.replaceAll('-', '.') || '-';
const messageFor = (error: unknown) => error instanceof Error && /[가-힣]/.test(error.message)
  ? error.message : '계약 자료를 조회하지 못했습니다. 연결 상태를 확인한 뒤 이어서 조회해 주세요.';

export function CompanyContractsPanel({ company, from, to }: { company: PublicCompany; from?: string; to?: string }) {
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
    const work = initial.map(job => ({ ...job }));
    const pending = work.map((job, index) => job.status === 'complete' ? -1 : index).filter(index => index >= 0);
    let cursor = 0, quotaMessage = '';
    const current = () => run.current.token === token;
    setRunning(pending.length > 0); setMessage(''); setIssue(''); publish(work);
    async function worker() {
      while (current() && !controller.signal.aborted) {
        const index = pending[cursor++];
        if (index === undefined) break;
        if (work[index].restartRequired) work[index] = restartContractJob(work[index]);
        while (current() && !controller.signal.aborted) {
          work[index] = { ...work[index], status: 'loading', error: undefined }; publish(work);
          try {
            const q = work[index].query;
            const params = new URLSearchParams({ businessNumber: q.businessNumber, type: q.type, from: q.from, to: q.to, page: String(q.page) });
            const result = await fetchCompanyApi<CompanyContractPage>(`/api/company-contracts?${params}`, controller.signal);
            if (!current()) return;
            work[index] = appendContractPage(work[index], result); publish(work);
            if (!result.hasMore) break;
          } catch (cause) {
            if (!current()) return;
            if (controller.signal.aborted) { work[index] = { ...work[index], status: 'idle' }; break; }
            const error = messageFor(cause);
            work[index] = { ...work[index], status: 'error', error,
              restartRequired: cause instanceof ContractPageError || (cause instanceof ApiError && /COMPANY_CONTRACTS_(CHANGED|INCOMPLETE)/.test(cause.code)) };
            if (cause instanceof ApiError && (cause.status === 429 || /QUOTA|RATE_LIMIT|LIMIT_EXCEEDED/.test(cause.code))) {
              quotaMessage = error; controller.abort();
            }
            publish(work); break;
          }
        }
      }
    }
    await Promise.all([worker(), worker()]);
    if (!current()) return;
    publish(work.map(job => job.status === 'loading' ? { ...job, status: 'idle' } : job));
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
    const start = normalizeAwardDay(from || company.registrationDate), end = normalizeAwardDay(to || koreanToday());
    publish([]); setRange(null); setPage(1); setMessage(''); setIssue('');
    setManualDates({ from: start || '', to: end || koreanToday() });
    if (!start || !end) { setNeedsStart(true); setRunning(false); }
    else begin({ from: start, to: end });
    return () => { ++run.current.token; run.current.controller?.abort(); run.current.controller = null; };
  }, [company.businessNumber, company.registrationDate, from, to]);

  const rows = useMemo(() => mergeCompanyContracts(...jobs.flatMap(job => [job.previousItems, job.items]))
    .filter(item => item.businessNumber === company.businessNumber), [jobs, company.businessNumber]);
  const completed = jobs.filter(job => job.status === 'complete').length;
  const allComplete = jobs.length > 0 && completed === jobs.length;
  const remaining = jobs.length - completed;
  const warnings = jobs.filter(job => job.error || job.warnings.length > 0);
  const receivedPages = jobs.reduce((sum, job) => sum + job.fingerprints.length, 0);
  const active = jobs.filter(job => job.status === 'loading');
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
    <header className="company-contracts-heading"><span className="company-contracts-symbol"><FileCheck2 size={23} /></span><div><h2>계약 이력</h2><p>입찰공고 없이 체결한 수의계약을 포함해 공사·용역 계약을 확인합니다.</p></div><span className={`company-contracts-state${allComplete ? ' is-complete' : ''}`}>{running ? <><LoaderCircle size={14} className="company-contracts-spin" />조회 중</> : allComplete ? <><CheckCircle2 size={14} />조회 완료</> : '조회 범위 확인'}</span></header>
    {needsStart ? <form className="company-contracts-start" onSubmit={event => { event.preventDefault(); begin(manualDates); }}><p><Info size={17} />{!normalizeAwardDay(company.registrationDate) && !from ? '업체 등록일이 제공되지 않았습니다. 계약 조회 시작일을 입력해 주세요.' : '계약 조회 기간을 확인해 주세요.'}</p><label>계약 시작일<input required type="date" value={manualDates.from} onChange={event => setManualDates({ ...manualDates, from: event.target.value })} /></label><label>계약 종료일<input required type="date" value={manualDates.to} onChange={event => setManualDates({ ...manualDates, to: event.target.value })} /></label><button type="submit"><Play size={15} />계약 이력 조회</button></form> : range && <div className="company-contracts-progress"><div className="company-contracts-progress-top"><div><strong><CalendarDays size={15} />계약일 {day(range.from)} ~ {day(range.to)}</strong><p>최신 구간부터 조회 · 받은 계약은 바로 표시됩니다.</p></div><div className="company-contracts-controls">{running ? <button onClick={stop}><CirclePause size={15} />조회 중지</button> : remaining > 0 ? <button onClick={() => { void execute(snapshot.current); }}><Play size={15} />남은 구간 이어받기</button> : <button onClick={refreshLatest}><RefreshCw size={15} />최신 구간 다시 조회</button>}</div></div><div className="company-contracts-track" role="progressbar" aria-label="계약 이력 조회 진행률" aria-valuemin={0} aria-valuemax={jobs.length} aria-valuenow={completed}><span style={{ width: `${jobs.length ? completed / jobs.length * 100 : 0}%` }} /></div><div className="company-contracts-progress-meta"><strong>{number(completed)} / {number(jobs.length)}구간 완료</strong><span>{number(receivedPages)}쪽 확인{active.length > 0 && ` · ${active.map(job => `${job.query.from.slice(0, 7).replace('-', '.')} ${job.query.type} ${number(job.query.page)}쪽`).join(' / ')}`}</span></div></div>}
    {issue && <p className="company-contracts-message is-error" role="alert"><Info size={16} />{issue}</p>}
    {message && <p className="company-contracts-message" role="status"><Info size={16} />{message}</p>}
    {warnings.length > 0 && <details className="company-contracts-warnings"><summary>일부 구간 확인 안내 {number(warnings.length)}건</summary><ul>{warnings.map(job => <li key={contractJobKey(job)}><strong>{job.query.type} · {day(job.query.from)} ~ {day(job.query.to)}</strong>{job.error && <p>{job.error}</p>}{job.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</li>)}</ul></details>}
    {range && <>
      <div className="company-contracts-list-heading"><h3 ref={heading} tabIndex={-1}>확인된 계약 <span>{number(rows.length)}건</span>{running && <small> · 조회 중</small>}</h3><p>수의계약 {number(negotiated)}건 포함{!allComplete && ' · 아직 조회하지 않은 이력이 있을 수 있습니다.'}</p></div>
      <p className="company-contracts-note"><Info size={14} />계약금액은 공개된 금차 총액입니다. 공동계약의 업체별 수주금액과 다를 수 있으며, 변경계약은 계약번호별로 표시합니다.</p>
      {rows.length > 0 ? <><div className="company-contracts-desktop"><table><thead><tr><th scope="col">계약명</th><th scope="col">계약기관</th><th scope="col">계약일</th><th scope="col">계약방법</th><th scope="col">계약금액</th><th scope="col">업체 지분</th></tr></thead><tbody>{visible.map(item => <tr key={item.id}><td><ContractTitle item={item} /></td><td>{item.agency || '-'}</td><td>{day(item.contractDate)}</td><td><span className={item.method.includes('수의') ? 'company-contracts-negotiated' : ''}>{item.method || '-'}</span></td><td className="company-contracts-money">{money(item.contractAmount)}</td><td>{item.shareRate == null ? '-' : `${number(item.shareRate)}%`}</td></tr>)}</tbody></table></div><div className="company-contracts-mobile">{visible.map(item => <article key={item.id}><ContractTitle item={item} /><p>{item.agency || '-'}</p><dl><div><dt>계약일</dt><dd>{day(item.contractDate)}</dd></div><div><dt>계약방법</dt><dd>{item.method || '-'}</dd></div><div><dt>계약금액</dt><dd>{money(item.contractAmount)}</dd></div><div><dt>업체 지분</dt><dd>{item.shareRate == null ? '-' : `${number(item.shareRate)}%`}</dd></div></dl></article>)}</div></> : <div className="company-contracts-empty">{running ? <><LoaderCircle size={24} className="company-contracts-spin" /><strong>확인된 계약 0건 · 조회 중</strong><p>일부 목록에 결과가 없어도 남은 구간을 계속 확인합니다.</p></> : allComplete ? <><FileCheck2 size={25} /><strong>선택한 계약 기간에 공개된 계약이 없습니다.</strong></> : <><Info size={24} /><strong>현재 확인된 계약 0건</strong><p>아직 조회되지 않은 구간이 있습니다. 남은 구간을 이어서 확인해 주세요.</p></>}</div>}
      {rows.length > 0 && <footer className="company-contracts-pagination"><p>{number((currentPage - 1) * 30 + 1)}–{number(Math.min(currentPage * 30, rows.length))} / {number(rows.length)}건 · 30건씩 표시</p><nav aria-label="계약 이력 페이지"><button disabled={pageGroup === 0} aria-label="이전 10개 페이지" onClick={() => changePage(pageGroup)}><ChevronLeft size={16} /></button>{pages.map(value => <button key={value} className={currentPage === value ? 'active' : ''} aria-current={currentPage === value ? 'page' : undefined} onClick={() => changePage(value)}>{value}</button>)}<button disabled={pageGroup + 10 >= pageCount} aria-label="다음 10개 페이지" onClick={() => changePage(pageGroup + 11)}><ChevronRight size={16} /></button></nav></footer>}
    </>}
  </section>;
}

function ContractTitle({ item }: { item: CompanyContract }) {
  return <div className="company-contracts-title"><small>{item.type} · {item.contractNumber || item.unifiedContractNumber}</small>{item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.title || '계약명 -'}<ExternalLink size={12} /></a> : <strong>{item.title || '계약명 -'}</strong>}</div>;
}
