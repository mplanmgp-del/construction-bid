import {describe,expect,it,vi} from 'vitest';
import {AlertsController,type AlertRepository} from '../src/alerts/useAlerts';
import {DEFAULT_ALERT_SETTINGS,type AlertInboxItem,type AlertOverview} from '../src/alerts/types';
const item=(id:string):AlertInboxItem=>({id,kind:'test',notice:null,message:id,changeFields:[],createdAt:'2026-10-15T00:00:00Z',readAt:null});
const page=(patch:Partial<AlertOverview>={}):AlertOverview=>({settings:structuredClone(DEFAULT_ALERT_SETTINGS),notifications:[],unreadCount:0,hasMore:false,existingMatches:[],existingHasMore:false,status:{configured:true,lastCheckedAt:null,coverageFrom:null,backfillPending:false,error:null,paused:false,pushConfigured:false},subscriptionCount:0,publicKey:null,...patch});
const repo=(patch:Partial<AlertRepository>={}):AlertRepository=>({load:async()=>page(),mutate:async()=>{},...patch});
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};};

describe('recoverable inbox deletion',()=>{
 it('removes the confirmed row and unread badge without merging it back on refresh',async()=>{
  const load=vi.fn().mockResolvedValueOnce(page({notifications:[item('one'),item('two')],unreadCount:2})).mockResolvedValue(page({notifications:[item('two')],unreadCount:1,deletedNotifications:[{...item('one'),deletedAt:'now'}],deletedCount:1}));
  const mutate=vi.fn(async()=>{});const c=new AlertsController(repo({load,mutate}));c.setUser('a');await c.refresh();
  expect(await c.remove({id:'one'})).toBe(true);await c.refresh();
  expect(c.getSnapshot().overview?.notifications.map(n=>n.id)).toEqual(['two']);
  expect(c.getSnapshot().overview?.unreadCount).toBe(1);
  expect(mutate.mock.calls[0].slice(0,2)).toEqual(['delete',{id:'one'}]);
 });
 it('treats the server inbox as authoritative when another device deleted an alert',async()=>{
  const load=vi.fn().mockResolvedValueOnce(page({notifications:[item('one')],unreadCount:1})).mockResolvedValueOnce(page());
  const c=new AlertsController(repo({load}));c.setUser('a');await c.refresh();await c.refresh();
  expect(c.getSnapshot().overview?.notifications).toEqual([]);
 });
 it('does not remove anything or announce success when deletion is rejected',async()=>{
  const c=new AlertsController(repo({load:async()=>page({notifications:[item('one')],unreadCount:1}),mutate:async()=>{throw new Error('삭제 실패');}}));c.setUser('a');await c.refresh();
  expect(await c.remove({all:true})).toBe(false);
  expect(c.getSnapshot()).toMatchObject({message:'',removing:false,error:'삭제 실패',overview:{unreadCount:1,notifications:[{id:'one'}]}});
 });
 it('shows an acknowledged deletion locally but reports reload failure candidly',async()=>{
  const load=vi.fn().mockResolvedValueOnce(page({notifications:[item('one')],unreadCount:1})).mockRejectedValueOnce(new Error('최신 상태 확인 실패'));
  const c=new AlertsController(repo({load}));c.setUser('a');await c.refresh();
  expect(await c.remove({all:true})).toBe(false);
  expect(c.getSnapshot()).toMatchObject({message:'',removing:false,error:'최신 상태 확인 실패',overview:{notifications:[],unreadCount:0}});
 });
 it('restores through the owner endpoint and uses the returned inbox and deleted count',async()=>{
  const load=vi.fn().mockResolvedValueOnce(page({deletedNotifications:[{...item('one'),deletedAt:'now'}],deletedCount:1})).mockResolvedValueOnce(page({notifications:[item('one')],unreadCount:1,deletedNotifications:[],deletedCount:0}));
  const mutate=vi.fn(async()=>{}),c=new AlertsController(repo({load,mutate}));c.setUser('a');await c.refresh();
  expect(await c.restore({id:'one'})).toBe(true);
  expect(mutate.mock.calls[0].slice(0,2)).toEqual(['restore',{id:'one'}]);expect(c.getSnapshot().overview?.deletedCount).toBe(0);
 });
 it('paginates deleted alerts independently from received alerts',async()=>{
  const load=vi.fn().mockResolvedValueOnce(page({notifications:[item('live')],deletedNotifications:[item('old')],deletedHasMore:true})).mockResolvedValueOnce(page({notifications:[],deletedNotifications:[item('older')],deletedHasMore:false}));
  const c=new AlertsController(repo({load}));c.setUser('a');await c.refresh();await c.loadDeleted();
  expect(load.mock.calls[1][3]).toBe(1);
  expect(c.getSnapshot().overview?.deletedNotifications?.map(n=>n.id)).toEqual(['old','older']);expect(c.getSnapshot().overview?.notifications.map(n=>n.id)).toEqual(['live']);
 });
 it('cancels a pre-delete read so its late data cannot resurrect the row',async()=>{
  const pending=deferred<AlertOverview>();const load=vi.fn().mockResolvedValueOnce(page({notifications:[item('one')]})).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page());
  const c=new AlertsController(repo({load}));c.setUser('a');await c.refresh();const old=c.refresh();await c.remove({id:'one'});pending.resolve(page({notifications:[item('one')]}));await old;
  expect(c.getSnapshot().overview?.notifications).toEqual([]);
 });
 it('does not carry deletion state or results into another account',async()=>{
  const writing=deferred<void>();const c=new AlertsController(repo({load:async()=>page({notifications:[item('one')]}),mutate:()=>writing.promise}));c.setUser('a');await c.refresh();const deletion=c.remove({all:true});c.setUser('b');writing.resolve();
  expect(await deletion).toBe(false);expect(c.getSnapshot()).toMatchObject({userId:'b',overview:null,removing:false});
 });
});
