import { collectAlertWindow,createAlertProvider,type AlertProvider } from './alert-collector.ts';
import { planAlertChanges } from './alert-planner.ts';
import { alertNoticeKey } from '../src/alerts/domain.ts';
import { sendAlertPush,isAlertPushConfigured } from './alert-push.ts';
import type { AlertStore,AlertCheckpoint } from './alert-store.ts';
import type { AlertNotice } from '../src/alerts/types.ts';
import type { ActiveCatalogStore } from './active-catalog-store.ts';
import { scanCatalogForAlerts } from './catalog-alert-scan.ts';
const dayKst=(time:number)=>new Date(time+9*3600_000).toISOString().slice(0,10);
const safeError=(error:unknown)=>error instanceof Error&&/^나라장터|^공고 |^참가조건|^조회 도중|^알리미 저장/.test(error.message)?error.message:'알리미 확인 중 오류가 발생했습니다. 다음 확인 때 다시 시도합니다.';

export async function runAlertWorker(store:AlertStore,{dispatchOnly=false,provider,now=Date.now(),catalog,deadline=Date.now()+43_000}: {dispatchOnly?:boolean;provider?:AlertProvider;now?:number;catalog?:Pick<ActiveCatalogStore,'page'>&Partial<Pick<ActiveCatalogStore,'enrich'>>;deadline?:number}={}) {
  store.setDeadline?.(deadline);
  provider??=createAlertProvider(undefined,undefined,{deadline:Math.min(deadline-(catalog?13_000:8_000),Date.now()+30_000),maxRequests:40});
  const claim=await store.claim(dispatchOnly);
  if(!claim.leaseId) return {ok:true,skipped:true};
  const lease=claim.leaseId;let collected=0,warning:string|undefined;
  let checkpoint:AlertCheckpoint|undefined;
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
    // Delivery fetch, a 10s push request, settlement and the final checkpoint share this deadline.
    if(!isAlertPushConfigured()||Date.now()>deadline-23_000)return;
    const {deliveries}=await store.deliveries(lease,5);
    for(let start=0;start<deliveries.length;start+=5) {
      const results=await Promise.all(deliveries.slice(start,start+5).map(async item=>({id:item.id,...await sendAlertPush(item.subscription,item.notification)})));
      await store.settle(lease,results);
    }
  }
  try {
    if(claim.enabled&&claim.collectionDue&&!dispatchOnly&&claim.rules.length) {
      if(catalog) {
        // A source change can sort before the initial catalog cursor. Poll it independently first.
        // Freeze the end across retries so a moving result set never silently skips a page.
        const from=claim.catalogDeltaFrom??claim.cursor??new Date(now-20*60_000).toISOString();
        const through=claim.catalogDeltaThrough??new Date(now).toISOString();
        checkpoint={cursor:claim.cursor??from,backfillDay:null,coverageFrom:claim.coverageFrom,
          catalogCursor:claim.catalogCursor??null,catalogDeltaFrom:from,catalogDeltaThrough:through,
          catalogDeltaCursor:claim.catalogDeltaCursor??null,windowMinutes:claim.windowMinutes??60};
        const delta=await scanCatalogForAlerts(catalog,provider,claim.rules,checkpoint.catalogDeltaCursor??null,commitNotices,deadline,now,30,{changedSince:from,changedThrough:through});
        checkpoint.catalogDeltaCursor=delta.cursor;
        checkpoint.coverageFrom=delta.status?.coverageFrom??claim.coverageFrom;
        if(delta.error)warning=`공고 변경 비교 재시도 대기: ${delta.error}`;
        if(delta.complete) {
          checkpoint.cursor=through;
          // Small overlap is intentional; the durable observation/version ledger suppresses repeats.
          checkpoint.catalogDeltaFrom=new Date(Math.max(0,Date.parse(through)-2*60_000)).toISOString();
          checkpoint.catalogDeltaThrough=null;checkpoint.catalogDeltaCursor=null;
          await dispatch();
          if(claim.catalogCursor!=='__complete__') {
            const scan=await scanCatalogForAlerts(catalog,provider,claim.rules,claim.catalogCursor??null,commitNotices,deadline,now);
            checkpoint.catalogCursor=scan.complete&&scan.status?.bootstrapComplete&&scan.status.pendingVerification===0?'__complete__':scan.cursor;
            checkpoint.coverageFrom=scan.status?.coverageFrom??checkpoint.coverageFrom;
            if(scan.error)warning=`전체 공고 비교 재시도 대기: ${scan.error}`;
          }
        }
      } else {
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
    }
    await dispatch();
    await store.commit(lease,{finish:true,...(checkpoint?{checkpoint}:{}),...(warning?{warning}:{})});
    return {ok:true,collected,...(warning?{warning}:{})};
  } catch(error) {
    const message=safeError(error);
    await store.commit(lease,{finish:true,...(checkpoint?{checkpoint}:{}),error:message,retryWindowMinutes:Math.max(1,Math.floor((claim.windowMinutes||60)/2))}).catch(()=>{});
    return {ok:false,error:message};
  }
}
