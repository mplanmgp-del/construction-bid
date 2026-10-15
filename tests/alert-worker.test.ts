import {describe,it,expect,vi} from 'vitest';
import {planAlertChanges,type Observation} from '../server/alert-planner';
import {collectAlertWindow,createAlertProvider,minuteKst,type AlertProvider} from '../server/alert-collector';
import {runAlertWorker} from '../server/alert-worker';
import {DEFAULT_ALERT_SETTINGS,type AlertNotice,type WorkerRule} from '../src/alerts/types';
import type {AlertStore} from '../server/alert-store';
const now=Date.parse('2026-10-15T10:00:00+09:00');
const notice=(patch:Partial<AlertNotice>={}):AlertNotice=>({id:'g2b:공사:R26BK00001:000',number:'R26BK00001',revision:'000',title:'석면 해체공사',agency:'교육청',type:'공사',category:'석면',province:'서울',district:'',allowedRegions:[],estimatedPrice:100,contractMethod:'제한',status:'접수중',postedAt:'2026-10-15T09:55:00+09:00',deadline:'2026-10-20T10:00:00+09:00',openingAt:'2026-10-20T11:00:00+09:00',registrationDeadline:'2026-10-19T18:00:00+09:00',licenses:[],duration:'',description:'내용',requirements:[],documents:[],revised:false,source:'live',sourceUpdatedAt:'2026-10-15T09:55:00+09:00',regionComplete:true,licenseComplete:true,...patch});
const rule:WorkerRule={userId:'owner',profile:null,settings:{...structuredClone(DEFAULT_ALERT_SETTINGS),enabled:true,activatedAt:'2026-10-15T09:00:00+09:00'}};
const member=(fact:Observation)=>[{userId:'owner',key:fact.key,lastVersion:fact.version}];
describe('durable alert event planning',()=>{
  it('emits a new match once and advances only on meaningful changes, including reversion',()=>{
    const first=planAlertChanges([notice()],[],[],[rule],now);expect(first.events.map(x=>x.kind)).toEqual(['new']);
    const fact=first.observations[0];
    expect(planAlertChanges([notice()],first.observations,member(fact),[rule],now).events).toEqual([]);
    const changed=notice({estimatedPrice:200,sourceUpdatedAt:'2026-10-15T10:00:00+09:00'});
    const second=planAlertChanges([changed],[fact],member(fact),[rule],now);
    expect(second.events[0]).toMatchObject({kind:'changed',version:2,changeFields:['추정가격']});
    const reverted=planAlertChanges([notice({sourceUpdatedAt:'2026-10-15T10:01:00+09:00'})],second.observations,member(second.observations[0]),[rule],now);
    expect(reverted.events[0].version).toBe(3);
  });
  it('seeds old matches for one digest, without emitting new alerts',()=>{
    const plan=planAlertChanges([notice({postedAt:'2026-10-14T10:00:00+09:00'})],[],[],[rule],now);
    expect(plan.events).toEqual([]);expect(plan.existing).toHaveLength(1);
  });
  it('notifies existing recipients of cancellation or losing eligibility',()=>{
    const fact=planAlertChanges([notice()],[],[],[rule],now).observations[0];
    const cancelled=planAlertChanges([notice({status:'취소'})],[fact],member(fact),[rule],now);
    expect(cancelled.events[0].kind).toBe('cancelled');
    const disabled=structuredClone(rule);disabled.settings.notifyChanges=false;
    const muted=planAlertChanges([notice({estimatedPrice:200})],[fact],member(fact),[disabled],now);
    expect(muted.events).toEqual([]);expect(muted.existing[0]).toMatchObject({version:2,initial:false});
  });
  it('ignores old revisions and revision-only refreshes',()=>{
    const fact=planAlertChanges([notice({revision:'002'})],[],[],[rule],now).observations[0];
    expect(planAlertChanges([notice({estimatedPrice:200})],[fact],member(fact),[rule],now).observations).toEqual([]);
    expect(planAlertChanges([notice({revision:'003'})],[fact],member(fact),[rule],now).events).toEqual([]);
  });
});

describe('rule activation and historical collection regressions', () => {
  it('ignores an unrelated old membership after the saved filter changes', () => {
    const originalRule = structuredClone(rule); originalRule.settings.filter.keywords = ['철거'];
    const originalNotice = notice({ title: '노후 창고 철거공사', category: '철거·해체' });
    const fact = planAlertChanges([originalNotice], [], [], [originalRule], now).observations[0];
    const changedRule = structuredClone(rule); changedRule.settings.filter.keywords = ['석면']; changedRule.settings.activatedAt = '2026-10-15T09:59:00+09:00';
    const plan = planAlertChanges([{ ...originalNotice, estimatedPrice: 200 }], [fact], [{ ...member(fact)[0], initial: false }], [changedRule], now);
    expect(plan.events).toEqual([]); expect(plan.existing).toEqual([]);
    const cancellation = planAlertChanges([{ ...originalNotice, status: '취소' }], [fact], member(fact), [changedRule], now);
    expect(cancellation.events).toEqual([]);
  });

  it('reseeds a matching existing notice after activation without replaying its event', () => {
    const fact = planAlertChanges([notice()], [], [], [rule], now).observations[0];
    const activatedRule = structuredClone(rule); activatedRule.settings.activatedAt = '2026-10-15T10:00:00+09:00';
    const plan = planAlertChanges([notice()], [fact], [{ ...member(fact)[0], initial: false }], [activatedRule], now);
    expect(plan.events).toEqual([]);
    expect(plan.existing).toEqual([{ userId: 'owner', key: fact.key, version: fact.version }]);
  });

  it('commits current notices and advances their cursor when a historical day fails', async () => {
    const liveRow = { bidNtceNo: 'R26BK00001', bidNtceOrd: '000', bidNtceNm: '석면 해체공사', bidNtceDt: '2026-10-15 09:55:00', rgstDt: '2026-10-15 09:55:00', bidClseDt: '2026-10-20 10:00:00' };
    const provider: AlertProvider = async (operation, params) => {
      if (params.inqryBgnDt?.startsWith('20261014')) throw new Error('나라장터 과거 조회 오류');
      return operation.endsWith('Cnstwk') && params.inqryDiv === '1' ? [liveRow] : [];
    };
    const commit = vi.fn(async (_leaseId: string, _payload: unknown) => ({ storageFull: false }));
    const store = {
      claim: async () => ({ leaseId: 'lease', cursor: new Date(now - 10 * 60_000).toISOString(), backfillDay: '2026-10-14', coverageFrom: '2026-10-15', rules: [rule], enabled: true, collectionDue: true }),
      load: async () => ({ observations: [], memberships: [] }), commit,
      deliveries: async () => ({ deliveries: [] }), settle: async () => ({}),
    } as unknown as AlertStore;
    const result = await runAlertWorker(store, { provider, now });
    expect(result).toMatchObject({ ok: true, collected: 1, warning: expect.stringContaining('기존 공고 보충 확인 대기') });
    expect(commit.mock.calls[0][1]).toMatchObject({ events: [{ kind: 'new' }] });
    expect(commit.mock.calls.at(-1)?.[1]).toMatchObject({ finish: true, checkpoint: { cursor: new Date(now).toISOString(), backfillDay: '2026-10-14', coverageFrom: '2026-10-15' }, warning: expect.stringContaining('나라장터 과거 조회 오류') });
  });
});
describe('official registration and modification polling',()=>{
  const row={bidNtceNo:'R26BK00001',bidNtceOrd:'000',bidNtceNm:'석면 해체',bidNtceDt:'2026-10-15 09:55:00',rgstDt:'2026-10-15 09:55:00',bidClseDt:'2026-10-20 10:00:00'};
  it('uses KST minute windows and hydrates participation conditions from exact identities',async()=>{
    const calls:{operation:string;params:Record<string,string>}[]=[];
    const provider:AlertProvider=async(operation,params)=>{calls.push({operation,params});if(operation.endsWith('PrtcptPsblRgn'))return[{...row,prtcptPsblRgnNm:'경기도'}];if(operation.endsWith('LicenseLimit'))return[{...row,lcnsLmtNm:'석면해체·제거업'}];return params.inqryDiv==='1'?[row]:[];};
    const items=await collectAlertWindow(provider,now-12*60_000,now,['공사']);
    expect(minuteKst(now)).toBe('202610151000');expect(calls).toHaveLength(4);
    expect(calls.find(x=>x.params.inqryDiv==='3')?.params.inqryBgnDt).toBe('202610150948');
    expect(items[0]).toMatchObject({allowedRegions:['경기도'],licenses:['석면해체·제거업'],regionComplete:true});
  });
  it('rehydrates an older changed notice with number + revision',async()=>{
    const provider=vi.fn<AlertProvider>(async(operation,params)=>operation.endsWith('Cnstwk')&&params.inqryDiv==='3'?[{...row,rgstDt:'2026-10-01 09:00:00',chgDt:'2026-10-15 09:58:00'}]:[]);
    await collectAlertWindow(provider,now-12*60_000,now,['공사']);
    expect(provider).toHaveBeenCalledWith('getBidPblancListInfoLicenseLimit',{inqryDiv:'2',bidNtceNo:'R26BK00001',bidNtceOrd:'000'});
  });
  it('rejects incomplete pages rather than silently advancing the window',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({response:{header:{resultCode:'00'},body:{totalCount:1000,items:[row]}}})));
    const request=createAlertProvider('secret',fetcher);
    await expect(request('getBidPblancListInfoCnstwk',{})).rejects.toThrow(/범위/);expect(fetcher).toHaveBeenCalledTimes(12);
  });
  it('keeps cursor after collection failure and skips concurrent claims',async()=>{
    const commit=vi.fn(async()=>({}));
    const store={claim:vi.fn(async()=>({leaseId:'lease',cursor:new Date(now-600000).toISOString(),rules:[rule],enabled:true,collectionDue:true})),commit} as unknown as AlertStore;
    const result=await runAlertWorker(store,{provider:async()=>{throw new Error('나라장터 오류');},now});
    expect(result.ok).toBe(false);expect(commit).toHaveBeenCalledWith('lease',{finish:true,error:'나라장터 오류',retryWindowMinutes:30});
    store.claim=vi.fn(async()=>({leaseId:null})) as unknown as AlertStore['claim'];
    expect(await runAlertWorker(store,{now})).toMatchObject({skipped:true});
  });
});
