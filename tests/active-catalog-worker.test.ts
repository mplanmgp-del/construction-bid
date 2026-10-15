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
function store(sources: ActiveCatalogSourceJob[] = [], verify: ActiveCatalogClaim['verify'] = [], rules: WorkerRule[] = [rule()], currentCoverage?: ActiveCatalogClaim['status']['currentCoverage']) {
  const commit = vi.fn(async (_leaseId: string, _payload: ActiveCatalogCommit) => ({ ok: true }));
  const finish = vi.fn(async (_leaseId: string, _payload: { error?: string }) => ({ ok: true }));
  const indexUpsert = vi.fn<ActiveCatalogStore['indexUpsert']>(async () => ({ ok: true }));
  const publishSearchVerified = vi.fn<ActiveCatalogStore['publishSearchVerified']>(async () => ({ ok: true }));
  return { claim: vi.fn(async () => ({ leaseId: 'lease', sources, verify, rules, scopeVersion: 'enabled-rules-v1', status: { currentCoverage } })), commit, finish, indexUpsert, publishSearchVerified } as unknown as ActiveCatalogStore & { commit: typeof commit; finish: typeof finish; indexUpsert: typeof indexUpsert; publishSearchVerified: typeof publishSearchVerified };
}

describe('all-age active catalog collection', () => {
  it.each(['개찰완료', '유찰'])('excludes an actually %s notice awaiting a future scheduled opening', async state => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }], []);
    const provider = vi.fn<ActiveCatalogProvider>(async operation => operation === 'getOpengResultListInfoCnstwk'
      ? { items: [{ bidNtceNo: 'R26BK01359594', bidNtceOrd: '000', bidClsfcNo: '0', rbidNo: '0', progrsDivCdNm: state }], totalCount: 1 }
      : operation === 'getScsbidListSttusCnstwk' ? { items: [], totalCount: 0 }
        : { items: [row({ bidClseDt: '2026-10-14 10:00:00', opengDt: '2026-10-16 11:00:00' })], totalCount: 1 });
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: true, requests: 3, searchGroups: 1 });
    expect(db.publishSearchVerified.mock.calls[0][1].groups[0][0]).toMatchObject({ openingCompleted: true });
    expect(provider.mock.calls.some(([operation]) => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation))).toBe(false);
  });

  it('keeps verification queued when actual opening status cannot be confirmed', async () => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }], []);
    const provider: ActiveCatalogProvider = async operation => {
      if (operation === 'getOpengResultListInfoCnstwk') throw new Error('private-provider-url');
      return operation === 'getScsbidListSttusCnstwk' || /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation) ? { items: [], totalCount: 0 }
        : { items: [row({ bidClseDt: '2026-10-14 10:00:00', opengDt: '2026-10-16 11:00:00' })], totalCount: 1 };
    };
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result.ok).toBe(false);
    expect(db.publishSearchVerified).not.toHaveBeenCalled();
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.rejectedGroups ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedGroups ?? [])).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private-provider-url');
  });

  it('excludes completed openings even when winner lookup is unavailable', async () => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }], []);
    const provider: ActiveCatalogProvider = async operation => {
      if (operation === 'getScsbidListSttusCnstwk') throw new Error('winner unavailable');
      return operation === 'getOpengResultListInfoCnstwk'
        ? { items: [{ bidNtceNo: 'R26BK01359594', bidNtceOrd: '000', bidClsfcNo: '0', rbidNo: '0', progrsDivCdNm: '개찰완료' }], totalCount: 1 }
        : { items: [row({ bidClseDt: '2026-10-14 10:00:00', opengDt: '2026-10-16 11:00:00' })], totalCount: 1 };
    };
    expect(await runActiveCatalogWorker(db, { provider, now })).toMatchObject({ ok: true, requests: 3 });
    expect(db.publishSearchVerified.mock.calls[0][1].groups[0][0]).toMatchObject({ openingCompleted: true });
  });

  it('keeps a genuine future rebid after a complete non-terminal opening status', async () => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }], []);
    const provider: ActiveCatalogProvider = async operation => operation === 'getOpengResultListInfoCnstwk'
      ? { items: [{ bidNtceNo: 'R26BK01359594', bidNtceOrd: '000', bidClsfcNo: '0', rbidNo: '1', progrsDivCdNm: '재입찰' }], totalCount: 1 }
      : operation === 'getScsbidListSttusCnstwk' || /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation) ? { items: [], totalCount: 0 }
        : { items: [row({ bidClseDt: '2026-10-14 10:00:00', opengDt: '2026-10-16 11:00:00' })], totalCount: 1 };
    expect(await runActiveCatalogWorker(db, { provider, now })).toMatchObject({ ok: true, requests: 5 });
    expect(db.publishSearchVerified.mock.calls[0][1].groups[0][0]).toMatchObject({ regionComplete: true, licenseComplete: true });
    expect(db.publishSearchVerified.mock.calls[0][1].groups[0][0].openingCompleted).not.toBe(true);
  });

  it('counts opening calls in the shared 40-request and four-concurrent-call limits', async () => {
    let running = 0, maximum = 0;
    const identities = Array.from({ length: 12 }, (_, index) => ({ type: '공사' as const, number: `R26OPENING${index}` }));
    const db = store([], identities, []);
    const provider = vi.fn<ActiveCatalogProvider>(async (operation, params) => {
      running++; maximum = Math.max(maximum, running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running--;
      return /^(?:getOpengResultListInfo|getScsbidListSttus)/.test(operation) || /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
        ? { items: [], totalCount: 0 }
        : { items: [row({ bidNtceNo: params.bidNtceNo, bidClseDt: '2026-10-14 10:00:00', opengDt: '2026-10-16 11:00:00' })], totalCount: 1 };
    });
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: true, requests: 40 });
    expect(maximum).toBe(4);
    expect(provider.mock.calls.some(([operation]) => operation === 'getOpengResultListInfoCnstwk')).toBe(true);
    expect(db.publishSearchVerified.mock.calls.length).toBeLessThan(identities.length);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedGroups ?? [])).toEqual([]);
  });

  it('verifies and publishes every ongoing public notice and its conditions without personal alarm rules', async () => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }], []);
    const provider = vi.fn<ActiveCatalogProvider>(async operation => operation === 'getBidPblancListInfoPrtcptPsblRgn'
      ? { items: [{ bidNtceNo: 'R26BK01359594', bidNtceOrd: '001', prtcptPsblRgnNm: '서울특별시' }], totalCount: 1 }
      : operation === 'getBidPblancListInfoLicenseLimit'
        ? { items: [{ bidNtceNo: 'R26BK01359594', bidNtceOrd: '001', lcnsLmtNm: '정보통신공사업' }], totalCount: 1 }
        : { items: [row(), row({ bidNtceOrd: '001', bidNtceNm: '전산 유지보수' })], totalCount: 2 });
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: true, requests: 3 });
    expect(db.publishSearchVerified).toHaveBeenCalledWith('lease', { scopeVersion: 'enabled-rules-v1', groups: [[
      expect.objectContaining({ revision: '000' }), expect.objectContaining({ revision: '001', allowedRegions: ['서울특별시'], licenses: ['정보통신공사업'], regionComplete: true, licenseComplete: true }),
    ]] });
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.groups ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.rejectedGroups ?? [])).toEqual([{ type: '공사', number: 'R26BK01359594' }]);
    expect(db.publishSearchVerified.mock.invocationCallOrder[0]).toBeLessThan(db.commit.mock.invocationCallOrder[0]);
  });

  it('keeps a failed public publication queued without consuming or privately accepting it', async () => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }]);
    db.publishSearchVerified.mockResolvedValueOnce({ ok: false });
    const result = await runActiveCatalogWorker(db, { provider: async operation => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
      ? { items: [], totalCount: 0 } : { items: [row()], totalCount: 1 }, now });
    expect(result.ok).toBe(false);
    expect(db.publishSearchVerified).toHaveBeenCalledTimes(1);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.groups ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.rejectedGroups ?? [])).toEqual([]);
  });

  it.each(['unavailable', 'capacity'])('continues claimed verification after an independent source index %s failure', async failure => {
    const identities = Array.from({ length: 8 }, (_, index) => ({ type: '공사' as const, number: `R26ISOLATE${index}` }));
    const db = store([source({ id: 'registered-construction', kind: 'registered' })], identities, []);
    if (failure === 'capacity') db.indexUpsert.mockResolvedValueOnce({ ok: false, storageFull: true });
    else db.indexUpsert.mockRejectedValueOnce(new Error('private storage URL'));
    const provider = vi.fn<ActiveCatalogProvider>(async (operation, params) => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
      ? { items: [], totalCount: 0 } : { items: [row({ bidNtceNo: params.bidNtceNo ?? 'R26SOURCE001' })], totalCount: 1 });
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: false, sources: 0, searchGroups: 8, requests: 25 });
    expect(db.publishSearchVerified).toHaveBeenCalledTimes(8);
    expect(db.indexUpsert.mock.invocationCallOrder[0]).toBeLessThan(db.publishSearchVerified.mock.invocationCallOrder[0]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedSources ?? [])).toEqual([
      { id: 'registered-construction', error: expect.any(String) },
    ]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.rejectedGroups ?? [])).toHaveLength(8);
    expect(db.finish).toHaveBeenCalledWith('lease', { error: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('private storage URL');
  });

  it.each(['unavailable', 'capacity'])('isolates one %s publication and retry metadata failure from other checked identities', async failure => {
    const identities = Array.from({ length: 8 }, (_, index) => ({ type: '공사' as const, number: `R26PUBFAIL${index}` }));
    const db = store([], identities, []);
    db.publishSearchVerified.mockImplementation(async (_lease, batch) => {
      if (batch.groups[0][0].number === 'R26PUBFAIL0') {
        if (failure === 'capacity') return { ok: false, storageFull: true };
        throw new Error('private publication URL');
      }
      return { ok: true };
    });
    db.commit.mockImplementation(async (_lease, payload) => {
      if (payload.failedGroups?.length) throw new Error('private retry URL');
      return { ok: true };
    });
    const provider = vi.fn<ActiveCatalogProvider>(async (operation, params) => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
      ? { items: [], totalCount: 0 } : { items: [row({ bidNtceNo: params.bidNtceNo })], totalCount: 1 });
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: false, searchGroups: 7, requests: 24 });
    expect(db.publishSearchVerified).toHaveBeenCalledTimes(8);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedGroups ?? [])).toEqual([
      { type: '공사', number: 'R26PUBFAIL0', error: expect.any(String) },
    ]);
    const accepted = db.commit.mock.calls.flatMap(([, payload]) => payload.rejectedGroups ?? []);
    expect(accepted.map(item => item.number)).not.toContain('R26PUBFAIL0');
    expect(db.finish).toHaveBeenCalledWith('lease', { error: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('continues later verification when failed source retry metadata cannot be stored', async () => {
    const identities = Array.from({ length: 8 }, (_, index) => ({ type: '공사' as const, number: `R26RETRY${index}` }));
    const db = store([source({ id: 'registered-construction', kind: 'registered' })], identities, []);
    db.indexUpsert.mockRejectedValueOnce(new Error('source unavailable'));
    db.commit.mockImplementation(async (_lease, payload) => {
      if (payload.failedSources?.length) throw new Error('retry metadata unavailable');
      return { ok: true };
    });
    const provider = vi.fn<ActiveCatalogProvider>(async (operation, params) => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
      ? { items: [], totalCount: 0 } : { items: [row({ bidNtceNo: params.bidNtceNo ?? 'R26SOURCE001' })], totalCount: 1 });
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: false, sources: 0, searchGroups: 8, requests: 25 });
    expect(db.publishSearchVerified).toHaveBeenCalledTimes(8);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? [])).toEqual([]);
    expect(db.finish).toHaveBeenCalledWith('lease', { error: expect.any(String) });
  });

  it.each([{ count: 32, failFirst: false }, { count: 32, failFirst: true }, { count: 36, failFirst: false }])(
    'flushes $count failed current/live sources within the sixteen-source RPC fence (first failure: $failFirst)', async ({ count, failFirst }) => {
      const jobs = Array.from({ length: count }, (_, index) => source({ id: `failed-source-${index}`,
        kind: count === 36 && index < 4 ? 'registered' : 'current' }));
      const db = store(jobs, [], []);
      db.indexUpsert.mockResolvedValue({ ok: false, storageFull: true });
      db.commit.mockImplementation(async (_lease, payload) => {
        if ((payload.failedSources?.length ?? 0) > 16) throw new Error('legacy sixteen-source RPC guard');
        if (failFirst && db.commit.mock.calls.length === 1) throw new Error('private retry storage URL');
        return { ok: true };
      });
      const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [], totalCount: 0 }));
      const result = await runActiveCatalogWorker(db, { provider, now, maxRequests: 40 });
      expect(result).toMatchObject({ ok: false, sources: 0, requests: count });
      expect(db.commit.mock.calls.map(([, payload]) => payload.failedSources?.length)).toEqual(count === 32 ? [16, 16] : [16, 16, 4]);
      const failedIds = db.commit.mock.calls.flatMap(([, payload]) => payload.failedSources ?? []).map(job => job.id).sort();
      expect(failedIds).toEqual(jobs.map(job => job.id).sort());
      expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? [])).toEqual([]);
      expect(provider).toHaveBeenCalledTimes(count);
      expect(db.finish).toHaveBeenCalledWith('lease', { error: expect.any(String) });
      expect(JSON.stringify(result)).not.toContain('private retry storage URL');
    });

  it('publishes a cancellation tombstone from complete history without fetching inactive participant conditions', async () => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }], []);
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [row(), row({ bidNtceOrd: '001', ntceKindNm: '취소공고' })], totalCount: 2 }));
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: true, requests: 1 });
    expect(db.publishSearchVerified).toHaveBeenCalledWith('lease', expect.objectContaining({ groups: [[expect.objectContaining({ revision: '000' }), expect.objectContaining({ revision: '001', status: '취소' })]] }));
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.groups ?? [])).toEqual([]);
  });

  it('defers a slow historical source throughout the current verification pass', async () => {
    let elapsed = 0;
    const db = store([source()], [{ type: '공사', number: 'R26BK01359594' }], []);
    const provider = vi.fn<ActiveCatalogProvider>(async (operation, params) => {
      if (params.inqryDiv === '1') { elapsed += 25_000; return { items: [], totalCount: 0 }; }
      elapsed += 100;
      return /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation) ? { items: [], totalCount: 0 } : { items: [row()], totalCount: 1 };
    });
    const result = await runActiveCatalogWorker(db, { provider, now, clock: () => elapsed, budgetMs: 43_000 });
    expect(result).toMatchObject({ ok: true, searchGroups: 1, sources: 0, requests: 3 });
    expect(db.publishSearchVerified).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0][1]).toMatchObject({ inqryDiv: '2', bidNtceNo: 'R26BK01359594' });
    expect(db.indexUpsert).not.toHaveBeenCalled();
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? [])).toEqual([]);
  });

  it('keeps verification unfinished after the 40-call cap without treating budget exhaustion as a failed notice', async () => {
    const identities = Array.from({ length: 16 }, (_, index) => ({ type: '공사' as const, number: `R26BUDGET${index}` }));
    const db = store([], identities, []);
    const provider = vi.fn<ActiveCatalogProvider>(async (operation, params) => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
      ? { items: [], totalCount: 0 } : { items: [row({ bidNtceNo: params.bidNtceNo })], totalCount: 1 });
    const result = await runActiveCatalogWorker(db, { provider, now, maxRequests: 40 });
    expect(result).toMatchObject({ ok: true, requests: 40, searchGroups: 12 });
    expect(db.publishSearchVerified).toHaveBeenCalledTimes(12);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.rejectedGroups ?? [])).toHaveLength(12);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedGroups ?? [])).toEqual([]);
    expect(db.finish).toHaveBeenCalledWith('lease', {});
  });

  it('uses the current verification pass for every claimed urgent notice before considering history', async () => {
    const identities = Array.from({ length: 8 }, (_, index) => ({ type: '공사' as const, number: `R26URGENT${index}` }));
    const db = store([source()], identities, []);
    const provider = vi.fn<ActiveCatalogProvider>(async (operation, params) => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
      ? { items: [], totalCount: 0 } : { items: [row({ bidNtceNo: params.bidNtceNo ?? 'R26HISTORY001', bidClseDt: '2026-10-16 10:00:00' })], totalCount: 1 });
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: true, sources: 0, searchGroups: 8, requests: 24 });
    expect(provider.mock.calls.some(([operation]) => operation.endsWith('PPSSrch'))).toBe(false);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.rejectedGroups ?? []).map(item => item.number))
      .toEqual(identities.map(item => item.number));
    expect(db.finish).toHaveBeenCalledWith('lease', {});
  });

  it('spends the 40-call cap on current verification without starting an old source page', async () => {
    const identities = Array.from({ length: 16 }, (_, index) => ({ type: '공사' as const, number: `R26CURRENT${index}` }));
    const db = store([source()], identities, []);
    const provider = vi.fn<ActiveCatalogProvider>(async (operation, params) => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
      ? { items: [], totalCount: 0 } : { items: [row({ bidNtceNo: params.bidNtceNo ?? 'R26HISTORY001' })], totalCount: 1 });
    const result = await runActiveCatalogWorker(db, { provider, now, maxRequests: 40 });
    expect(result).toMatchObject({ ok: true, sources: 0, requests: 40, searchGroups: 12 });
    expect(provider.mock.calls.some(([operation]) => operation.endsWith('PPSSrch'))).toBe(false);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedGroups ?? [])).toEqual([]);
    expect(db.finish).toHaveBeenCalledWith('lease', {});
  });

  it('reuses completed participant facts only while the verified source version is unchanged', async () => {
    const mapped = mapNotice(row(), '공사', now);
    const cached = compactCatalogNotice({ ...mapped, sourceUpdatedAt: mapped.postedAt, allowedRegions: ['서울특별시'], licenses: ['해체공사업'], regionComplete: true, licenseComplete: true });
    for (const changed of [false, true]) {
      const db = store([], [{ type: '공사', number: 'R26BK01359594', notice: cached }], []);
      const provider = vi.fn<ActiveCatalogProvider>(async operation => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
        ? { items: [], totalCount: 0 } : { items: [row(changed ? { bidNtceNm: '공고명 변경 철거공사' } : {})], totalCount: 1 });
      const result = await runActiveCatalogWorker(db, { provider, now });
      expect(result).toMatchObject({ ok: true, requests: changed ? 3 : 1, searchGroups: 1 });
      expect(db.publishSearchVerified.mock.calls[0][1].groups[0][0]).toMatchObject({ regionComplete: true, licenseComplete: true,
        allowedRegions: changed ? [] : ['서울특별시'], licenses: changed ? [] : ['해체공사업'] });
    }
  });

  it('polls every due registration and modification window before historical discovery', async () => {
    const db = store([source({ id: 'live-cnstwk', kind: 'registered' }), source({ id: 'changed-cnstwk', kind: 'modified' }),
      source({ id: 'live-servc', kind: 'registered', type: '용역' }), source({ id: 'changed-servc', kind: 'modified', type: '용역' }),
      source({ id: 'history-cnstwk' }), source({ id: 'history-servc', type: '용역' })]);
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [], totalCount: 0 }));
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: true, sources: 6, requests: 6 });
    const completed = db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? []).map(item => item.id);
    expect(completed).toEqual(['live-cnstwk', 'changed-cnstwk', 'live-servc', 'changed-servc', 'history-cnstwk', 'history-servc']);
    expect(provider.mock.calls.map(([operation, params]) => [operation, params.inqryDiv])).toEqual([
      ['getBidPblancListInfoCnstwk', '1'], ['getBidPblancListInfoCnstwk', '3'], ['getBidPblancListInfoServc', '1'], ['getBidPblancListInfoServc', '3'],
      ['getBidPblancListInfoCnstwkPPSSrch', '1'], ['getBidPblancListInfoServcPPSSrch', '1'],
    ]);
  });

  it('discovers all live windows before the full verification claim and leaves history pending', async () => {
    const identities = Array.from({ length: 6 }, (_, index) => ({ type: '공사' as const, number: `R26STAGE${index}` }));
    const db = store([
      source({ id: 'old-history' }),
      source({ id: 'registered-construction', kind: 'registered' }),
      source({ id: 'september-history', from: '2026-09-01T00:00:00+09:00', to: '2026-09-30T23:59:00+09:00' }),
      source({ id: 'modified-construction', kind: 'modified' }),
      source({ id: 'registered-service', kind: 'registered', type: '용역' }),
      source({ id: 'october-history', from: '2026-10-01T00:00:00+09:00', to: '2026-10-15T15:30:00+09:00' }),
      source({ id: 'modified-service', kind: 'modified', type: '용역' }),
    ], identities, []);
    const calls: string[] = [];
    const provider: ActiveCatalogProvider = async (operation, params) => {
      calls.push(params.inqryDiv === '2' ? `verify:${params.bidNtceNo}`
        : operation.endsWith('PPSSrch') ? `history:${params.inqryBgnDt}` : `${operation}:${params.inqryDiv}`);
      return params.inqryDiv === '2'
        ? { items: [row({ bidNtceNo: params.bidNtceNo, ntceKindNm: '취소공고' })], totalCount: 1 }
        : { items: [], totalCount: 0 };
    };
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(calls).toEqual([
      'getBidPblancListInfoCnstwk:1', 'getBidPblancListInfoCnstwk:3',
      'getBidPblancListInfoServc:1', 'getBidPblancListInfoServc:3',
      'verify:R26STAGE0', 'verify:R26STAGE1', 'verify:R26STAGE2', 'verify:R26STAGE3',
      'verify:R26STAGE4', 'verify:R26STAGE5',
    ]);
    expect(result).toMatchObject({ ok: true, sources: 4, searchGroups: 6, requests: 10 });
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? []).map(item => item.id)).toEqual([
      'registered-construction', 'modified-construction', 'registered-service', 'modified-service',
    ]);
  });

  it('uses only the two newest historical windows when no verification is ready', async () => {
    const db = store([
      source({ id: 'old-history' }),
      source({ id: 'september-history', from: '2026-09-01T00:00:00+09:00', to: '2026-09-30T23:59:00+09:00' }),
      source({ id: 'october-history', from: '2026-10-01T00:00:00+09:00', to: '2026-10-15T15:30:00+09:00' }),
    ], [], []);
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [], totalCount: 0 }));
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: true, sources: 2, searchGroups: 0, requests: 2 });
    expect(provider.mock.calls.map(([, params]) => params.inqryBgnDt)).toEqual(['202610010000', '202609010000']);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? []).map(item => item.id))
      .toEqual(['october-history', 'september-history']);
  });

  it('discovers current candidates between urgent verification and the rest of the claim without reading history', async () => {
    const identities = Array.from({ length: 6 }, (_, index) => ({ type: '공사' as const, number: `R26CURRENTSTAGE${index}` }));
    const db = store([
      source({ id: 'old-history' }),
      source({ id: 'september-current', kind: 'current', from: '2026-09-01T00:00:00+09:00', to: '2026-09-30T23:59:00+09:00' }),
      source({ id: 'registered-construction', kind: 'registered' }),
      source({ id: 'october-current', kind: 'current', from: '2026-10-01T00:00:00+09:00', to: '2026-10-15T15:30:00+09:00' }),
    ], identities, []);
    const calls: string[] = [];
    const provider: ActiveCatalogProvider = async (operation, params) => {
      calls.push(params.inqryDiv === '2' ? `verify:${params.bidNtceNo}`
        : operation.endsWith('PPSSrch') ? `current:${params.inqryBgnDt}:${params.bidClseExcpYn ?? ''}` : 'registered');
      return params.inqryDiv === '2'
        ? { items: [row({ bidNtceNo: params.bidNtceNo, ntceKindNm: '취소공고' })], totalCount: 1 }
        : { items: [], totalCount: 0 };
    };
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(calls).toEqual([
      'registered',
      'verify:R26CURRENTSTAGE0', 'verify:R26CURRENTSTAGE1', 'verify:R26CURRENTSTAGE2', 'verify:R26CURRENTSTAGE3',
      'current:202610010000:Y', 'current:202609010000:Y',
      'verify:R26CURRENTSTAGE4', 'verify:R26CURRENTSTAGE5',
    ]);
    expect(result).toMatchObject({ ok: true, sources: 3, searchGroups: 6, requests: 9 });
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? []).map(item => item.id))
      .toEqual(['registered-construction', 'october-current', 'september-current']);
  });

  it('retains current-only source progress for an old posting with a future deadline and no opening date', async () => {
    const db = store([source({ id: 'current-construction', kind: 'current' })], [], []);
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [row({ bidClseDt: '2099-03-04 10:00:00' })], totalCount: 1 }));
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(provider).toHaveBeenCalledWith('getBidPblancListInfoCnstwkPPSSrch', expect.objectContaining({
      inqryDiv: '1', inqryBgnDt: '199510010000', inqryEndDt: '199510312359', bidClseExcpYn: 'Y',
    }));
    expect(result).toMatchObject({ ok: true, sources: 1, requests: 1 });
    expect(db.indexUpsert).toHaveBeenCalledWith('lease', expect.objectContaining({
      sourceId: 'current-construction', notices: [expect.objectContaining({ postedAt: '1995-10-02T00:00:00+09:00', deadline: '2099-03-04T10:00:00+09:00', openingAt: '' })],
    }));
  });

  it('indexes the four focused current titles including scheduled notices without invalidating unrelated titles', async () => {
    const db = store([source({ id: 'current-construction', kind: 'current' })], [], []);
    const rows = [
      row({ bidNtceNo: 'R26FOCUS0', bidNtceNm: '노후 시설 철거 공사' }),
      row({ bidNtceNo: 'R26FOCUS1', bidNtceNm: '기존 건축물 해체 공사', bidBeginDt: '2026-10-17 10:00:00' }),
      row({ bidNtceNo: 'R26FOCUS2', bidNtceNm: '학교 석면 제거' }),
      row({ bidNtceNo: 'R26FOCUS3', bidNtceNm: '건설폐기물 처리' }),
      row({ bidNtceNo: 'R26OTHER0', bidNtceNm: '전산 유지보수' }),
      row({ bidNtceNo: 'R26OTHER1', bidNtceNm: '도로 포장 공사', ntceKindNm: '취소공고' }),
      row({ bidNtceNo: 'R26FOCUSBLOCK', bidNtceNm: '시설 철거 공사 취소', ntceKindNm: '취소공고' }),
    ];
    const result = await runActiveCatalogWorker(db, { provider: async () => ({ items: rows, totalCount: 7 }), now });
    expect(result).toMatchObject({ ok: true, sources: 1, requests: 1 });
    expect(db.indexUpsert.mock.calls[0][1].notices.map(notice => notice.number))
      .toEqual(['R26FOCUS0', 'R26FOCUS1', 'R26FOCUS2', 'R26FOCUS3']);
    expect(db.indexUpsert.mock.calls[0][1].notices[1].biddingStartAt).toBe('2026-10-17T10:00:00+09:00');
    expect(db.indexUpsert.mock.calls[0][1].removed.map(notice => notice.number)).toEqual(['R26FOCUSBLOCK']);
    expect(db.commit.mock.calls[0][1].sources?.[0]).toMatchObject({ totalCount: 7, receivedCount: 7, complete: true });
    expect(db.commit.mock.calls[0][1].sources?.[0].observed.map(notice => notice.number))
      .toEqual(['R26FOCUS0', 'R26FOCUS1', 'R26FOCUS2', 'R26FOCUS3', 'R26OTHER0', 'R26OTHER1', 'R26FOCUSBLOCK']);
  });

  it('advances a partial current source by all 999 raw rows while indexing only its focused candidate', async () => {
    const db = store([source({ id: 'current-construction', kind: 'current' })], [], []);
    const rows = Array.from({ length: 999 }, (_, index) => row({ bidNtceNo: `R26FOCUSRAW${index}`,
      bidNtceNm: index === 746 ? '노후 건축물 철거' : '전산 유지보수' }));
    const result = await runActiveCatalogWorker(db, { provider: async () => ({ items: rows, totalCount: 1000 }), now });
    expect(result).toMatchObject({ ok: true, sources: 1, requests: 1 });
    expect(db.indexUpsert).toHaveBeenCalledTimes(1);
    expect(db.indexUpsert.mock.calls[0][1]).toMatchObject({ batch: 0, batches: 1, removed: [] });
    expect(db.indexUpsert.mock.calls[0][1].notices.map(notice => notice.number)).toEqual(['R26FOCUSRAW746']);
    expect(db.commit.mock.calls[0][1].sources?.[0]).toMatchObject({ page: 1, totalCount: 1000, receivedCount: 999, complete: false });
    expect(db.commit.mock.calls[0][1].sources?.[0].observed).toHaveLength(999);
  });

  it('checkpoints all 999 raw identities even when a current page has no focused titles', async () => {
    const db = store([source({ id: 'current-construction', kind: 'current' })], [], []);
    const rows = Array.from({ length: 999 }, (_, index) => row({ bidNtceNo: `R26RAWONLY${index}`, bidNtceNm: '전산 유지보수' }));
    const result = await runActiveCatalogWorker(db, { provider: async () => ({ items: rows, totalCount: 1000 }), now });
    expect(result).toMatchObject({ ok: true, sources: 1, requests: 1 });
    expect(db.indexUpsert.mock.calls[0][1]).toMatchObject({ notices: [], removed: [], batch: 0, batches: 1 });
    const completed = db.commit.mock.calls[0][1].sources?.[0];
    expect(completed).toMatchObject({ receivedCount: 999, totalCount: 1000, complete: false });
    expect(completed?.rawIdentities).toHaveLength(999);
    expect(completed?.rawIdentities?.[0]).toBe('R26RAWONLY0:000');
    expect(completed?.rawIdentities?.[998]).toBe('R26RAWONLY998:000');
    expect(new Set(completed?.rawIdentities).size).toBe(999);
  });

  it('keeps both raw revisions of the same number in the current source checkpoint', async () => {
    const db = store([source({ id: 'current-construction', kind: 'current' })], [], []);
    const rows = [row({ bidNtceNo: 'R26RAWREVISION', bidNtceOrd: '000', bidNtceNm: '전산 유지보수' }),
      row({ bidNtceNo: 'R26RAWREVISION', bidNtceOrd: '001', bidNtceNm: '전산 유지보수 변경' })];
    await runActiveCatalogWorker(db, { provider: async () => ({ items: rows, totalCount: 2 }), now });
    const completed = db.commit.mock.calls[0][1].sources?.[0];
    expect(completed?.rawIdentities).toEqual(['R26RAWREVISION:000', 'R26RAWREVISION:001']);
    expect(completed?.observed).toEqual([expect.objectContaining({ number: 'R26RAWREVISION', revision: '001' })]);
    expect(completed).toMatchObject({ receivedCount: 2, totalCount: 2, complete: true });
  });

  it.each(['history', 'registered', 'modified'] as const)('keeps unrelated current facts and actual cancellations in the %s source', async kind => {
    const db = store([source({ id: `${kind}-construction`, kind })], [], []);
    const rows = [row({ bidNtceNo: 'R26GENERAL0', bidNtceNm: '전산 유지보수' }),
      row({ bidNtceNo: 'R26GENERAL1', bidNtceNm: '도로 포장 공사', ntceKindNm: '취소공고' })];
    await runActiveCatalogWorker(db, { provider: async () => ({ items: rows, totalCount: 2 }), now });
    expect(db.indexUpsert.mock.calls[0][1].notices.map(notice => notice.number)).toEqual(['R26GENERAL0']);
    expect(db.indexUpsert.mock.calls[0][1].removed.map(notice => notice.number)).toEqual(['R26GENERAL1']);
    expect(db.commit.mock.calls[0][1].sources?.[0]).not.toHaveProperty('rawIdentities');
  });

  it('leaves unstarted current pages and remaining verification queued at the shared request cap', async () => {
    const identities = Array.from({ length: 6 }, (_, index) => ({ type: '공사' as const, number: `R26CURRENTLIMIT${index}` }));
    const db = store([
      source({ id: 'old-history' }),
      ...Array.from({ length: 4 }, (_, index) => source({ id: `current-${index}`, kind: 'current' })),
    ], identities, []);
    const provider = vi.fn<ActiveCatalogProvider>(async (_operation, params) => params.inqryDiv === '2'
      ? { items: [row({ bidNtceNo: params.bidNtceNo, ntceKindNm: '취소공고' })], totalCount: 1 }
      : { items: [], totalCount: 0 });
    const result = await runActiveCatalogWorker(db, { provider, now, maxRequests: 6 });
    expect(result).toMatchObject({ ok: true, sources: 2, searchGroups: 4, requests: 6 });
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? []).map(item => item.id)).toEqual(['current-0', 'current-1']);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedSources ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedGroups ?? [])).toEqual([]);
    expect(db.finish).toHaveBeenCalledWith('lease', {});
  });

  it('retains a failed current page while later independent verification can still publish', async () => {
    const identities = Array.from({ length: 6 }, (_, index) => ({ type: '공사' as const, number: `R26CURRENTFAIL${index}` }));
    const db = store([source({ id: 'current-construction', kind: 'current' })], identities, []);
    db.indexUpsert.mockResolvedValueOnce({ ok: false, storageFull: true });
    const provider: ActiveCatalogProvider = async (_operation, params) => params.inqryDiv === '2'
      ? { items: [row({ bidNtceNo: params.bidNtceNo, ntceKindNm: '취소공고' })], totalCount: 1 }
      : { items: [], totalCount: 0 };
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: false, sources: 0, searchGroups: 6, requests: 7 });
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedSources ?? []))
      .toEqual([{ id: 'current-construction', error: expect.any(String) }]);
    expect(db.publishSearchVerified.mock.invocationCallOrder[3]).toBeLessThan(db.indexUpsert.mock.invocationCallOrder[0]);
    expect(db.indexUpsert.mock.invocationCallOrder[0]).toBeLessThan(db.publishSearchVerified.mock.invocationCallOrder[4]);
  });

  it.each([
    { cutoff: '2026-10-15T06:30:00Z', checked: 1, pending: 1, verificationPending: 0, complete: false },
    { cutoff: '2026-10-15T06:30:00Z', checked: 2, pending: 0, verificationPending: 1, complete: false },
    { cutoff: '2026-10-15T06:30:00Z', checked: 2, pending: 0, verificationPending: 0, complete: false },
  ])('leaves history queued until current coverage is complete: %o', async currentCoverage => {
    const db = store([source()], [], [], currentCoverage);
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [], totalCount: 0 }));
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: true, sources: 0, requests: 0 });
    expect(provider).not.toHaveBeenCalled();
    expect(db.commit).not.toHaveBeenCalled();
    expect(db.finish).toHaveBeenCalledWith('lease', {});
  });

  it('resumes historical discovery only after current coverage and ready verification are complete', async () => {
    const db = store([source()], [], [], { cutoff: '2026-10-15T06:30:00Z', checked: 2, pending: 0, verificationPending: 0, complete: true });
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [], totalCount: 0 }));
    expect(await runActiveCatalogWorker(db, { provider, now })).toMatchObject({ ok: true, sources: 1, requests: 1 });
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? []).map(item => item.id)).toEqual(['history-construction']);
  });

  it('leaves verification and old source windows unacknowledged when the live windows use the request budget', async () => {
    const db = store([source(), source({ id: 'registered-construction', kind: 'registered' }),
      source({ id: 'modified-construction', kind: 'modified' }), source({ id: 'registered-service', kind: 'registered', type: '용역' }),
      source({ id: 'modified-service', kind: 'modified', type: '용역' })], [{ type: '공사', number: 'R26BK01359594' }], []);
    const provider = vi.fn<ActiveCatalogProvider>(async (_operation, params) => params.inqryDiv === '2'
      ? { items: [row({ ntceKindNm: '취소공고' })], totalCount: 1 } : { items: [], totalCount: 0 });
    const result = await runActiveCatalogWorker(db, { provider, now, maxRequests: 4 });
    expect(provider.mock.calls.map(([operation, params]) => [operation, params.inqryDiv])).toEqual([
      ['getBidPblancListInfoCnstwk', '1'], ['getBidPblancListInfoCnstwk', '3'],
      ['getBidPblancListInfoServc', '1'], ['getBidPblancListInfoServc', '3'],
    ]);
    expect(result).toMatchObject({ ok: true, sources: 4, searchGroups: 0, requests: 4 });
    expect(db.publishSearchVerified).not.toHaveBeenCalled();
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? []).map(item => item.id)).toEqual([
      'registered-construction', 'modified-construction', 'registered-service', 'modified-service',
    ]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedSources ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedGroups ?? [])).toEqual([]);
    expect(db.finish).toHaveBeenCalledWith('lease', {});
  });

  it('does not fetch historical pages or publish backlog after live discovery exhausts the provider quota', async () => {
    const db = store([source(), source({ id: 'registered-construction', kind: 'registered' }),
      source({ id: 'modified-construction', kind: 'modified' }), source({ id: 'registered-service', kind: 'registered', type: '용역' }),
      source({ id: 'modified-service', kind: 'modified', type: '용역' })], [{ type: '공사', number: 'R26BK01359594' }], []);
    const provider = vi.fn<ActiveCatalogProvider>(async () => { throw new ProviderQuotaError(1800); });
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: false, sources: 0, searchGroups: 0, requests: 4 });
    expect(provider.mock.calls.map(([operation, params]) => [operation, params.inqryDiv])).toEqual([
      ['getBidPblancListInfoCnstwk', '1'], ['getBidPblancListInfoCnstwk', '3'],
      ['getBidPblancListInfoServc', '1'], ['getBidPblancListInfoServc', '3'],
    ]);
    expect(db.publishSearchVerified).not.toHaveBeenCalled();
    expect(db.indexUpsert).not.toHaveBeenCalled();
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? [])).toEqual([]);
    expect(db.finish).toHaveBeenCalledWith('lease', { error: expect.any(String), retryAfterSeconds: 1800 });
  });

  it('keeps failed live discovery and deferred history pending while verifying the entire claim', async () => {
    const identities = Array.from({ length: 8 }, (_, index) => ({ type: '공사' as const, number: `R26LIVEFAIL${index}` }));
    const db = store([source(), source({ id: 'registered-construction', kind: 'registered' })], identities, []);
    db.indexUpsert.mockResolvedValueOnce({ ok: false, storageFull: true });
    const provider: ActiveCatalogProvider = async (_operation, params) => params.inqryDiv === '2'
      ? { items: [row({ bidNtceNo: params.bidNtceNo, ntceKindNm: '취소공고' })], totalCount: 1 } : { items: [], totalCount: 0 };
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: false, sources: 0, searchGroups: 8, requests: 9 });
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.sources ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.failedSources ?? [])).toEqual([
      { id: 'registered-construction', error: expect.any(String) },
    ]);
    expect(db.indexUpsert.mock.invocationCallOrder[0]).toBeLessThan(db.publishSearchVerified.mock.invocationCallOrder[0]);
    expect(db.indexUpsert).toHaveBeenCalledTimes(1);
    expect(db.finish).toHaveBeenCalledWith('lease', { error: expect.any(String) });
  });

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
    const provider = vi.fn<ActiveCatalogProvider>(async (operation, params) => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
      ? { items: [], totalCount: 0 } : { items: params.pageNo === '1' ? rows.slice(0, 999) : rows.slice(999), totalCount: 1000 });
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }]);
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(provider).toHaveBeenCalledTimes(4);
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
    const provider: ActiveCatalogProvider = async (operation, params) => { running++; maximum = Math.max(maximum, running); await new Promise(resolve => setTimeout(resolve, 2)); running--; return /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
      ? { items: [], totalCount: 0 } : { items: [row({ bidNtceNo: params.bidNtceNo })], totalCount: 1 }; };
    await runActiveCatalogWorker(store([], Array.from({ length: 9 }, (_, i) => ({ type: '공사', number: `R26TEST${i}` }))), { provider, now });
    expect(maximum).toBe(4);
  });

  it('releases a short-budget claim without acknowledging partially started verification', async () => {
    let elapsed = 0;
    const db = store([source()], [{ type: '공사', number: 'R26BK01359594' }]);
    const provider = vi.fn<ActiveCatalogProvider>(async () => { elapsed += 2000; return { items: [row()], totalCount: 1 }; });
    db.commit.mockImplementation(async () => { elapsed += 1500; return { ok: true }; });
    const result = await runActiveCatalogWorker(db, { provider, now, budgetMs: 20_000, maxRequests: 1, clock: () => elapsed });
    expect(result).toMatchObject({ ok: true, sources: 0, groups: 0, requests: 1 });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(db.commit).not.toHaveBeenCalled();
    expect(db.publishSearchVerified).not.toHaveBeenCalled();
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
    await runActiveCatalogWorker(db, { provider: async operation => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
      ? { items: [], totalCount: 0 } : { items: [row(), row({ bidNtceOrd: '001', bidNtceNm: '전산 유지보수' })], totalCount: 2 }, now });
    expect(db.commit.mock.calls[0][1]).toMatchObject({ scopeVersion: 'enabled-rules-v1', groups: [],
      rejectedGroups: [{ type: '공사', number: 'R26BK01359594' }] });
  });

  it('does not store an untracked latest cancellation even when an earlier revision matched', async () => {
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }]);
    await runActiveCatalogWorker(db, { provider: async () => ({ items: [row(), row({ bidNtceOrd: '001', ntceKindNm: '취소공고' })], totalCount: 2 }), now });
    expect(db.commit.mock.calls[0][1]).toMatchObject({ groups: [], rejectedGroups: [{ type: '공사', number: 'R26BK01359594' }] });
  });

  it('loads common exact region and license conditions before retaining a matching group', async () => {
    const provider = vi.fn<ActiveCatalogProvider>(async (operation) => operation === 'getBidPblancListInfoLicenseLimit'
      ? { items: [{ bidNtceNo: 'R26BK01359594', bidNtceOrd: '000', lcnsLmtNm: '해체공사업' }], totalCount: 1 }
      : operation === 'getBidPblancListInfoPrtcptPsblRgn' ? { items: [], totalCount: 0 }
      : { items: [row()], totalCount: 1 });
    const db = store([], [{ type: '공사', number: 'R26BK01359594' }], [rule({ licenses: ['해체공사업'], includeUnknown: false })]);
    const result = await runActiveCatalogWorker(db, { provider, now });
    expect(result).toMatchObject({ ok: true, groups: 1, requests: 3 });
    expect(provider.mock.calls.map(([operation]) => operation)).toEqual(['getBidPblancListInfoCnstwk', 'getBidPblancListInfoPrtcptPsblRgn', 'getBidPblancListInfoLicenseLimit']);
    expect(db.commit.mock.calls[0][1].groups?.[0][0]).toMatchObject({ licenses: ['해체공사업'], licenseComplete: true, regionComplete: true });
  });

  it('drops a candidate whose exact conditions do not match and retries an incomplete condition page', async () => {
    for (const truncated of [false, true]) {
      const db = store([], [{ type: '공사', number: 'R26BK01359594' }], [rule({ licenses: ['해체공사업'], includeUnknown: false })]);
      const result = await runActiveCatalogWorker(db, { provider: async operation => operation === 'getBidPblancListInfoLicenseLimit'
        ? { items: [{ bidNtceNo: 'R26BK01359594', bidNtceOrd: '000', lcnsLmtNm: '정보통신공사업' }], totalCount: truncated ? 2 : 1 }
        : operation === 'getBidPblancListInfoPrtcptPsblRgn' ? { items: [], totalCount: 0 }
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
      : operation === 'getBidPblancListInfoPrtcptPsblRgn' ? { items: [], totalCount: 0 }
      : { items: [row()], totalCount: 1 }, now });
    expect(result.ok).toBe(false);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.groups ?? [])).toEqual([]);
    expect(db.commit.mock.calls.flatMap(([, payload]) => payload.rejectedGroups ?? [])).toEqual([]);
    expect(db.commit.mock.calls[0][1].failedGroups).toEqual([{ type: '공사', number: 'R26BK01359594', error: expect.any(String) }]);
  });

  it('restarts a reordered source page atomically without reporting a completed source or a storage failure', async () => {
    const db = store([source({ page: 2, totalCount: 1000 })]);
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
    expect(db.commit.mock.calls[0][1].failedSources).toHaveLength(2);
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
  it('routes exact opening summaries to the fixed opening service', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { totalCount: 0, items: [] } } })));
    await createActiveCatalogProvider('test-key', fetcher)('getOpengResultListInfoCnstwk', { inqryDiv: '4', bidNtceNo: 'R26BK01359594', bidNtceOrd: '000' }, { service: 'opening' });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.origin).toBe('https://apis.data.go.kr');
    expect(url.pathname).toBe('/1230000/as/ScsbidInfoService/getOpengResultListInfoCnstwk');
    expect(url.searchParams.get('bidNtceOrd')).toBe('000');
  });

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
