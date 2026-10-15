import { createHash } from 'node:crypto';
import { alertNoticeKey,isOlderAlertNotice,matchAlertNotice,meaningfulChanges,noticeContentKey } from '../src/alerts/domain.ts';
import type { AlertEventKind,AlertNotice,WorkerRule } from '../src/alerts/types.ts';
export interface Observation { key:string;notice:AlertNotice;fingerprint:string;version:number }
export interface Membership {userId:string;key:string;lastVersion:number;initial?:boolean}
export interface AlertCommit {observations:Observation[];events:{userId:string;key:string;version:number;kind:AlertEventKind;message:string;changeFields:string[]}[];existing:{userId:string;key:string;version:number;initial?:boolean}[]}
export function planAlertChanges(notices:AlertNotice[],previous:Observation[],memberships:Membership[],rules:WorkerRule[],now=Date.now()):AlertCommit {
  const plan:AlertCommit={observations:[],events:[],existing:[]};
  const facts=new Map(previous.map(item=>[item.key,item]));
  const seen=new Map(memberships.map(item=>[`${item.userId}:${item.key}`,item]));
  for(const notice of notices) {
    const key=alertNoticeKey(notice),before=facts.get(key);
    if(before&&isOlderAlertNotice(notice,before.notice)) continue;
    const fingerprint=createHash('sha256').update(noticeContentKey(notice)).digest('hex');
    const changed=Boolean(before&&fingerprint!==before.fingerprint);
    const version=before?before.version+(changed?1:0):1;
    const fields=before&&changed?meaningfulChanges(before.notice,notice):[];
    let relevant=Boolean(before);
    for(const rule of rules) {
      if(!rule.settings.enabled) continue;
      const membership=seen.get(`${rule.userId}:${key}`),last=membership?.lastVersion;
      const matched=matchAlertNotice(notice,rule.settings,rule.profile,now).matched;
      if(!matched&&last===undefined) continue;
      // A retained dedup ledger is not a subscription to an old, now unrelated filter.
      // Compare the previous source facts too, so losing eligibility/cancellation is still reported.
      if(!matched&&before&&!matchAlertNotice(before.notice,rule.settings,rule.profile,Date.parse(before.notice.postedAt)).matched) continue;
      relevant=true;
      if(last!==undefined&&last>=version) {
        if(membership?.initial===false&&matched&&Date.parse(notice.postedAt)<Date.parse(rule.settings.activatedAt||'')) plan.existing.push({userId:rule.userId,key,version});
        continue;
      }
      if(last!==undefined) {
        if(changed&&rule.settings.notifyChanges) plan.events.push({userId:rule.userId,key,version,kind:notice.status==='취소'?'cancelled':'changed',message:notice.status==='취소'?'관심 공고가 취소되었습니다.':`관심 공고의 ${fields.join(' · ')} 항목이 변경되었습니다.`,changeFields:fields});
        else plan.existing.push({userId:rule.userId,key,version,initial:false});
      } else if(matched) {
        const activation=Date.parse(rule.settings.activatedAt||new Date(now).toISOString());
        if(Date.parse(notice.postedAt)<activation) plan.existing.push({userId:rule.userId,key,version});
        else plan.events.push({userId:rule.userId,key,version,kind:'new',message:'설정한 조건에 맞는 새 공고가 등록되었습니다.',changeFields:[]});
      }
    }
    if(relevant) plan.observations.push({key,notice,fingerprint,version});
  }
  return plan;
}
