import type { AlertCommit,Membership,Observation } from './alert-planner.ts';
import type { AlertInboxItem,BrowserPushSubscription,WorkerRule } from '../src/alerts/types.ts';
export class AlertError extends Error {constructor(public status:number,public code:string,message:string){super(message);}}
export interface AlertClaim {leaseId:string|null;cursor:string|null;backfillDay:string|null;coverageFrom:string|null;windowMinutes?:number;rules:WorkerRule[];enabled:boolean;collectionDue:boolean;lastCheckedAt:string|null;error:string|null}
export interface AlertDelivery {id:string;subscription:BrowserPushSubscription;notification:AlertInboxItem}
export function createAlertStore(options:{url?:string;key?:string;fetcher?:typeof fetch;token?:string}={}) {
  const url=options.url??process.env.VITE_SUPABASE_URL,key=options.key??process.env.VITE_SUPABASE_PUBLISHABLE_KEY??process.env.VITE_SUPABASE_ANON_KEY;
  const fetcher=options.fetcher??fetch;
  function configured() {
    let valid=Boolean(url&&key&&!key.startsWith('sb_secret_'));
    if(key?.split('.').length===3) {try {valid=valid&&JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role==='anon';} catch {valid=false;}}
    if(!valid) throw new AlertError(503,'ALERT_NOT_CONFIGURED','알리미 저장소 설정을 확인해 주세요.');
  }
  async function rpc<T>(name:string,payload:unknown,bearer?:string,timeout=12_000):Promise<T> {
    configured();let response:Response;
    try {response=await fetcher(new URL(`/rest/v1/rpc/${name}`,url),{method:'POST',headers:{apikey:key!,'Content-Type':'application/json',...(bearer?{Authorization:`Bearer ${bearer}`}:{})},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout),cache:'no-store',redirect:'error'});} catch {throw new AlertError(503,'ALERT_STORAGE_UNAVAILABLE','알림 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');}
    if(!response.ok) {
      const error=await response.json().catch(()=>({})) as {message?:string;code?:string};
      if(error.message?.includes('subscription_owned')) throw new AlertError(409,'PUSH_ALREADY_OWNED','이 브라우저 알림은 다른 계정에 연결되어 있습니다. 기존 계정에서 해제해 주세요.');
      if(error.message?.includes('admin_required')) throw new AlertError(403,'ADMIN_REQUIRED','관리자만 수집기를 연결할 수 있습니다.');
      throw new AlertError(response.status===401||response.status===403?403:503,'ALERT_STORAGE_ERROR','알림 저장소 요청을 처리하지 못했습니다. 설정과 연결 상태를 확인해 주세요.');
    }
    return await response.json() as T;
  }
  async function authenticate(authorization:unknown):Promise<string> {
    configured();const token=typeof authorization==='string'&&authorization.length<8192?/^Bearer ([A-Za-z0-9._~-]+)$/i.exec(authorization)?.[1]:undefined;
    if(!token) throw new AlertError(401,'LOGIN_REQUIRED','로그인 후 알리미를 이용해 주세요.');
    let response:Response; try {response=await fetcher(new URL('/auth/v1/user',url),{headers:{apikey:key!,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(8_000),cache:'no-store',redirect:'error'});} catch {throw new AlertError(503,'AUTH_UNAVAILABLE','로그인 상태를 확인하지 못했습니다.');}
    if(!response.ok) throw new AlertError(401,'LOGIN_REQUIRED','로그인이 만료되었습니다. 다시 로그인해 주세요.');
    const user=await response.json() as {id?:string};if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id||'')) throw new AlertError(401,'LOGIN_REQUIRED','로그인 정보를 확인해 주세요.');
    return token;
  }
  const worker=<T>(action:string,payload:unknown={})=>rpc<T>('bid_alert_worker',{p_token:options.token??process.env.ALERT_WORKER_TOKEN,p_action:action,p_payload:payload},undefined,4_000);
  return {authenticate,user:<T>(bearer:string,action:string,payload:unknown={})=>rpc<T>('bid_alert_user',{p_action:action,p_payload:payload},bearer),
    setup:(bearer:string)=>rpc('bid_alert_admin_setup',{p_token:process.env.ALERT_WORKER_TOKEN,p_endpoint:'https://construction-bid-nine.vercel.app/api/alerts?action=worker'},bearer),
    claim:(dispatchOnly=false)=>worker<AlertClaim>('claim',{dispatchOnly}),
    load:(leaseId:string,keys:string[])=>worker<{observations:Observation[];memberships:Membership[]}>('load',{leaseId,keys}),
    commit:(leaseId:string,payload:Partial<AlertCommit>&{checkpoint?:{cursor:string;backfillDay:string|null;coverageFrom:string|null;windowMinutes?:number};finish?:boolean;error?:string;warning?:string;retryWindowMinutes?:number})=>worker<{storageFull?:boolean}>('commit',{leaseId,...payload}),
    deliveries:(leaseId:string,limit=5)=>worker<{deliveries:AlertDelivery[]}>('deliveries',{leaseId,limit}),
    settle:(leaseId:string,results:unknown[])=>worker('settle',{leaseId,results}),
  };
}
export type AlertStore=ReturnType<typeof createAlertStore>;
