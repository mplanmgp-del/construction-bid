import {describe,it,expect,vi} from 'vitest';
import {handleAlertRequest,validWorkerToken} from '../server/alert-http';
import {createAlertStore,type AlertStore} from '../server/alert-store';
import {DEFAULT_ALERT_SETTINGS} from '../src/alerts/types';
describe('alert API authority',()=>{
  it('allows an authenticated maintenance comparison without waiting for the next scheduled run',async()=>{
    const token='w'.repeat(64);vi.stubEnv('ALERT_WORKER_TOKEN',token);
    try {
      const claim=vi.fn(async()=>({leaseId:null}));
      const store={claim,setDeadline:vi.fn()} as unknown as AlertStore;
      await handleAlertRequest('POST',new URLSearchParams('action=worker'),{forceCollection:true},`Bearer ${token}`,store);
      expect(claim).toHaveBeenCalledWith(false,true);
      await expect(handleAlertRequest('POST',new URLSearchParams('action=worker'),{forceCollection:true},'Bearer member',store)).rejects.toMatchObject({status:401});
      expect(claim).toHaveBeenCalledTimes(1);
    }finally{vi.unstubAllEnvs();}
  });
  it('sends the maintenance flag only through the existing private worker RPC',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>Response.json({leaseId:null}));
    const store=createAlertStore({url:'https://example.supabase.co',key:'public',token:'w'.repeat(64),fetcher});
    await store.claim(false,true);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({p_action:'claim',p_payload:{dispatchOnly:false,forceCollection:true}});
  });
  it('does not accept missing or unverified member credentials',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>new Response('{}',{status:401}));
    const store=createAlertStore({url:'https://example.supabase.co',key:'public',fetcher});
    await expect(handleAlertRequest('GET',new URLSearchParams(),{},undefined,store)).rejects.toMatchObject({status:401});
    await expect(handleAlertRequest('GET',new URLSearchParams(),{},'Bearer fake',store)).rejects.toMatchObject({status:401});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('never forwards a supplied user id and only saves normalized preferences',async()=>{
    const user=vi.fn(async()=>({ok:true}));
    const store={authenticate:async()=> 'verified',user} as unknown as AlertStore;
    await handleAlertRequest('POST',new URLSearchParams('action=save'),{settings:DEFAULT_ALERT_SETTINGS,userId:'victim'},'Bearer token',store);
    expect(user).toHaveBeenCalledWith('verified','save',{settings:DEFAULT_ALERT_SETTINGS});
  });
  it('requires the private worker token before any database claim',async()=>{
    const claim=vi.fn();const store={claim} as unknown as AlertStore;
    expect(validWorkerToken('Bearer abc','x'.repeat(43))).toBe(false);
    expect(validWorkerToken(`Bearer ${'x'.repeat(43)}`,'x'.repeat(43))).toBe(true);
    await expect(handleAlertRequest('POST',new URLSearchParams('action=worker'),{},'Bearer member',store)).rejects.toMatchObject({status:401});
    expect(claim).not.toHaveBeenCalled();
  });
  it('rejects arbitrary push URLs before calling owner storage',async()=>{
    const user=vi.fn();const store={authenticate:async()=> 'verified',user} as unknown as AlertStore;
    await expect(handleAlertRequest('POST',new URLSearchParams('action=test'),{endpoint:'https://127.0.0.1/internal'},'Bearer member',store)).rejects.toThrow();
    expect(user).not.toHaveBeenCalled();
  });
});
