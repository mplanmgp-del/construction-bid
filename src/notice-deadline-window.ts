import type { BidNotice } from './types.ts';
import { noticeState } from './notice-status.ts';

export interface NoticeDeadlineWindow { from: string; to: string }
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;

export function kstDay(now = Date.now()): string {
  return new Date(now + KST_MS).toISOString().slice(0, 10);
}

function shiftMonth(day: string, offset: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1 + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(date, last));
  return first.toISOString().slice(0, 10);
}

export function deadlineMonthWindow(months: number, now = Date.now()): NoticeDeadlineWindow {
  const today = kstDay(now);
  return { from: shiftMonth(today, -months), to: shiftMonth(today, months) };
}

export function deadlineDayWindow(days: number, now = Date.now()): NoticeDeadlineWindow {
  const today = Date.parse(`${kstDay(now)}T00:00:00Z`);
  return { from: new Date(today - days * DAY_MS).toISOString().slice(0, 10),
    to: new Date(today + days * DAY_MS).toISOString().slice(0, 10) };
}

export function noticeTimestamp(value?: string): number {
  if (!value?.trim()) return Number.NaN;
  const text = value.trim().replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}+09:00`);
}

/** Submission-closed notices awaiting a future opening remain ongoing. */
export function isOngoingNotice(notice: BidNotice, now = Date.now()): boolean {
  if (!Number.isFinite(noticeTimestamp(notice.deadline)) || notice.openingCompleted
    || notice.status === '취소' || /취소/.test(notice.noticeKind ?? '')) return false;
  return ['active', 'urgent', 'scheduled'].includes(noticeState(notice, now).tone);
}

/** Manual private tenders need review even when the electronic deadline is absent. */
export function isCatalogNotice(notice: BidNotice, now = Date.now()): boolean {
  if (isOngoingNotice(notice, now)) return true;
  return notice.procurementSource === 'private' && !notice.deadline.trim()
    && !notice.openingCompleted && notice.status !== '취소' && !/취소/.test(notice.noticeKind ?? '')
    && Number.isFinite(noticeTimestamp(notice.openingAt)) && noticeTimestamp(notice.openingAt) > now;
}

export function matchesDeadlineWindow(notice: BidNotice, window: NoticeDeadlineWindow, now = Date.now()): boolean {
  if (!isOngoingNotice(notice, now)) return false;
  const day = kstDay(noticeTimestamp(notice.deadline));
  return day >= window.from && day <= window.to;
}

export function isAlarmEligible(notice: BidNotice, now = Date.now()): boolean {
  return isCatalogNotice(notice, now);
}
