import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, CirclePause, ExternalLink, Info, ListOrdered, LoaderCircle, Play, RefreshCw, Trophy } from 'lucide-react';
import type { PublicCompany } from '../company-types';
import type { CompanyAward, CompanyAwardPage, CompanyAwardQuery } from '../company-award-types';
import { ApiError, koreanToday } from '../live/client';
import { fetchCompanyApi } from './company-request';
import { OpeningResultsPanel } from '../live/OpeningResultsPanel';
import { companyAwardKey, companyAwardTaskKey, companyAwardTasks, mergeCompanyAwards, normalizeAwardDay, type AwardDateRange } from './company-awards';
import './company-awards.css';

type AwardJob = { query: CompanyAwardQuery; status: 'idle' | 'loading' | 'complete' | 'partial' | 'error'; result?: CompanyAwardPage; error?: string; force?: boolean };
const number = (value: number) => value.toLocaleString('ko-KR');
const money = (value: number | null) => value == null ? '-' : `${number(value)}원`;
const day = (value: string) => normalizeAwardDay(value)?.replaceAll('-', '.') || '-';

export function CompanyAwardsPanel({ company, from, to }: { company: PublicCompany; from?: string; to?: string }) {
  const [jobs, setJobs] = useState<AwardJob[]>([]);
  const [running, setRunning] = useState(false);
  const [range, setRange] = useState<AwardDateRange | null>(null);
  const [manualDates, setManualDates] = useState({ from: '', to: to || koreanToday() });
  const [needsStart, setNeedsStart] = useState(false);
  const [issue, setIssue] = useState('');
  const [message, setMessage] = useState('');
  const [page, setPage] = useState(1);
  const [opening, setOpening] = useState<CompanyAward | null>(null);
  const run = useRef<{ token: number; controller: AbortController | null }>({ token: 0, controller: null });
  const jobSnapshot = useRef<AwardJob[]>([]);
  const listHeading = useRef<HTMLHeadingElement | null>(null);

  function publish(next: AwardJob[]) {
    const snapshot = next.map(job => ({ ...job }));
    jobSnapshot.current = snapshot; setJobs(snapshot);
  }

  function stop(showMessage = true) {
    ++run.current.token; run.current.controller?.abort(); run.current.controller = null;
    setRunning(false);
    publish(jobSnapshot.current.map(job => job.status === 'loading' ? { ...job, status: 'idle' } : job));
    if (showMessage) setMessage('조회를 중지했습니다. 확인된 이력은 유지되며 남은 구간을 이어서 조회할 수 있습니다.');
  }

  async function execute(initial: AwardJob[]) {
    run.current.controller?.abort();
    const controller = new AbortController();
    const token = ++run.current.token;
    run.current.controller = controller;
    const work = initial.map(job => ({ ...job }));
    const pending = work.filter(job => job.status !== 'complete');
    let cursor = 0;
    let quotaMessage = '';
    setMessage(''); setIssue(''); setRunning(pending.length > 0); publish(work);
    const current = () => token === run.current.token;
    async function worker() {
      while (current() && !controller.signal.aborted) {
        const job = pending[cursor++];
        if (!job) break;
        job.status = 'loading'; job.error = undefined; publish(work);
        try {
          const params = new URLSearchParams({ ...job.query });
          if (job.force) params.set('refresh', '1');
          const result = await fetchCompanyApi<CompanyAwardPage>(`/api/company-awards?${params}`, controller.signal);
          if (!current()) return;
          if (result.businessNumber !== job.query.businessNumber || result.type !== job.query.type || result.from !== job.query.from || result.to !== job.query.to
            || result.items.some(item => item.businessNumber !== job.query.businessNumber || item.awarded !== true)) {
            throw new Error('요청한 업체·기간의 확정 낙찰 자료인지 확인하지 못했습니다. 해당 구간을 다시 조회해 주세요.');
          }
          job.result = result; job.status = result.complete && result.warnings.length === 0 ? 'complete' : 'partial'; job.force = false;
        } catch (cause) {
          if (!current()) return;
          if (controller.signal.aborted) { job.status = 'idle'; break; }
          job.status = 'error'; job.error = cause instanceof Error ? cause.message : '이 구간을 조회하지 못했습니다.';
          if (cause instanceof ApiError && (cause.status === 429 || /QUOTA|RATE_LIMIT|LIMIT_EXCEEDED/.test(cause.code))) {
            quotaMessage = job.error; controller.abort();
          }
        }
        if (current()) publish(work);
      }
    }
    await Promise.all([worker(), worker()]);
    if (!current()) return;
    for (const job of work) if (job.status === 'loading') job.status = 'idle';
    publish(work); setRunning(false); run.current.controller = null;
    if (quotaMessage) setMessage(`${quotaMessage} 확인된 이력은 유지했습니다. 남은 구간 이어받기로 계속할 수 있습니다.`);
  }

  function begin(next: AwardDateRange) {
    try {
      const queries = companyAwardTasks(company.businessNumber, next.from, next.to);
      const initial = queries.map(query => ({ query, status: 'idle' } as AwardJob));
      setRange(next); setNeedsStart(false); setPage(1); setOpening(null);
      void execute(initial);
    } catch (cause) { setRunning(false); setNeedsStart(true); setIssue(cause instanceof Error ? cause.message : '조회 기간을 확인해 주세요.'); }
  }

  useEffect(() => {
    const start = normalizeAwardDay(from || company.registrationDate);
    const end = normalizeAwardDay(to || koreanToday());
    setOpening(null); setPage(1); setIssue(''); setMessage(''); setRange(null); publish([]);
    setManualDates({ from: start || '', to: end || koreanToday() });
    if (!start) { setNeedsStart(true); setRunning(false); }
    else if (!end) { setNeedsStart(true); setRunning(false); setIssue('조회 종료일을 확인해 주세요.'); }
    else begin({ from: start, to: end });
    return () => { ++run.current.token; run.current.controller?.abort(); run.current.controller = null; };
  }, [company.businessNumber, company.registrationDate, from, to]);

  const rows = useMemo(() => mergeCompanyAwards(...jobs.map(job => job.result?.items ?? [])), [jobs]);
  const completed = jobs.filter(job => job.status === 'complete').length;
  const remaining = jobs.length - completed;
  const incomplete = jobs.filter(job => job.status === 'error' || job.status === 'partial');
  const warningJobs = jobs.filter(job => job.error || job.result?.warnings.length);
  const totalAmount = rows.reduce((sum, item) => sum + (item.winningAmount ?? 0), 0);
  const knownAmounts = rows.filter(item => item.winningAmount !== null).length;
  const knownRates = rows.map(item => item.awardRate).filter((value): value is number => value !== null);
  const averageRate = knownRates.length ? knownRates.reduce((sum, value) => sum + value, 0) / knownRates.length : null;
  const pageCount = Math.max(1, Math.ceil(rows.length / 30));
  const currentPage = Math.min(page, pageCount);
  const visibleRows = rows.slice((currentPage - 1) * 30, currentPage * 30);
  const pageGroup = Math.floor((currentPage - 1) / 10) * 10;
  const pages = Array.from({ length: Math.min(10, pageCount - pageGroup) }, (_, index) => pageGroup + index + 1);
  const allComplete = jobs.length > 0 && completed === jobs.length;
  const progress = jobs.length ? completed / jobs.length * 100 : 0;

  function resume() {
    void execute(jobSnapshot.current.map(job => job.status === 'complete' ? job : { ...job, force: job.force || job.status === 'error' || job.status === 'partial', status: 'idle' }));
  }
  function refreshLatest() {
    const firstMonth = jobSnapshot.current[0]?.query.from.slice(0, 7);
    if (!firstMonth) return;
    void execute(jobSnapshot.current.map(job => job.query.from.slice(0, 7) === firstMonth ? { ...job, status: 'idle', force: true } : job));
  }
  function changePage(next: number) {
    setPage(next); setOpening(null);
    listHeading.current?.focus({ preventScroll: true }); listHeading.current?.scrollIntoView({ block: 'start' });
  }

  return <section className="company-awards panel" aria-label="업체 확정 낙찰 이력">
    <header className="company-awards-heading"><span className="company-awards-symbol"><Trophy size={23} /></span><div><h2>확정 낙찰 이력</h2><p>나라장터에서 이 업체를 최종 낙찰업체로 공개한 공사·용역입니다.</p></div><span className={`company-awards-state${allComplete ? ' is-complete' : ''}`}>{running ? <><LoaderCircle size={13} className="company-awards-spin" />조회 중</> : allComplete ? <><CheckCircle2 size={13} />조회 완료</> : '조회 범위 확인'}</span></header>

    {needsStart ? <form className="company-awards-start" onSubmit={event => { event.preventDefault(); begin(manualDates); }}><div><Info size={18} /><p>{!normalizeAwardDay(company.registrationDate) && !from ? '등록일이 제공되지 않아 전체 조회의 시작일을 정할 수 없습니다. 개찰 시작일을 입력해 주세요.' : '조회할 개찰 시작일과 종료일을 확인해 주세요.'}</p></div><label>개찰 시작일<input required type="date" value={manualDates.from} onChange={event => setManualDates({ ...manualDates, from: event.target.value })} /></label><label>개찰 종료일<input required type="date" value={manualDates.to} onChange={event => setManualDates({ ...manualDates, to: event.target.value })} /></label><button type="submit"><Play size={14} />낙찰 이력 조회</button></form> : range && <div className="company-awards-progress"><div className="company-awards-progress-top"><div><span><CalendarDays size={15} />개찰일 {day(range.from)} ~ {day(range.to)}</span><p>{!from && range.from === normalizeAwardDay(company.registrationDate) ? '업체 등록일' : '선택한 시작일'}부터 조회 · 조회 일수 제한 없음 · 최신 구간부터 확인</p></div><div className="company-awards-controls">{running ? <button onClick={() => stop()}><CirclePause size={15} />조회 중지</button> : remaining > 0 ? <button onClick={resume}><Play size={15} />남은 구간 이어받기</button> : <button onClick={refreshLatest}><RefreshCw size={14} />최신 구간 다시 조회</button>}</div></div><div className="company-awards-progress-track" role="progressbar" aria-label="낙찰 이력 조회 진행률" aria-valuemin={0} aria-valuemax={jobs.length} aria-valuenow={completed}><span style={{ width: `${progress}%` }} /></div><div className="company-awards-progress-meta"><strong>{number(completed)} / {number(jobs.length)}구간 완료</strong><span>공사·용역 포함 · 남은 {number(remaining)}구간{incomplete.length > 0 && ` · 다시 확인 ${number(incomplete.length)}구간`}</span></div></div>}

    {issue && <p className="company-awards-message is-error" role="alert"><Info size={16} />{issue}</p>}
    {message && <p className="company-awards-message" role="status"><Info size={16} />{message}</p>}
    {warningJobs.length > 0 && <details className="company-awards-warnings"><summary>일부 구간 확인 안내 {number(warningJobs.length)}건</summary><ul>{warningJobs.map(job => <li key={companyAwardTaskKey(job.query)}><strong>{job.query.type} · {day(job.query.from)} ~ {day(job.query.to)}</strong>{job.error && <p>{job.error}</p>}{job.result?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</li>)}</ul></details>}

    {range && <>
      <div className="company-awards-metrics"><article><span>확인된 최종 낙찰</span><strong>{rows.length || allComplete ? number(rows.length) : '-'}<small>건</small></strong><p>{allComplete ? '선택한 전체 기간 조회 완료' : '현재 받은 구간 기준'}</p></article><article><span>공개 낙찰금액 합계</span><strong>{knownAmounts ? number(totalAmount) : allComplete && rows.length === 0 ? '0' : '-'}<small>원</small></strong><p>금액이 공개된 {number(knownAmounts)}건 합계</p></article><article><span>평균 낙찰률</span><strong>{averageRate === null ? '-' : number(Math.round(averageRate * 1000) / 1000)}<small>%</small></strong><p>나라장터에 공개된 낙찰률 기준</p></article></div>
      <div className="company-awards-list-heading"><h3 ref={listHeading} tabIndex={-1}>최종 낙찰 공고 <span>{number(rows.length)}건</span></h3><p>{running ? '조회되는 즉시 목록에 추가됩니다.' : allComplete ? '위 개찰 기간에 해당하는 공개 낙찰 이력입니다.' : '아직 조회되지 않은 구간의 이력은 포함되지 않았습니다.'}</p></div>
      {opening && <OpeningResultsPanel key={`${opening.type}-${opening.number}-${opening.revision}`} row={opening} activeBusinessNumber={company.businessNumber} onClose={() => setOpening(null)} />}
      {rows.length > 0 ? <><div className="company-awards-desktop"><table><thead><tr><th scope="col">공고명 / 수요기관</th><th scope="col">입찰분류 / 재입찰</th><th scope="col">낙찰금액</th><th scope="col">낙찰률</th><th scope="col">개찰일</th><th scope="col">낙찰일</th></tr></thead><tbody>{visibleRows.map(item => <tr key={companyAwardKey(item)}><td><AwardTitle item={item} /><p>{item.agency || '-'}{item.method && ` · ${item.method}`}</p><button className="company-awards-detail" onClick={() => setOpening(item)}><ListOrdered size={13} />투찰업체·순위 보기</button></td><td>{item.classification || '-'} / {item.rebid || '-'}</td><td className="company-awards-price">{money(item.winningAmount)}</td><td>{item.awardRate == null ? '-' : `${item.awardRate}%`}</td><td>{day(item.openingAt)}</td><td>{day(item.awardDate)}</td></tr>)}</tbody></table></div><div className="company-awards-mobile">{visibleRows.map(item => <article key={companyAwardKey(item)}><AwardTitle item={item} /><p>{item.agency || '-'}{item.method && ` · ${item.method}`}</p><dl><div><dt>낙찰금액</dt><dd>{money(item.winningAmount)}</dd></div><div><dt>낙찰률</dt><dd>{item.awardRate == null ? '-' : `${item.awardRate}%`}</dd></div><div><dt>입찰분류 / 재입찰</dt><dd>{item.classification || '-'} / {item.rebid || '-'}</dd></div><div><dt>개찰일 / 낙찰일</dt><dd>{day(item.openingAt)} / {day(item.awardDate)}</dd></div></dl><button className="company-awards-detail" onClick={() => setOpening(item)}><ListOrdered size={14} />투찰업체·순위 보기<ChevronRight size={14} /></button></article>)}</div></> : <div className="company-awards-empty">{running ? <><LoaderCircle size={23} className="company-awards-spin" /><strong>최신 구간부터 과거 낙찰 이력을 확인하고 있습니다.</strong><p>일부 구간에 결과가 없어도 남은 기간을 계속 조회합니다.</p></> : allComplete ? <><Trophy size={26} /><strong>선택한 개찰 기간에 공개된 최종 낙찰 이력이 없습니다.</strong></> : <><Info size={23} /><strong>아직 확인된 최종 낙찰 이력이 없습니다.</strong><p>남은 구간을 조회하면 과거 이력이 추가될 수 있습니다.</p></>}</div>}
      {rows.length > 0 && <footer className="company-awards-pagination"><p>{number((currentPage - 1) * 30 + 1)}–{number(Math.min(currentPage * 30, rows.length))} / {number(rows.length)}건 · 30건씩 표시</p><nav aria-label="최종 낙찰 이력 페이지"><button disabled={pageGroup === 0} aria-label="이전 10개 페이지" onClick={() => changePage(pageGroup)}><ChevronLeft size={16} /></button>{pages.map(value => <button key={value} aria-current={currentPage === value ? 'page' : undefined} className={currentPage === value ? 'active' : ''} onClick={() => changePage(value)}>{value}</button>)}<button disabled={pageGroup + 10 >= pageCount} aria-label="다음 10개 페이지" onClick={() => changePage(pageGroup + 11)}><ChevronRight size={16} /></button></nav></footer>}
    </>}
  </section>;
}

function AwardTitle({ item }: { item: CompanyAward }) {
  return <div className="company-awards-title"><small>{item.type} · {item.number}-{item.revision}</small><a href={`/notice-detail.html?${new URLSearchParams({ number: item.number, revision: item.revision, type: item.type })}`} target="_blank" rel="noreferrer">{item.title || item.number}<ExternalLink size={12} /></a></div>;
}
