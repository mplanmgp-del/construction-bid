import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDownToLine, ChevronDown, FileSpreadsheet, FileText, LoaderCircle } from 'lucide-react';
import './ExportButton.css';

export type ExportFormat = 'xlsx' | 'csv';

export function ExportButton({ onExport, disabled = false }: { onExport: (format: ExportFormat) => Promise<void>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLButtonElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<'main' | 'toggle' | null>(null);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (busy || !returnFocus.current) return;
    if (document.activeElement === document.body || root.current?.contains(document.activeElement)) {
      (returnFocus.current === 'toggle' ? toggle : main).current?.focus();
    }
    returnFocus.current = null;
  });

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  async function download(format: ExportFormat) {
    if (busy || disabled) return;
    returnFocus.current = menu.current?.contains(document.activeElement) ? 'toggle' : 'main';
    setOpen(false);
    setBusy(format);
    try { await onExport(format); } finally { setBusy(null); }
  }

  function navigateMenu(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    if (!items.length) return;
    const current = items.findIndex(item => item === document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return <div className="export-control" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={main} className="export-main" aria-label={busy ? '다운로드 파일 만드는 중' : '현재 목록 엑셀 다운로드'}
      title={disabled ? '표시된 공고가 있을 때 다운로드할 수 있습니다.' : '현재 목록 엑셀 다운로드'} disabled={busy !== null || disabled} onClick={() => void download('xlsx')}>
      {busy ? <LoaderCircle size={16} className="export-spinner" /> : <ArrowDownToLine size={16} />}
      <span>{busy ? '준비 중' : '엑셀 다운로드'}</span>
    </button>
    <button ref={toggle} className="export-format-toggle" aria-label="다운로드 형식 선택" title="다운로드 형식 선택"
      aria-haspopup="menu" aria-expanded={open} disabled={busy !== null || disabled} onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>
      <ChevronDown size={14} />
    </button>
    {open && <div ref={menu} className="export-format-menu" role="menu" aria-label="다운로드 형식" onKeyDown={navigateMenu}>
      <button role="menuitem" onClick={() => void download('xlsx')}><FileSpreadsheet size={17} /><span>엑셀 다운로드<small>서식이 적용된 .xlsx</small></span></button>
      <button role="menuitem" onClick={() => void download('csv')}><FileText size={17} /><span>CSV 다운로드<small>데이터용 .csv</small></span></button>
    </div>}
  </div>;
}
