import type { BidNotice } from '../types';

function koreanTime(value: string | undefined): number {
  if (!value?.trim()) return Number.NaN;
  const text = value.trim().replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}+09:00`);
}

/** Submission context supplements the existing schedule/filter status without changing it. */
export function noticeSubmissionMessage(bid: BidNotice, now = Date.now()): string {
  if (bid.status === '취소' || bid.noticeKind?.includes('취소')) return '취소된 공고';
  const deadline = koreanTime(bid.deadline);
  if (!Number.isFinite(deadline)) return bid.procurementSource === 'private' ? '일정은 공고서 확인' : '제출 마감일 확인 필요';
  if (deadline <= now) {
    const opening = koreanTime(bid.openingAt);
    return !bid.openingCompleted && Number.isFinite(opening) && opening > now
      ? '제출 마감 · 개찰 대기' : '제출 마감';
  }
  const start = koreanTime(bid.biddingStartAt);
  return Number.isFinite(start) && start > now ? '입찰 개시 전' : '';
}
