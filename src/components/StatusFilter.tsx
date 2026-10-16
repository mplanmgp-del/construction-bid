import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { NOTICE_STATUSES, type NoticeStatus } from '../types';

interface Props {
  values: NoticeStatus[];
  onChange: (values: NoticeStatus[]) => void;
  compact?: boolean;
}

export function StatusFilter({ values, onChange, compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = NOTICE_STATUSES.filter(value => values.includes(value));
  const summary = !selected.length ? compact ? '상태' : '전체 상태'
    : selected.length === 1 ? selected[0] : `상태 ${selected.length}개`;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!compact || !trigger.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const width = Math.min(248, window.innerWidth - 24);
      const height = popup.current?.offsetHeight || 260;
      const top = rect.bottom + height + 8 <= window.innerHeight
        ? rect.bottom + 6 : Math.max(12, rect.top - height - 6);
      setPosition({ top, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)) });
    };
    place();
    popup.current?.querySelector<HTMLInputElement>('input')?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, compact]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  function close() { setOpen(false); trigger.current?.focus(); }
  function toggle(value: NoticeStatus) {
    onChange(selected.includes(value) ? selected.filter(item => item !== value) : NOTICE_STATUSES.filter(item => selected.includes(item) || item === value));
  }

  const options = open && <div ref={popup} id={id} className={`status-filter-popup${compact ? ' is-floating' : ''}`}
    style={compact ? { top: position.top, left: position.left } : undefined}
    role="dialog" aria-label="공고 상태 선택" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
    <div className="status-filter-popup-heading"><strong>상태 선택</strong><button type="button" aria-label="상태 선택 닫기" onClick={close}><X size={16} /></button></div>
    <p>여러 상태를 함께 선택할 수 있습니다.</p>
    <label className={`status-filter-option${!selected.length ? ' is-selected' : ''}`}><input type="checkbox" checked={!selected.length} onChange={() => onChange([])} /><span>전체</span></label>
    {NOTICE_STATUSES.map(value => <label key={value} className={`status-filter-option${selected.includes(value) ? ' is-selected' : ''}`}><input type="checkbox" checked={selected.includes(value)} onChange={() => toggle(value)} /><span>{value}</span></label>)}
  </div>;

  return <div className={`status-filter${compact ? ' is-compact' : ''}`}>
    <button ref={trigger} type="button" className={`status-filter-trigger${selected.length ? ' is-active' : ''}`} aria-label={`공고 상태 필터: ${selected.length ? selected.join(', ') : '전체'}`}
      title={selected.length ? selected.join(' · ') : '전체 상태'} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}><span>{summary}</span><ChevronDown size={14} aria-hidden="true" /></button>
    {compact && typeof document !== 'undefined' ? options && createPortal(options, document.body) : options}
  </div>;
}
