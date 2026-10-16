import type { BidNotice } from '../types';

export function noticeWorkLabel(bid: BidNotice): string {
  return bid.procurementSource === 'private' ? `민간${bid.type}` : bid.type;
}

/** Unknown private schedules need document review rather than an inferred active state. */
export function noticeVisibleStateLabel(bid: BidNotice, label: string): string {
  return bid.procurementSource === 'private' && label === '-' && bid.status !== '취소' && !bid.noticeKind?.includes('취소')
    ? '일정 확인 필요' : label;
}
