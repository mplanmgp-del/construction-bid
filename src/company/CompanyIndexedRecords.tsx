import { ChevronLeft, ChevronRight, ExternalLink, FileCheck2, Info, ListOrdered, Trophy } from 'lucide-react';
import type { CompanyContract } from '../company-contract-types';
import type { CompanyHistory, CompanyIndexedPage, CompanyParticipation } from '../company-types';
import { safeG2bUrl } from '../live/client';
import { collectedCount } from './company-index';

const number = (value: number) => value.toLocaleString('ko-KR');
const money = (value?: number | null) => value == null ? '-' : `${number(value)}원`;
const day = (value?: string | null) => value ? value.slice(0, 10).replaceAll('-', '.') : '-';
const count = (page?: CompanyIndexedPage<unknown>) => {
  const value = collectedCount(page?.totalCount ?? 0, page?.coverage);
  return value == null ? '-' : `${number(value)}건`;
};

export function CompanyIndexedRecords({ history, onAwardPage, onContractPage, onOpening, showAwards = true }: {
  history: CompanyHistory;
  showAwards?: boolean;
  onAwardPage: (page: number) => void;
  onContractPage: (page: number) => void;
  onOpening: (row: CompanyParticipation, button: HTMLButtonElement) => void;
}) {
  const awards = history.awards, contracts = history.contracts;
  return <div className="company-indexed-records">
    {showAwards && <section className="company-indexed-section company-indexed-awards panel" aria-label="수집된 참여 중 낙찰">
      <header className="company-section-heading"><div><span className="company-indexed-label"><Trophy size={16} />입찰 결과</span><h2>수집된 참여 중 낙찰 <span>{count(awards)}</span></h2><p>공식 참여 기록에서 낙찰이 확인된 이력입니다. 전체 최종낙찰 이력과 범위가 다를 수 있습니다.</p></div></header>
      <SourceCoverage page={awards} basis="개찰일" />
      {awards?.items.length ? <>
        <div className="company-history-desktop company-table-scroll"><table><thead><tr><th scope="col">공고명 / 수요기관</th><th scope="col">개찰일</th><th scope="col">계약방법</th><th scope="col">낙찰금액</th></tr></thead><tbody>{awards.items.map(row => <tr key={row.id}><td className="company-history-title"><small>{row.type} · {row.number}-{row.revision}</small><AwardTitle row={row} /><span>{row.agency || '-'}</span>{row.number && <button className="company-opening-trigger" onClick={event => onOpening(row, event.currentTarget)}><ListOrdered size={14} />투찰업체·순위 보기</button>}</td><td>{day(row.openingAt)}</td><td>{row.method || '-'}</td><td className="company-amount">{money(row.winningAmount)}</td></tr>)}</tbody></table></div>
        <div className="company-history-mobile">{awards.items.map(row => <article key={row.id}><div><span>{row.type} · {day(row.openingAt)}</span><span className="company-outcome is-won">낙찰 확인</span></div><AwardTitle row={row} /><p>{row.agency || '-'}</p><dl><div><dt>낙찰금액</dt><dd>{money(row.winningAmount)}</dd></div><div><dt>계약방법</dt><dd>{row.method || '-'}</dd></div></dl>{row.number && <button className="company-opening-trigger" onClick={event => onOpening(row, event.currentTarget)}><ListOrdered size={14} />투찰업체·순위 보기</button>}</article>)}</div>
      </> : <EmptySource page={awards} subject="낙찰" />}
      <IndexedPagination page={awards} name="수집된 낙찰" onPage={onAwardPage} />
    </section>}

    <section className="company-indexed-section company-indexed-contracts panel" aria-label="계약 이력">
      <header className="company-section-heading"><div><span className="company-indexed-label"><FileCheck2 size={16} />계약 정보</span><h2>계약 이력 <span>{count(contracts)}</span></h2><p>수의계약을 포함한 공식 계약 기록입니다. 계약 건수를 입찰 낙찰 건수에 더하지 않습니다.</p></div></header>
      <SourceCoverage page={contracts} basis="계약일" />
      <p className="company-indexed-note"><Info size={14} />계약금액은 공개된 금차 총액이며 공동계약의 업체별 수주금액과 다를 수 있습니다. 변경계약은 계약번호별로 표시합니다.</p>
      {contracts?.items.length ? <>
        <div className="company-history-desktop company-table-scroll"><table><thead><tr><th scope="col">계약명 / 계약번호</th><th scope="col">계약기관</th><th scope="col">계약일</th><th scope="col">계약방법</th><th scope="col">계약금액</th><th scope="col">업체 지분</th></tr></thead><tbody>{contracts.items.map(item => <tr key={item.id}><td className="company-history-title"><ContractTitle item={item} /></td><td>{item.agency || '-'}</td><td>{day(item.contractDate)}</td><td><ContractMethod method={item.method} /></td><td className="company-amount">{money(item.contractAmount)}</td><td>{item.shareRate == null ? '-' : `${number(item.shareRate)}%`}</td></tr>)}</tbody></table></div>
        <div className="company-history-mobile">{contracts.items.map(item => <article key={item.id}><div><span>{item.type} · {day(item.contractDate)}</span><ContractMethod method={item.method} /></div><ContractTitle item={item} /><p>{item.agency || '-'}</p><dl><div><dt>계약금액</dt><dd>{money(item.contractAmount)}</dd></div><div><dt>업체 지분</dt><dd>{item.shareRate == null ? '-' : `${number(item.shareRate)}%`}</dd></div></dl></article>)}</div>
      </> : <EmptySource page={contracts} subject="계약" />}
      <IndexedPagination page={contracts} name="계약 이력" onPage={onContractPage} />
    </section>
  </div>;
}

function SourceCoverage({ page, basis }: { page?: CompanyIndexedPage<unknown>; basis: string }) {
  const coverage = page?.coverage;
  return <div className={`company-indexed-coverage${coverage?.status !== 'ready' ? ' is-partial' : ''}`}><Info size={15} /><div><strong>{coverage?.status === 'ready' ? '표시된 수집 범위 확인 완료' : coverage?.status === 'unavailable' ? '저장소 확인 필요' : '수집 진행 중 · 현재 저장된 자료 기준'}</strong><p>{coverage?.message || '자료 수집을 준비하고 있습니다. 아직 확인되지 않은 이력을 0건으로 계산하지 않습니다.'}</p><small>{basis} 기준 {day(coverage?.from)} ~ {day(coverage?.to)}{coverage?.updatedAt && ` · 자료 갱신 ${day(coverage.updatedAt)}`}</small></div></div>;
}

function EmptySource({ page, subject }: { page?: CompanyIndexedPage<unknown>; subject: string }) {
  return <div className="company-section-empty">{page?.coverage.status === 'ready'
    ? `확인된 수집 범위에서 선택한 조건의 ${subject} 이력이 없습니다.`
    : `${subject} 이력을 아직 확인하지 못했습니다. 수집된 자료가 추가되면 자동으로 표시됩니다.`}</div>;
}

function IndexedPagination({ page, name, onPage }: { page?: CompanyIndexedPage<unknown>; name: string; onPage: (page: number) => void }) {
  if (!page || !page.totalCount) return null;
  const totalPages = Math.max(1, Math.ceil(page.totalCount / page.pageSize));
  const group = Math.floor((page.page - 1) / 10) * 10;
  if (page.page > totalPages) return <footer className="company-history-footer"><p>수집 자료가 갱신되어 페이지 수가 바뀌었습니다.</p><button className="button button-secondary" onClick={() => onPage(1)}>첫 페이지 보기</button></footer>;
  const pages = Array.from({ length: Math.max(0, Math.min(10, totalPages - group)) }, (_, index) => group + index + 1);
  return <footer className="company-history-footer"><p>{number((page.page - 1) * page.pageSize + 1)}–{number(Math.min(page.page * page.pageSize, page.totalCount))} / 수집된 {number(page.totalCount)}건</p><nav className="company-pagination" aria-label={`${name} 페이지`}><button disabled={!group} aria-label="이전 10개 페이지" onClick={() => onPage(group)}><ChevronLeft size={17} /></button>{pages.map(value => <button key={value} className={page.page === value ? 'active' : ''} aria-current={page.page === value ? 'page' : undefined} onClick={() => onPage(value)}>{value}</button>)}<button disabled={group + 10 >= totalPages} aria-label="다음 10개 페이지" onClick={() => onPage(group + 11)}><ChevronRight size={17} /></button></nav></footer>;
}

function AwardTitle({ row }: { row: CompanyParticipation }) {
  if (!row.number) return <strong className="company-notice-title">{row.title || '-'}</strong>;
  return <a className="company-notice-title" href={`/notice-detail.html?${new URLSearchParams({ number: row.number, revision: row.revision, type: row.type })}`} target="_blank" rel="noreferrer">{row.title || row.number}<ExternalLink size={12} /></a>;
}

function ContractTitle({ item }: { item: CompanyContract }) {
  const href = safeG2bUrl(item.sourceUrl);
  return <><small className="company-contract-number">{item.type} · {item.contractNumber || item.unifiedContractNumber || '-'}</small>{href ? <a className="company-notice-title" href={href} target="_blank" rel="noreferrer">{item.title || '-'}<ExternalLink size={12} /></a> : <strong className="company-notice-title">{item.title || '-'}</strong>}</>;
}

function ContractMethod({ method }: { method: string }) {
  return <span className={method.includes('수의') ? 'company-contract-method is-direct' : 'company-contract-method'}>{method || '-'}</span>;
}
