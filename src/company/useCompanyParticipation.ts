import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicCompany } from '../company-types';
import type { CompanyParticipationPage, CompanyParticipationQuery } from '../company-live-types';
import { koreanToday } from '../live/client';
import { normalizeAwardDay } from './company-awards';
import { fetchCompanyApi } from './company-request';
import { companyParticipationTasks, liveCompanyHistory, participationPageRestartReason } from './company-live-summary';

type Job = { query: CompanyParticipationQuery; status: 'idle' | 'loading' | 'complete' | 'partial' | 'error'; pages: CompanyParticipationPage[]; error?: string };

export function useCompanyParticipation(company: PublicCompany | null, filter: { from: string; to: string; page: number; outcome: 'all' | 'won' }, refresh: number) {
  const [jobs, setJobs] = useState<Job[]>([]), [running, setRunning] = useState(false), [message, setMessage] = useState('');
  const snapshot = useRef<Job[]>([]), run = useRef({ token: 0, controller: null as AbortController | null });
  const from = normalizeAwardDay(filter.from || company?.registrationDate), to = normalizeAwardDay(filter.to || koreanToday());
  function publish(work: Job[]) { snapshot.current = work.map(job => ({ ...job, query: { ...job.query }, pages: [...job.pages] })); setJobs(snapshot.current); }
  async function execute(initial: Job[]) {
    run.current.controller?.abort(); const controller = new AbortController(); run.current.controller = controller;
    const token = ++run.current.token, current = () => run.current.token === token;
    const work = initial.map(job => ({ ...job, query: { ...job.query }, pages: [...job.pages] }));
    const pending = work.filter(job => job.status !== 'complete'); let cursor = 0;
    setRunning(pending.length > 0); setMessage('');
    async function worker() {
      while (current() && !controller.signal.aborted) {
        const job = pending[cursor++]; if (!job) return;
        job.status = 'loading'; job.error = undefined; publish(work);
        try {
          for (;;) {
            const params = new URLSearchParams({ businessNumber: job.query.businessNumber, type: job.query.type, day: job.query.day, from: job.query.day, to: job.query.day, page: String(job.query.page) });
            const result = await fetchCompanyApi<CompanyParticipationPage>(`/api/company-participation?${params}`, controller.signal);
            if (!current() || controller.signal.aborted) return;
            if (result.businessNumber !== job.query.businessNumber || result.day !== job.query.day || result.type !== job.query.type || result.page !== job.query.page || result.items.some(row => row.businessNumber !== job.query.businessNumber)) throw new Error('조회한 업체·날짜와 응답이 일치하지 않습니다.');
            const restartReason = participationPageRestartReason(job.pages, result);
            if (restartReason) { job.pages = []; job.query.page = 1; throw new Error(restartReason); }
            job.pages = [...job.pages.filter(page => page.page !== result.page), result];
            if (!result.complete || result.warnings.length) { job.status = 'partial'; job.error = result.warnings.join(' ') || '이 페이지의 조회를 완료하지 못했습니다.'; break; }
            if (!result.hasMore) { job.status = 'complete'; break; }
            job.query.page = result.page + 1; publish(work);
          }
        } catch (cause) {
          if (!current()) return;
          if (controller.signal.aborted) { job.status = 'idle'; return; }
          job.status = 'error'; job.error = cause instanceof Error ? cause.message : '참여 이력을 불러오지 못했습니다.';
          setMessage(`${job.error} 받은 이력은 유지했습니다. 남은 구간을 이어서 조회할 수 있습니다.`); controller.abort();
        }
        if (current()) publish(work);
      }
    }
    await Promise.all([worker(), worker()]);
    if (!current()) return;
    for (const job of work) if (job.status === 'loading') job.status = 'idle';
    publish(work); setRunning(false); run.current.controller = null;
  }
  useEffect(() => {
    publish([]); setMessage(''); setRunning(false);
    if (company && from && to && from <= to) void execute(companyParticipationTasks(company.businessNumber, from, to).map(query => ({ query, status: 'idle', pages: [] })));
    else if (company) setMessage(!from ? '등록일이 제공되지 않아 전체 조회의 시작일을 정할 수 없습니다. 개찰 시작일을 입력한 뒤 적용해 주세요.' : '조회 시작일과 종료일을 확인해 주세요.');
    return () => { ++run.current.token; run.current.controller?.abort(); run.current.controller = null; };
  }, [company?.businessNumber, from, to, refresh]);
  const completed = jobs.filter(job => job.status === 'complete').length, complete = jobs.length > 0 && completed === jobs.length;
  const history = useMemo(() => company && from && to && jobs[0]?.query.businessNumber === company.businessNumber && jobs[0]?.query.day === to && jobs.at(-1)?.query.day === from ? liveCompanyHistory(company, jobs.flatMap(job => job.pages.flatMap(page => page.items)), { ...filter, from, to, complete, fetchedAt: jobs.flatMap(job => job.pages.map(page => page.fetchedAt)).sort().at(-1) || '' }) : null, [company, from, to, filter.page, filter.outcome, jobs, complete]);
  function stop() { ++run.current.token; run.current.controller?.abort(); run.current.controller = null; publish(snapshot.current.map(job => job.status === 'loading' ? { ...job, status: 'idle' } : job)); setRunning(false); setMessage('조회를 중지했습니다. 확인된 이력은 유지하며 남은 날짜와 페이지를 이어서 조회할 수 있습니다.'); }
  function resume() { void execute(snapshot.current.map(job => job.status === 'complete' ? job : { ...job, status: 'idle' })); }
  const problems = jobs.filter(job => job.status === 'error' || job.status === 'partial');
  return { history, running, message, completed, total: jobs.length, pages: jobs.reduce((sum, job) => sum + job.pages.length, 0), errors: problems.length, problems: problems.slice(0, 5).map(job => ({ day: job.query.day, type: job.query.type, message: job.error })), stop, resume, from, to, complete };
}
