import { describe, expect, it, vi } from 'vitest';
import { compactCatalogNotice, createActiveCatalogProvider, runActiveCatalogWorker, type ActiveCatalogProvider } from '../server/active-catalog-worker';
import type { ActiveCatalogStore } from '../server/active-catalog-store';
import type { ActiveCatalogClaim, ActiveCatalogCommit, ActiveCatalogSourceJob } from '../src/live/active-catalog-types';
import { mapNotice } from '../server/g2b';
import { DEFAULT_ALERT_SETTINGS, type WorkerRule } from '../src/alerts/types';
import { ProviderQuotaError } from '../server/provider-quota';

const now = Date.parse('2026-10-15T15:30:00+09:00');
const row = (patch: Record<string, unknown> = {}) => ({ bidNtceNo: 'R26BK01359594', bidNtceOrd: '000', bsnsDivNm: '공사', bidNtceNm: '구조물 철거공사', bidNtceDt: '1995-10-02 00:00:00', rgstDt: '1995-10-02 00:00:00', bidBeginDt: '2026-02-27 10:00:00', bidClseDt: '2026-10-20 10:00:00', ...patch });
const rule = (filter: Partial<WorkerRule['settings']['filter']> = {}): WorkerRule => ({ userId: 'member-one', profile: null, settings: { ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: true, filter: { ...structuredClone(DEFAULT_ALERT_SETTINGS.filter), keywords: ['철거'], ...filter } } });
const source = (patch: Partial<ActiveCatalogSourceJob> = {}): ActiveCatalogSourceJob => ({ id: 'history-construction', type: '공사', kind: 'history', from: '1995-10-01T00:00:00+09:00', to: '1995-10-31T23:59:00+09:00', page: 1, pageSize: 999, totalCount: null, ...patch });
function store(sources: ActiveCatalogSourceJob[] = [], verify: ActiveCatalogClaim['verify'] = [], rules: WorkerRule[] = [rule()]) {
  const commit = vi.fn(async (_leaseId: string, _payload: ActiveCatalogCommit) => ({ ok: true }));
  const finish = vi.fn(async (_leaseId: string, _payload: { error?: string }) => ({ ok: true }));
  const indexUpsert = vi.fn<ActiveCatalogStore['indexUpsert']>(async () => ({ ok: true }));
  return { claim: vi.fn(async () => ({ leaseId: 'lease', sources, verify, rules, scopeVersion: 'enabled-rules-v1' })), commit, finish, indexUpsert } as unknown as ActiveCatalogStore & { commit: typeof commit; finish: typeof finish; indexUpsert: typeof indexUpsert };
}

describe('all-age active catalog collection', () => {
  it('discovers a 1995-posted active notice with a 2099 deadline and no opening date', async () => {
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [row({ bidClseDt: '2099-03-04 10:00:00' })], totalCount: 1 }));
    const db = store([source()]);
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(provider).toHaveBeenCalledWith('getBidPblancListInfoCnstwkPPSSrch', expect.objectContaining({ inqryDiv: '1', inqryBgnDt: '199510010000', inqryEndDt: '199510312359', pageNo: '1', numOfRows: '999' }));
    expect(provider.mock.calls[0][1]).not.toHaveProperty('bidClseExcpYn');
    expect(db.indexUpsert).toHaveBeenCalledWith('lease', expect.objectContaining({ notices: [expect.objectContaining({ postedAt: '1995-10-02T00:00:00+09:00', deadline: '2099-03-04T10:00:00+09:00', openingAt: '' })] }));
    expect(db.commit.mock.calls[0][1].sources?.[0].items).toEqual([]);
    expect(result).toMatchObject({ ok: true, sources: 1, requests: 1 });
  });

  it('independently polls registrations and modifications without excluding cancellation', async () => {
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [], totalCount: 0 }));
    await runActiveCatalogWorker(store([source({ id: 'modified', kind: 'modified' }), source({ id: 'registered', kind: 'registered', type: '용역' })]), { provider, now });
    expect(provider).toHaveBeenCalledWith('getBidPblancListInfoCnstwk', expect.objectContaining({ inqryDiv: '3' }));
    expect(provider).toHaveBeenCalledWith('getBidPblancListInfoServc', expect.objectContaining({ inqryDiv: '1' }));
    for (const [, params] of provider.mock.calls) expect(params).not.toHaveProperty('bidClseExcpYn');
  });

  it('keeps every returned revision, including the original and the latest cancellation', async () => {
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [row(), row({ bidNtceOrd: '001', ntceKindNm: '취소공고', chgDt: '2026-10-15 15:20:00' })], totalCount: 2 }));
    const db = store([], [{ type: '공사', number: 'R26BK01359594', tracked: true }]);
    const result = await runActiveCatalogWorker(db, { provider, now });
    const params = provider.mock.calls[0][1];
    expect(params).toEqual({ inqryDiv: '2', bidNtceNo: 'R26BK01359594', pageNo: '1', numOfRows: '999' });
    expect(db.commit).toHaveBeenCalledWith('lease', expect.objectContaining({ groups: [[expect.objectContaining({ revision: '000', status: '접수중' }), expect.objectContaining({ revision: '001', status: '취소' })]] }));
    expect(result).toMatchObject({ ok: true, groups: 1, versions: 2 });
  });

  it('reads both provider pages if all 1000 three-digit revisions exist', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => row({ bidNtceOrd: String(index).padStart(3, '0') }));
    const provider = vi.fn<ActiveCatalogProvider>(async (_operation, params) => ({ items: params.pageNo === '1' ? rows.slice(0, 999) : rows.slice(999), totalCount: 1000 }));
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }]);
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: true, groups: 1, versions: 1000 });
    expect(db.commit.mock.calls[0][1].groups?.[0].at(-1)?.revision).toBe('999');
  });

  it.each([
    ['wrong number', [row({ bidNtceNo: 'R26BK99999999' })], 1],
    ['wrong business type', [row({ bsnsDivNm: '용역' })], 1],
    ['invalid revision', [row({ bidNtceOrd: 'bad' })], 1],
    ['duplicate revision', [row(), row()], 2],
    ['truncated page', [row()], 2],
    ['empty history', [], 0],
  ])('does not publish an incomplete or mismatched history: %s', async (_name, items, totalCount) => {
    const provider: ActiveCatalogProvider = async () => ({ items, totalCount });
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }]);
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result.ok).toBe(false);
    expect(db.commit).toHaveBeenCalledWith('lease', expect.objectContaining({ failedGroups: [{ type: '공사', number: 'R26BK01359594', error: expect.any(String) }] }));
    expect(db.commit.mock.calls.some(([, payload]) => payload.groups?.length)).toBe(false);
  });

  it('does not advance a partial source page or a source whose total changed', async () => {
    for (const job of [source(), source({ page: 2, totalCount: 1001 })]) {
      const db = store([job]);
      await runActiveCatalogWorker(db, { provider: async () => ({ items: [row()], totalCount: 2 }), now });
      expect(db.commit).toHaveBeenCalledWith('lease', expect.objectContaining({ failedSources: [{ id: job.id, error: expect.any(String), ...(job.totalCount === null ? {} : { restart: true }) }] }));
      expect(db.commit.mock.calls.some(([, payload]) => payload.sources?.length)).toBe(false);
    }
  });

  it('commits successful live work even when an independent historical request fails', async () => {
    const provider: ActiveCatalogProvider = async (operation) => { if (operation.endsWith('PPSSrch')) throw new Error('secret-provider-url'); return { items: [row()], totalCount: 1 }; };
    const db = store([source(), source({ id: 'registered', kind: 'registered' })]);
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-provider-url');
    expect(db.commit).toHaveBeenCalledWith('lease', expect.objectContaining({ sources: [expect.objectContaining({ id: 'registered', complete: true })] }));
    expect(db.commit).toHaveBeenCalledWith('lease', expect.objectContaining({ failedSources: [{ id: 'history-construction', error: expect.any(String) }] }));
  });

  it('respects the shared request budget and never marks unstarted work complete', async () => {
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [], totalCount: 0 }));
    const db = store([source(), source({ id: 'registered', kind: 'registered' }), source({ id: 'modified', kind: 'modified' })]);
    await runActiveCatalogWorker(db, { provider, now, maxRequests: 2 });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? [])).toHaveLength(2);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedSources ?? [])).toEqual([]);
    expect(db.finish).toHaveBeenCalledWith('lease', {});
  });

  it('limits concurrent provider calls to four', async () => {
    let running = 0, maximum = 0;
    const provider: ActiveCatalogProvider = async () => { running++; maximum = Math.max(maximum, running); await new Promise(resolve => setTimeout(resolve, 2)); running--; return { items: [], totalCount: 0 }; };
    await runActiveCatalogWorker(store(Array.from({ length: 9 }, (_, i) => source({ id: `job-${i}` }))), { provider, now });
    expect(maximum).toBe(4);
  });

  it('releases a short-budget claim without changing unstarted verification jobs', async () => {
    let elapsed = 0;
    const db = store([source()], [{ type: '공사', number: 'R26BK01359594' }]);
    const provider = vi.fn<ActiveCatalogProvider>(async () => { elapsed += 2000; return { items: [], totalCount: 0 }; });
    db.commit.mockImplementation(async () => { elapsed += 1500; return { ok: true }; });
    const result = await runActiveCatalogWorker(db, { provider, now, budgetMs: 20_000, clock: () => elapsed });
    expect(result).toMatchObject({ ok: true, sources: 1, groups: 0, requests: 1 });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(db.commit).toHaveBeenCalledTimes(1);
    expect(db.finish).toHaveBeenCalledWith('lease', {});
  });

  it('skips concurrent leases and always releases a claimed lease', async () => {
    const db = store();
    db.claim = vi.fn(async () => ({ leaseId: null })) as unknown as ActiveCatalogStore['claim'];
    expect(await runActiveCatalogWorker(db, { now })).toMatchObject({ ok: true, skipped: true });
    expect(db.finish).not.toHaveBeenCalled();
    const claimed = store();
    await runActiveCatalogWorker(claimed, { now });
    expect(claimed.finish).toHaveBeenCalledWith('lease', {});
  });

  it('stores compact source facts without full document or description bodies', () => {
    const mapped = mapNotice(row(), '공사', now);
    const compact = compactCatalogNotice({ ...mapped, description: 'large'.repeat(10000), requirements: ['large'], documents: [{ name: 'large', size: 'large' }], sourceUpdatedAt: mapped.postedAt, regionComplete: true, licenseComplete: true });
    expect(compact).toMatchObject({ description: '', requirements: [], documents: [], duration: '', title: mapped.title, regionComplete: true, licenseComplete: true });
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(2000);
  });

  it('keeps an omitted-content digest before dropping large bodies and preserves it on repeated compaction', () => {
    const base = mapNotice(row(), '공사', now);
    const full = { ...base, description: '공고 원문', documents: [{ name: '공고문.pdf', size: '', url: 'https://www.g2b.go.kr/file.pdf' }], requirements: ['참가조건'], sourceUpdatedAt: base.postedAt, regionComplete: false, licenseComplete: false };
    const first = compactCatalogNotice(full) as ReturnType<typeof compactCatalogNotice> & { sourceOmittedDigest?: string };
    const same = compactCatalogNotice(first) as typeof first;
    const changed = compactCatalogNotice({ ...full, description: '변경된 공고 원문' }) as typeof first;
    expect(first.sourceOmittedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(same.sourceOmittedDigest).toBe(first.sourceOmittedDigest);
    expect(changed.sourceOmittedDigest).not.toBe(first.sourceOmittedDigest);
    const conditioned = compactCatalogNotice({ ...full, licenses: ['해체공사업'], allowedRegions: ['서울특별시'], regionComplete: true, licenseComplete: true }) as typeof first;
    expect(conditioned.sourceOmittedDigest).toBe(first.sourceOmittedDigest);
  });

  it('reads 999 source rows at the provider limit, retains only potential matches, and advances by received count', async () => {
    const rows = Array.from({ length: 999 }, (_, index) => row({ bidNtceNo: `R26BK${String(index).padStart(8, '0')}`, bidNtceNm: index === 746 ? '학교 철거공사' : '무관한 소프트웨어 유지보수' }));
    const db = store([source()]);
    const result = await runActiveCatalogWorker(db, { provider: async () => ({ items: rows, totalCount: 1000 }), now });
    expect(result).toMatchObject({ ok: true, sources: 1 });
    const payload = db.commit.mock.calls[0][1];
    expect(payload.scopeVersion).toBe('enabled-rules-v1');
    expect(payload.sources?.[0]).toMatchObject({ page: 1, totalCount: 1000, receivedCount: 999, complete: false });
    expect(payload.sources?.[0].items).toEqual([expect.objectContaining({ number: 'R26BK00000746' })]);
    expect(payload.sources?.[0].observed).toHaveLength(999);
    expect(JSON.stringify(payload.sources?.[0].items)).not.toContain('무관한 소프트웨어');
  });

  it('reports each encountered base identity once without retaining unrelated cancellation facts', async () => {
    const db = store([source({ kind: 'modified' })]);
    await runActiveCatalogWorker(db, { provider: async () => ({ items: [row(), row({ bidNtceOrd: '001', bidNtceNm: '조건 변경된 공고', ntceKindNm: '취소공고' })], totalCount: 2 }), now });
    expect(db.commit.mock.calls[0][1].sources?.[0]).toMatchObject({ receivedCount: 2, complete: true,
      items: [expect.objectContaining({ revision: '000' })], observed: [{ type: '공사', number: 'R26BK01359594', revision: '001', sourceUpdatedAt: '1995-10-02T00:00:00+09:00' }] });
  });

  it('continues the shared public index when no enabled alarm rules remain', async () => {
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [row()], totalCount: 1 }));
    const db = store([source()], [], [{ ...rule(), settings: { ...rule().settings, enabled: false } }]);
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: true, sources: 1, requests: 1 });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(db.indexUpsert).toHaveBeenCalledWith('lease', expect.objectContaining({ notices: [expect.objectContaining({ number: 'R26BK01359594' })] }));
    expect(db.commit.mock.calls[0][1].sources?.[0].items).toEqual([]);
    expect(db.finish).toHaveBeenCalledWith('lease', {});
  });

  it('writes all 999 common candidates in five chunks before advancing the source, independently of member keywords', async () => {
    const rows = Array.from({ length: 999 }, (_, index) => row({ bidNtceNo: `R26BK${String(index).padStart(8, '0')}`, bidNtceNm: '전산 유지보수' }));
    const db = store([source()]);
    await runActiveCatalogWorker(db, { provider: async () => ({ items: rows, totalCount: 999 }), now });
    expect(db.indexUpsert).toHaveBeenCalledTimes(5);
    expect(db.indexUpsert.mock.calls.map(([, batch]) => batch.notices.length)).toEqual([200, 200, 200, 200, 199]);
    expect(db.indexUpsert.mock.invocationCallOrder.at(-1)).toBeLessThan(db.commit.mock.invocationCallOrder[0]);
    expect(db.commit.mock.calls[0][1].sources?.[0]).toMatchObject({ receivedCount: 999, items: [], complete: true });
  });

  it('keeps passed-deadline future-opening candidates and sends only identities for cancelled and opened rows', async () => {
    const db = store([source()]);
    await runActiveCatalogWorker(db, { provider: async () => ({ totalCount: 3, items: [
      row({ bidNtceNo: 'R26WAIT00001', bidClseDt: '2026-10-14 10:00:00', opengDt: '2026-10-16 11:00:00' }),
      row({ bidNtceNo: 'R26DONE00001', opengDt: '2026-10-14 11:00:00' }),
      row({ bidNtceNo: 'R26CANCEL001', ntceKindNm: '취소공고' }),
    ] }), now });
    expect(db.indexUpsert.mock.calls[0][1].notices).toEqual([expect.objectContaining({ number: 'R26WAIT00001', status: '마감' })]);
    const removed = db.indexUpsert.mock.calls[0][1].removed;
    expect(removed.map(item => item.number)).toEqual(['R26DONE00001', 'R26CANCEL001']);
    expect(removed.every(item => !('title' in item) && !('documents' in item))).toBe(true);
  });

  it('never checkpoints a source after any common index chunk hits the fixed storage cap', async () => {
    const db = store([source()]);
    db.indexUpsert.mockResolvedValueOnce({ ok: false, storageFull: true });
    const result = await runActiveCatalogWorker(db, { provider: async () => ({ items: [row()], totalCount: 1 }), now });
    expect(result.ok).toBe(false);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? [])).toEqual([]);
    expect(db.finish).toHaveBeenCalledWith('lease', { error: expect.stringContaining('저장 한도') });
  });

  it('discards a candidate when its verified latest revision no longer matches any rule', async () => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }]);
    await runActiveCatalogWorker(db, { provider: async () => ({ items: [row(), row({ bidNtceOrd: '001', bidNtceNm: '전산 유지보수' })], totalCount: 2 }), now });
    expect(db.commit.mock.calls[0][1]).toMatchObject({ scopeVersion: 'enabled-rules-v1', groups: [],
      rejectedGroups: [{ type: '공사', number: 'R26BK01359594' }] });
  });

  it('does not store an untracked latest cancellation even when an earlier revision matched', async () => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }]);
    await runActiveCatalogWorker(db, { provider: async () => ({ items: [row(), row({ bidNtceOrd: '001', ntceKindNm: '취소공고' })], totalCount: 2 }), now });
    expect(db.commit.mock.calls[0][1]).toMatchObject({ groups: [], rejectedGroups: [{ type: '공사', number: 'R26BK01359594' }] });
  });

  it('loads only necessary exact participant conditions before retaining a matching group', async () => {
    const provider = vi.fn<ActiveCatalogProvider>(async (operation) => operation === 'getBidPblancListInfoLicenseLimit'
      ? { items: [{ bidNtceNo: 'R26BK01359594', bidNtceOrd: '000', lcnsLmtNm: '해체공사업' }], totalCount: 1 }
      : { items: [row()], totalCount: 1 });
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }], [rule({ licenses: ['해체공사업'], includeUnknown: false })]);
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: true, groups: 1, requests: 2 });
    expect(provider.mock.calls.map(([operation]) => operation)).toEqual(['getBidPblancListInfoCnstwk', 'getBidPblancListInfoLicenseLimit']);
    expect(db.commit.mock.calls[0][1].groups?.[0][0]).toMatchObject({ licenses: ['해체공사업'], licenseComplete: true, regionComplete: false });
  });

  it('drops a candidate whose exact conditions do not match and retries an incomplete condition page', async () => {
    for (const truncated of [false, true]) {
      const db = store([], [{ type: '공사', number: 'R26BK01359594' }], [rule({ licenses: ['해체공사업'], includeUnknown: false })]);
      const result = await runActiveCatalogWorker(db, { provider: async operation => operation === 'getBidPblancListInfoLicenseLimit'
        ? { items: [{ bidNtceNo: 'R26BK01359594', bidNtceOrd: '000', lcnsLmtNm: '정보통신공사업' }], totalCount: truncated ? 2 : 1 }
        : { items: [row()], totalCount: 1 }, now });
      expect(db.commit.mock.calls[0][1].groups).toEqual([]);
      if (truncated) {
        expect(result.ok).toBe(false);
        expect(db.commit.mock.calls[0][1].failedGroups).toEqual([{ type: '공사', number: 'R26BK01359594', error: expect.any(String) }]);
      } else {
        expect(result.ok).toBe(true);
        expect(db.commit.mock.calls[0][1].rejectedGroups).toEqual([{ type: '공사', number: 'R26BK01359594' }]);
      }
    }
  });

  it.each(['', undefined, '001'])('keeps verification pending when participant conditions omit or change the revision: %s', async revision => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }], [rule({ licenses: ['해체공사업'], includeUnknown: false })]);
    const result = await runActiveCatalogWorker(db, { provider: async operation => operation === 'getBidPblancListInfoLicenseLimit'
      ? { items: [{ bidNtceNo: 'R26BK01359594', bidNtceOrd: revision, lcnsLmtNm: '해체공사업' }], totalCount: 1 }
      : { items: [row()], totalCount: 1 }, now });
    expect(result.ok).toBe(false);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.groups ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.rejectedGroups ?? [])).toEqual([]);
    expect(db.commit.mock.calls[0][1].failedGroups).toEqual([{ type: '공사', number: 'R26BK01359594', error: expect.any(String) }]);
  });

  it('restarts a reordered source page atomically without reporting a completed source or a storage failure', async () => {
    const db = store([source({ page: 2, totalCount: 1000 })], [{ type: '공사', number: 'R26BK01359594' }]);
    db.commit.mockImplementationOnce(async () => ({ ok: true, restartRequired: true }));
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [row()], totalCount: 1000 }));
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: false, restartRequired: true, sources: 0, groups: 0, requests: 1 });
    expect(result).toMatchObject({ error: expect.stringContaining('순서') });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(db.commit).toHaveBeenCalledTimes(1);
    expect(db.commit.mock.calls[0][1].failedSources).toBeUndefined();
    expect(db.finish).toHaveBeenCalledWith('lease', { error: expect.stringContaining('순서') });
  });

  it('stops further provider requests after quota exhaustion without completing failed pages', async () => {
    const provider = vi.fn<ActiveCatalogProvider>(async () => { throw new ProviderQuotaError(1800); });
    const db = store(Array.from({ length: 9 }, (_, i) => source({ id: `job-${i}` })));
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result.ok).toBe(false);
    expect(provider.mock.calls.length).toBeLessThanOrEqual(4);
    expect(db.commit.mock.calls[0][1].sources).toEqual([]);
    expect(db.commit.mock.calls[0][1].failedSources).toHaveLength(9);
    expect(db.finish).toHaveBeenCalledWith('lease', { error: expect.any(String), retryAfterSeconds: 1800 });
  });

  it('restarts an unstable source snapshot but keeps a timed-out page resumable', async () => {
    const db = store([source({ page: 2, totalCount: 1001 })]);
    await runActiveCatalogWorker(db, { provider: async () => ({ items: [], totalCount: 0 }), now });
    expect(db.commit.mock.calls[0][1].failedSources).toEqual([{ id: 'history-construction', error: expect.any(String), restart: true }]);
    const failed = store([source({ page: 2, totalCount: 1001 })]);
    await runActiveCatalogWorker(failed, { provider: async () => { throw new Error('timeout'); }, now });
    expect(failed.commit.mock.calls[0][1].failedSources).toEqual([{ id: 'history-construction', error: expect.any(String) }]);
  });

  it('commits each provider page separately so full broad-condition batches do not accumulate in a large RPC', async () => {
    const rows = Array.from({ length: 999 }, (_, index) => row({ bidNtceNo: `R26BK${String(index).padStart(8, '0')}` }));
    const db = store([source({ id: 'month-a' }), source({ id: 'month-b' })]);
    const result = await runActiveCatalogWorker(db, { provider: async () => ({ items: rows, totalCount: 999 }), now });
    expect(result).toMatchObject({ ok: true, sources: 2 });
    const committed = db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? []);
    expect(committed).toHaveLength(2);
    expect(db.commit.mock.calls.every(([, payload]) => (payload.sources?.length ?? 0) <= 1)).toBe(true);
  });

  it.each([
    { revision: '001', sourceUpdatedAt: '1995-10-02T00:00:00+09:00' },
    { revision: '000', sourceUpdatedAt: '2026-10-15T15:00:00+09:00' },
  ])('keeps a newer observed change pending when the full-history endpoint is stale: %j', async minimum => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594', tracked: true, ...minimum }]);
    const result = await runActiveCatalogWorker(db, { provider: async () => ({ items: [row()], totalCount: 1 }), now });
    expect(result.ok).toBe(false);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.groups ?? [])).toEqual([]);
    expect(db.commit.mock.calls[0][1].failedGroups).toEqual([{ type: '공사', number: 'R26BK01359594', error: expect.any(String) }]);
  });
});

describe('active catalog provider', () => {
  it('reads complete provider pages without leaking its server key', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { totalCount: 1, items: [row()] } } })));
    const provider = createActiveCatalogProvider('test-key', fetcher);
    expect(await provider('getBidPblancListInfoCnstwk', { inqryDiv: '2', bidNtceNo: 'R26BK01359594' })).toMatchObject({ totalCount: 1 });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get('serviceKey')).toBe('test-key');
    const bad = createActiveCatalogProvider('secret', async () => { throw new Error('https://upstream?serviceKey=secret'); });
    await expect(bad('getBidPblancListInfoCnstwk', {})).rejects.toThrow('나라장터');
    await expect(bad('getBidPblancListInfoCnstwk', {})).rejects.not.toThrow('secret');
  });

  it('treats provider quota and error envelopes as failures, not empty pages', async () => {
    const limited = createActiveCatalogProvider('secret', async () => new Response('{}', { status: 429 }));
    await expect(limited('getBidPblancListInfoCnstwk', {})).rejects.toMatchObject({ code: 'G2B_QUOTA_EXCEEDED' });
    const bad = createActiveCatalogProvider('secret', async () => new Response(JSON.stringify({ 'nkoneps.com.response.ResponseError': { header: { resultCode: '08', resultMsg: '필수값 입력 에러' } } })));
    await expect(bad('getBidPblancListInfoCnstwk', {})).rejects.toThrow();
  });
});
