import { collectAlertWindow,createAlertProvider,type AlertProvider } from './alert-collector.ts';
import { planAlertChanges } from './alert-planner.ts';
import { alertNoticeKey } from '../src/alerts/domain.ts';
import { sendAlertPush,isAlertPushConfigured } from './alert-push.ts';
import type { AlertStore } from './alert-store.ts';
import type { AlertNotice } from '../src/alerts/types.ts';
const dayKst=(time:number)=>new Date(time+9*3600_000).toISOString().slice(0,10);
const safeError=(error:unknown)=>error instanceof Error&&/^나라장터|^공고 |^참가조건|^조회 도중|^알리미 저장/.test(error.message)?error.message:'알리미 확인 중 오류가 발생했습니다. 다음 확인 때 다시 시도합니다.';

export async function runAlertWorker(store:AlertStore,{dispatchOnly=false,provider=createAlertProvider(),now=Date.now()}: {dispatchOnly?:boolean;provider?:AlertProvider;now?:number}={}) {
  const deadline=Date.now()+43_000;
  const claim=await store.claim(dispatchOnly);
  if(!claim.leaseId) return {ok:true,skipped:true};
  const lease=claim.leaseId;let collected=0,warning:string|undefined;
  let checkpoint:{cursor:string;backfillDay:string|null;coverageFrom:string|null;windowMinutes?:number}|undefined;
  async function commitNotices(notices:AlertNotice[]) {
    const chunk=Math.min(150,Math.max(1,Math.floor(900/Math.max(1,claim.rules.length))));
    for(let offset=0;offset<notices.length;offset+=chunk) {
      if(Date.now()>deadline-12_000)throw new Error('나라장터 조회 저장 시간이 초과되어 다음 확인 때 다시 시도합니다.');
      const batch=notices.slice(offset,offset+chunk),stored=await store.load(lease,batch.map(alertNoticeKey));
      const result=await store.commit(lease,planAlertChanges(batch,stored.observations,stored.memberships,claim.rules,now));
      if(result.storageFull) throw new Error('알리미 저장 한도에 도달하여 수집을 대기합니다. 기존 알림은 보존됩니다.');
      collected+=batch.length;
    }
  }
  async function dispatch() {
    if(!isAlertPushConfigured()||Date.now()>deadline-15_000)return;
    const {deliveries}=await store.deliveries(lease,5);
    for(let start=0;start<deliveries.length;start+=5) {
      const results=await Promise.all(deliveries.slice(start,start+5).map(async item=>({id:item.id,...await sendAlertPush(item.subscription,item.notification)})));
      await store.settle(lease,results);
    }
  }
  try {
    if(claim.enabled&&claim.collectionDue&&!dispatchOnly&&claim.rules.length) {
      const end=Math.floor(now/60_000)*60_000;
      const cursor=claim.cursor?Date.parse(claim.cursor):end-20*60_000;
      const to=Math.min(end,cursor+(claim.windowMinutes||60)*60_000),types=[...new Set(claim.rules.flatMap(rule=>rule.settings.filter.types))];
      // Live notices commit first. A bad historical day cannot starve current notifications.
      await commitNotices(await collectAlertWindow(provider,cursor-2*60_000,to,types));
      checkpoint={cursor:new Date(to).toISOString(),backfillDay:claim.backfillDay,coverageFrom:claim.coverageFrom||dayKst(cursor),windowMinutes:Math.min(60,(claim.windowMinutes||60)*2)};
      await dispatch();
      if(to===end) {
        const day=claim.backfillDay||(!claim.coverageFrom?dayKst(Date.parse(dayKst(now)+'T00:00:00+09:00')-86400_000):null);
        const boundary=dayKst(end-30*86400_000);
        if(day&&day>=boundary) {
          try {
            const start=Date.parse(day+'T00:00:00+09:00');
            await commitNotices(await collectAlertWindow(provider,start,start+86400_000-60_000,types,false));
            checkpoint.coverageFrom=day;
            const next=dayKst(start-86400_000);checkpoint.backfillDay=next>=boundary?next:null;
          } catch(error) {
            checkpoint.backfillDay=day;warning=`기존 공고 보충 확인 대기: ${safeError(error)}`;
          }
        } else if(day) checkpoint.backfillDay=null;
      }
    }
    await dispatch();
    await store.commit(lease,{finish:true,...(checkpoint?{checkpoint}:{}),...(warning?{warning}:{})});
    return {ok:true,collected,...(warning?{warning}:{})};
  } catch(error) {
    const message=safeError(error);
    await store.commit(lease,{finish:true,error:message,retryWindowMinutes:Math.max(1,Math.floor((claim.windowMinutes||60)/2))}).catch(()=>{});
    return {ok:false,error:message};
  }
}
