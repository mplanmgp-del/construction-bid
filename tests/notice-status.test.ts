import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, DEMO_PROFILES, NOTICES } from '../src/data';
import { filterNotices } from '../src/domain';
import { noticeState } from '../src/notice-status';
import type { BidNotice, NoticeStatus } from '../src/types';

const stamp = (value: string) => Date.parse(`${value}+09:00`);
const bid = (patch: Partial<BidNotice> = {}): BidNotice => ({
  ...NOTICES[0], source: 'live', status: '접수중',
  biddingStartAt: '2026-10-13T09:00:00+09:00',
  deadline: '2026-10-16T10:00:00+09:00', openingAt: '2026-10-16T11:00:00+09:00',
  ...patch,
});

describe('shared notice status classification', () => {
  it.each([
    ['2026-10-13T08:59:59.999', '예정'],
    ['2026-10-13T09:00:00', '진행중'],
    ['2026-10-15T09:59:59.999', '진행중'],
    ['2026-10-15T10:00:00', '마감 임박'],
    ['2026-10-16T09:59:59.999', '마감 임박'],
    ['2026-10-16T10:00:00', '진행중'],
    ['2026-10-16T10:59:59.999', '진행중'],
    ['2026-10-16T11:00:00', '개찰 완료'],
  ] as const)('classifies the start, 24-hour, deadline and opening boundaries at %s', (now, expected) => {
    expect(noticeState(bid(), stamp(now)).label).toBe(expected);
  });

  it('identifies the closed submission period without calling it imminent', () => {
    const state = noticeState(bid(), stamp('2026-10-16T10:30:00'));
    expect(state.label).toBe('진행중');
    expect(state.description).toContain('제출은 마감');
    expect(state.description).toContain('개찰을 기다리고');
  });

  it('interprets dates without offsets as Korean time, including API-style spaces', () => {
    const noOffset = bid({ biddingStartAt: '2026-10-13 09:00:00', deadline: '2026-10-16T10:00:00', openingAt: '2026-10-16 11:00:00' });
    expect(noticeState(noOffset, Date.parse('2026-10-13T00:00:00Z')).label).toBe('진행중');
    expect(noticeState(noOffset, Date.parse('2026-10-15T01:00:00Z')).label).toBe('마감 임박');
    expect(noticeState(noOffset, Date.parse('2026-10-16T02:00:00Z')).label).toBe('개찰 완료');
  });

  it('recomputes cached upcoming and open notices without mutating their stored status', () => {
    const cached = Object.freeze(bid({ status: '접수예정' }));
    expect(noticeState(cached, stamp('2026-10-13T10:00:00')).label).toBe('진행중');
    expect(noticeState(cached, stamp('2026-10-16T09:00:00')).label).toBe('마감 임박');
    expect(noticeState(cached, stamp('2026-10-16T11:00:00')).label).toBe('개찰 완료');
    expect(cached.status).toBe('접수예정');
    expect(noticeState(bid({ status: '접수중' }), stamp('2026-10-13T08:00:00')).label).toBe('예정');
  });

  it('keeps an upcoming provider status if its start time is missing', () => {
    expect(noticeState(bid({ status: '접수예정', biddingStartAt: undefined }), stamp('2026-10-13T10:00:00')).label).toBe('예정');
  });

  it('keeps canceled notices out of the four phases even after opening', () => {
    const state = noticeState(bid({ status: '취소' }), stamp('2026-10-17T10:00:00'));
    expect(state.label).toBe('-');
    expect(state.description).toContain('취소');
  });

  it.each(['', 'invalid'])('does not invent a phase for absent or invalid schedules: %s', value => {
    expect(noticeState(bid({ status: '확인필요', biddingStartAt: value, deadline: value, openingAt: value }), stamp('2026-10-13T10:00:00')).label).toBe('-');
  });

  it('does not infer opening completion from a submission deadline alone', () => {
    expect(noticeState(bid({ openingAt: '' }), stamp('2026-10-17T10:00:00')).label).toBe('-');
  });
});

describe('status filtering matches the list before pagination or result lookup', () => {
  const now = stamp('2026-10-13T10:00:00');
  const cases: Record<NoticeStatus, BidNotice> = {
    '개찰 완료': bid({ id: 'opened', biddingStartAt: '2026-10-09T09:00:00+09:00', deadline: '2026-10-12T10:00:00+09:00', openingAt: '2026-10-12T11:00:00+09:00' }),
    '진행중': bid({ id: 'active' }),
    '마감 임박': bid({ id: 'urgent', deadline: '2026-10-14T10:00:00+09:00', openingAt: '2026-10-14T11:00:00+09:00' }),
    '예정': bid({ id: 'upcoming', biddingStartAt: '2026-10-14T09:00:00+09:00' }),
  };
  const all = [
    ...Array.from({ length: 31 }, (_, index) => bid({ id: `active-${index}` })),
    ...Object.values(cases),
    bid({ id: 'canceled', status: '취소' }),
    bid({ id: 'unknown', status: '확인필요', biddingStartAt: '', deadline: '', openingAt: '' }),
  ];
  const filters = { ...DEFAULT_FILTERS, category: '전체' as const, autoRegion: false, status: '전체' as const };

  it.each(Object.keys(cases) as NoticeStatus[])('selects every %s row with exactly the visible label', status => {
    const found = filterNotices(all, { ...filters, status }, DEMO_PROFILES[0], now);
    expect(found.length).toBe(status === '진행중' ? 32 : 1);
    expect(found.map(item => item.id)).toContain(cases[status].id);
    expect(found.every(item => noticeState(item, now).label === status)).toBe(true);
    // Three non-active cases start beyond the first 30 items; they need no page visit or result summary.
    if (status !== '진행중') expect(all.indexOf(found[0])).toBeGreaterThanOrEqual(30);
  });

  it('keeps unclassified records available in all results', () => {
    const found = filterNotices(all, filters, DEMO_PROFILES[0], now);
    expect(found).toHaveLength(all.length);
    expect(found.map(item => item.id)).toEqual(expect.arrayContaining(['canceled', 'unknown']));
  });
});
