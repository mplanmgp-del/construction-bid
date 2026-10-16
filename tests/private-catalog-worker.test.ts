import { describe, expect, it, vi } from 'vitest';
import { createActiveCatalogProvider, runActiveCatalogWorker, type ActiveCatalogProvider } from '../server/active-catalog-worker';
import { createAlertProvider } from '../server/alert-collector';
import { scanCatalogForAlerts } from '../server/catalog-alert-scan';
import { NOTICES } from '../src/data';
import type { ActiveCatalogStore } from '../server/active-catalog-store';
import type { ActiveCatalogClaim } from '../src/live/active-catalog-types';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/types';

const now = Date.parse('2026-10-16T13:00:00+09:00');
const row = (revision = '001') => ({ bidNtceNo: 'R26BK01774453', bidNtceOrd: revision,
  bidNtceClsfc: '민간공사', ntceNm: '건물외벽 드라이비트 철거 및 준불연재 재시공 업체선정 입찰공고',
  nticeDt: '2026-10-16 10:32:23', rgstDt: '2026-10-16 10:32:23', ntceDivNm: revision === '001' ? '변경공고' : '등록공고',
  ntceInsttNm: '주식회사 한국자산보증관리', bidMethdNm: '직찰', cntrctMthdNm: '일반경쟁',
  bidClseDt: '', bidBeginDt: '', opengDt: '2026-11-25 13:00:00' });
const payload = (items: Record<string, unknown>[] = []) => ({ response: { header: { resultCode: '00' }, body: { items, totalCount: items.length } } });
function storage(verification = false) {
  const settings = structuredClone(DEFAULT_ALERT_SETTINGS);
  settings.enabled = true; settings.filter.keywords = ['철거'];
  const claim = { leaseId: 'lease', scopeVersion: 'scope', rules: [{ userId: 'user', profile: null, settings }],
    verify: verification ? [{ type: '공사', number: 'R26BK01774453', procurementSource: 'private' }] : [],
    sources: verification ? [] : [{ id: 'private-source', type: '공사', kind: 'current', procurementSource: 'private',
      from: '2026-10-01T00:00:00+09:00', to: '2026-10-16T13:00:00+09:00', page: 1, pageSize: 999, totalCount: null }],
    status: { currentCoverage: { complete: false } } } as unknown as ActiveCatalogClaim;
  return { claim: vi.fn(async () => claim), commit: vi.fn(async () => ({ ok: true })), finish: vi.fn(async () => ({ ok: true })),
    indexUpsert: vi.fn(async () => ({ ok: true })), publishSearchVerified: vi.fn(async () => ({ ok: true })) };
}

describe('private notices share bounded catalog work without entering public provider operations', () => {
  it('rechecks a private candidate using private history during automatic alert comparison', async () => {
    const latest = { ...NOTICES[0], number: 'R26BK01774453', revision: '000', source: 'live' as const,
      procurementSource: 'private' as const, deadline: '', biddingStartAt: '', openingAt: '2026-11-25T13:00:00+09:00',
      sourceUpdatedAt: '2026-10-16T10:32:23+09:00', regionComplete: false, licenseComplete: false };
    const catalog = { page: vi.fn(async () => ({ groups: [{ key: '공사:R26BK01774453', type: '공사' as const,
      number: latest.number, latest, versions: [latest], verifiedAt: '' }], nextCursor: null, status: {} as never })),
      publishVerified: vi.fn(async () => ({ ok: true })) };
    const provider = vi.fn(async () => [row('000'), row('001')]);
    const settings = structuredClone(DEFAULT_ALERT_SETTINGS); settings.enabled = true; settings.filter.keywords = ['철거'];
    const commit = vi.fn();
    expect(await scanCatalogForAlerts(catalog, provider, [{ userId: 'member', profile: null, settings }], null, commit,
      Date.now() + 30_000, now)).toMatchObject({ complete: true, processed: 1 });
    expect(provider.mock.calls[0]).toEqual(['getPrvtBidPblancListInfoCnstwk', { inqryDiv: '4', bidNtceNo: latest.number }]);
    expect(commit.mock.calls[0][0][1]).toMatchObject({ procurementSource: 'private', revision: '001', deadline: '' });
  });

  it('discovers a private manual tender and preserves its missing electronic deadline in the index', async () => {
    const db = storage();
    const provider = vi.fn<ActiveCatalogProvider>(async () => ({ items: [row()], totalCount: 1 }));
    expect(await runActiveCatalogWorker(db as unknown as ActiveCatalogStore, { provider, now })).toMatchObject({ ok: true, sources: 1, requests: 1 });
    expect(provider.mock.calls[0]).toEqual(['getPrvtBidPblancListInfoCnstwkPPSSrch', expect.objectContaining({ inqryDiv: '1' })]);
    expect(provider.mock.calls[0][1]).not.toHaveProperty('bidClseExcpYn');
    const batch = (db.indexUpsert.mock.calls as unknown as [string, { notices: unknown[]; removed: unknown[] }][])[0][1];
    expect(batch.notices).toEqual([expect.objectContaining({ procurementSource: 'private', deadline: '', status: '확인필요' })]);
    expect(batch.removed).toEqual([]);
  });

  it('verifies every private revision and private participant conditions before publishing and matching', async () => {
    const db = storage(true);
    const provider = vi.fn<ActiveCatalogProvider>(async operation => /(?:PrtcptPsblRgn|LicenseLimit)$/.test(operation)
      ? { items: [], totalCount: 0 } : { items: [row('000'), row('001')], totalCount: 2 });
    expect(await runActiveCatalogWorker(db as unknown as ActiveCatalogStore, { provider, now })).toMatchObject({ ok: true, searchGroups: 1, groups: 1, requests: 3 });
    expect(provider.mock.calls.map(([operation]) => operation)).toEqual([
      'getPrvtBidPblancListInfoCnstwk', 'getPrvtBidPblancListInfoPrtcptPsblRgn', 'getPrvtBidPblancListInfoLicenseLimit',
    ]);
    expect(provider.mock.calls[0][1]).toMatchObject({ inqryDiv: '4', bidNtceNo: 'R26BK01774453' });
    const published = (db.publishSearchVerified.mock.calls as unknown as [string, { groups: { revision: string; deadline: string }[][] }][])[0][1];
    expect(published.groups[0].map(item => item.revision)).toEqual(['000', '001']);
    expect(published.groups[0][1].deadline).toBe('');
  });

  it.each(['catalog', 'alarm'])('routes %s private provider calls to the separate official service', async kind => {
    const outgoing: URL[] = [];
    const fetcher: typeof fetch = async input => { outgoing.push(new URL(String(input))); return Response.json(payload()); };
    const provider = kind === 'catalog' ? createActiveCatalogProvider('test-key', fetcher) : createAlertProvider('test-key', fetcher);
    await provider('getPrvtBidPblancListInfoCnstwk', { inqryDiv: '4', bidNtceNo: 'R26BK01774453' });
    expect(outgoing[0].pathname).toBe('/1230000/ao/PrvtBidNtceService/getPrvtBidPblancListInfoCnstwk');
  });
});
