import { useEffect, useRef, useState } from 'react';
import type { G2bBusinessType, G2bOpeningResult, G2bResultPage } from '../g2b-types';
import type { BidNotice } from '../types';
import { formatDateTime, formatPrice } from '../domain';
import { dateRangeError, fetchApi, koreanToday, mergeById, recentDates } from './client';

export function PublicResults({ bid }: { bid?: BidNotice }) {
  const [query, setQuery] = useState(() => {
    const openingDate = bid?.openingAt && Number.isFinite(Date.parse(bid.openingAt)) ? koreanToday(new Date(bid.openingAt)) : '';
    return { type: (bid?.type ?? '공사') as G2bBusinessType, ...(openingDate ? { from: openingDate, to: openingDate } : recentDates(1)) };
  });
  const [draft, setDraft] = useState(query);
  const [number, setNumber] = useState(bid?.number ?? '');
  const [company, setCompany] = useState('');
  const [rows, setRows] = useState<G2bOpeningResult[]>([]);
  const [meta, setMeta] = useState<G2bResultPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const [refresh, setRefresh] = useState(0);

  async function load(page = 1) {
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const token = ++requestId.current;
    setLoading(true); setError('');
    if (page === 1) { setRows([]); setMeta(null); }
    try {
      const result = await fetchApi<G2bResultPage>(`/api/results?${new URLSearchParams({ ...query, page: String(page), pageSize: '100' })}`, abort.signal);
      if (token !== requestId.current) return;
      setRows(previous => mergeById(page === 1 ? [] : previous, result.items)); setMeta(result);
    } catch (cause) { if (!abort.signal.aborted && token === requestId.current) setError(cause instanceof Error ? cause.message : '공개 결과 조회에 실패했습니다.'); }
    finally { if (token === requestId.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { requestId.current++; controller.current?.abort(); }; }, [query, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && !loading && !error && (meta?.page ?? 1) === 1) setRefresh(value => value + 1); }, 300_000);
    return () => window.clearInterval(timer);
  }, [loading, error, meta?.page]);
  const filtered = rows.filter(row => (!number.trim() || row.number.includes(number.trim())) && (!bid || row.revision === bid.revision) && (!company.trim() || `${row.companyName} ${row.businessNumber} ${row.winnerName} ${row.winnerBusinessNumber}`.includes(company.trim())));
  return <section className="public-results panel" aria-label="공개 개찰 결과">
    <header><h2>공개 개찰·낙찰 결과</h2><p>나라장터 공공데이터개방표준서비스의 공개 자료입니다. 입찰서 제출 접수 여부와는 별개입니다.</p></header>
    <form className="live-query" onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const next = { type: bid?.type ?? form.get('type') as G2bBusinessType, from: String(form.get('from') ?? ''), to: String(form.get('to') ?? '') };
      const issue = dateRangeError(next.from, next.to, 7); setError(issue ?? '');
      if (!issue) { setDraft(next); setQuery(next); setRefresh(value => value + 1); }
    }}>
      <label>업무<select name="type" disabled={Boolean(bid)} value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value as G2bBusinessType })}><option>공사</option><option>용역</option></select></label>
      <label>개찰 시작일<input name="from" type="date" required value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
      <label>개찰 종료일<input name="to" type="date" required value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
      <button className="button button-primary" disabled={loading}>결과 조회</button>
    </form>
    <div className="result-local-search"><label>공고번호<input value={number} readOnly={Boolean(bid)} onChange={event => setNumber(event.target.value)} placeholder="불러온 결과에서 검색" /></label><label>업체명·사업자등록번호<input value={company} onChange={event => setCompany(event.target.value)} placeholder="불러온 결과에서 검색" /></label></div>
    <p className="live-scope">최대 7일씩 조회 · 업체별 공개 결과 {rows.length.toLocaleString('ko-KR')} / {meta?.totalCount.toLocaleString('ko-KR') ?? '—'}행 불러옴 · {filtered.length.toLocaleString('ko-KR')}행 표시{meta && ` · ${formatDateTime(meta.fetchedAt)} 조회`} · 첫 100행은 화면을 보는 동안 5분마다 갱신됩니다.</p>
    {loading && <p role="status">공개 결과를 불러오는 중입니다.</p>}
    {error && <p className="live-error" role="alert">{error}</p>}
    {meta?.warnings?.map(warning => <p className="live-warning" key={warning}>{warning}</p>)}
    <div className="public-result-cards">{filtered.map(row => <article key={row.id} className="public-result-card"><div><span className="badge badge-gray">{row.result || '결과 미제공'}</span><h3>{row.title || row.number}</h3><p>{row.number} · 차수 {row.revision} · {row.agency}</p></div><dl><div><dt>개찰일</dt><dd>{formatDateTime(row.openingAt)}</dd></div><div><dt>공개 업체</dt><dd>{row.companyName || row.winnerName || '미제공'}</dd></div><div><dt>사업자번호</dt><dd>{row.businessNumber || row.winnerBusinessNumber || '미제공'}</dd></div><div><dt>순위</dt><dd>{row.rank || '미제공'}</dd></div><div><dt>투찰금액</dt><dd>{formatPrice(row.bidAmount)}</dd></div><div><dt>투찰률</dt><dd>{row.bidRate === null ? '미제공' : `${row.bidRate}%`}</dd></div><div><dt>최종 낙찰업체</dt><dd>{row.winnerName || '미제공'}</dd></div><div><dt>낙찰 여부</dt><dd>{row.awarded === true ? '낙찰' : row.awarded === false ? '미낙찰' : '미제공'}</dd></div><div><dt>낙찰금액</dt><dd>{formatPrice(row.winningAmount)}</dd></div></dl>{row.disqualificationReason && <p>공개 사유: {row.disqualificationReason}</p>}</article>)}</div>
    {!loading && !error && filtered.length === 0 && <p className="live-empty">현재 불러온 공개 자료에서 일치하는 결과를 찾지 못했습니다. 아직 공개되지 않았거나 조회 기간·페이지가 다를 수 있으며, 미조회는 탈락이나 미제출을 뜻하지 않습니다.</p>}
    {meta?.hasMore && <button className="button button-secondary live-more" disabled={loading} onClick={() => void load(meta.page + 1)}>공개 결과 100건 더 불러오기</button>}
  </section>;
}
