import { koreanTimestamp, mapNotice, readProviderPayload } from './g2b.ts';
import { PRIVATE_BID_BASE } from './g2b-private.ts';
import { latestAlertNotices } from '../src/alerts/domain.ts';
import type { AlertNotice } from '../src/alerts/types.ts';

type Row = Record<string, unknown>;
export type AlertProvider = (operation: string, params: Record<string,string>) => Promise<Row[]>;
const str=(value:unknown)=>String(value ?? '').trim();
export const minuteKst=(time:number)=>new Date(time+9*3600_000).toISOString().slice(0,16).replace(/[-T:]/g,'');
export function createAlertProvider(key=process.env.G2B_SERVICE_KEY, fetcher:typeof fetch=fetch,options:{deadline?:number;maxRequests?:number}={}):AlertProvider {
  const deadline=options.deadline??Date.now()+30_000;let requests=0;
  return async(operation,params)=>{
    if(!key) throw new Error('나라장터 인증키가 설정되지 않았습니다.');
    const rows:Row[]=[]; let total:number|undefined;
    for(let page=1;page<=12;page++) {
      const remaining=deadline-Date.now();
      if(remaining<1500||++requests>(options.maxRequests??40)) throw new Error('나라장터 조회 시간 또는 호출 예산에 도달하여 다음 확인 때 다시 시도합니다.');
      const url=new URL(operation,operation.startsWith('getPrvt')?PRIVATE_BID_BASE:'https://apis.data.go.kr/1230000/ad/BidPublicInfoService/');
      let decoded=key; try { if(key.includes('%')) decoded=decodeURIComponent(key); } catch { throw new Error('나라장터 인증키 형식을 확인해 주세요.'); }
      url.search=new URLSearchParams({...params,pageNo:String(page),numOfRows:'999',type:'json',serviceKey:decoded}).toString();
      let response:Response; try { response=await fetcher(url,{signal:AbortSignal.timeout(Math.min(12_000,remaining)),redirect:'error',cache:'no-store'}); } catch { throw new Error('나라장터 응답이 지연되어 다음 확인 때 다시 시도합니다.'); }
      if(!response.ok) throw new Error(response.status===429?'나라장터 호출 한도에 도달했습니다. 다음 확인 때 다시 시도합니다.':'나라장터 응답을 확인하지 못했습니다.');
      let parsed:ReturnType<typeof readProviderPayload>;
      try { const raw=await response.text(); if(raw.length>15_000_000) throw new Error(); parsed=readProviderPayload(JSON.parse(raw)); } catch { throw new Error('나라장터 목록이 완전하지 않아 확인 시점을 유지합니다.'); }
      if(total!==undefined&&total!==parsed.totalCount) throw new Error('조회 도중 전체 건수가 바뀌어 다음 확인 때 다시 시도합니다.');
      total=parsed.totalCount; rows.push(...parsed.items);
      if(rows.length===total) return rows;
      if(rows.length>total||parsed.items.length===0) break;
    }
    throw new Error('나라장터 조회 범위를 모두 확인하지 못해 다음 확인 때 다시 시도합니다.');
  };
}
const identity=(row:Row)=>`${str(row.bidNtceNo)}:${str(row.bidNtceOrd).padStart(3,'0')}`;
function validate(rows:Row[]) { for(const row of rows) if(!/^[A-Za-z0-9-]{5,30}$/.test(str(row.bidNtceNo))||!/^\d{1,3}$/.test(str(row.bidNtceOrd))) throw new Error('공고 식별정보가 불완전하여 다음 확인 때 다시 시도합니다.'); }

/** Registration and modification windows are independent. A failed page never advances the cursor. */
export async function collectAlertWindow(provider:AlertProvider,from:number,to:number,types:('공사'|'용역')[]=['공사','용역'],modified=true):Promise<AlertNotice[]> {
  const params={inqryBgnDt:minuteKst(from),inqryEndDt:minuteKst(to)};
  const jobs=types.flatMap(type=>(modified?['1','3']:['1']).map(inqryDiv=>({type,inqryDiv,operation:`getBidPblancListInfo${type==='공사'?'Cnstwk':'Servc'}`})));
  const responses=await Promise.all(jobs.map(async job=>({ ...job,rows:await provider(job.operation,{...params,inqryDiv:job.inqryDiv}) })));
  const [regions,licenses]=await Promise.all(['PrtcptPsblRgn','LicenseLimit'].map(suffix=>provider(`getBidPblancListInfo${suffix}`,{...params,inqryDiv:'1'})));
  validate(regions);validate(licenses);
  const notices:AlertNotice[]=[];
  for(const response of responses) {
    validate(response.rows);
    for(const row of response.rows) {
      const notice=mapNotice(row,response.type,to);
      const updated=koreanTimestamp(row.chgDt)||koreanTimestamp(row.rgstDt)||notice.postedAt;
      if(!updated||!notice.postedAt) throw new Error('공고 일시가 불완전하여 다음 확인 때 다시 시도합니다.');
      const matches=(related:Row)=>identity(related)===identity(row)&&(!str(related.bsnsDivNm)||str(related.bsnsDivNm)===response.type);
      // Older changed notices lie outside the registration-indexed bulk condition endpoints.
      const old=response.inqryDiv==='3'&&Date.parse(koreanTimestamp(row.rgstDt)||notice.postedAt)<from;
      const exact={inqryDiv:'2',bidNtceNo:notice.number,bidNtceOrd:notice.revision};
      const [r,l]=old?await Promise.all([provider('getBidPblancListInfoPrtcptPsblRgn',exact),provider('getBidPblancListInfoLicenseLimit',exact)]):[regions,licenses];
      validate(r);validate(l);
      const regionNames=r.filter(matches).map(item=>str(item.prtcptPsblRgnNm)).filter(Boolean);
      const licenseNames=l.filter(matches).map(item=>str(item.lcnsLmtNm)).filter(Boolean);
      if(r.some(item=>matches(item)&&!str(item.prtcptPsblRgnNm))||l.some(item=>matches(item)&&!str(item.lcnsLmtNm))) throw new Error('참가조건이 불완전하여 다음 확인 때 다시 시도합니다.');
      notices.push({...notice,allowedRegions:[...new Set(regionNames)],licenses:[...new Set(licenseNames)],sourceUpdatedAt:updated,regionComplete:true,licenseComplete:true});
    }
  }
  return latestAlertNotices(notices);
}
