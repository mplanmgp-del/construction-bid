import { matchAlarmNotice } from '../src/alerts/domain.ts';
import type { AlertNotice, WorkerRule } from '../src/alerts/types.ts';
import type { ActiveCatalogPage, ActiveCatalogPageQuery, ActiveCatalogStatus } from '../src/live/active-catalog-types.ts';
import type { AlertProvider } from './alert-collector.ts';
import { noticeTimestamp } from '../src/notice-deadline-window.ts';
import { createG2bClient, koreanTimestamp, mapNotice } from './g2b.ts';
import { mapPrivateNotice, matchesPrivateNotice, PRIVATE_NOTICE_DIVISIONS, privateNoticeOperation } from './g2b-private.ts';
import { compactCatalogNotice } from './active-catalog-worker.ts';
import type { G2bResultSummary } from '../src/g2b-types.ts';

export interface CatalogReader {
  page(query: ActiveCatalogPageQuery): Promise<ActiveCatalogPage>;
  alarmPage?: (query:ActiveCatalogPageQuery)=>Promise<ActiveCatalogPage>;
  publishVerified?: (notices:AlertNotice[])=>Promise<{ok:boolean;storageFull?:boolean}>;
  enrich?: (notice: AlertNotice) => Promise<unknown>;
}
interface AlarmScanScope extends Pick<ActiveCatalogPageQuery,'changedSince'|'changedThrough'> {
  resultSummary?: (notice:AlertNotice)=>Promise<G2bResultSummary>;
}
export async function scanCatalogForAlerts(catalog: CatalogReader, provider: AlertProvider, rules: WorkerRule[],
  initialCursor: string | null, commit: (notices: AlertNotice[]) => Promise<void>, deadline: number, now = Date.now(), maxRequests = 30,
  scope: AlarmScanScope = {}) {
  let cursor = initialCursor, requests = 0, processed = 0, status: ActiveCatalogStatus | null = null;
  const result = (complete: boolean, error?: string) => ({ cursor, complete, processed, requests, status, ...(error ? { error } : {}) });
  const resultClient=createG2bClient({serviceKey:process.env.G2B_SERVICE_KEY,fetcher:async(input,init)=>{
    const remaining=deadline-15_000-Date.now();
    if(remaining<1_000||requests>=maxRequests)throw new Error('공고 개찰 상태 확인을 다음 확인 때 이어갑니다.');
    requests++;
    return fetch(input,{...init,signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(Math.floor(remaining))])});
  }});
  const summary=scope.resultSummary??((notice:AlertNotice)=>resultClient.resultSummary(notice.number,notice.revision,notice.type,notice.openingAt));
  const seen = new Set<string>();
  while (Date.now() < deadline - 15_000) {
    const page = await (catalog.alarmPage??catalog.page)({changedSince:scope.changedSince,changedThrough:scope.changedThrough,
      includeIndex:true,cursor,limit:100,includeInactive:true}); status = page.status;
    if (!Array.isArray(page.groups) || page.nextCursor && seen.has(page.nextCursor)) throw new Error('전체 공고 비교 위치를 확인하지 못했습니다.');
    const pending: AlertNotice[] = []; let last = cursor, stop = false, error = '';
    for (const group of page.groups) {
      if (Date.now() > deadline - 15_000) { stop = true; break; }
      let notice = group.latest,versions=group.versions,changed=false;
      const potential=(candidate:AlertNotice)=>rules.filter(rule=>matchAlarmNotice(candidate,
        {...rule.settings,filter:{...rule.settings.filter,includeUnknown:true}},rule.profile,now).matched);
      const verifyHistory=!group.verifiedAt&&potential(notice).length>0;
      try {
        if(verifyHistory) {
          if(requests>=maxRequests){stop=true;break;}
          requests++;
          const privateSource=notice.procurementSource==='private';
          const rows=await provider(privateSource?privateNoticeOperation(notice.type):`getBidPblancListInfo${notice.type==='공사'?'Cnstwk':'Servc'}`,
            {inqryDiv:privateSource?PRIVATE_NOTICE_DIVISIONS.number:'2',bidNtceNo:notice.number});
          if(!rows.length||rows.length>1000)throw new Error('공고 전체 차수 이력을 확인하지 못했습니다. 다음 확인 때 다시 시도합니다.');
          versions=rows.map(row=>{
            const revision=String(row.bidNtceOrd??'').trim();
            if(String(row.bidNtceNo??'').trim()!==notice.number||!/^\d{1,3}$/.test(revision)
              ||row.bsnsDivNm&&String(row.bsnsDivNm).trim()!==notice.type
              ||privateSource&&!matchesPrivateNotice(row,notice.number,notice.type))throw new Error('공고 전체 이력의 번호·차수를 확인하지 못했습니다.');
            const mapped=privateSource?mapPrivateNotice(row,notice.type,now):mapNotice(row,notice.type,now),sourceUpdatedAt=koreanTimestamp(row.chgDt)||koreanTimestamp(row.rgstDt)||mapped.postedAt;
            if(!mapped.postedAt||!sourceUpdatedAt)throw new Error('공고 전체 이력의 일시를 확인하지 못했습니다.');
            return compactCatalogNotice({...mapped,sourceUpdatedAt,regionComplete:false,licenseComplete:false});
          }).sort((a,b)=>Number(a.revision)-Number(b.revision));
          if(new Set(versions.map(item=>item.revision)).size!==versions.length)throw new Error('공고 전체 이력의 차수가 중복되어 다시 확인합니다.');
          const latest=versions.at(-1)!;
          if(Number(latest.revision)<Number(notice.revision)||latest.revision===notice.revision
            &&noticeTimestamp(latest.sourceUpdatedAt)<noticeTimestamp(notice.sourceUpdatedAt))throw new Error('공고 전체 이력이 이미 확인한 변경 정보보다 오래되어 다시 확인합니다.');
          notice=latest;
        }
        let region=false,license=false;
        for(const rule of potential(notice)) {
          const filter=rule.settings.filter,basis=filter.regionBasis??'auto';
          region ||= !notice.regionComplete&&(filter.useCompanyRegion||filter.regions.length>0
            &&(basis==='participation'||basis==='either'||basis==='both'||basis==='auto'&&notice.type==='용역'));
          license ||= !notice.licenseComplete&&(filter.licenses.length>0||filter.useCompanyLicenses===true);
        }
        const needed=Number(region)+Number(license);
        const waiting=notice.procurementSource!=='private'&&potential(notice).length>0&&noticeTimestamp(notice.deadline)<=now&&noticeTimestamp(notice.openingAt)>now;
        if(requests+needed+(waiting?2:0)>maxRequests){stop=true;break;}
        if (needed) {
          const exact = { inqryDiv: '2', bidNtceNo: notice.number, bidNtceOrd: notice.revision };
          const load = async (operation: string) => {
            requests++; const rows = await provider(operation, exact);
            if (rows.some(row => !/^\d{1,3}$/.test(String(row.bidNtceOrd ?? '').trim()) || String(row.bidNtceNo ?? '').trim() !== notice.number
              || String(row.bidNtceOrd ?? '').trim().padStart(3, '0') !== notice.revision
              || row.bsnsDivNm && String(row.bsnsDivNm).trim() !== notice.type)) throw new Error('공고 참가조건의 번호·차수를 확인하지 못했습니다.');
            return rows;
          };
          const prefix=notice.procurementSource==='private'?'getPrvtBidPblancListInfo':'getBidPblancListInfo';
          const [regions, licenses] = await Promise.all([region ? load(`${prefix}PrtcptPsblRgn`) : null, license ? load(`${prefix}LicenseLimit`) : null]);
          const values = (rows: Record<string, unknown>[], key: string) => {
            const names = rows.map(row => String(row[key] ?? '').trim());
            if (names.some(name => !name)) throw new Error('공고 참가조건이 불완전하여 다음 확인 때 다시 시도합니다.');
            return [...new Set(names)];
          };
          const regionNames=regions?values(regions,'prtcptPsblRgnNm'):[];
          notice = { ...notice, ...(regions ? { allowedRegions: !regionNames.length&&notice.procurementSource==='private'?null:regionNames, regionComplete: true } : {}),
            ...(licenses ? { licenses: values(licenses, 'lcnsLmtNm'), licenseComplete: true } : {}) };
          changed=true;
        }
        if(waiting&&rules.some(rule=>matchAlarmNotice(notice,rule.settings,rule.profile,now).matched)) {
          if(scope.resultSummary)requests+=2;
          const opening=await summary(notice);
          if(!(opening.openingComplete??opening.complete))throw new Error('공고 개찰 상태를 모두 확인하지 못해 다음 확인 때 다시 시도합니다.');
          if(/^(?:개찰\s*완료|유찰)$/.test(opening.result.trim())){notice={...notice,openingCompleted:true};changed=true;}
        }
        versions=versions.map(item=>item.revision===notice.revision?notice:item);
        if(verifyHistory||changed&&catalog.publishVerified) {
          const stored=await catalog.publishVerified?.(versions);
          if(!stored?.ok||stored.storageFull)throw new Error('공고 전체 이력 저장을 확인하지 못했습니다. 다음 확인 때 다시 시도합니다.');
        } else if(changed) {
          const stored = await catalog.enrich?.(notice);
          if (stored && typeof stored === 'object' && 'ok' in stored && stored.ok === false) throw new Error('공고 참가조건 저장을 확인하지 못했습니다. 다음 확인 때 다시 시도합니다.');
        }
      } catch (cause) { stop = true; error = cause instanceof Error ? cause.message : '공고 참가조건 확인을 다음 확인 때 이어갑니다.'; break; }
      pending.push(...versions);
      last = group.key; processed++;
    }
    if (pending.length) { await commit(pending); cursor = last; }
    if (stop) return result(false, error || undefined);
    if (!page.nextCursor) { cursor = null; return result(true); }
    cursor = page.nextCursor; seen.add(cursor);
  }
  return result(false);
}
