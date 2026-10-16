import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDownToLine, Building2, CheckCircle2, Clock3, ExternalLink, FileClock, FileSignature, Info, Layers3, LoaderCircle, RefreshCw } from 'lucide-react';
import type { G2bRelatedDetail, G2bRelatedGroup, G2bRelatedRecord } from '../g2b-types';
import type { BidNotice } from '../types';
import { formatDateTime } from '../domain';
import { fetchApi, safeG2bUrl } from './client';

function groupIcon(id: string) {
  if (/contract|cntrct/i.test(id)) return <FileSignature size={19} />;
  if (/process|progress|history/i.test(id)) return <FileClock size={19} />;
  if (/org|agency|institution|demand/i.test(id)) return <Building2 size={19} />;
  return <Layers3 size={19} />;
}

function RelatedRecord({ record }: { record: G2bRelatedRecord }) {
  const sourceUrl = safeG2bUrl(record.sourceUrl);
  return <article className="rnd-record">
    <div className="rnd-record-heading"><h4>{record.title || '공개 연관 정보'}</h4>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`${record.title || '연관 정보'} 나라장터 원문 열기`}>원문 <ExternalLink size={15} /></a>}</div>
    <dl className="rnd-fields">{record.fields.map(field => {
      const missing = field.value === null || field.value === '';
      return <div className={`rnd-field${field.wide ? ' is-wide' : ''}`} key={field.key}><dt>{field.label}</dt><dd className={missing ? 'rnd-missing' : undefined}>{missing ? '-' : field.value}{field.note && <small>{field.note}</small>}</dd></div>;
    })}</dl>
    {record.fields.length === 0 && <p className="rnd-empty-fields">공개된 추가 항목이 없습니다.</p>}
  </article>;
}

function RelatedGroup({ group }: { group: G2bRelatedGroup }) {
  const titleId = useId();
  const hasRecords = group.records.length > 0;
  const statusLabel = group.status === 'unavailable' ? '조회 불가' : group.status === 'empty' || !hasRecords ? '공개 내역 없음' : `${group.records.length.toLocaleString('ko-KR')}건`;
  return <section className={`rnd-group is-${group.status}`} aria-labelledby={titleId}>
    <div className="rnd-group-heading"><h3 id={titleId}><span className="rnd-group-icon">{groupIcon(group.id)}</span>{group.label}</h3><span className="rnd-status-badge">{statusLabel}</span></div>
    {group.message && <p className="rnd-group-message"><Info size={15} /><span>{group.message}</span></p>}
    {hasRecords ? <div className="rnd-records">{group.records.map(record => <RelatedRecord key={record.id} record={record} />)}</div> : <div className="rnd-group-empty"><Info size={19} /><p>{group.status === 'unavailable' ? '이 항목을 불러오지 못했습니다. 다시 조회하거나 나라장터 원문에서 확인해 주세요.' : '현재 조회되는 공개 내역이 없습니다. 아직 공개되지 않았거나 공고와 연결된 정보가 없을 수 있습니다.'}</p></div>}
  </section>;
}

/** Optional related lookups run only after the reader requests them. */
export function RelatedNoticeDetails({ bid, onDataChange }: { bid: BidNotice; onDataChange?: (data: G2bRelatedDetail | null) => void }) {
  const headingId = useId();
  const key = `${bid.type}:${bid.number}:${bid.revision}`;
  const [result, setResult] = useState<{ key: string; value: G2bRelatedDetail } | null>(null);
  const [loadingKey, setLoadingKey] = useState('');
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const currentKey = useRef(key);
  currentKey.current = key;
  const data = result?.key === key ? result.value : null;
  const loading = loadingKey === key;
  const error = failure?.key === key ? failure.message : '';
  const unavailableCount = data?.groups.filter(group => group.status === 'unavailable').length ?? 0;

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setResult(null); setFailure(null); setLoadingKey('');
    onDataChange?.(null);
    return () => { request.current?.abort(); };
  }, [key, onDataChange]);

  async function loadRelated() {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setLoadingKey(key); setFailure(null);
    try {
      const params = new URLSearchParams({ number: bid.number, revision: bid.revision, type: bid.type });
      const value = await fetchApi<G2bRelatedDetail>(`/api/related?${params}`, abort.signal);
      if (abort.signal.aborted || currentKey.current !== key) return;
      if (value.number !== bid.number || value.revision !== bid.revision || value.type !== bid.type) throw new Error('요청한 공고와 조회 결과가 일치하지 않습니다. 다시 조회해 주세요.');
      setResult({ key, value });
      onDataChange?.(value);
    } catch (reason) {
      if (!abort.signal.aborted && currentKey.current === key) setFailure({ key, message: reason instanceof Error ? reason.message : '연관 정보를 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.' });
    } finally {
      if (!abort.signal.aborted && currentKey.current === key) setLoadingKey('');
    }
  }

  return <section className="rnd-details" aria-labelledby={headingId}>
    <div className="rnd-heading"><div><span className="rnd-eyebrow">CONNECTED INFORMATION</span><h2 id={headingId}>계약·진행 이력·기관 정보</h2><p>이 공고에 연결된 공개 계약, 진행 이력과 공고·수요기관 정보를 함께 확인합니다.</p></div><button className="rnd-load-button" type="button" onClick={loadRelated} disabled={loading}>{loading ? <LoaderCircle className="rnd-spin" size={18} /> : data || error ? <RefreshCw size={18} /> : <ArrowDownToLine size={18} />}<span>{loading ? '연관 정보 조회 중' : data || error ? '연관 정보 다시 조회' : '연관 정보 불러오기'}</span></button></div>
    {!data && !loading && !error && <div className="rnd-intro"><span><FileSignature size={20} /><b>연결된 계약</b></span><span><FileClock size={20} /><b>공개 진행 이력</b></span><span><Building2 size={20} /><b>공고·수요기관</b></span><p>필요할 때 불러올 수 있습니다. 기존 공고의 추정가격과 참가조건은 위에서 계속 확인하실 수 있습니다.</p></div>}
    {loading && <p className="rnd-loading" role="status"><LoaderCircle className="rnd-spin" size={18} />{data ? '새로운 연관 정보를 조회하고 있습니다. 아래에는 이전 조회 결과가 표시됩니다.' : '계약, 진행 이력과 기관 정보를 확인하고 있습니다.'}</p>}
    {error && <div className="rnd-error" role="alert"><Info size={19} /><div><strong>연관 정보 조회를 완료하지 못했습니다</strong><p>{error}</p>{data && <small>아래에는 이전 조회 결과가 표시됩니다.</small>}</div></div>}
    {data && <>
      <div className={`rnd-result-meta${unavailableCount > 0 ? ' is-review' : ''}`}><span>{unavailableCount > 0 ? <Info size={16} /> : <CheckCircle2 size={16} />}{unavailableCount > 0 ? unavailableCount === data.groups.length ? '연관 정보 확인 필요' : '일부 정보 확인 필요' : '연관 정보 조회 완료'}</span><span><Clock3 size={15} />{formatDateTime(data.fetchedAt)} (한국시간)</span></div>
      {data.warnings.length > 0 && <details className="rnd-warnings"><summary><Info size={16} /><span>조회 확인사항 {data.warnings.length}개</span></summary><ul>{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <div className="rnd-groups">{data.groups.map(group => <RelatedGroup key={group.id} group={group} />)}</div>
      {data.groups.length === 0 && <p className="rnd-no-groups">현재 이 공고에 연결된 공개 정보를 확인할 수 없습니다. 계약 여부와 세부 내용은 나라장터 원문을 확인해 주세요.</p>}
      <p className="rnd-footnote"><Info size={15} /><span>조회되는 내역이 없어도 미계약이나 절차 미진행을 의미하지 않습니다. 정보 공개 시점과 공고 연결 여부에 따라 조회 결과가 달라질 수 있습니다.</span></p>
    </>}
  </section>;
}
