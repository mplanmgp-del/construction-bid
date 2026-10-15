import { expect, it } from 'vitest';
import { createG2bClient, mapNotice } from '../server/g2b';

const now = () => Date.parse('2026-10-15T12:00:00+09:00');
const record = { bidNtceNo:'R26BK01756799', bidNtceOrd:'000', bidNtceNm:'철거 공사', ntceKindNm:'등록공고',
  bidBeginDt:'2026-10-01 10:00:00', bidClseDt:'2026-10-15 10:00:00', opengDt:'2026-10-16 11:00:00' };
const response = (items: unknown[]) => Response.json({ response:{ header:{ resultCode:'00' }, body:{ items,totalCount:items.length } } });

it('preserves an explicit official completion flag in notice mapping', () => {
  expect(mapNotice({ ...record,progrsDivCdNm:'개찰완료' },'공사',now()).openingCompleted).toBe(true);
  expect(mapNotice({ ...record,progrsDivCdNm:'재입찰' },'공사',now()).openingCompleted).not.toBe(true);
});

it.each(['개찰완료','재입찰'])('checks the latest pending-opening notice against small exact result summaries: %s', async state => {
  const calls:string[]=[];
  const api=createG2bClient({ serviceKey:'test',now,fetcher:async input=>{
    const url=new URL(String(input)); calls.push(url.pathname);
    if(url.pathname.includes('/BidPublicInfoService/')) return response([record]);
    if(url.pathname.includes('getScsbidList')) return response([]);
    return response([{ bidNtceNo:record.bidNtceNo,bidNtceOrd:'000',bidClsfcNo:'1',rbidNo:'0',progrsDivCdNm:state }]);
  } });
  const result=await api.lookupNotices('공사',record.bidNtceNo);
  expect(result.items[0].openingCompleted===true).toBe(state==='개찰완료');
  expect(calls).toHaveLength(3);
  expect(calls.some(path=>path.includes('OpengCompt'))).toBe(false);
});

it('excludes an officially opened notice even when the separate winner list is unavailable', async () => {
  const api=createG2bClient({serviceKey:'test',now,fetcher:async input=>{
    const url=new URL(String(input));
    if(url.pathname.includes('/BidPublicInfoService/')) return response([record]);
    if(url.pathname.includes('getScsbidList')) return Response.json({response:{header:{resultCode:'99'}}});
    return response([{...record,bidClsfcNo:'1',rbidNo:'0',progrsDivCdNm:'개찰완료'}]);
  }});
  expect((await api.lookupNotices('공사',record.bidNtceNo)).items[0].openingCompleted).toBe(true);
});
