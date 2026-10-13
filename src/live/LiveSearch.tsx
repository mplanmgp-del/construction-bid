import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { dateRangeError } from './client';
import type { NoticeQuery } from './useLiveNotices';

export function LiveSearch({ query, loading, onSearch, onRefresh }: { query: NoticeQuery; loading: boolean; onSearch: (query: NoticeQuery) => void; onRefresh: () => void }) {
  const [draft, setDraft] = useState(query);
  const [error, setError] = useState('');
  return <section className="live-query panel" aria-label="나라장터 원본 조회 조건">
    <div className="live-query-heading"><strong>나라장터 원본 조회</strong><span>입찰 개시일 기준 · 이전 90일 게시 공고까지 자동 조회</span></div>
    <form onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const next: NoticeQuery = { type: form.get('type') as NoticeQuery['type'], from: String(form.get('from') ?? ''), to: String(form.get('to') ?? ''), keyword: String(form.get('keyword') ?? '').trim() };
      const nextError = dateRangeError(next.from, next.to, 31); setError(nextError ?? '');
      if (!nextError) { setDraft(next); onSearch(next); }
    }}>
      <label>업무<select name="type" value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value as NoticeQuery['type'] })}><option>공사·용역</option><option>공사</option><option>용역</option></select></label>
      <label>개시 기간 시작<input name="from" aria-label="입찰 개시 기간 시작" type="date" required value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
      <label>개시 기간 종료<input name="to" aria-label="입찰 개시 기간 종료" type="date" required value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
      <label className="live-keyword">공고명<input name="keyword" value={draft.keyword} onChange={event => setDraft({ ...draft, keyword: event.target.value })} placeholder="나라장터 공고명 검색" maxLength={100} /></label>
      <button className="button button-primary" disabled={loading}>조회</button><button type="button" className="button button-secondary" disabled={loading} onClick={onRefresh}><RefreshCw size={15} />새로고침</button>
    </form>
    {error && <p className="live-error" role="alert">{error}</p>}
  </section>;
}
