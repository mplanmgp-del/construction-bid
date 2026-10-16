import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, ChevronDown, Search, X } from 'lucide-react';
import type { NoticeQuery } from './notice-search';
import type { BidNotice } from '../types';
import { deadlineMonthWindow } from '../notice-deadline-window';
import { NoticeNumberController, visibleNoticeNumberSearch } from './notice-number-search';
import { NoticeNumberResults } from './NoticeNumberLookup';
import { noticeSearchKind, planUnifiedNoticeSearch, reconcileUnifiedSearchDraft, type NoticeSearchKind, type NoticeSearchTarget, type UnifiedSearchDraft } from './unified-notice-search';

export interface UnifiedNoticeSearchProps {
  query: NoticeQuery;
  loading: boolean;
  refreshBlocked?: boolean;
  onSearch: (query: NoticeQuery) => void;
  userId?: string;
  bookmarks: string[];
  onOpen: (notice: BidNotice) => void;
  onBookmark: (notice: BidNotice) => void;
  onLogin: () => void;
  onResultModeChange: (kind: NoticeSearchKind) => void;
  resetKey?: number;
  initialDraft?: UnifiedSearchDraft;
  onDraftChange?: (draft: UnifiedSearchDraft) => void;
}

export function UnifiedNoticeSearch({ query, loading, refreshBlocked = false, onSearch, userId, bookmarks, onOpen, onBookmark, onLogin, onResultModeChange, resetKey, initialDraft, onDraftChange }: UnifiedNoticeSearchProps) {
  const owner = userId || null;
  const [controller] = useState(() => new NoticeNumberController());
  const [form, setForm] = useState<UnifiedSearchDraft>(() => initialDraft
    ? reconcileUnifiedSearchDraft(initialDraft, query, query, owner, resetKey)
    : { query: { ...query }, target: 'auto', owner, resetKey });
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const periodRef = useRef<HTMLDetailsElement>(null);
  const previousQuery = useRef(query), previousReset = useRef(resetKey);
  const modeChange = useRef(onResultModeChange);
  modeChange.current = onResultModeChange;
  const draftChange = useRef(onDraftChange);
  draftChange.current = onDraftChange;
  const inputId = useId(), hintId = useId(), errorId = useId();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const visible = visibleNoticeNumberSearch(snapshot, userId);
  // Mask private results and number drafts in the very first render of another account.
  const resetting = form.resetKey !== resetKey;
  const effectiveForm = reconcileUnifiedSearchDraft(form, previousQuery.current, query, owner, resetKey);
  const { query: draft, target } = effectiveForm;
  const kind = noticeSearchKind(draft.keyword, target);
  const formError = !resetting && form.owner === owner ? error : '';
  const dateError = formError.startsWith('제출마감 기간:');
  const unchanged = draft.type === query.type && draft.from === query.from && draft.to === query.to && draft.keyword.trim() === query.keyword.trim();
  const busy = kind === 'number' ? visible.loading : loading && unchanged;
  const blocked = kind === 'number' ? visible.loading : (loading || refreshBlocked) && unchanged;

  useEffect(() => {
    controller.setUser(userId);
    return () => controller.setUser();
  }, [controller, userId]);

  useEffect(() => {
    const before = previousQuery.current;
    previousQuery.current = query;
    const reset = previousReset.current !== resetKey;
    previousReset.current = resetKey;
    if (reset) controller.clear();
    setForm(previous => reconcileUnifiedSearchDraft(previous, before, query, owner, resetKey));
    setError('');
  }, [controller, owner, resetKey, query.type, query.from, query.to, query.keyword]);

  useEffect(() => { modeChange.current(kind); }, [kind, resetKey]);
  useEffect(() => { draftChange.current?.(effectiveForm); }, [form, owner, resetKey, query.type, query.from, query.to, query.keyword]);

  function change(next: NoticeQuery, nextTarget = target) {
    controller.clear();
    const nextForm = { owner, resetKey, query: next, target: nextTarget };
    setForm(nextForm);
    draftChange.current?.(nextForm);
    setError('');
    modeChange.current(noticeSearchKind(next.keyword, nextTarget));
  }

  function submit(next = draft) {
    try {
      const plan = planUnifiedNoticeSearch(next.keyword, target, next);
      setError('');
      const nextForm = { owner, resetKey, query: { ...next, keyword: next.keyword.trim() }, target };
      setForm(nextForm);
      // Publish before navigation can unmount this form during the guest login handoff.
      draftChange.current?.(nextForm);
      modeChange.current(plan.kind);
      if (plan.kind === 'number') {
        if (!userId) { onLogin(); return; }
        if (controller.getSnapshot().userId !== userId) controller.setUser(userId);
        void controller.search(plan.input, plan.type);
      } else {
        controller.clear();
        onSearch(plan.query);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '검색 조건을 확인해 주세요.';
      setError(message);
      if (message.startsWith('제출마감 기간:') && periodRef.current) periodRef.current.open = true;
    }
  }

  function period(from: string, to: string) {
    const next = { ...draft, from, to };
    change(next);
    submit(next);
  }

  return <section className="unified-notice-search" aria-label="입찰공고 통합검색">
    <form role="search" aria-label="입찰공고 검색" noValidate aria-busy={busy} onSubmit={event => { event.preventDefault(); if (!blocked) submit(); }}>
      <div className="unified-search-heading">
        <h2>공고 검색</h2>
        <div className="unified-search-configuration">
          <label><span>업무 구분</span><select name="type" value={draft.type} onChange={event => change({ ...draft, type: event.target.value as NoticeQuery['type'] })}><option>공사·용역</option><option>공사</option><option>용역</option></select></label>
          <label><span>검색 대상</span><select name="searchTarget" value={target} onChange={event => change(draft, event.target.value as NoticeSearchTarget)}><option value="auto">자동</option><option value="title">공고명</option><option value="number">공고번호</option></select></label>
        </div>
      </div>
      <label className="unified-search-label" htmlFor={inputId}>공고명 또는 공고번호</label>
      <div className="unified-search-input-row">
        <Search size={21} strokeWidth={1.8} aria-hidden="true" />
        <input ref={inputRef} id={inputId} name="keyword" type="text" value={draft.keyword} onChange={event => change({ ...draft, keyword: event.target.value })} placeholder="철거 공사 또는 R26BK01359594-000" maxLength={100} autoComplete="off" spellCheck={false} aria-invalid={formError && !dateError ? true : undefined} aria-describedby={`${hintId}${formError && !dateError ? ` ${errorId}` : ''}`} />
        {draft.keyword && <button type="button" className="unified-search-clear" aria-label="검색어 지우기" onClick={() => { change({ ...draft, keyword: '' }); inputRef.current?.focus(); }}><X size={18} aria-hidden="true" /></button>}
        <button className="button button-primary unified-search-submit" type="submit" disabled={blocked}>{busy ? '조회 중' : kind === 'number' && !userId ? '로그인 후 조회' : '검색'}<ArrowRight size={17} aria-hidden="true" /></button>
      </div>
      <p id={hintId} className="unified-search-hint">{kind === 'number' ? '번호 조회에는 기간과 상세 조건을 적용하지 않습니다. 최신 차수와 전체 이력을 확인합니다.' : '공고명은 입찰서 제출마감 기간으로 검색합니다. 제출마감 미제공 민간공고는 게시일 기준으로 함께 표시합니다. 검색어를 비우면 전체 공고를 조회합니다.'}</p>
      <details ref={periodRef} className="unified-search-period-details" hidden={kind === 'number'}>
        <summary><span>제출마감 기간 · {query.from.replaceAll('-', '.')} – {query.to.replaceAll('-', '.')}</span><ChevronDown size={17} aria-hidden="true" /></summary>
        <fieldset className="unified-search-period" disabled={kind === 'number'}>
        <legend>입찰서 제출마감 기간</legend>
        <div className="unified-search-dates">
          <label>시작일<input name="from" aria-label="입찰서 제출마감 시작일" type="date" min="1995-10-01" max="2100-12-31" required={kind === 'title'} aria-invalid={dateError ? true : undefined} aria-describedby={dateError ? errorId : undefined} value={draft.from} onChange={event => change({ ...draft, from: event.target.value })} /></label>
          <span aria-hidden="true">~</span>
          <label>종료일<input name="to" aria-label="입찰서 제출마감 종료일" type="date" min="1995-10-01" max="2100-12-31" required={kind === 'title'} aria-invalid={dateError ? true : undefined} aria-describedby={dateError ? errorId : undefined} value={draft.to} onChange={event => change({ ...draft, to: event.target.value })} /></label>
        </div>
        <div className="unified-search-presets" role="group" aria-label="제출마감 기간 빠른 선택">{[1, 3, 6, 12, 36].map(months => {
          const window = deadlineMonthWindow(months);
          return <button type="button" key={months} disabled={kind === 'title' && loading} aria-pressed={draft.from === window.from && draft.to === window.to} onClick={() => period(window.from, window.to)}>전후 {months < 12 ? `${months}개월` : `${months / 12}년`}</button>;
        })}<button type="button" disabled={kind === 'title' && loading} aria-pressed={draft.from === '1995-10-01' && draft.to === '2100-12-31'} onClick={() => period('1995-10-01', '2100-12-31')}>전체 보관 범위</button></div>
        </fieldset>
      </details>
    </form>
    {formError && <p id={errorId} className="unified-search-error" role="alert">{formError}</p>}
    {kind === 'number' && !userId && <p className="unified-search-login">로그인 후 공고번호로 전체 차수 이력을 확인할 수 있습니다.</p>}
    {kind === 'number' && userId && !resetting && form.owner === owner && <NoticeNumberResults snapshot={visible} bookmarks={bookmarks} onBookmark={onBookmark} onOpen={onOpen} />}
  </section>;
}
