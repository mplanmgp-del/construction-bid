import { useRef, useState } from 'react';
import { ArrowRight, Search, Sparkles, X } from 'lucide-react';
import { dateRangeError } from './client';
import type { NoticeQuery } from './useLiveNotices';

export function LiveSearch({ query, loading, refreshBlocked = false, onSearch, onCustomSearch }: { query: NoticeQuery; loading: boolean; refreshBlocked?: boolean; onSearch: (query: NoticeQuery) => void; onRefresh: () => void; onCustomSearch?: () => void }) {
  const [draft, setDraft] = useState(query);
  const [error, setError] = useState('');
  const keywordInput = useRef<HTMLInputElement>(null);
  const changed = draft.type !== query.type || draft.from !== query.from || draft.to !== query.to || draft.keyword.trim() !== query.keyword.trim();
  return <section className="notice-search-panel panel" aria-label="입찰공고 통합검색">
    <div className="notice-search-heading"><strong>공고 검색</strong><span>입찰 개시일 기준 · 이전 90일 게시 공고 포함</span>{onCustomSearch && <button type="button" className="button button-secondary custom-search-launch" onClick={onCustomSearch}><Sparkles size={15} />맞춤 조회</button>}</div>
    <form role="search" aria-label="입찰공고 검색" onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const next: NoticeQuery = { type: form.get('type') as NoticeQuery['type'], from: String(form.get('from') ?? ''), to: String(form.get('to') ?? ''), keyword: String(form.get('keyword') ?? '').trim() };
      const nextError = !next.keyword ? '철거·석면 등 검색할 공고명을 입력해 주세요.' : dateRangeError(next.from, next.to, 31); setError(nextError ?? '');
      if (!nextError) {
        setDraft(next); onSearch(next);
      }
    }}>
      <div className="notice-keyword-row">
        <Search size={22} strokeWidth={1.8} aria-hidden="true" />
        <label className="sr-only" htmlFor="notice-keyword">공고명</label>
        <input ref={keywordInput} id="notice-keyword" name="keyword" value={draft.keyword} onChange={event => { setDraft({ ...draft, keyword: event.target.value }); setError(''); }} placeholder="철거, 석면 등 공고명 검색" maxLength={100} required autoComplete="off" aria-describedby={error ? 'notice-search-error' : undefined} />
        {draft.keyword && <button type="button" className="icon-button" aria-label="검색어 지우기" onClick={() => { setDraft({ ...draft, keyword: '' }); setError(''); keywordInput.current?.focus(); }}><X size={18} /></button>}
        <button className="button button-primary notice-search-submit" type="submit" disabled={loading || !draft.keyword.trim() || (!changed && refreshBlocked)}>{loading ? '조회 중' : '검색'}<ArrowRight size={18} aria-hidden="true" /></button>
      </div>
      <div className="notice-search-options">
        <label className="notice-search-type">업무 구분<select name="type" value={draft.type} onChange={event => { setDraft({ ...draft, type: event.target.value as NoticeQuery['type'] }); setError(''); }}><option>공사·용역</option><option>공사</option><option>용역</option></select></label>
        <label>개시 기간 시작<input name="from" aria-label="입찰 개시 기간 시작" type="date" required value={draft.from} onChange={event => { setDraft({ ...draft, from: event.target.value }); setError(''); }} /></label>
        <label>개시 기간 종료<input name="to" aria-label="입찰 개시 기간 종료" type="date" required value={draft.to} onChange={event => { setDraft({ ...draft, to: event.target.value }); setError(''); }} /></label>
      </div>
    </form>
    {error && <p id="notice-search-error" className="live-error" role="alert">{error}</p>}
  </section>;
}
