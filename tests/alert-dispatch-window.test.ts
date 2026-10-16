import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAlertWorker } from '../server/alert-worker';
import type { AlertStore } from '../server/alert-store';
import type { AlertInboxItem, AlertNotice } from '../src/alerts/types';
import { NOTICES } from '../src/data';

const transport=vi.hoisted(()=>({send:vi.fn(async()=>({status:'sent' as const}))}));
vi.mock('../server/alert-push',()=>({isAlertPushConfigured:()=>true,sendAlertPush:transport.send}));
const now=Date.parse('2026-10-15T10:00:00+09:00');
const notice=(patch:Partial<AlertNotice>={}):AlertNotice=>({...NOTICES[0],source:'live',status:'접수중',
  deadline:'2026-10-20T10:00:00+09:00',openingAt:'2026-10-20T11:00:00+09:00',
  sourceUpdatedAt:'2026-10-15T09:59:00+09:00',regionComplete:true,licenseComplete:true,...patch});
const item=(id:string,kind:AlertInboxItem['kind'],source:AlertNotice|null):AlertInboxItem=>({id,kind,notice:source,message:'공고 알림',changeFields:[],createdAt:new Date(now-600000).toISOString(),readAt:null});
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});

describe('push delivery uses the current alarm deadline and phase',()=>{
  it('settles stale queued notices without sending while allowing active notices and test/digest messages',async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);
    const queued=[item('opened','changed',notice({openingAt:'2026-10-15T09:00:00+09:00'})),
      item('outside','new',notice({deadline:'2026-10-23T10:00:00+09:00',openingAt:'2026-10-23T11:00:00+09:00'})),
      item('cancelled','cancelled',notice({status:'취소'})), {...item('deleted','new',notice()),deletedAt:new Date(now).toISOString()}, item('active','new',notice()),item('test','test',null),item('digest','initial',null)];
    const settle=vi.fn(async()=>({}));
    const store={claim:async()=>({leaseId:'lease',enabled:true,collectionDue:false,rules:[]}),
      deliveries:vi.fn(async()=>({deliveries:queued.map(notification=>({id:notification.id,notification,subscription:{}}))})),
      settle,commit:async()=>({})} as unknown as AlertStore;
    await runAlertWorker(store,{dispatchOnly:true,now,deadline:now+45000});
    expect(transport.send.mock.calls.map(call=>(call as unknown as [unknown,AlertInboxItem])[1].id)).toEqual(['outside','active','test','digest']);
    const results=settle.mock.calls.flatMap(call=>(call as unknown as [unknown,{id:string;status:string}[]])[1]);
    expect(results.filter(result=>result.status==='failed').map(result=>result.id)).toEqual(['opened','cancelled','deleted']);
  });
});
