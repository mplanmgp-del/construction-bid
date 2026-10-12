import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ExternalLink, FileCheck2, Info, LoaderCircle, Printer, RefreshCw, X } from 'lucide-react';
import type { G2bNoticeDetail, G2bRelatedDetail } from '../g2b-types';
import type { BidNotice } from '../types';
import { fetchApi } from '../live/client';
import { buildNoticePrintDocument, type NoticePrintDocument } from './notice-print-model';
import './NoticePrintDialog.css';

interface Props { bid: BidNotice; detail: G2bNoticeDetail; related: G2bRelatedDetail | null; onClose: () => void; }
interface ReadyDocument { document: NoticePrintDocument; url: string; notice: string; }

export function NoticePrintDialog({ bid, detail, related, onClose }: Props) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const closeAction = useRef(onClose); closeAction.current = onClose;
  const [ready, setReady] = useState<ReadyDocument | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const [printHelp, setPrintHelp] = useState(false);
  // Snapshot the selected notice. Closing/changing the parent destroys this dialog and its request.
  const [input] = useState({ bid, detail, related });

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const originalOverflow = document.body.style.overflow;
    const ownsScrollLock = originalOverflow !== 'hidden';
    if (ownsScrollLock) document.body.style.overflow = 'hidden';
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeAction.current(); }
      if (event.key !== 'Tab') return;
      // This dialog can also be opened inside the notice drawer, which has its own focus trap.
      event.stopImmediatePropagation();
      const elements = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],iframe:not([tabindex="-1"])') ?? [])];
      const first = elements[0], last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); if (ownsScrollLock) document.body.style.overflow = originalOverflow; if (trigger?.isConnected) trigger.focus(); };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | undefined;
    setReady(null); setError(''); setFrameReady(false); setPrintHelp(false);
    async function prepare() {
      try {
        const { createNoticePdf } = await import('./notice-pdf');
        let relatedData = input.related;
        let notice = '';
        if (!relatedData && input.bid.source === 'live') {
          try {
            const params = new URLSearchParams({ number: input.bid.number, revision: input.bid.revision, type: input.bid.type });
            relatedData = await fetchApi<G2bRelatedDetail>(`/api/related?${params}`, abort.signal);
          } catch (reason) {
            if (abort.signal.aborted) return;
            notice = '연관 정보는 조회하지 못해 공고 상세와 첨부목록으로 문서를 만들었습니다.';
          }
        }
        if (abort.signal.aborted) return;
        if (input.detail.warnings.length || relatedData?.warnings.length || relatedData?.groups.some(group => group.status === 'unavailable')) {
          notice = '일부 자료를 조회하지 못했습니다. 문서에는 확인된 정보만 포함했습니다.';
        }
        const document = buildNoticePrintDocument(input.bid, input.detail, relatedData);
        const blob = await createNoticePdf(document);
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setReady({ document, url: objectUrl, notice });
      } catch {
        if (!abort.signal.aborted) setError('인쇄 문서를 만들지 못했습니다. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.');
      }
    }
    void prepare();
    return () => {
      abort.abort();
      // Allow an already-started download or separate PDF viewer to finish loading.
      if (objectUrl) { const expired = objectUrl; window.setTimeout(() => URL.revokeObjectURL(expired), 60_000); }
    };
  }, [input, retry]);

  function printPdf() {
    if (!ready) return;
    if (!frameReady || window.matchMedia('(max-width: 700px)').matches) {
      window.open(ready.url, '_blank', 'noopener,noreferrer');
      setPrintHelp(true);
      return;
    }
    try { frame.current?.contentWindow?.focus(); frame.current?.contentWindow?.print(); }
    catch { setPrintHelp(true); }
  }

  return createPortal(<div className="npd-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="npd-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="npd-header"><div><span>PRINT DOCUMENT</span><h2 id={titleId}>공고 인쇄 문서</h2><p>제공된 정보만 정리한 A4 문서입니다.</p></div><button ref={close} type="button" className="npd-close" onClick={onClose} aria-label="인쇄 문서 닫기"><X size={22} /></button></header>
      <div className="npd-content">
        {!ready && !error && <div className="npd-state" role="status"><LoaderCircle className="npd-spin" size={28} /><strong>인쇄 문서를 정리하고 있습니다</strong><p>공고와 연관 자료를 확인하고 한글 PDF를 생성합니다.</p></div>}
        {error && <div className="npd-state" role="alert"><Info size={28} /><strong>{error}</strong><button type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={17} />다시 생성</button></div>}
        {ready && <>
          <div className="npd-ready"><FileCheck2 size={18} /><span>미제공 항목·빈 이력·안내 주석 제거 완료</span></div>
          {ready.notice && <p className="npd-notice" role="status"><Info size={17} />{ready.notice}</p>}
          <article className="npd-paper" aria-label="인쇄 문서 내용 미리보기">
            <span className="npd-paper-caption">입찰공고 상세</span><h3>{ready.document.title}</h3><p className="npd-paper-number">{ready.document.number}</p>
            {ready.document.summary.length > 0 && <dl className="npd-summary">{ready.document.summary.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>}
            {ready.document.sections.map(section => <section className="npd-section" key={section.id}><h4>{section.title}</h4><dl>{section.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl></section>)}
            {ready.document.documents.length > 0 && <section className="npd-section"><h4>첨부서류</h4><ol className="npd-documents">{ready.document.documents.map((name, index) => <li key={index}>{name}</li>)}</ol></section>}
          </article>
          <iframe ref={frame} className="npd-print-frame" src={ready.url} title="인쇄용 PDF" tabIndex={-1} aria-hidden="true" onLoad={() => setFrameReady(true)} />
        </>}
      </div>
      <footer className="npd-footer"><div><p>PDF에는 브라우저의 날짜·제목·사이트 주소가 붙지 않습니다.</p>{ready && <p><a href={ready.url} target="_blank" rel="noopener noreferrer">PDF 새 창으로 열기 <ExternalLink size={12} /></a>{printHelp && <span role="status"> · PDF 뷰어에서 인쇄를 선택해 주세요.</span>}</p>}</div><div className="npd-actions">{ready ? <><a className="npd-download" href={ready.url} download={ready.document.filename}><Download size={18} />PDF 다운로드</a><button className="npd-print" type="button" onClick={printPdf}><Printer size={18} />PDF 인쇄</button></> : <button type="button" onClick={onClose}>닫기</button>}</div></footer>
    </div>
  </div>, document.body);
}
