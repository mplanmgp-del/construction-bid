import { describe, it, expect } from 'vitest';
import { DEFAULT_ALERT_SETTINGS, type AlertNotice } from '../src/alerts/types';
import { meaningfulChanges, noticeContentKey, matchAlertNotice, normalizeAlertSettings, latestAlertNotices } from '../src/alerts/domain';
import type { CompanyProfile } from '../src/types';
import { mapNotice } from '../server/g2b';
const now = Date.parse('2026-10-15T10:00:00+09:00');
const notice = (patch: Partial<AlertNotice> = {}): AlertNotice => ({
  id:'g2b:공사:R26BK00000001:000', number:'R26BK00000001', revision:'000', title:'학교 석면 해체공사', agency:'교육청',
  type:'공사', category:'석면', province:'서울', district:'마포구', allowedRegions:['경기도'], estimatedPrice:200000000,
  contractMethod:'제한경쟁',status:'접수중',postedAt:'2026-10-14T09:00:00+09:00',deadline:'2026-10-20T10:00:00+09:00',
  openingAt:'2026-10-20T11:00:00+09:00',registrationDeadline:'2026-10-19T18:00:00+09:00',licenses:['석면해체·제거업'],
  duration:'원문 확인',description:'내용',requirements:[],documents:[],revised:false,source:'live',
  sourceUpdatedAt:'2026-10-14T09:00:00+09:00',regionComplete:true,licenseComplete:true,...patch,
});
const settings = () => structuredClone(DEFAULT_ALERT_SETTINGS);
describe('personalized alert content and matching',()=>{
  it('ignores refresh times, derived phase, row order and revision-only edits',()=>{
    const old=notice({licenses:['A','B'],allowedRegions:['서울','경기']});
    const repeated=notice({revision:'001',id:'other',status:'마감',revised:true,sourceUpdatedAt:'2026-10-15T10:00:00+09:00',licenses:['B','A'],allowedRegions:['경기','서울']});
    expect(noticeContentKey(repeated)).toBe(noticeContentKey(old));
    expect(meaningfulChanges(old,repeated)).toEqual([]);
  });
  it('identifies same-revision deadline, price, region and cancellation changes',()=>{
    expect(meaningfulChanges(notice(),notice({deadline:'2026-10-18T10:00:00+09:00',estimatedPrice:220000000,allowedRegions:['서울'],status:'취소'}))).toEqual(expect.arrayContaining(['제출 마감','추정가격','참가 가능 지역','공고 취소']));
  });
  it('matches service participation regions, construction sites, and normalized licenses',()=>{
    const s=settings();s.enabled=true;Object.assign(s.filter,{regionBasis:'auto'});s.filter.regions=['경기'];s.filter.licenses=['석면해체ㆍ제거업'];
    expect(matchAlertNotice(notice({type:'용역'}),s,null,now).matched).toBe(true);
    s.filter.regions=['서울'];
    expect(matchAlertNotice(notice({type:'용역'}),s,null,now).matched).toBe(false);
    expect(matchAlertNotice(notice(),s,null,now).matched).toBe(true);
  });
  it('keeps unknown conditions explicit and allows users to exclude them',()=>{
    const s=settings();s.enabled=true;s.filter.regions=['경기'];s.filter.minAmount=1;
    const missing=notice({type:'용역',allowedRegions:null,regionComplete:false,estimatedPrice:null});
    expect(matchAlertNotice(missing,s,null,now)).toMatchObject({matched:true,needsReview:true});
    s.filter.includeUnknown=false;
    expect(matchAlertNotice(missing,s,null,now).matched).toBe(false);
  });
  it('does not generate fresh matches for cancelled, expired, excluded or demo notices',()=>{
    const s=settings();s.enabled=true;s.filter.excludeKeywords=['학교'];
    expect(matchAlertNotice(notice(),s,null,now).matched).toBe(false);
    s.filter.excludeKeywords=[];
    for(const n of [notice({status:'취소'}),notice({deadline:'2026-10-01T10:00:00+09:00'}),notice({source:'demo'})])expect(matchAlertNotice(n,s,null,now).matched).toBe(false);
  });
  it('rejects inverted amounts and refuses unbounded automatic alerts',()=>{
    const s=settings();s.enabled=true;s.filter.minAmount=10;s.filter.maxAmount=1;
    expect(()=>normalizeAlertSettings(s)).toThrow(/금액/);
    s.filter.minAmount=null;s.filter.maxAmount=null;s.filter.keywords=[];
    expect(()=>normalizeAlertSettings(s)).toThrow(/조건/);
  });
  it('keeps the newest revision and does not regress from out-of-order overlap rows',()=>{
    const rows=latestAlertNotices([notice({revision:'002',sourceUpdatedAt:'2026-10-15T10:00:00+09:00'}),notice(),notice({revision:'001',sourceUpdatedAt:'2026-10-15T11:00:00+09:00'})]);
    expect(rows).toHaveLength(1);expect(rows[0].revision).toBe('002');
  });
});

describe('expanded construction and service alert comparison',()=>{
  const company: CompanyProfile={id:'company',companyName:'테스트',province:'경기도',district:'성남시',address:'',licenses:['석면해체ㆍ제거업/4999'],contactName:'',email:''};
  const rule=(filter:Record<string,unknown>={})=>{
    const s=settings();s.enabled=true;Object.assign(s.filter,filter);return s;
  };
  it.each(['공사','용역'] as const)('compares both region sources for %s without substituting one for the other',type=>{
    const n=notice({type});
    expect(matchAlertNotice(n,rule({regions:['경기'],regionBasis:'participation'}),null,now)).toMatchObject({matched:true,needsReview:false});
    expect(matchAlertNotice(n,rule({regions:['경기'],regionBasis:'site'}),null,now).matched).toBe(false);
    expect(matchAlertNotice(n,rule({regions:['경기'],regionBasis:'either'}),null,now)).toMatchObject({matched:true,needsReview:false});
    expect(matchAlertNotice(n,rule({regions:['경기'],regionBasis:'both'}),null,now).matched).toBe(false);
    expect(matchAlertNotice(n,rule({regions:['서울','경기'],regionBasis:'both'}),null,now)).toMatchObject({matched:true,needsReview:false});
  });
  it.each(['공사','용역'] as const)('keeps an absent %s site reviewable and obeys the unknown switch',type=>{
    const n=notice({type,province:'',district:''});
    expect(matchAlertNotice(n,rule({regions:['경기'],regionBasis:'site'}),null,now)).toMatchObject({matched:true,needsReview:true});
    expect(matchAlertNotice(n,rule({regions:['경기'],regionBasis:'site',includeUnknown:false}),null,now).matched).toBe(false);
    expect(matchAlertNotice(n,rule({regions:['경기'],regionBasis:'either',includeUnknown:false}),null,now)).toMatchObject({matched:true,needsReview:false});
    expect(matchAlertNotice(n,rule({regions:['경기'],regionBasis:'both'}),null,now)).toMatchObject({matched:true,needsReview:true});
  });
  it('does not discard unknown provider regions or call incomplete matches confirmed',()=>{
    const partial=notice({allowedRegions:['경기'],regionComplete:false});
    expect(matchAlertNotice(partial,rule({regions:['서울'],regionBasis:'participation'}),null,now)).toMatchObject({matched:true,needsReview:true});
    expect(matchAlertNotice(partial,rule({regions:['서울'],regionBasis:'both'}),null,now)).toMatchObject({matched:true,needsReview:true});
    expect(matchAlertNotice(partial,rule({regions:['서울'],regionBasis:'either',includeUnknown:false}),null,now)).toMatchObject({matched:true,needsReview:false});
    expect(matchAlertNotice(notice({type:'용역',allowedRegions:['전국']}),rule({regions:['제주'],regionBasis:'participation'}),null,now)).toMatchObject({matched:true,needsReview:false});
  });
  it.each(['공사','용역'] as const)('compares company license overlap for %s with normalized industry names',type=>{
    const s=rule({useCompanyLicenses:true});
    expect(matchAlertNotice(notice({type}),s,company,now)).toMatchObject({matched:true,needsReview:false});
    expect(matchAlertNotice(notice({type,licenses:['건축공사업']}),s,company,now).matched).toBe(false);
    expect(matchAlertNotice(notice({type}),s,{...company,licenses:[]},now)).toMatchObject({matched:true,needsReview:true});
    expect(matchAlertNotice(notice({type,licenseComplete:false}),s,company,now)).toMatchObject({matched:true,needsReview:true});
    expect(matchAlertNotice(notice({type}),s,null,now)).toMatchObject({matched:true,needsReview:true});
  });
  it('flags multiple required licenses as a combination to check even if one overlaps',()=>{
    const match=matchAlertNotice(notice({licenses:['석면해체·제거업','건축공사업']}),rule({useCompanyLicenses:true}),company,now);
    expect(match).toMatchObject({matched:true,needsReview:true});
    expect(match.reasons.join(' ')).toContain('복수 면허');
  });
  it.each(['공사','용역'] as const)('combines agency, method and submission lead time for %s',type=>{
    const n=notice({type,demandAgency:'성남시 교육지원청'});
    const s=rule({agencies:['성남시','서울시'],contractMethods:['제한경쟁'],minDaysUntilDeadline:5});
    expect(matchAlertNotice(n,s,null,now)).toMatchObject({matched:true,needsReview:false});
    expect(matchAlertNotice(n,rule({...s.filter,agencies:['환경부']}),null,now).matched).toBe(false);
    expect(matchAlertNotice(n,rule({...s.filter,contractMethods:['일반경쟁']}),null,now).matched).toBe(false);
    expect(matchAlertNotice(n,rule({...s.filter,minDaysUntilDeadline:6}),null,now).matched).toBe(false);
    expect(matchAlertNotice({...n,registrationDeadline:'2026-10-15T09:00:00+09:00'},s,null,now).matched).toBe(true);
  });
  it('keeps unprovided method/agency unknown and does not treat fallback labels as facts',()=>{
    const mapped=mapNotice({bidNtceNo:'R26BK00000001',bidNtceOrd:'000'},'공사',now);
    const n=notice({agency:mapped.agency,demandAgency:mapped.demandAgency,contractMethod:mapped.contractMethod});
    expect(matchAlertNotice(n,rule({agencies:['교육청'],contractMethods:['제한경쟁']}),null,now)).toMatchObject({matched:true,needsReview:true});
    expect(matchAlertNotice(n,rule({agencies:['교육청'],includeUnknown:false}),null,now).matched).toBe(false);
  });
  it('preserves all new fields through validation and bounds their values',()=>{
    const s=rule({regionBasis:'both',agencies:[' 성남시 ','성남시'],contractMethods:['제한경쟁'],minDaysUntilDeadline:2,useCompanyLicenses:true});
    expect(normalizeAlertSettings(s).filter).toMatchObject({regionBasis:'both',agencies:['성남시'],contractMethods:['제한경쟁'],minDaysUntilDeadline:2,useCompanyLicenses:true});
    for(const patch of [{regionBasis:'invalid'},{regionBasis:null},{agencies:[null]},{contractMethods:'제한경쟁'},{useCompanyLicenses:1},{minDaysUntilDeadline:-1},{minDaysUntilDeadline:1.5},{minDaysUntilDeadline:366}]){
      expect(()=>normalizeAlertSettings(rule(patch))).toThrow();
    }
  });
  it('keeps legacy saved region semantics while giving new settings a broader default',()=>{
    const s=rule();
    delete (s.filter as Partial<typeof s.filter>).regionBasis;
    expect(normalizeAlertSettings(s).filter).toMatchObject({regionBasis:'auto',agencies:[],contractMethods:[],minDaysUntilDeadline:null,useCompanyLicenses:false});
    expect(DEFAULT_ALERT_SETTINGS.filter.regionBasis).toBe('either');
  });
  it.each([{agencies:['교육청']},{contractMethods:['제한경쟁']},{minDaysUntilDeadline:2},{useCompanyLicenses:true}])('accepts a new condition on its own: %j',patch=>{
    expect(()=>normalizeAlertSettings(rule({keywords:[],...patch}))).not.toThrow();
  });
});
