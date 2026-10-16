import { describe, expect, it } from 'vitest';
import { planAlertChanges, type Observation } from '../server/alert-planner';
import { DEFAULT_ALERT_SETTINGS, type AlertNotice, type WorkerRule } from '../src/alerts/types';
import { NOTICES } from '../src/data';

const now = Date.parse('2026-10-16T10:00:00+09:00');
const rule: WorkerRule = { userId: 'owner', profile: null, settings: {
  ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: true, activatedAt: '2026-10-16T09:00:00+09:00',
} };
const notice = (patch: Partial<AlertNotice> = {}): AlertNotice => ({
  ...NOTICES[0], id: 'g2b:공사:R26PRIORITY:000', number: 'R26PRIORITY', revision: '000',
  title: '석면 해체공사', source: 'live', status: '접수중',
  postedAt: '2026-10-15T08:00:00+09:00', sourceUpdatedAt: '2026-10-15T08:00:00+09:00',
  biddingStartAt: '2026-10-15T09:00:00+09:00', deadline: '2027-11-20T10:00:00+09:00',
  openingAt: '2027-11-20T11:00:00+09:00', regionComplete: true, licenseComplete: true, ...patch,
});
const stored = (): Observation => planAlertChanges([notice()], [], [], [rule], now).observations[0];
const member = (fact: Observation) => ({ userId: rule.userId, key: fact.key, lastVersion: fact.version, initial: true });

describe('exact current-rule matches for recurring verification priority', () => {
  it('prioritizes a preactivation matching baseline without generating a new alert', () => {
    const plan = planAlertChanges([notice()], [], [], [rule], now);
    expect(plan).toHaveProperty('matchingKeys', ['g2b:공사:R26PRIORITY']);
    expect(plan.events).toEqual([]);
    expect(plan.existing).toHaveLength(1);
    expect(plan.observations.every(item => !Object.hasOwn(item, 'observedAt'))).toBe(true);
  });

  it('deduplicates matching identities across users, duplicate rows and notice revisions', () => {
    const other = { ...rule, userId: 'other-owner' };
    const rows = [notice({ revision: '002' }), notice(), notice({ revision: '001' }), notice({ revision: '001' })];
    const plan = planAlertChanges(rows, [], [], [rule, other], now);
    expect(plan).toHaveProperty('matchingKeys', ['g2b:공사:R26PRIORITY']);
    expect(new Set(plan.observations.map(item => item.key)).size).toBe(1);
  });

  it('keeps business types distinct and includes only keys with a real current match', () => {
    const plan = planAlertChanges([notice(), notice({ type: '용역' }), notice({ number: 'UNRELATED', title: '사무용품 구매' })], [], [], [rule], now);
    expect(plan).toHaveProperty('matchingKeys', ['g2b:공사:R26PRIORITY', 'g2b:용역:R26PRIORITY']);
  });

  it('continues prioritizing an unchanged known match after its event is deduplicated', () => {
    const before = stored();
    const plan = planAlertChanges([notice()], [before], [member(before)], [rule], now);
    expect(plan.events).toEqual([]);
    expect(plan).toHaveProperty('matchingKeys', [before.key]);
  });

  it('does not prioritize earlier matching revisions when the batch head is cancelled', () => {
    const plan = planAlertChanges([notice(), notice({ revision: '001', status: '취소' })], [], [], [rule], now);
    expect(plan).not.toHaveProperty('matchingKeys');
    expect(plan.events).toEqual([]);
  });

  it.each([
    { deadline: '2026-09-01T10:00:00+09:00', openingAt: '2026-09-01T11:00:00+09:00' },
    { deadline: '' },
    { status: '취소' as const },
    { openingCompleted: true },
  ])('does not prioritize ineligible historical or cancelled notices', patch => {
    expect(planAlertChanges([notice(patch)], [], [], [rule], now)).not.toHaveProperty('matchingKeys');
  });

  it('never prioritizes a source revision rejected as older than a stored observation', () => {
    const before = stored(); before.notice = { ...before.notice, revision: '001' };
    const plan = planAlertChanges([notice()], [before], [member(before)], [rule], now);
    expect(plan).toEqual({ observations: [], events: [], existing: [] });
  });

  it('uses actual saved unknown-condition matching instead of the broader potential-candidate guard', () => {
    const strict = structuredClone(rule);
    strict.settings.filter.regions = ['경기']; strict.settings.filter.regionBasis = 'participation';
    strict.settings.filter.includeUnknown = false;
    const plan = planAlertChanges([notice({ province: '', district: '', allowedRegions: null, regionComplete: false })], [], [], [strict], now);
    expect(plan).not.toHaveProperty('matchingKeys');
  });

  it('does not prioritize an old membership after its current filter stops matching', () => {
    const before = stored();
    const changed = structuredClone(rule); changed.settings.filter.keywords = ['전기'];
    expect(planAlertChanges([notice()], [before], [member(before)], [changed], now)).not.toHaveProperty('matchingKeys');
  });

  it('preserves the exact empty-plan shape when rules are disabled or absent', () => {
    const disabled = structuredClone(rule); disabled.settings.enabled = false;
    for (const rules of [[], [disabled]]) expect(planAlertChanges([notice()], [], [], rules, now)).toEqual({ observations: [], events: [], existing: [] });
  });
});
