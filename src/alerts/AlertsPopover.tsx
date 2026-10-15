import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Bell, CheckCheck, ChevronRight, RefreshCw, RotateCcw, Settings2, Trash2, X } from 'lucide-react';
import { formatDateTime } from '../domain';
import type { AlertInboxItem, AlertNotice } from './types';
import { BookmarkButton } from '../components/BookmarkButton';
import type { AlertsAccess } from './useAlerts';
import './alerts-popover.css';

export function AlertBell({ unreadCount, onOpen, disabled = false, expanded = false, controls, buttonRef }: {
  unreadCount: number; onOpen: () => void; disabled?: boolean; expanded?: boolean; controls?: string; buttonRef?: Ref<HTMLButtonElement>;
}) {
  const count = Math.max(0, Math.floor(unreadCount));
  return <button ref={buttonRef} type="button" className={`alerts-bell${expanded ? ' is-open' : ''}`} onClick={onOpen} disabled={disabled}
    aria-label={count ? `알림, 읽지 않은 알림 ${count}개` : '알림'} title={disabled ? '예시 모드에서는 알림을 사용할 수 없습니다.' : '내 알림'} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? controls : undefined}>
    <Bell size={21} aria-hidden="true" />{count > 0 && <span className="alerts-unread-badge" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
  </button>;
}

const eventLabels: Record<AlertInboxItem['kind'], string> = { initial: '첫 알림', new: '새 공고', changed: '주요 변경', cancelled: '취소', test: '테스트' };
interface ContentProps {
  alerts: AlertsAccess; signedIn: boolean; onLogin: () => void; onClose: () => void;
  onOpenSettings: () => void; onOpenExisting: () => void; headingId: string;
  bookmarks?: string[]; onBookmark?: (notice: AlertNotice) => void;
}

export function AlertsPopoverContent({ alerts, signedIn, onLogin, onClose, onOpenSettings, onOpenExisting, headingId, bookmarks = [], onBookmark }: ContentProps) {
  const [ui, setUi] = useState({ owner: alerts.userId, trash: false, confirmDelete: false, busy: false, feedback: '' });
  const owner = useRef(alerts.userId); owner.current = alerts.userId;
  const mutation = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const sameOwner = ui.owner === alerts.userId;
  const trash = sameOwner && ui.trash;
  const busy = Boolean(alerts.removing || alerts.restoring || alerts.reading || alerts.saving || alerts.settingUp || sameOwner && ui.busy);
  const overview = signedIn ? alerts.overview : null;
  const notifications = trash ? overview?.deletedNotifications ?? [] : overview?.notifications ?? [];
  const count = trash ? overview?.deletedCount ?? notifications.length : overview?.unreadCount ?? 0;
  const hasMore = trash ? overview?.deletedHasMore : overview?.hasMore;
  const canChangeAll = notifications.length > 0 || Boolean(hasMore) || trash && Boolean(overview?.deletedCount);
  useEffect(() => {
    mutation.current = false;
    setUi({ owner: alerts.userId, trash: false, confirmDelete: false, busy: false, feedback: '' });
  }, [alerts.userId, signedIn]);
  async function change(action: 'remove' | 'restore', target: { id: string } | { all: true }) {
    if (busy || mutation.current || !signedIn) return;
    const userId = alerts.userId;
    mutation.current = true;
    setUi(previous => ({ ...previous, busy: true, feedback: '' }));
    try {
      const changed = await alerts[action](target);
      if (owner.current !== userId) return;
      if (changed) {
        setUi(previous => previous.owner === userId ? { ...previous, confirmDelete: false,
          feedback: action === 'remove' ? '알림을 삭제했습니다.' : '알림을 복원했습니다.' } : previous);
      }
    } finally {
      if (owner.current === userId) {
        mutation.current = false;
        setUi(previous => previous.owner === userId ? { ...previous, busy: false } : previous);
        // The controller can remove an acknowledged row even if reloading its
        // final count fails. Keep focus in the panel without claiming success.
        heading.current?.focus();
      }
    }
  }
  function switchInbox() {
    if (busy || mutation.current) return;
    const nextTrash = !trash;
    setUi({ owner: alerts.userId, trash: nextTrash, confirmDelete: false, busy: false, feedback: '' });
    if (nextTrash && overview?.deletedNotifications === undefined) void alerts.loadDeleted();
    heading.current?.focus();
  }
  function openExisting(item: AlertInboxItem) {
    if (busy || mutation.current || trash) return;
    if (!item.readAt) void alerts.read({ id: item.id });
    onOpenExisting();
  }
  return <>
    <div className="alert-popover-heading"><h2 ref={heading} tabIndex={-1} id={headingId}>{trash ? '삭제한 알림' : '알림'}{count > 0 && <span>{count}</span>}</h2>
      <div>{signedIn && !trash && <button type="button" className="alert-popover-read-all" disabled={!overview?.unreadCount || alerts.reading || busy} onClick={() => { if (!mutation.current) void alerts.read({ all: true }); }}><CheckCheck size={14} />모두 읽음</button>}
        {signedIn && <button type="button" className="alert-popover-bulk" disabled={!canChangeAll || busy || alerts.loadingDeleted} onClick={() => { if (busy || mutation.current) return; if (trash) void change('restore', { all: true }); else setUi(previous => ({ ...previous, confirmDelete: !previous.confirmDelete, feedback: '' })); }} aria-expanded={!trash ? sameOwner && ui.confirmDelete : undefined}>{trash ? <RotateCcw size={13} /> : <Trash2 size={13} />}{trash ? '전체 복원' : '전체 삭제'}</button>}
        <button type="button" className="alert-popover-close" onClick={onClose} aria-label="알림 닫기"><X size={17} /></button></div>
    </div>
    <div className="alert-popover-body">
      {!signedIn ? <div className="alert-popover-empty"><Bell size={24} /><p>로그인하고 맞춤 공고 알림을 받아보세요.</p><button type="button" className="button button-primary" onClick={onLogin}>로그인</button></div> : <>
        {sameOwner && ui.confirmDelete && !trash && <div className="alert-popover-confirm" role="group" aria-label="전체 알림 삭제 확인"><p>받은 알림을 모두 삭제할까요?</p><small>이전 알림도 포함합니다. 삭제한 알림에서 복원할 수 있습니다.</small><div><button type="button" disabled={busy} onClick={() => { void change('remove', { all: true }); }}>전체 알림 삭제</button><button type="button" disabled={busy} onClick={() => setUi(previous => ({ ...previous, confirmDelete: false }))}>취소</button></div></div>}
        {sameOwner && ui.feedback && <div className="alert-popover-feedback" role="status"><p>{ui.feedback}</p>{ui.feedback === '알림을 삭제했습니다.' && <small>삭제한 알림에서 복원할 수 있습니다.</small>}</div>}
        {alerts.error && <div className="alert-popover-error" role="alert"><p>{alerts.error}</p><button type="button" disabled={alerts.loading || alerts.loadingDeleted || busy} onClick={() => { void alerts.refresh(); }}><RefreshCw size={13} />다시 확인</button></div>}
        {!overview && !alerts.error && <p className="alert-popover-empty" role="status">{alerts.loading ? '알림을 불러오는 중입니다.' : '알림을 불러오지 못했습니다.'}</p>}
        {trash && alerts.loadingDeleted && <p className="alert-popover-loading" role="status">삭제한 알림을 불러오는 중입니다.</p>}
        {overview && notifications.length === 0 && !alerts.loadingDeleted && <div className="alert-popover-empty">{trash ? <Trash2 size={24} /> : <Bell size={24} />}<p>{trash ? '삭제한 알림이 없습니다.' : '아직 받은 알림이 없습니다.'}</p><small>{trash ? '삭제한 알림은 이곳에서 복원할 수 있습니다.' : '저장한 조건에 맞는 공고가 올라오면 알려드려요.'}</small></div>}
        {notifications.map(item => <article key={item.id} className={`alert-popover-item${trash ? ' is-deleted' : item.readAt ? '' : ' is-unread'}`}>
          <div className="alert-popover-meta"><span className={`alert-popover-kind kind-${item.kind}`}>{eventLabels[item.kind]}</span>{!trash && !item.readAt && <span className="alert-popover-unread" aria-label="읽지 않음" />}<time dateTime={(trash && item.deletedAt ? item.deletedAt : item.createdAt) || undefined}>{trash && item.deletedAt ? `삭제 ${formatDateTime(item.deletedAt)}` : item.createdAt ? formatDateTime(item.createdAt) : ''}</time>
            <button type="button" className={`alert-popover-item-change${trash ? ' is-restore' : ''}`} disabled={busy} aria-label={`${item.notice?.title || item.message || eventLabels[item.kind]} 알림 ${trash ? '복원' : '삭제'}`} title={trash ? '알림 복원' : '알림 삭제'} onClick={() => { void change(trash ? 'restore' : 'remove', { id: item.id }); }}>{trash ? <RotateCcw size={14} /> : <Trash2 size={14} />}</button>
          </div>
          {item.notice ? trash ? <p className="alert-popover-title">{item.notice.title}</p> : <a className="alert-popover-title" href={`/notice-detail.html?${new URLSearchParams({ number: item.notice.number, revision: item.notice.revision, type: item.notice.type })}`} target="_blank" rel="noopener noreferrer" aria-disabled={busy || undefined} tabIndex={busy ? -1 : undefined} onClick={event => { if (busy || mutation.current) { event.preventDefault(); return; } if (!item.readAt) void alerts.read({ id: item.id }); onClose(); }}>{item.notice.title}<ChevronRight size={14} /></a> : null}
          {item.message && <p className="alert-popover-message">{item.message}</p>}
          {item.changeFields.length > 0 && <div className="alert-popover-changes">{item.changeFields.map(field => <span key={field}>{field}</span>)}</div>}
          {!trash && item.notice && onBookmark && <div className="alert-popover-bookmark"><BookmarkButton noticeTitle={item.notice.title} saved={bookmarks.includes(item.notice.id)} disabled={busy} onToggle={() => { if (!mutation.current) onBookmark(item.notice!); }} /></div>}
          {!trash && (item.kind === 'initial' || !item.readAt) && <div className="alert-popover-actions">
            {item.kind === 'initial' && <button type="button" disabled={busy} onClick={() => openExisting(item)}>기존 공고 {item.existingCount ?? 0}건 보기<ChevronRight size={13} /></button>}
            {!item.readAt && <button type="button" disabled={alerts.reading || busy} onClick={() => { if (!mutation.current) void alerts.read({ id: item.id }); }}>읽음</button>}
          </div>}
        </article>)}
        {hasMore && <button type="button" className="alert-popover-more" disabled={alerts.loadingMore || alerts.loadingDeleted || alerts.loading || busy} onClick={() => { if (trash) void alerts.loadDeleted(); else void alerts.loadMore(); }}>{alerts.loadingMore || alerts.loadingDeleted ? '불러오는 중' : trash ? '삭제한 알림 더 보기' : '이전 알림 더 보기'}</button>}
      </>}
    </div>
    {signedIn && <><button type="button" className="alert-popover-inbox-switch" disabled={busy || alerts.loadingDeleted} onClick={switchInbox} aria-label={trash ? '받은 알림' : '삭제한 알림'}>{trash ? <ArrowLeft size={14} /> : <Trash2 size={14} />}{trash ? '받은 알림' : '삭제한 알림'}{!trash && Boolean(overview?.deletedCount) && <span>{overview?.deletedCount}</span>}</button><button type="button" className="alert-popover-settings" disabled={busy} onClick={() => { if (!mutation.current) onOpenSettings(); }}><Settings2 size={15} />알림 조건 설정<ChevronRight size={15} /></button></>}
  </>;
}

export function alertPopoverPosition(rect: Pick<DOMRect, 'left' | 'right' | 'bottom'>, viewportWidth: number, viewportHeight: number) {
  const width = Math.min(360, viewportWidth - 24);
  const left = Math.max(12, Math.min(rect.right - width, viewportWidth - width - 12));
  const top = rect.bottom + 10;
  return { width, left, top, maxHeight: Math.min(480, Math.max(120, viewportHeight - top - 12)), arrow: Math.max(18, Math.min(width - 18, (rect.left + rect.right) / 2 - left)) };
}

export function AlertMenu({ alerts, signedIn, disabled = false, contextKey, onLogin, onOpenSettings, onOpenExisting, bookmarks, onBookmark }: Omit<ContentProps, 'onClose' | 'headingId'> & { disabled?: boolean; contextKey: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof alertPopoverPosition> | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const headingId = `${dialogId}-heading`;
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  useEffect(() => { setOpen(false); }, [contextKey, alerts.userId, signedIn, disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (trigger.current) setPosition(alertPopoverPosition(trigger.current.getBoundingClientRect(), window.innerWidth, window.innerHeight));
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open]);
  const positioned = position !== null;
  useLayoutEffect(() => { if (open && positioned) panel.current?.focus(); }, [open, positioned]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(true); } };
    const onHashChange = () => close();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('hashchange', onHashChange);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape); window.removeEventListener('hashchange', onHashChange); };
  }, [open]);
  function toggle() {
    if (open) { close(); return; }
    setPosition(null); setOpen(true);
    if (signedIn && !alerts.loading) void alerts.refresh();
  }
  const act = (action: () => void) => () => { close(true); action(); };
  const style = position ? { left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, '--alert-arrow-left': `${position.arrow}px` } as CSSProperties : { visibility: 'hidden' as const };
  return <>
    <AlertBell buttonRef={trigger} unreadCount={signedIn ? alerts.overview?.unreadCount ?? 0 : 0} onOpen={toggle} disabled={disabled} expanded={open} controls={dialogId} />
    {open && createPortal(<div ref={panel} id={dialogId} role="dialog" aria-labelledby={headingId} tabIndex={-1} className="alert-popover" style={style}>
      <AlertsPopoverContent alerts={alerts} signedIn={signedIn} headingId={headingId} onClose={() => close(true)} onLogin={act(onLogin)} onOpenSettings={act(onOpenSettings)} onOpenExisting={act(onOpenExisting)} bookmarks={bookmarks} onBookmark={onBookmark} />
    </div>, document.body)}
  </>;
}
