import { CATEGORIES, type CompanyProfile } from '../types';
import { assessRegion, assessSearchRegions } from '../domain';
import { canonicalProvince } from '../search-filters';
import { DEFAULT_ALERT_SETTINGS, type AlertNotice, type AlertSettings, type AlertMatch } from './types';

const clean = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const canonical = (value: string) => clean(value).toLowerCase();
const license = (value: string) => canonical(value).replace(/[ㆍ・ᆞ]/g, '·').replace(/\s+/g, '').replace(/\/\d+$/, '');
const sorted = (values: string[], normalize = canonical) => [...new Set(values.map(normalize))].sort();
const date = (value: string | undefined) => { const stamp = Date.parse(value || ''); return Number.isFinite(stamp) ? new Date(stamp).toISOString() : clean(value || ''); };
const region = (value: string) => {
  const parts = clean(value).split(' ');
  return [canonicalProvince(parts[0]) || parts[0], ...parts.slice(1)].join(' ');
};

/** Only source facts affect a version. A clock tick, ordering and revision label do not. */
function content(notice: AlertNotice): Record<string, unknown> {
  return {
    '공고명':clean(notice.title), '발주기관':clean(notice.agency), '수요기관':clean(notice.demandAgency || ''),
    '현장 위치':region(`${notice.province} ${notice.district}`),
    '업무':notice.type, '추정가격':notice.estimatedPrice, '예산금액':notice.plannedAmount ?? null,
    '제출 마감':date(notice.deadline), '참가등록 마감':date(notice.registrationDeadline),
    '입찰 개시':date(notice.biddingStartAt), '개찰 일정':date(notice.openingAt),
    '참가 가능 지역':notice.allowedRegions === null ? null : sorted(notice.allowedRegions, region),
    '요구 면허':sorted(notice.licenses,license), '별도 지역조건':Boolean(notice.specialRegionCondition),
    '계약방법':clean(notice.contractMethod), '공고 취소':notice.status === '취소',
    '첨부서류':notice.documents.map(doc=>[clean(doc.name),doc.url || '']).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    '공고 내용':clean(notice.description), '참가조건':sorted(notice.requirements),
  };
}
export function noticeContentKey(notice: AlertNotice): string { return JSON.stringify(content(notice)); }
export function meaningfulChanges(before: AlertNotice, after: AlertNotice): string[] {
  const previous = content(before), next = content(after);
  return Object.keys(previous).filter(key=>JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}
export function alertNoticeKey(notice: Pick<AlertNotice,'type'|'number'>): string { return `g2b:${notice.type}:${notice.number}`; }
export function isOlderAlertNotice(incoming: AlertNotice, stored: AlertNotice): boolean {
  if (Number(incoming.revision) !== Number(stored.revision)) return Number(incoming.revision) < Number(stored.revision);
  const first=Date.parse(incoming.sourceUpdatedAt), second=Date.parse(stored.sourceUpdatedAt);
  return Number.isFinite(first) && Number.isFinite(second) && first < second;
}
export function latestAlertNotices(notices: AlertNotice[]): AlertNotice[] {
  const map = new Map<string,AlertNotice>();
  for(const notice of notices) {
    const key=alertNoticeKey(notice), previous=map.get(key);
    if(!previous || !isOlderAlertNotice(notice,previous)) map.set(key,notice);
  }
  return [...map.values()];
}

export function normalizeAlertSettings(input: unknown): AlertSettings {
  const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
  if(!object(input)||!object(input.filter)) throw new Error('알림 조건을 확인해 주세요.');
  const source=input.filter;
  const strings=(key:string,maxLength=100):string[]=>{
    const value=source[key];
    if(!Array.isArray(value)||value.length>20||value.some(item=>typeof item!=='string'||!item.trim()||item.length>maxLength||/[\u0000-\u001f]/.test(item))) throw new Error('알림 조건은 항목별 20개 이내로 입력해 주세요.');
    return [...new Set(value.map(value=>clean(value as string)))];
  };
  const bool=(value:unknown,label:string)=>{if(typeof value!=='boolean') throw new Error(`${label} 설정을 확인해 주세요.`);return value;};
  const amount=(value:unknown):number|null=>{
    if(value===null)return null;
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error('금액은 0 이상의 원 단위 정수로 입력해 주세요.');
    return value;
  };
  const types=strings('types'), categories=strings('categories');
  if(!types.length||types.some(type=>!['공사','용역'].includes(type)))throw new Error('공사 또는 용역을 선택해 주세요.');
  if(categories.some(item=>![...CATEGORIES,'기타'].includes(item as never)))throw new Error('작업 분야를 확인해 주세요.');
  const filter:AlertSettings['filter']={keywords:strings('keywords',80),excludeKeywords:strings('excludeKeywords',80),
    types:types as ('공사'|'용역')[],categories:categories as AlertSettings['filter']['categories'],
    regions:strings('regions'),licenses:strings('licenses',120),minAmount:amount(source.minAmount),maxAmount:amount(source.maxAmount),
    includeUnknown:bool(source.includeUnknown,'미확인 조건'),useCompanyRegion:bool(source.useCompanyRegion,'업체 지역')};
  if(filter.minAmount!==null&&filter.maxAmount!==null&&filter.minAmount>filter.maxAmount)throw new Error('최소 금액은 최대 금액 이하로 입력해 주세요.');
  const enabled=bool(input.enabled,'알림');
  if(enabled&&!filter.keywords.length&&!filter.categories.length&&!filter.regions.length&&!filter.licenses.length&&!filter.useCompanyRegion&&filter.minAmount===null&&filter.maxAmount===null)throw new Error('맞춤 알림 조건을 한 가지 이상 입력해 주세요.');
  return {...structuredClone(DEFAULT_ALERT_SETTINGS),enabled,filter,notifyChanges:bool(input.notifyChanges,'변경 알림'),
    pushEnabled:bool(input.pushEnabled,'푸시 알림'),
    activatedAt:typeof input.activatedAt==='string'?input.activatedAt:null,updatedAt:typeof input.updatedAt==='string'?input.updatedAt:null};
}

export function matchAlertNotice(notice: AlertNotice, settings: AlertSettings, profile: CompanyProfile|null, now=Date.now()): AlertMatch {
  const reasons:string[]=[], missing:string[]=[];
  const no=():AlertMatch=>({matched:false,reasons:[],needsReview:false});
  if(!settings.enabled||notice.source!=='live'||notice.status==='취소')return no();
  const deadline=Date.parse(notice.deadline);
  if(Number.isFinite(deadline)&&deadline<=now)return no();
  if(!Number.isFinite(deadline))missing.push('마감일 확인 필요');
  const filter=settings.filter, text=canonical(`${notice.title} ${notice.agency} ${notice.demandAgency||''}`);
  if(filter.keywords.length&&!filter.keywords.some(keyword=>text.includes(canonical(keyword))))return no();
  if(filter.excludeKeywords.some(keyword=>text.includes(canonical(keyword))))return no();
  if(!filter.types.includes(notice.type)||filter.categories.length&&!filter.categories.includes(notice.category))return no();
  if(filter.keywords.length)reasons.push('관심 검색어 일치');
  if(filter.regions.length) {
    const assessment=assessSearchRegions(notice,filter.regions.map(value=>{const parts=clean(value).split(' ');return {province:parts[0],district:parts[1],locality:parts.slice(2).join(' ')};}));
    if(assessment.status==='excluded')return no();
    if(assessment.status==='review'||notice.type==='용역'&&!notice.regionComplete)missing.push('검색 지역 확인 필요');
    else reasons.push('검색 지역 일치');
  }
  if(filter.useCompanyRegion) {
    if(!profile)missing.push('업체 소재지 확인 필요');
    else {
      const assessment=assessRegion(notice,profile);
      if(assessment.status==='excluded')return no();
      if(assessment.status==='review')missing.push('업체 지역조건 확인 필요');else reasons.push('내 업체 지역 일치');
    }
  }
  if(filter.licenses.length) {
    if(!notice.licenseComplete||!notice.licenses.length)missing.push('면허조건 확인 필요');
    else if(!filter.licenses.some(wanted=>notice.licenses.some(item=>license(item)===license(wanted))))return no();
    else reasons.push('관심 면허 일치');
  }
  if(filter.minAmount!==null||filter.maxAmount!==null) {
    if(notice.estimatedPrice===null)missing.push('추정가격 확인 필요');
    else if(filter.minAmount!==null&&notice.estimatedPrice<filter.minAmount||filter.maxAmount!==null&&notice.estimatedPrice>filter.maxAmount)return no();
    else reasons.push('추정가격 범위 일치');
  }
  if(missing.length&&!filter.includeUnknown)return no();
  return {matched:true,reasons:[...reasons,...missing],needsReview:missing.length>0};
}
