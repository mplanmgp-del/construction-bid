import { afterEach, expect, it, vi } from 'vitest';
import type { G2bNoticePage } from '../src/g2b-types';
import { NOTICE_CACHE_MAX_AGE_MS } from '../src/live/notice-cache';
import { canRetainNoticePage } from '../src/live/useLiveNotices';

afterEach(() => vi.useRealTimers());
const timestamp = Date.parse('2026-10-12T00:00:00Z');
const page = { fetchedAt: new Date(timestamp).toISOString() } as G2bNoticePage;

it('rechecks snapshot age after a slow failed refresh instead of retaining its initial validity', () => {
  vi.useFakeTimers(); vi.setSystemTime(timestamp + NOTICE_CACHE_MAX_AGE_MS - 1000);
  expect(canRetainNoticePage(page)).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(canRetainNoticePage(page)).toBe(false);
});

it('retains complete snapshots only before the exact 24-hour expiry, rejecting unknown or future timestamps', () => {
  expect(canRetainNoticePage(page, timestamp + NOTICE_CACHE_MAX_AGE_MS - 1)).toBe(true);
  expect(canRetainNoticePage(page, timestamp + NOTICE_CACHE_MAX_AGE_MS)).toBe(false);
  expect(canRetainNoticePage(page, timestamp - 1)).toBe(false);
  expect(canRetainNoticePage({ ...page, fetchedAt: 'invalid' }, timestamp)).toBe(false);
  expect(canRetainNoticePage(null, timestamp)).toBe(false);
});
