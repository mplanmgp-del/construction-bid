import { describe, it, expect } from 'vitest';
import { DEFAULT_ALERT_SETTINGS, type AlertNotice } from '../src/alerts/types';
import { meaningfulChanges, noticeContentKey, matchAlertNotice, normalizeAlertSettings, latestAlertNotices } from '../src/alerts/domain';
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
    const s=settings();s.enabled=true;s.filter.regions=['경기'];s.filter.licenses=['석면해체ㆍ제거업'];
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
