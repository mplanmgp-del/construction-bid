import type { IncomingMessage,ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createAlertStore,AlertError,type AlertStore } from './alert-store.ts';
import { runAlertWorker } from './alert-worker.ts';
import { normalizeAlertSettings } from '../src/alerts/domain.ts';
import { getAlertPushPublicKey,isAlertPushConfigured,validatePushEndpoint,validatePushSubscription } from './alert-push.ts';
import type { AlertOverview } from '../src/alerts/types.ts';
export function validWorkerToken(authorization:unknown,token=process.env.ALERT_WORKER_TOKEN):boolean {
  if(!token||token.length<32||typeof authorization!=='string') return false;
  const actual=Buffer.from(authorization),expected=Buffer.from(`Bearer ${token}`);
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export async function handleAlertRequest(method:string,params:URLSearchParams,body:Record<string,unknown>,authorization:unknown,store:AlertStore=createAlertStore()) {
  const action=params.get('action')||String(body.action||'overview');
  if(action==='worker') {
    if(method!=='POST') throw new AlertError(405,'METHOD_NOT_ALLOWED','POST 요청이 필요합니다.');
    if(!validWorkerToken(authorization)) throw new AlertError(401,'WORKER_UNAUTHORIZED','수집기 인증이 필요합니다.');
    return runAlertWorker(store);
  }
  const bearer=await store.authenticate(authorization);
  if(action==='overview'&&method==='GET') {
    const data=await store.user<AlertOverview>(bearer,'get',{offset:params.get('offset')||'0',existingOffset:params.get('existingOffset')||'0'});
    return {...data,publicKey:getAlertPushPublicKey(),status:{...data.status,pushConfigured:isAlertPushConfigured()}};
  }
  if(method!=='POST') throw new AlertError(405,'METHOD_NOT_ALLOWED','POST 요청이 필요합니다.');
  if(action==='save') {await store.user(bearer,'save',{settings:normalizeAlertSettings(body.settings)});return {ok:true};}
  if(action==='read') {await store.user(bearer,'read',body.all===true?{all:true}:{id:String(body.id||'')});return {ok:true};}
  if(action==='subscribe') {
    if(!isAlertPushConfigured()) throw new AlertError(503,'PUSH_NOT_CONFIGURED','푸시 서버 설정이 아직 완료되지 않았습니다.');
    await store.user(bearer,'subscribe',{subscription:validatePushSubscription(body.subscription)});return {ok:true};
  }
  if(['unsubscribe','subscription-status','test'].includes(action)) {
    const result=await store.user(bearer,action.replace('-','_'),{endpoint:validatePushEndpoint(body.endpoint)});
    if(action==='test') await runAlertWorker(store,{dispatchOnly:true});
    return action==='subscription-status'?result:{ok:true};
  }
  if(action==='setup') {
    if(!process.env.ALERT_WORKER_TOKEN) throw new AlertError(503,'ALERT_NOT_CONFIGURED','수집기 서버 환경변수를 먼저 설정해 주세요.');
    await store.setup(bearer);return {ok:true};
  }
  throw new AlertError(400,'INVALID_ACTION','지원하지 않는 알림 요청입니다.');
}
export async function alertApiHandler(req:IncomingMessage,res:ServerResponse) {
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');
  try {
    if(!['GET','POST'].includes(req.method||'')) throw new AlertError(405,'METHOD_NOT_ALLOWED','지원하지 않는 요청 방식입니다.');
    const parsed=(req as IncomingMessage&{body?:unknown}).body;
    let raw='';if(parsed===undefined)for await(const chunk of req) {raw+=chunk.toString();if(Buffer.byteLength(raw)>65536) throw new AlertError(413,'BODY_TOO_LARGE','요청이 너무 큽니다.');}
    let body:Record<string,unknown>={};try {const value:unknown=parsed===undefined?(raw?JSON.parse(raw):{}):typeof parsed==='string'?JSON.parse(parsed):parsed;if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>65536)throw new Error();body=value as Record<string,unknown>;} catch {throw new AlertError(400,'INVALID_BODY','요청 내용을 확인해 주세요.');}
    const params=new URL(req.url||'/api/alerts','http://localhost').searchParams;
    const result=await handleAlertRequest(req.method!,params,body,req.headers.authorization);
    res.statusCode=200;res.end(JSON.stringify(result));
  } catch(error) {
    const known=error instanceof AlertError;
    res.statusCode=known?error.status:400;
    res.end(JSON.stringify({error:{code:known?error.code:'INVALID_ALERT_REQUEST',message:known?error.message:'알리미 요청을 처리하지 못했습니다. 입력값과 연결 상태를 확인해 주세요.'}}));
  }
}
