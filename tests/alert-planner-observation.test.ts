import { describe, expect, it } from 'vitest';
import { planAlertChanges, type Observation } from '../server/alert-planner';
import { DEFAULT_ALERT_SETTINGS, type AlertNotice, type WorkerRule } from '../src/alerts/types';
import { NOTICES } from '../src/data';

const now = Date.parse('2026-10-16T10:00:00+09:00');
const activation = '2026-10-16T09:00:00+09:00';
const rule: WorkerRule = { userId: 'owner', profile: null, settings: {
  ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: true, activatedAt: activation,
} };
const notice = (patch: Partial<AlertNotice> = {}): AlertNotice => ({
  ...NOTICES[0], id: 'g2b:공사:R26OBSERVED:000', number: 'R26OBSERVED', revision: '000',
  title: '석면 해체공사', source: 'live', status: '접수중',
  postedAt: '2026-10-15T08:00:00+09:00', sourceUpdatedAt: '2026-10-15T08:00:00+09:00',
  biddingStartAt: '2026-10-15T09:00:00+09:00', deadline: '2027-11-20T10:00:00+09:00',
  openingAt: '2027-11-20T11:00:00+09:00', regionComplete: true, licenseComplete: true,
  sourceOmittedDigest: 'a'.repeat(64), ...patch,
});
const stored = (observedAt?: string): Observation & { observedAt?: string } => ({
  ...planAlertChanges([notice()], [], [], [rule], now).observations[0], observedAt,
});
const member = (fact: Observation, userId = 'owner') => ({ userId, key: fact.key, lastVersion: fact.version, initial: true });

describe('database observation time and same-clock alert changes', () => {
  it.each([
    { sourceOmittedDigest: 'b'.repeat(64) },
    { estimatedPrice: 987654321 },
  ])('alerts once for a meaningful change observed after activation despite an old source clock', patch => {
    const before = stored('2026-10-16T09:10:00+09:00');
    const incoming = notice(patch);
    const plan = planAlertChanges([incoming], [before], [member(before)], [rule], now);
    expect(plan.events).toEqual([expect.objectContaining({ kind: 'changed', version: 2 })]);
    expect(plan.observations[0].notice.sourceUpdatedAt).toBe(before.notice.sourceUpdatedAt);
    const latest = plan.observations[0];
    expect(planAlertChanges([incoming], [latest], [member(latest)], [rule], now).events).toEqual([]);
    expect(planAlertChanges([notice()], [before], [member(before)], [rule], now).events).toEqual([]);
  });

  it.each([undefined, '2026-10-16T08:59:59.999+09:00', 'invalid'])('keeps an unproven or preactivation observation in the historical baseline: %s', observedAt => {
    const before = stored(observedAt);
    const plan = planAlertChanges([notice({ sourceOmittedDigest: 'b'.repeat(64) })], [before], [member(before)], [rule], now);
    expect(plan.events).toEqual([]);
    expect(plan.existing).toEqual([{ userId: 'owner', key: before.key, version: 2 }]);
  });

  it('evaluates a shared DB observation against each user’s own latest activation', () => {
    const before = stored('2026-10-16T09:10:00+09:00');
    const resetRule = structuredClone(rule);
    resetRule.userId = 'reset-owner';
    resetRule.settings.activatedAt = '2026-10-16T09:30:00+09:00';
    const plan = planAlertChanges([notice({ sourceOmittedDigest: 'b'.repeat(64) })], [before],
      [member(before), member(before, resetRule.userId)], [rule, resetRule], now);
    expect(plan.events.map(event => event.userId)).toEqual(['owner']);
    expect(plan.existing).toEqual([{ userId: resetRule.userId, key: before.key, version: 2 }]);
  });

  it('never manufactures observation timestamps while replaying historical revisions', () => {
    const rows = ['000', '001', '002'].map(revision => notice({ revision, sourceOmittedDigest: revision.padEnd(64, 'a') }));
    const plan = planAlertChanges(rows, [], [], [rule], now);
    expect(plan.events).toEqual([]);
    expect(plan.observations.map(fact => fact.version)).toEqual([1, 2, 3]);
    expect(plan.observations.every(fact => !Object.hasOwn(fact, 'observedAt'))).toBe(true);
    expect(plan.existing).toHaveLength(3);
  });

  it.each([
    { revision: '000', sourceUpdatedAt: '2026-10-15T07:59:59+09:00' },
    { revision: '000', sourceUpdatedAt: '2026-10-16T09:59:00+09:00', beforeRevision: '001' },
  ])('does not override stale source or revision guards with a recent observation', ({ beforeRevision, ...patch }) => {
    const before = stored('2026-10-16T09:10:00+09:00');
    if (beforeRevision) before.notice = { ...before.notice, revision: beforeRevision };
    const plan = planAlertChanges([notice({ ...patch, sourceOmittedDigest: 'b'.repeat(64) })], [before], [member(before)], [rule], now);
    expect(plan.events).toEqual([]);
    expect(plan.observations).toEqual([]);
  });

  it('still respects disabled change notifications after an observed same-clock change', () => {
    const before = stored('2026-10-16T09:10:00+09:00');
    const muted = structuredClone(rule); muted.settings.notifyChanges = false;
    const plan = planAlertChanges([notice({ sourceOmittedDigest: 'b'.repeat(64) })], [before], [member(before)], [muted], now);
    expect(plan.events).toEqual([]);
    expect(plan.existing).toEqual([{ userId: 'owner', key: before.key, version: 2, initial: false }]);
  });
});
