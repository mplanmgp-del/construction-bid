import { CalendarClock, FileCheck2 } from 'lucide-react';
import type { BidNotice } from '../types';
import type { G2bNoticeDetail } from '../g2b-types';
import { formatDateTime, formatPrice } from '../domain';

export function NoticeSummary({ bid, detail, pending = false, failed = false }: {
  bid: BidNotice; detail?: G2bNoticeDetail; pending?: boolean; failed?: boolean;
}) {
  const privateSource = bid.procurementSource === 'private';
  const budget = detail?.sections?.flatMap(section => section.fields).find(field => field.key === (privateSource ? 'asignBdgtAmt' : 'bdgtAmt'));
  // Once returned, the current detail is authoritative, including an explicit missing value.
  const planned = budget ? budget.value : bid.plannedAmount == null ? null : formatPrice(bid.plannedAmount);
  const unknown = pending ? '조회 중' : failed ? '조회 실패' : '-';
  const schedule = (value: string, privateMissing: string) => {
    const formatted = formatDateTime(value, { includeYear: true });
    return bid.procurementSource === 'private' && formatted === '일정 미제공' ? privateMissing : value ? formatted : unknown;
  };
  return <div className="fnd-key-summary" aria-label="입찰 핵심 정보">
    <div className="fnd-estimate"><span>추정가격</span><strong>{bid.estimatedPrice == null ? unknown : formatPrice(bid.estimatedPrice)}</strong><small>공고에 공개된 추정가격 기준</small></div>
    <div className="fnd-estimate fnd-base-amount"><span>{privateSource ? '배정예산금액' : '예정금액'}</span><strong>{planned || unknown}</strong><small>{privateSource ? '누리장터에 공개된 배정예산금액' : bid.type === '공사' ? '공고에 공개된 공사 예정금액 기준' : '공고에 공개된 사업 예산금액 기준'}</small></div>
    <div className="fnd-summary-date"><CalendarClock size={20} /><span>입찰서 제출마감</span><strong>{schedule(bid.deadline, '공고서 확인')}</strong></div>
    <div className="fnd-summary-date"><FileCheck2 size={20} /><span>개찰일시</span><strong>{schedule(bid.openingAt, '일정 확인 필요')}</strong></div>
  </div>;
}

export function PendingNoticeDetails({ bid, failed }: { bid: BidNotice; failed: boolean }) {
  return <div className="fnd-complete" aria-busy={!failed}>
    <NoticeSummary bid={bid} pending={!failed} failed={failed} />
    {failed ? <section className="fnd-pending-message" role="alert"><h3>상세정보를 불러오지 못했습니다</h3><p>위의 ‘새로 조회’를 눌러 다시 확인해 주세요. 목록에서 받은 금액과 일정은 계속 표시합니다.</p></section>
      : <section className="fnd-pending-message" role="status"><h3>공고 상세정보를 불러오고 있습니다</h3><p>공고 일반 · 참가조건 · 첨부서류를 확인하고 있습니다.</p><div className="fnd-skeleton-lines" aria-hidden="true"><span /><span /><span /></div></section>}
  </div>;
}
