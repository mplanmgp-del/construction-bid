import { describe, expect, it } from 'vitest';
import { NOTICES } from '../src/data';
import { deadlineDayWindow, deadlineMonthWindow, isAlarmEligible, matchesDeadlineWindow } from '../src/notice-deadline-window';

const now=Date.parse('2026-10-15T12:00:00+09:00');
const notice=(patch:Record<string,unknown>={})=>({...NOTICES[0],status:'접수중' as const,deadline:'2026-10-22T23:59:59+09:00',biddingStartAt:'2026-10-01T00:00:00+09:00',openingAt:'2026-10-23T10:00:00+09:00',...patch});
describe('submission deadline windows shared by search and alarms',()=>{
  it('uses calendar months on both sides of Korean today',()=>{
    expect(deadlineMonthWindow(6,now)).toEqual({from:'2026-04-15',to:'2027-04-15'});
    expect(deadlineMonthWindow(3,now)).toEqual({from:'2026-07-15',to:'2027-01-15'});
    expect(deadlineMonthWindow(1,now)).toEqual({from:'2026-09-15',to:'2026-11-15'});
    expect(deadlineMonthWindow(6,Date.parse('2024-08-31T15:00:00+09:00'))).toEqual({from:'2024-02-29',to:'2025-02-28'});
  });
  it('keeps selectable KST day windows independent of automatic alarm eligibility',()=>{
    expect(deadlineDayWindow(7,Date.parse('2026-10-14T15:00:00Z'))).toEqual({from:'2026-10-08',to:'2026-10-22'});
    expect(isAlarmEligible(notice(),now)).toBe(true);
    expect(isAlarmEligible(notice({deadline:'2026-10-23T00:00:00+09:00'}),now)).toBe(true);
  });
  it('retains submission-closed notices still waiting for a future opening as ongoing',()=>{
    expect(isAlarmEligible(notice({status:'마감',deadline:'2026-10-08T00:00:00+09:00',openingAt:'2026-10-16T10:00:00+09:00'}),now)).toBe(true);
    expect(isAlarmEligible(notice({status:'마감',deadline:'2026-09-01T00:00:00+09:00',openingAt:'2026-10-16T10:00:00+09:00'}),now)).toBe(true);
  });
  it('excludes opened, cancelled, unknown-deadline and unclassifiable notices',()=>{
    for(const patch of [{openingAt:'2026-10-15T11:00:00+09:00'}, {openingCompleted:true}, {status:'취소'}, {noticeKind:'취소공고'}, {deadline:''}, {deadline:'not-a-date'}, {deadline:'2026-10-10T10:00:00+09:00',openingAt:''}]){
      expect(isAlarmEligible(notice(patch),now)).toBe(false);
    }
  });
  it('includes distant ongoing and scheduled alarms without inheriting the selected search period',()=>{
    const future=notice({deadline:'2027-03-01T10:00:00+09:00',openingAt:'2027-03-01T11:00:00+09:00'});
    expect(matchesDeadlineWindow(future,deadlineMonthWindow(6,now),now)).toBe(true);
    expect(isAlarmEligible(future,now)).toBe(true);
    const distant=notice({deadline:'2037-03-01T10:00:00+09:00',openingAt:'2037-03-01T11:00:00+09:00'});
    expect(matchesDeadlineWindow(distant,deadlineMonthWindow(6,now),now)).toBe(false);
    expect(isAlarmEligible(distant,now)).toBe(true);
    expect(isAlarmEligible({...distant,biddingStartAt:'2037-02-01T09:00:00+09:00'},now)).toBe(true);
  });
});
