import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUpRight, Bookmark, CircleAlert, LoaderCircle, Search } from 'lucide-react';
import { NOTICE_REVISION_CONTEXT, type BidNotice } from '../types';
import { noticeState } from '../notice-status';
import { currentNotice } from './client';
import {
  NoticeNumberController, visibleNoticeNumberSearch,
  type NoticeNumberSnapshot, type NoticeNumberType,
} from './notice-number-search';
import './notice-number-search.css';

function fullDate(value?: string): string {
  if (!value?.trim()) return '일정 미제공';
  const normalized = value.trim().replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : normalized + '+09:00');
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : '일정 미제공';
}
function latestState(notice: BidNotice) {
  if (notice.status === '취소' || notice.noticeKind?.includes('취소')) return { label: '취소공고', tone: 'cancelled' };
  const current = currentNotice(notice);
  if (current.status === '마감') return { label: '입찰 마감', tone: 'closed' };
  const phase = noticeState(current);
  return { label: phase.label === '-' ? '상태 확인 필요' : phase.label, tone: phase.tone };
}

/** Preserve the original record while carrying its current revision context into the drawer. */
export function historicNoticeForDetail(notice: BidNotice, latest: BidNotice): BidNotice {
  if (notice.number !== latest.number || notice.type !== latest.type || Number(latest.revision) <= Number(notice.revision)) return notice;
  return { ...notice, [NOTICE_REVISION_CONTEXT]: { latestRevision: latest.revision, latestStatus: latest.status,
    ...(latest.noticeKind ? { latestNoticeKind: latest.noticeKind } : {}) } };
}

export function NoticeNumberResults({ snapshot, bookmarks, onBookmark, onOpen }: {
  snapshot: NoticeNumberSnapshot; bookmarks: string[];
  onBookmark: (notice: BidNotice) => void; onOpen: (notice: BidNotice) => void;
}) {
  return <div className="notice-number-results" aria-live="polite" aria-busy={snapshot.loading}>
    {snapshot.error && <p className="notice-number-error" role="alert"><CircleAlert size={16} /><span>{snapshot.error}</span></p>}
    {snapshot.loading && <p className="notice-number-progress" role="status">공고번호로 최신 차수와 전체 이력을 확인하고 있습니다.</p>}
    {snapshot.errors.map(failure => <p key={failure.type} className="notice-number-error" role="alert"><CircleAlert size={16} /><span><strong>{failure.type} 조회 실패</strong> · {failure.message}</span></p>)}
    {snapshot.groups.map(group => {
      const latest = group.latest, state = latestState(latest), saved = bookmarks.includes(latest.id);
      return <article key={group.type} className="notice-number-card" data-notice-number={latest.number}>
        <div className="notice-number-card-top"><span>{group.type} · {latest.number}</span><div><strong>최신 {latest.revision}차수</strong><span className={`notice-number-status ${state.tone}`}>{state.label}</span></div></div>
        <h3><button type="button" onClick={() => onOpen(latest)}>{latest.title}</button></h3>
        <p className="notice-number-agency">{latest.agency}{latest.demandAgency && latest.demandAgency !== latest.agency ? ` · 수요기관 ${latest.demandAgency}` : ''}</p>
        {state.tone === 'cancelled' && <p className="notice-number-cancel-note"><CircleAlert size={17} /><span>최신 {latest.revision}차수가 취소공고입니다. 이전 {group.history.at(1)?.revision ?? '공고'}차수의 마감일이 남아 있어도 현재 진행 공고로 볼 수 없습니다.</span></p>}
        {group.requestedRevision !== null && group.requestedRevision !== latest.revision && <p className="notice-number-history-note">{group.requested ? `입력한 ${group.requestedRevision}차수는 이전 차수입니다. 아래 이력에서 확인할 수 있습니다.` : `입력한 ${group.requestedRevision}차수는 확인되지 않았습니다. 조회된 최신 차수를 표시합니다.`}</p>}
        <dl className="notice-number-dates"><div><dt>최신 공고 게시일</dt><dd>{fullDate(latest.postedAt)}</dd></div><div><dt>입찰 개시일시</dt><dd>{fullDate(latest.biddingStartAt)}</dd></div><div><dt>입찰 마감일시</dt><dd>{fullDate(latest.deadline)}</dd></div></dl>
        {group.warnings.map((warning, index) => <p key={index} className="notice-number-history-note">{warning}</p>)}
        <div className="notice-number-card-actions"><button type="button" className={`button button-secondary${saved ? ' is-saved' : ''}`} aria-label={`${latest.number}-${latest.revision} 즐겨찾기 ${saved ? '해제' : '추가'}`} aria-pressed={saved} onClick={() => onBookmark(latest)}><Bookmark size={16} fill={saved ? 'currentColor' : 'none'} /><span>{saved ? '즐겨찾기됨' : '즐겨찾기'}</span></button><button type="button" className="button button-secondary" onClick={() => onOpen(latest)}><span>최신 공고 상세</span><ArrowUpRight size={16} /></button></div>
        <details className="notice-number-history" open={group.requestedRevision !== null && group.requestedRevision !== latest.revision}>
          <summary>전체 차수 이력 {group.history.length}건</summary>
          <ol>{group.history.map(item => {
            const current = item.revision === latest.revision, requested = item.revision === group.requestedRevision;
            return <li key={item.revision} data-revision={item.revision} data-current={current} data-requested={requested} className={requested ? 'is-requested' : undefined}>
              <div><strong>{current ? '최신' : '이전'} {item.revision}차수</strong><span>{item.noticeKind || (item.status === '취소' ? '취소공고' : '등록공고')}{requested ? ' · 입력한 차수' : ''}</span><small>{fullDate(item.postedAt)}{!current ? ' · 현재 상태는 최신 차수 기준' : ''}</small></div>
              <button type="button" onClick={() => onOpen(historicNoticeForDetail(item, latest))} aria-label={`${item.number}-${item.revision} ${current ? '최신' : '이전'} 차수 상세보기`}>상세보기<ArrowUpRight size={14} /></button>
            </li>;
          })}</ol>
        </details>
        <p className="notice-number-fetched">조회 시각 {fullDate(group.fetchedAt)}</p>
      </article>;
    })}
    {!snapshot.loading && snapshot.attempted && snapshot.groups.length === 0 && <p className="notice-number-empty">{snapshot.errors.length ? '조회하지 못한 업무가 있습니다. 오류를 확인한 뒤 다시 조회해 주세요.' : '선택한 업무 구분에서 해당 번호의 공고가 없습니다. 공고번호와 업무 구분을 확인해 주세요.'}</p>}
  </div>;
}

export function NoticeNumberLookup({ userId, bookmarks, onBookmark, onOpen }: {
  userId: string; bookmarks: string[]; onBookmark: (notice: BidNotice) => void; onOpen: (notice: BidNotice) => void;
}) {
  const controllerRef = useRef<NoticeNumberController | null>(null);
  if (!controllerRef.current) controllerRef.current = new NoticeNumberController();
  const controller = controllerRef.current, inputId = useId(), errorId = useId();
  const [draft, setDraft] = useState<{ owner: string; input: string; type: NoticeNumberType }>({ owner: userId, input: '', type: '공사·용역' });
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const visible = visibleNoticeNumberSearch(snapshot, userId);
  const input = draft.owner === userId ? draft.input : '', type = draft.owner === userId ? draft.type : '공사·용역';
  useEffect(() => { controller.setUser(userId); return () => controller.setUser(); }, [controller, userId]);
  function change(value: string, nextType: NoticeNumberType) {
    setDraft({ owner: userId, input: value, type: nextType });
    if (controller.getSnapshot().userId === userId) controller.clear();
  }
  return <section className="notice-number-panel panel" aria-label="공고번호 조회">
    <div className="notice-number-heading"><h2>공고번호 조회</h2><p>게시일·맞춤 조건에 관계없이 최신 차수와 이전 공고를 확인합니다.</p></div>
    <form className="notice-number-form" role="search" aria-label="공고번호 직접 조회" onSubmit={event => {
      event.preventDefault(); if (controller.getSnapshot().userId === userId) void controller.search(input, type);
    }}>
      <div className="notice-number-input"><label htmlFor={inputId}>공고번호</label><input id={inputId} name="noticeNumber" value={input} onChange={event => change(event.target.value, type)} placeholder="R26BK01359594-000" maxLength={44} autoComplete="off" spellCheck={false} aria-invalid={visible.error ? true : undefined} aria-describedby={visible.error ? errorId : undefined} required /></div>
      <label className="notice-number-type">업무 구분<select value={type} onChange={event => change(input, event.target.value as NoticeNumberType)} name="noticeNumberType"><option>공사·용역</option><option>공사</option><option>용역</option></select></label>
      <button type="submit" className="button button-primary notice-number-submit" disabled={!input.trim() || visible.loading}><span className="notice-number-submit-label">{visible.loading ? '조회 중' : '번호 조회'}</span><span className={`notice-number-submit-icon${visible.loading ? ' is-loading' : ''}`} aria-hidden="true"><Search size={17} /><LoaderCircle size={17} /></span></button>
    </form>
    <div id={errorId}><NoticeNumberResults snapshot={visible} bookmarks={bookmarks} onBookmark={onBookmark} onOpen={onOpen} /></div>
  </section>;
}
