import type { BidNotice, NoticeStatus } from './types.ts';

export const CLOSING_SOON_MS = 24 * 60 * 60 * 1000;
type NoticeState = { label: NoticeStatus | '-'; tone: 'opened' | 'active' | 'urgent' | 'scheduled' | 'unknown'; description: string };

function time(value?: string): number {
  if (!value?.trim()) return Number.NaN;
  const text = value.trim().replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}+09:00`);
}

/** Display and filter the same schedule-based phase, without changing cached API data. */
export function noticeState(bid: BidNotice, now = Date.now()): NoticeState {
  if (bid.status === '취소' || /취소/.test(bid.noticeKind ?? '')) return { label: '-', tone: 'unknown', description: '취소된 공고입니다.' };
  if (bid.openingCompleted) return { label: '개찰 완료', tone: 'opened', description: '공식 개찰 결과에서 완료된 공고입니다.' };
  const opening = time(bid.openingAt);
  const start = time(bid.biddingStartAt);
  const deadline = time(bid.deadline);
  if (Number.isFinite(opening) && opening <= now) {
    return { label: '개찰 완료', tone: 'opened', description: '공고에 기재된 개찰일시 기준입니다. 실제 개찰·낙찰 결과는 공개 결과에서 확인하세요.' };
  }
  if (bid.procurementSource === 'private' && !Number.isFinite(deadline)) {
    return { label: '-', tone: 'unknown', description: '민간공고의 제출 마감은 공고서에서 확인해 주세요.' };
  }
  if (Number.isFinite(start) && start > now) return { label: '예정', tone: 'scheduled', description: '입찰 개시 전입니다.' };
  // Preserve an explicitly upcoming phase when the API did not provide its start time.
  if (!Number.isFinite(start) && bid.status === '접수예정' && (!Number.isFinite(deadline) || deadline > now)) {
    return { label: '예정', tone: 'scheduled', description: '입찰 개시 예정인 공고입니다.' };
  }
  if (Number.isFinite(deadline) && deadline > now) {
    return deadline - now <= CLOSING_SOON_MS
      ? { label: '마감 임박', tone: 'urgent', description: '입찰서 제출 마감까지 24시간 이내입니다.' }
      : { label: '진행중', tone: 'active', description: '입찰서 제출 기간입니다.' };
  }
  if (Number.isFinite(deadline) && deadline <= now && Number.isFinite(opening) && opening > now) {
    return { label: '진행중', tone: 'active', description: '입찰서 제출은 마감되었으며 개찰을 기다리고 있습니다.' };
  }
  return { label: '-', tone: 'unknown', description: '상태를 판단할 일정이 제공되지 않았습니다.' };
}
