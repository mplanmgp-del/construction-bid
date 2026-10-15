import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { Bell, CheckCheck, ChevronRight, RefreshCw, Settings2, X } from 'lucide-react';
import { formatDateTime } from '../domain';
import type { AlertInboxItem } from './types';
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
}

export function AlertsPopoverContent({ alerts, signedIn, onLogin, onClose, onOpenSettings, onOpenExisting, headingId }: ContentProps) {
  const overview = signedIn ? alerts.overview : null;
  const notifications = overview?.notifications ?? [];
  function openExisting(item: AlertInboxItem) {
    if (!item.readAt) void alerts.read({ id: item.id });
    onOpenExisting();
  }
  return <>
    <div className="alert-popover-heading"><h2 id={headingId}>알림{Boolean(overview?.unreadCount) && <span>{overview?.unreadCount}</span>}</h2>
      <div>{signedIn && <button type="button" className="alert-popover-read-all" disabled={!overview?.unreadCount || alerts.reading} onClick={() => { void alerts.read({ all: true }); }}><CheckCheck size={14} />모두 읽음</button>}
        <button type="button" className="alert-popover-close" onClick={onClose} aria-label="알림 닫기"><X size={17} /></button></div>
    </div>
    <div className="alert-popover-body">
      {!signedIn ? <div className="alert-popover-empty"><Bell size={24} /><p>로그인하고 맞춤 공고 알림을 받아보세요.</p><button type="button" className="button button-primary" onClick={onLogin}>로그인</button></div> : <>
        {alerts.error && <div className="alert-popover-error" role="alert"><p>{alerts.error}</p><button type="button" disabled={alerts.loading} onClick={() => { void alerts.refresh(); }}><RefreshCw size={13} />다시 확인</button></div>}
        {!overview && !alerts.error && <p className="alert-popover-empty" role="status">{alerts.loading ? '알림을 불러오는 중입니다.' : '알림을 불러오지 못했습니다.'}</p>}
        {overview && notifications.length === 0 && <div className="alert-popover-empty"><Bell size={24} /><p>아직 받은 알림이 없습니다.</p><small>저장한 조건에 맞는 공고가 올라오면 알려드려요.</small></div>}
        {notifications.map(item => <article key={item.id} className={`alert-popover-item${item.readAt ? '' : ' is-unread'}`}>
          <div className="alert-popover-meta"><span className={`alert-popover-kind kind-${item.kind}`}>{eventLabels[item.kind]}</span>{!item.readAt && <span className="alert-popover-unread" aria-label="읽지 않음" />}<time dateTime={item.createdAt || undefined}>{item.createdAt ? formatDateTime(item.createdAt) : ''}</time></div>
          {item.notice ? <a className="alert-popover-title" href={`/notice-detail.html?${new URLSearchParams({ number: item.notice.number, revision: item.notice.revision, type: item.notice.type })}`} target="_blank" rel="noopener noreferrer" onClick={() => { if (!item.readAt) void alerts.read({ id: item.id }); onClose(); }}>{item.notice.title}<ChevronRight size={14} /></a> : null}
          {item.message && <p className="alert-popover-message">{item.message}</p>}
          {item.changeFields.length > 0 && <div className="alert-popover-changes">{item.changeFields.map(field => <span key={field}>{field}</span>)}</div>}
          {(item.kind === 'initial' || !item.readAt) && <div className="alert-popover-actions">
            {item.kind === 'initial' && <button type="button" onClick={() => openExisting(item)}>기존 공고 {item.existingCount ?? 0}건 보기<ChevronRight size={13} /></button>}
            {!item.readAt && <button type="button" disabled={alerts.reading} onClick={() => { void alerts.read({ id: item.id }); }}>읽음</button>}
          </div>}
        </article>)}
        {overview?.hasMore && <button type="button" className="alert-popover-more" disabled={alerts.loadingMore || alerts.loading} onClick={() => { void alerts.loadMore(); }}>{alerts.loadingMore ? '불러오는 중' : '이전 알림 더 보기'}</button>}
      </>}
    </div>
    {signedIn && <button type="button" className="alert-popover-settings" onClick={onOpenSettings}><Settings2 size={15} />알림 조건 설정<ChevronRight size={15} /></button>}
  </>;
}

export function alertPopoverPosition(rect: Pick<DOMRect, 'left' | 'right' | 'bottom'>, viewportWidth: number, viewportHeight: number) {
  const width = Math.min(360, viewportWidth - 24);
  const left = Math.max(12, Math.min(rect.right - width, viewportWidth - width - 12));
  const top = rect.bottom + 10;
  return { width, left, top, maxHeight: Math.min(480, Math.max(120, viewportHeight - top - 12)), arrow: Math.max(18, Math.min(width - 18, (rect.left + rect.right) / 2 - left)) };
}

export function AlertMenu({ alerts, signedIn, disabled = false, contextKey, onLogin, onOpenSettings, onOpenExisting }: Omit<ContentProps, 'onClose' | 'headingId'> & { disabled?: boolean; contextKey: string }) {
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
      <AlertsPopoverContent alerts={alerts} signedIn={signedIn} headingId={headingId} onClose={() => close(true)} onLogin={act(onLogin)} onOpenSettings={act(onOpenSettings)} onOpenExisting={act(onOpenExisting)} />
    </div>, document.body)}
  </>;
}
