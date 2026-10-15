import { describe, expect, it, vi } from 'vitest';
import { scanCatalogForAlerts } from '../server/catalog-alert-scan';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/types';
import type { WorkerRule } from '../src/alerts/types';
import { NOTICES } from '../src/data';

const notice = (revision: string) => ({ ...NOTICES[0], source: 'live' as const, number: 'OLD1995', revision, postedAt: '1995-10-01T00:00:00+09:00',
  deadline: '2099-01-01T10:00:00+09:00', sourceUpdatedAt: '2026-10-15T10:00:00+09:00', regionComplete: false, licenseComplete: false, documents: [], description: '', requirements: [] });
const group = (number = 'OLD1995') => { const versions = ['000', '001'].map(revision => ({ ...notice(revision), number })); return { key: `공사:${number}`, type: '공사' as const, number, latest: versions[1], versions, verifiedAt: '2026-10-15T10:00:00Z' }; };
const status = { groupCount: 1, activeCount: 1, pendingSources: 0, pendingVerification: 0, completedSources: 746, coverageFrom: '1995-10-01', bootstrapComplete: true, lastCheckedAt: '', error: null, storageBytes: 10, storageCeiling: 33554432 };
const rule: WorkerRule = { userId: 'a', profile: null, settings: { ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: true, filter: { ...structuredClone(DEFAULT_ALERT_SETTINGS.filter), keywords: [], categories: [], regions: [] } } };

describe('same catalog feeds all-age alerts', () => {
  it('scans every catalog page without a posting-year or opening-day cutoff and preserves every revision', async () => {
    const page = vi.fn().mockResolvedValueOnce({ groups: [group()], nextCursor: '공사:OLD1995', status })
      .mockResolvedValueOnce({ groups: [group('OLD2000')], nextCursor: null, status });
    const commit = vi.fn().mockResolvedValue(undefined), provider = vi.fn();
    const result = await scanCatalogForAlerts({ page }, provider, [rule], null, commit, Date.now() + 30000);
    expect(result.cursor).toBeNull(); expect(result.complete).toBe(true);
    expect(commit.mock.calls.flatMap(call => call[0]).map(item => `${item.number}:${item.revision}`))
      .toEqual(['OLD1995:000', 'OLD1995:001', 'OLD2000:000', 'OLD2000:001']);
    expect(page.mock.calls[0][0]).toMatchObject({ includeInactive: true });
    expect(provider).not.toHaveBeenCalled();
  });
  it('loads only necessary missing conditions once and writes compact enrichment for later search and alerts', async () => {
    const page = vi.fn().mockResolvedValue({ groups: [group()], nextCursor: null, status }), enrich = vi.fn().mockResolvedValue({ ok: true });
    const provider = vi.fn().mockResolvedValue([{ bidNtceNo: 'OLD1995', bidNtceOrd: '001', prtcptPsblRgnNm: '서울특별시' }]);
    const commit = vi.fn().mockResolvedValue(undefined), regionalRule = structuredClone(rule);
    regionalRule.settings.filter.regions = ['서울특별시']; regionalRule.settings.filter.regionBasis = 'participation';
    await scanCatalogForAlerts({ page, enrich }, provider, [regionalRule], null, commit, Date.now() + 30000);
    expect(provider).toHaveBeenCalledOnce(); expect(provider.mock.calls[0][1]).toMatchObject({ inqryDiv: '2', bidNtceNo: 'OLD1995', bidNtceOrd: '001' });
    expect(enrich.mock.calls[0][0]).toMatchObject({ revision: '001', allowedRegions: ['서울특별시'], regionComplete: true, documents: [] });
    expect(commit.mock.calls[0][0][1].allowedRegions).toEqual(['서울특별시']);
  });
  it('keeps its cursor before a failed group while committing earlier verified groups', async () => {
    const page = vi.fn().mockResolvedValue({ groups: [group('A'), group('B')], nextCursor: null, status });
    const provider = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('나라장터 일시 오류'));
    const commit = vi.fn().mockResolvedValue(undefined), regionalRule = structuredClone(rule);
    regionalRule.settings.filter.regions = ['서울특별시']; regionalRule.settings.filter.regionBasis = 'participation';
    const result = await scanCatalogForAlerts({ page }, provider, [regionalRule], null, commit, Date.now() + 30000);
    expect(result.cursor).toBe('공사:A'); expect(result.complete).toBe(false); expect(result.error).toContain('나라장터');
    expect(commit.mock.calls.flatMap(call => call[0]).every(item => item.number === 'A')).toBe(true);
  });
  it.each(['', undefined, 'x', '0000'])('does not turn missing or invalid condition revision %s into revision 000', async revision => {
    const item = group(); item.latest.revision = '000'; item.versions = [item.latest];
    const page = vi.fn().mockResolvedValue({ groups: [item], nextCursor: null, status });
    const provider = vi.fn().mockResolvedValue([{ bidNtceNo: 'OLD1995', bidNtceOrd: revision, prtcptPsblRgnNm: '서울특별시' }]);
    const commit = vi.fn(), regionalRule = structuredClone(rule);
    regionalRule.settings.filter.regions = ['서울특별시']; regionalRule.settings.filter.regionBasis = 'participation';
    const result = await scanCatalogForAlerts({ page }, provider, [regionalRule], null, commit, Date.now() + 30000);
    expect(result.complete).toBe(false); expect(result.cursor).toBeNull(); expect(result.error).toContain('번호·차수');
    expect(commit).not.toHaveBeenCalled();
  });
  it('retains the current position when enrichment storage rejects an otherwise complete condition response', async () => {
    const page = vi.fn().mockResolvedValue({ groups: [group()], nextCursor: null, status });
    const enrich = vi.fn().mockResolvedValue({ ok: false }), provider = vi.fn().mockResolvedValue([]), commit = vi.fn();
    const regionalRule = structuredClone(rule); regionalRule.settings.filter.regions = ['서울특별시']; regionalRule.settings.filter.regionBasis = 'participation';
    const result = await scanCatalogForAlerts({ page, enrich }, provider, [regionalRule], null, commit, Date.now() + 30000);
    expect(result.complete).toBe(false); expect(result.cursor).toBeNull(); expect(result.error).toContain('저장');
    expect(commit).not.toHaveBeenCalled();
  });
});
