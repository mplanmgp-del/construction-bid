import {expect,it,vi} from 'vitest';
import {handleAlertRequest} from '../server/alert-http';
import type {AlertStore} from '../server/alert-store';
const id='77777777-7777-4777-8777-777777777777';
it.each(['delete','restore'])('forwards only an authenticated owner target for %s',async action=>{
 const user=vi.fn(async()=>({ok:true})),store={authenticate:async()=> 'verified',user} as unknown as AlertStore;
 await handleAlertRequest('POST',new URLSearchParams({action}),{id,userId:'victim'},'Bearer token',store);
 expect(user).toHaveBeenCalledWith('verified',action,{id});
});
it.each([{id:'bad'},{all:false},{all:'true'},{all:true,id},{}])('rejects an ambiguous or invalid delete target: %o',async target=>{
 const user=vi.fn(),store={authenticate:async()=> 'verified',user} as unknown as AlertStore;
 await expect(handleAlertRequest('POST',new URLSearchParams('action=delete'),target,'Bearer token',store)).rejects.toMatchObject({status:400});expect(user).not.toHaveBeenCalled();
});
it('accepts bulk deletion without passing a user or unrelated settings',async()=>{
 const user=vi.fn(async()=>({ok:true})),store={authenticate:async()=> 'verified',user} as unknown as AlertStore;
 await handleAlertRequest('POST',new URLSearchParams('action=delete'),{all:true,settings:{enabled:false},userId:'victim'},'Bearer token',store);
 expect(user).toHaveBeenCalledWith('verified','delete',{all:true});
});
