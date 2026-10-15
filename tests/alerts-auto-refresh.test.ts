import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertsController, startAlertAutoRefresh, type AlertRepository } from '../src/alerts/useAlerts';
import { DEFAULT_ALERT_SETTINGS, type AlertOverview } from '../src/alerts/types';
const data = (unreadCount=0): AlertOverview => ({settings:structuredClone(DEFAULT_ALERT_SETTINGS),notifications:[],unreadCount,hasMore:false,existingMatches:[],existingHasMore:false,status:{configured:true,lastCheckedAt:null,coverageFrom:null,backfillPending:false,error:null,paused:false,pushConfigured:false},subscriptionCount:0,publicKey:null});
const deferred = <T,>() => {let resolve!: (value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
const repository = (overrides:Partial<AlertRepository>={}):AlertRepository => ({load:async()=>data(),mutate:async()=>undefined,...overrides});
afterEach(()=>vi.useRealTimers());
describe('automatic alert lookup',()=>{
  it('does not cancel a pending lookup when focus and visibility events overlap',async()=>{
    const result=deferred<AlertOverview>();const load=vi.fn<AlertRepository['load']>(()=>result.promise);const controller=new AlertsController(repository({load}));controller.setUser('a');
    const first=controller.refreshIfIdle();
    expect(await controller.refreshIfIdle()).toBe(false);expect(load).toHaveBeenCalledTimes(1);expect(load.mock.calls[0][2].aborted).toBe(false);
    result.resolve(data(2));expect(await first).toBe(true);expect(controller.getSnapshot().overview?.unreadCount).toBe(2);
  });
  it('waits for writes and lets the write perform its authoritative reload',async()=>{
    const writing=deferred<void>();const load=vi.fn().mockResolvedValueOnce(data()).mockResolvedValueOnce(data(4));const controller=new AlertsController(repository({load,mutate:()=>writing.promise}));controller.setUser('a');await controller.refresh();
    const save=controller.save(DEFAULT_ALERT_SETTINGS);expect(await controller.refreshIfIdle()).toBe(false);expect(load).toHaveBeenCalledTimes(1);
    writing.resolve();expect(await save).toBe(true);expect(load).toHaveBeenCalledTimes(2);expect(controller.getSnapshot().overview?.unreadCount).toBe(4);
  });
  it('preserves an older-page request and skips lookup after logout',async()=>{
    const next=deferred<AlertOverview>();const load=vi.fn().mockResolvedValueOnce(data()).mockReturnValueOnce(next.promise);const controller=new AlertsController(repository({load}));controller.setUser('a');await controller.refresh();const more=controller.loadMore();
    expect(await controller.refreshIfIdle()).toBe(false);expect(load.mock.calls[1][2].aborted).toBe(false);next.resolve(data());await more;
    controller.setUser();expect(await controller.refreshIfIdle()).toBe(false);expect(load).toHaveBeenCalledTimes(2);
  });
  it('looks up on visible focus, tab return, reconnect and interval, then removes its listeners',()=>{
    vi.useFakeTimers();const browserWindow=new EventTarget();const browserDocument=Object.assign(new EventTarget(),{visibilityState:'visible'});const refresh=vi.fn(async()=>true);
    const stop=startAlertAutoRefresh(refresh,browserWindow,browserDocument);
    browserWindow.dispatchEvent(new Event('focus'));expect(refresh).toHaveBeenCalledTimes(1);
    browserDocument.visibilityState='hidden';browserWindow.dispatchEvent(new Event('focus'));vi.advanceTimersByTime(60_000);expect(refresh).toHaveBeenCalledTimes(1);
    browserDocument.visibilityState='visible';browserDocument.dispatchEvent(new Event('visibilitychange'));browserWindow.dispatchEvent(new Event('online'));vi.advanceTimersByTime(60_000);expect(refresh).toHaveBeenCalledTimes(4);
    stop();browserWindow.dispatchEvent(new Event('focus'));browserWindow.dispatchEvent(new Event('online'));browserDocument.dispatchEvent(new Event('visibilitychange'));vi.advanceTimersByTime(60_000);expect(refresh).toHaveBeenCalledTimes(4);
  });
});
