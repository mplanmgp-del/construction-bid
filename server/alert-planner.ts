import { createHash } from 'node:crypto';
import { alertNoticeKey,hasOmittedContentDigest,isOlderAlertNotice,matchAlertNotice,meaningfulChanges,noticeContentKey,noticeOmittedContentKey } from '../src/alerts/domain.ts';
import type { AlertEventKind,AlertNotice,WorkerRule } from '../src/alerts/types.ts';
export interface Observation { key:string;notice:AlertNotice;fingerprint:string;version:number }
export interface Membership {userId:string;key:string;lastVersion:number;initial?:boolean}
export interface AlertCommit {observations:Observation[];events:{userId:string;key:string;version:number;kind:AlertEventKind;message:string;changeFields:string[]}[];existing:{userId:string;key:string;version:number;initial?:boolean}[]}
export function planAlertChanges(notices:AlertNotice[],previous:Observation[],memberships:Membership[],rules:WorkerRule[],now=Date.now()):AlertCommit {
  const plan:AlertCommit={observations:[],events:[],existing:[]};
  const facts=new Map(previous.map(item=>[item.key,item]));
  const seen=new Map(memberships.map(item=>[`${item.userId}:${item.key}`,item]));
  const ordered=[...notices].sort((a,b)=>alertNoticeKey(a).localeCompare(alertNoticeKey(b))||Number(a.revision)-Number(b.revision)||Date.parse(a.sourceUpdatedAt)-Date.parse(b.sourceUpdatedAt));
  function remember(item:{userId:string;key:string;version:number},initial=false) {
    const identity=`${item.userId}:${item.key}`,before=seen.get(identity);
    seen.set(identity,{userId:item.userId,key:item.key,lastVersion:Math.max(before?.lastVersion??0,item.version),initial:Boolean(before?.initial||initial)});
  }
  function existing(item:AlertCommit['existing'][number]) {plan.existing.push(item);remember(item,item.initial!==false);}
  function event(item:AlertCommit['events'][number]) {plan.events.push(item);remember(item);}
  for(const notice of ordered) {
    const key=alertNoticeKey(notice),before=facts.get(key);
    if(before&&isOlderAlertNotice(notice,before.notice)) continue;
    const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
    const omittedDigest=(value:AlertNotice)=>hasOmittedContentDigest(value)?value.sourceOmittedDigest!:hash(noticeOmittedContentKey(value));
    const compact=hasOmittedContentDigest(notice)||Boolean(before&&hasOmittedContentDigest(before.notice));
    const fields=before?meaningfulChanges(before.notice,notice):[];
    if(before&&compact&&omittedDigest(before.notice)!==omittedDigest(notice)&&!fields.includes('공고 내용'))fields.push('공고 내용');
    // Compare source facts, not a representation change from legacy rich observations to compact catalog rows.
    const changed=Boolean(before&&fields.length);
    const fingerprint=before&&!changed?before.fingerprint:hash(compact?JSON.stringify([noticeContentKey(notice),omittedDigest(notice)]):noticeContentKey(notice));
    const version=before?before.version+(changed?1:0):1;
    let relevant=Boolean(before);
    for(const rule of rules) {
      if(!rule.settings.enabled) continue;
      const membership=seen.get(`${rule.userId}:${key}`),last=membership?.lastVersion;
      const comparison=matchAlertNotice(notice,rule.settings,rule.profile,now);
      const matched=comparison.matched;
      if(!matched&&last===undefined) continue;
      // A retained dedup ledger is not a subscription to an old, now unrelated filter.
      // Compare the previous source facts too, so losing eligibility/cancellation is still reported.
      if(!matched&&before&&!matchAlertNotice(before.notice,rule.settings,rule.profile,Date.parse(before.notice.postedAt)).matched) continue;
      relevant=true;
      if(last!==undefined&&last>=version) {
        if(membership?.initial===false&&matched&&Date.parse(notice.postedAt)<Date.parse(rule.settings.activatedAt||'')) existing({userId:rule.userId,key,version});
        continue;
      }
      if(last!==undefined) {
        const activation=Date.parse(rule.settings.activatedAt||new Date(now).toISOString());
        const sourceTime=Math.max(Date.parse(notice.postedAt)||0,Date.parse(notice.sourceUpdatedAt)||0);
        if(sourceTime<activation) existing({userId:rule.userId,key,version,...(!matched?{initial:false}:{})});
        else if(changed&&rule.settings.notifyChanges) event({userId:rule.userId,key,version,kind:notice.status==='취소'?'cancelled':'changed',message:notice.status==='취소'?'관심 공고가 취소되었습니다.':`관심 공고의 ${fields.join(' · ')} 항목이 변경되었습니다.`,changeFields:fields});
        else existing({userId:rule.userId,key,version,initial:false});
      } else if(matched) {
        const activation=Date.parse(rule.settings.activatedAt||new Date(now).toISOString());
        if(Date.parse(notice.postedAt)<activation) existing({userId:rule.userId,key,version});
        else event({userId:rule.userId,key,version,kind:'new',message:`${comparison.needsReview?'일부 조건 확인이 필요한 새 관심 공고가 등록되었습니다.':'설정한 조건에 맞는 새 공고가 등록되었습니다.'} ${comparison.reasons.join(' · ')}`.trim(),changeFields:[]});
      }
    }
    if(relevant) {const observation={key,notice,fingerprint,version};plan.observations.push(observation);facts.set(key,observation);}
  }
  return plan;
}
