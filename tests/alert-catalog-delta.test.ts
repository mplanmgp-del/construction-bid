import { describe, expect, it, vi } from 'vitest';
import { runAlertWorker } from '../server/alert-worker';
import { DEFAULT_ALERT_SETTINGS, type AlertNotice, type WorkerRule } from '../src/alerts/types';
import type { AlertStore } from '../server/alert-store';
import type { ActiveCatalogPageQuery } from '../src/live/active-catalog-types';

const now = Date.parse('2026-10-15T10:00:00+09:00');
const rule: WorkerRule = { userId: 'owner', profile: null, settings: { ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: true, activatedAt: '2026-10-15T09:00:00+09:00',
  filter: { ...structuredClone(DEFAULT_ALERT_SETTINGS.filter), categories: [], keywords: [], regions: [] } } };
const notice = (number: string): AlertNotice => ({ id: `g2b:공사:${number}:000`, number, revision: '000', title: '철거 공사', agency: '교육청', type: '공사', category: '철거·해체', province: '서울', district: '',
  allowedRegions: [], estimatedPrice: 100, contractMethod: '', status: '접수중', postedAt: '2026-10-15T09:55:00+09:00', deadline: '2026-10-20T10:00:00+09:00', openingAt: '2026-10-20T11:00:00+09:00',
  registrationDeadline: '', licenses: [], duration: '', description: '', requirements: [], documents: [], revised: false, source: 'live', sourceUpdatedAt: '2026-10-15T09:55:00+09:00', regionComplete: true, licenseComplete: true });
const group = (number: string) => ({ key: `공사:${number}`, type: '공사' as const, number, latest: notice(number), versions: [notice(number)], verifiedAt: new Date(now).toISOString() });
const status = { groupCount: 6000, activeCount: 6000, pendingSources: 1, pendingVerification: 0, completedSources: 0, coverageFrom: '1995-10-01', bootstrapComplete: false, lastCheckedAt: null, error: null, storageBytes: 1, storageCeiling: 33554432 };
function harness(patch: Record<string, unknown> = {}) {
  const commit = vi.fn(async (_lease: string, _payload: Record<string, unknown>) => ({}));
  const store = { claim: vi.fn(async () => ({ leaseId: 'lease', cursor: new Date(now - 600000).toISOString(), catalogCursor: '공사:ZZZ', catalogDeltaFrom: new Date(now - 600000).toISOString(), catalogDeltaThrough: null, catalogDeltaCursor: null,
    backfillDay: null, coverageFrom: '1995-10-01', rules: [rule], enabled: true, collectionDue: true, ...patch })), load: vi.fn(async () => ({ observations: [], memberships: [] })), commit,
    deliveries: vi.fn(async () => ({ deliveries: [] })), settle: vi.fn(), setDeadline: vi.fn() } as unknown as AlertStore;
  return { store, commit };
}
describe('catalog live changes before the full historical comparison', () => {
  it('finds a newly arrived key before the backfill cursor and commits it before older candidates', async () => {
    const { store, commit } = harness();
    const page = vi.fn(async (query: ActiveCatalogPageQuery = {}) => ({ groups: [group(query.changedSince ? 'AAA_NEW' : 'ZZZ_OLD')], nextCursor: null, status }));
    await runAlertWorker(store, { now, provider: vi.fn(), catalog: { page }, deadline: Date.now() + 45000 });
    expect(page.mock.calls[0][0]).toMatchObject({ changedSince: new Date(now - 600000).toISOString(), changedThrough: new Date(now).toISOString(), cursor: null });
    expect(page.mock.calls[1][0]).toMatchObject({ cursor: '공사:ZZZ' });
    const observations = commit.mock.calls.flatMap(call => (call[1] as { observations?: { notice: AlertNotice }[] })?.observations ?? []);
    expect(observations.map(item => item.notice.number)).toEqual(['AAA_NEW', 'ZZZ_OLD']);
    expect(commit.mock.calls.at(-1)?.[1]).toMatchObject({ checkpoint: { catalogDeltaFrom: new Date(now - 120000).toISOString(), catalogDeltaThrough: null, catalogDeltaCursor: null, catalogCursor: null } });
  });
  it('resumes an interrupted fixed change window without replacing its end watermark with now', async () => {
    const through = new Date(now - 60000).toISOString();
    const { store, commit } = harness({ catalogDeltaThrough: through, catalogDeltaCursor: '공사:BEFORE' });
    const page = vi.fn(async (_query: ActiveCatalogPageQuery = {}) => ({ groups: [], nextCursor: null, status }));
    await runAlertWorker(store, { now, provider: vi.fn(), catalog: { page }, deadline: Date.now() + 45000 });
    expect(page.mock.calls[0][0]).toMatchObject({ cursor: '공사:BEFORE', changedThrough: through });
    expect(commit.mock.calls.at(-1)?.[1]).toMatchObject({ checkpoint: { catalogDeltaFrom: new Date(Date.parse(through) - 120000).toISOString(), catalogDeltaThrough: null, catalogDeltaCursor: null } });
  });
  it('does not advance the change watermark or backfill when exact conditions fail', async () => {
    const activeRule = structuredClone(rule); activeRule.settings.filter.regions = ['서울특별시']; activeRule.settings.filter.regionBasis = 'participation';
    const { store, commit } = harness({ rules: [activeRule] });
    const row = group('AAA_NEW'); row.latest.regionComplete = false;
    const page = vi.fn(async () => ({ groups: [row], nextCursor: null, status }));
    await runAlertWorker(store, { now, provider: async () => { throw new Error('나라장터 일시 오류'); }, catalog: { page }, deadline: Date.now() + 45000 });
    expect(page).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls.at(-1)?.[1]).toMatchObject({ checkpoint: { catalogDeltaFrom: new Date(now - 600000).toISOString(), catalogDeltaThrough: new Date(now).toISOString(), catalogDeltaCursor: null, catalogCursor: '공사:ZZZ' } });
  });
  it('keeps the old source window on page failure and does not run the historical pass', async () => {
    const { store, commit } = harness(); const page = vi.fn(async () => { throw new Error('공고 목록 일시 오류'); });
    await runAlertWorker(store, { now, provider: vi.fn(), catalog: { page }, deadline: Date.now() + 45000 });
    expect(page).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls.at(-1)?.[1]).toMatchObject({ finish: true, checkpoint: { catalogDeltaFrom: new Date(now - 600000).toISOString(), catalogDeltaThrough: new Date(now).toISOString(), catalogDeltaCursor: null } });
  });
  it('rechecks the current rolling deadline range after the baseline comparison has finished', async () => {
    const { store, commit } = harness({ catalogCursor: '__complete__' });
    const page = vi.fn(async (_query: ActiveCatalogPageQuery = {}) => ({ groups: [], nextCursor: null, status: { ...status, bootstrapComplete: true, pendingSources: 0 } }));
    await runAlertWorker(store, { now, provider: vi.fn(), catalog: { page }, deadline: Date.now() + 45000 });
    expect(page).toHaveBeenCalledTimes(2);
    expect(page.mock.calls[1][0]).toMatchObject({cursor:null,deadlineFrom:'2026-10-08',deadlineTo:'2026-10-22'});
    expect(commit.mock.calls.at(-1)?.[1]).toMatchObject({ checkpoint: { catalogCursor: '__complete__' } });
  });
  it('compares an unchanged head newly entering the seven-day window on the following KST day',async()=>{
    const tomorrow=Date.parse('2026-10-16T10:00:00+09:00');
    const {store,commit}=harness({catalogCursor:'__complete__',cursor:new Date(tomorrow-600000).toISOString(),catalogDeltaFrom:new Date(tomorrow-600000).toISOString()});
    const unchanged=group('ROLLING_WINDOW');unchanged.latest.deadline='2026-10-23T10:00:00+09:00';unchanged.latest.openingAt='2026-10-23T11:00:00+09:00';
    const page=vi.fn(async(query:ActiveCatalogPageQuery={})=>({groups:query.changedSince?[]:[unchanged],nextCursor:null,status:{...status,bootstrapComplete:true,pendingSources:0}}));
    await runAlertWorker(store,{now:tomorrow,provider:vi.fn(),catalog:{page},deadline:Date.now()+45000});
    expect(page.mock.calls[0][0]).toMatchObject({changedSince:new Date(tomorrow-600000).toISOString()});
    expect(page.mock.calls[1]?.[0]).toMatchObject({cursor:null,deadlineFrom:'2026-10-09',deadlineTo:'2026-10-23'});
    const observations=commit.mock.calls.flatMap(call=>(call[1] as {observations?:{notice:AlertNotice}[]}).observations??[]);
    expect(observations.map(item=>item.notice.number)).toEqual(['ROLLING_WINDOW']);
    expect(commit.mock.calls.at(-1)?.[1]).toMatchObject({checkpoint:{catalogCursor:'__complete__'}});
  });
  it('records completed baseline comparison only after historical discovery and verification are complete', async () => {
    const { store, commit } = harness();
    const page = vi.fn(async (_query: ActiveCatalogPageQuery = {}) => ({ groups: [], nextCursor: null, status: { ...status, bootstrapComplete: true, pendingSources: 0 } }));
    await runAlertWorker(store, { now, provider: vi.fn(), catalog: { page }, deadline: Date.now() + 45000 });
    expect(commit.mock.calls.at(-1)?.[1]).toMatchObject({ checkpoint: { catalogCursor: '__complete__' } });
  });
});
