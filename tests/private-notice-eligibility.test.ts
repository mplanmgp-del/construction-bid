import { describe, expect, it } from 'vitest';
import { NOTICES } from '../src/data';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/types';
import { matchAlarmNotice } from '../src/alerts/domain';
import { isAlarmEligible, isCatalogNotice, isOngoingNotice, matchesDeadlineWindow } from '../src/notice-deadline-window';
import { noticeState } from '../src/notice-status';

const now = Date.parse('2026-10-16T13:00:00+09:00');
const privateNotice = () => ({ ...NOTICES[0], source: 'live' as const,
  procurementSource: 'private' as const, bidMethod: '직찰', status: '확인필요' as const,
  title: '건물외벽 드라이비트 철거 및 준불연재 재시공 업체선정 입찰공고',
  deadline: '', biddingStartAt: '', openingAt: '2026-11-25T13:00:00+09:00', sourceUpdatedAt: '2026-10-16T10:32:23+09:00', regionComplete: false, licenseComplete: false });

describe('private notices with a manual submission schedule', () => {
  it('keeps an unknown private deadline reviewable even when a future start is supplied', () => {
    expect(noticeState({ ...privateNotice(), biddingStartAt: '2026-11-01T09:00:00+09:00' }, now))
      .toMatchObject({ label: '-', tone: 'unknown' });
  });
  it('retains a reviewable private notice without claiming an open electronic submission window', () => {
    const notice = privateNotice();
    expect(isCatalogNotice(notice, now)).toBe(true);
    expect(isOngoingNotice(notice, now)).toBe(false);
    expect(noticeState(notice, now).tone).toBe('unknown');
    expect(notice.deadline).toBe('');
    expect(matchesDeadlineWindow(notice, { from: '2026-01-01', to: '2027-12-31' }, now)).toBe(false);
  });

  it('matches automatic lookup only as a review item when unknown facts are included', () => {
    const settings = structuredClone(DEFAULT_ALERT_SETTINGS);
    settings.enabled = true;
    settings.filter.keywords = ['철거'];
    settings.filter.includeUnknown = true;
    expect(isAlarmEligible(privateNotice(), now)).toBe(true);
    expect(matchAlarmNotice(privateNotice(), settings, null, now)).toMatchObject({ matched: true, needsReview: true });
    settings.filter.includeUnknown = false;
    expect(matchAlarmNotice(privateNotice(), settings, null, now).matched).toBe(false);
  });

  it('keeps missing public deadlines, invalid private deadlines, cancellation and expired openings out', () => {
    const notice = privateNotice();
    for (const patch of [
      { procurementSource: 'public' as const }, { deadline: 'invalid' }, { openingAt: '' },
      { openingAt: '2026-10-16T12:00:00+09:00' }, { openingCompleted: true },
      { status: '취소' as const }, { noticeKind: '취소공고' },
    ]) expect(isCatalogNotice({ ...notice, ...patch }, now)).toBe(false);
  });
});
