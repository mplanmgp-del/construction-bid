import { describe, expect, it, vi } from 'vitest';
import { scanCatalogForAlerts } from '../server/catalog-alert-scan';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/types';
import type { AlertNotice, WorkerRule } from '../src/alerts/types';
import { NOTICES } from '../src/data';
import type { G2bResultSummary } from '../src/g2b-types';
import type { ActiveCatalogPageQuery } from '../src/live/active-catalog-types';

const notice = (revision: string) => ({ ...NOTICES[0], source: 'live' as const, number: 'OLD1995', revision, postedAt: '1995-10-01T00:00:00+09:00',
  deadline: new Date(Date.now()+2*86400000).toISOString(),openingAt:new Date(Date.now()+3*86400000).toISOString(), sourceUpdatedAt: '2026-10-15T10:00:00+09:00', regionComplete: false, licenseComplete: false, documents: [], description: '', requirements: [] });
const group = (number = 'OLD1995') => { const versions = ['000', '001'].map(revision => ({ ...notice(revision), number })); return { key: `공사:${number}`, type: '공사' as const, number, latest: versions[1], versions, verifiedAt: '2026-10-15T10:00:00Z' }; };
const status = { groupCount: 1, activeCount: 1, pendingSources: 0, pendingVerification: 0, completedSources: 746, coverageFrom: '1995-10-01', bootstrapComplete: true, lastCheckedAt: '', error: null, storageBytes: 10, storageCeiling: 33554432 };
const rule: WorkerRule = { userId: 'a', profile: null, settings: { ...structuredClone(DEFAULT_ALERT_SETTINGS), enabled: true, filter: { ...structuredClone(DEFAULT_ALERT_SETTINGS.filter), keywords: [], categories: [], regions: [] } } };

describe('same catalog feeds all-age alerts', () => {
  it('uses the alarm page and verifies every revision before publishing an unverified index candidate',async()=>{
    const item=group('R26BK00000001');item.verifiedAt='';item.latest.revision='000';item.versions=[item.latest];
    const page=vi.fn(),alarmPage=vi.fn(async(_query:ActiveCatalogPageQuery={})=>({groups:[item],nextCursor:null,status})),publishVerified=vi.fn(async(_notices:AlertNotice[])=>({ok:true}));
    const provider=vi.fn(async()=>['000','001'].map(bidNtceOrd=>({bidNtceNo:item.number,bidNtceOrd,bidNtceNm:'철거 공사',bidNtceDt:'2026-10-15 10:00:00',
      rgstDt:'2026-10-15 10:00:00',bidClseDt:'2026-10-20 10:00:00',opengDt:'2026-10-20 11:00:00'})));
    const commit=vi.fn();
    const result=await scanCatalogForAlerts({page,alarmPage,publishVerified},provider,[rule],null,commit,Date.now()+30000,Date.parse('2026-10-15T10:00:00+09:00'));
    expect(result.complete).toBe(true);expect(page).not.toHaveBeenCalled();
    expect(alarmPage.mock.calls[0]).toEqual([expect.objectContaining({includeIndex:true,includeInactive:true})]);
    expect(alarmPage.mock.calls[0][0]).not.toHaveProperty('deadlineFrom');
    expect(alarmPage.mock.calls[0][0]).not.toHaveProperty('deadlineTo');
    expect(provider.mock.calls[0]).toEqual(['getBidPblancListInfoCnstwk',{inqryDiv:'2',bidNtceNo:item.number}]);
    expect(publishVerified.mock.calls[0][0].map(notice=>notice.revision)).toEqual(['000','001']);
    expect(commit.mock.calls[0][0].map((notice:{revision:string})=>notice.revision)).toEqual(['000','001']);
  });
  it('keeps the comparison cursor when an exact revision-history publication loses a source race',async()=>{
    const item=group('R26BK00000001');item.verifiedAt='';item.latest.revision='000';item.versions=[item.latest];
    const page=vi.fn(async()=>({groups:[item],nextCursor:null,status})),publishVerified=vi.fn(async()=>({ok:false}));
    const provider=vi.fn(async()=>[{bidNtceNo:item.number,bidNtceOrd:'000',bidNtceNm:'철거 공사',bidNtceDt:'2026-10-15 10:00:00',
      rgstDt:'2026-10-15 10:00:00',bidClseDt:'2026-10-20 10:00:00',opengDt:'2026-10-20 11:00:00'}]);
    const commit=vi.fn();
    const result=await scanCatalogForAlerts({page,publishVerified},provider,[rule],null,commit,Date.now()+30000,Date.parse('2026-10-15T10:00:00+09:00'));
    expect(result.complete).toBe(false);expect(result.cursor).toBeNull();expect(commit).not.toHaveBeenCalled();
  });
  it.each([true,false])('marks a submission-closed candidate completed from the exact opening status even when winner completeness is %s',async complete=>{
    const now=Date.parse('2026-10-15T10:00:00+09:00'),item=group('R26BK00000001');
    item.latest={...item.latest,status:'마감',deadline:'2026-10-14T10:00:00+09:00',openingAt:'2026-10-16T11:00:00+09:00'};item.versions=[item.latest];
    const page=vi.fn(async()=>({groups:[item],nextCursor:null,status})),enrich=vi.fn(async(_notice:AlertNotice)=>({ok:true}));
    const resultSummary=vi.fn(async():Promise<G2bResultSummary>=>({number:item.number,revision:item.latest.revision,type:'공사',firstCompanies:[],winnerCompanies:[],result:'개찰완료',complete,openingComplete:true,fetchedAt:new Date(now).toISOString()}));
    const commit=vi.fn();
    await scanCatalogForAlerts({page,enrich},vi.fn(),[rule],null,commit,Date.now()+30000,now,30,{resultSummary});
    expect(resultSummary).toHaveBeenCalledOnce();expect(enrich.mock.calls[0][0]).toMatchObject({openingCompleted:true});
    expect(commit.mock.calls[0][0][0]).toMatchObject({openingCompleted:true});
  });
  it.each(['재입찰',''])('retains an unopened candidate when exact summary is %j instead of completed',async state=>{
    const now=Date.parse('2026-10-15T10:00:00+09:00'),item=group('R26BK00000001');
    item.latest={...item.latest,status:'마감',deadline:'2026-10-14T10:00:00+09:00',openingAt:'2026-10-16T11:00:00+09:00'};item.versions=[item.latest];
    const page=vi.fn(async()=>({groups:[item],nextCursor:null,status}));
    const resultSummary=vi.fn(async():Promise<G2bResultSummary>=>({number:item.number,revision:item.latest.revision,type:'공사',firstCompanies:[],winnerCompanies:[],result:state,complete:true,fetchedAt:new Date(now).toISOString()}));
    const commit=vi.fn();
    const result=await scanCatalogForAlerts({page},vi.fn(),[rule],null,commit,Date.now()+30000,now,30,{resultSummary});
    expect(result.complete).toBe(true);
    expect(commit.mock.calls[0][0][0].openingCompleted).not.toBe(true);
  });
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
  it.each(['auto', 'site', 'participation', 'either', 'both'] as const)('loads missing region facts for a saved %s basis before matching all region keywords', async basis => {
    const page = vi.fn().mockResolvedValue({ groups: [group()], nextCursor: null, status }), enrich = vi.fn().mockResolvedValue({ ok: true });
    const provider = vi.fn().mockResolvedValue([{ bidNtceNo: 'OLD1995', bidNtceOrd: '001', prtcptPsblRgnNm: '서울특별시' }]);
    const commit = vi.fn().mockResolvedValue(undefined), regionalRule = structuredClone(rule);
    regionalRule.settings.filter.regions = ['서울특별시']; regionalRule.settings.filter.regionBasis = basis;
    await scanCatalogForAlerts({ page, enrich }, provider, [regionalRule], null, commit, Date.now() + 30000);
    expect(provider).toHaveBeenCalledOnce(); expect(provider.mock.calls[0][1]).toMatchObject({ inqryDiv: '2', bidNtceNo: 'OLD1995', bidNtceOrd: '001' });
    expect(enrich.mock.calls[0][0]).toMatchObject({ revision: '001', allowedRegions: ['서울특별시'], regionComplete: true, documents: [] });
    expect(commit.mock.calls[0][0][1].allowedRegions).toEqual(['서울특별시']);
  });
  it('verifies missing participant regions even when other known region keywords do not match yet', async () => {
    const item = group();
    item.latest = { ...item.latest, title: '부산광역시 학교 철거공사', agency: '부산교육청', demandAgency: '', province: '부산광역시', district: '해운대구',
      allowedRegions: null, regionComplete: false };
    item.versions = [item.latest];
    const page = vi.fn(async () => ({ groups: [item], nextCursor: null, status })), enrich = vi.fn(async () => ({ ok: true }));
    const provider = vi.fn(async () => [{ bidNtceNo: item.number, bidNtceOrd: '001', prtcptPsblRgnNm: '서울특별시' }]);
    const regionalRule = structuredClone(rule); regionalRule.settings.filter.regions = ['서울특별시']; regionalRule.settings.filter.regionBasis = 'site';
    const commit = vi.fn();
    await scanCatalogForAlerts({ page, enrich }, provider, [regionalRule], null, commit, Date.now() + 30000);
    expect(provider).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0][0][0].allowedRegions).toEqual(['서울특별시']);
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
