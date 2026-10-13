import type { BidNotice, Category } from '../src/types.ts';
import type { G2bBusinessType, G2bNoticeDetail, G2bNoticePage, G2bOpeningResult, G2bResultPage, G2bResultSummary } from '../src/g2b-types.ts';
import { mapDetailSections } from './g2b-detail.ts';
import { createRelatedLoader } from './g2b-related.ts';
import { startSearchWindows } from '../src/live/start-range.ts';
import { checkProviderQuota, recordProviderQuota, ProviderQuotaError, PROVIDER_QUOTA_COOLDOWN_MS } from './provider-quota.ts';

type Row = Record<string, unknown>;
const BID_BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService/';
const STANDARD_BASE = 'https://apis.data.go.kr/1230000/ao/PubDataOpnStdService/';
const CACHE_TTL = 5 * 60_000;
const CACHE_LIMIT = 80;
const MAX_REGION_PAGES = 5;

export class G2bError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
export function money(value: unknown): number | null {
  const cleaned = text(value).replaceAll(',', '');
  if (!/^\d+(?:\.0+)?$/.test(cleaned)) return null;
  const amount = Number(cleaned);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}
function percentage(value: unknown): number | null {
  const cleaned = text(value);
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

export function koreanTimestamp(value: unknown): string {
  const match = text(value).match(/^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?$/);
  if (!match) return '';
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}+09:00`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 19);
  return local === iso.slice(0, 19) ? iso : '';
}
function combineDate(day: unknown, time: unknown) { return koreanTimestamp(`${text(day).replaceAll('-', '')}${text(time).replaceAll(':', '')}`); }

/** Only return trusted HTTPS links; downloads happen in the browser, never via a proxy. */
export function safeG2bUrl(value: unknown): string | undefined {
  try {
    const url = new URL(text(value));
    if (url.username || url.password || (url.port && url.port !== '443')) return;
    if (url.protocol !== 'https:' || !(url.hostname === 'g2b.go.kr' || url.hostname.endsWith('.g2b.go.kr'))) return;
    return url.href;
  } catch { return; }
}
function categoryFromTitle(title: string): Category {
  if (/석면/.test(title)) return '석면';
  if (/철거|해체/.test(title)) return '철거·해체';
  if (/폐기물/.test(title)) return '폐기물';
  if (/설계|감리|조사/.test(title)) return '조사·설계·감리';
  if (/전기|통신|소방/.test(title)) return '전기·통신·소방';
  if (/조경/.test(title)) return '조경';
  if (/기계|설비/.test(title)) return '기계·설비';
  if (/보수|유지관리/.test(title)) return '보수·유지관리';
  if (/토목|도로|하천/.test(title)) return '토목';
  if (/건축|리모델링|증축|신축/.test(title)) return '건축·리모델링';
  return '기타';
}
const identity = (row: Row) => `${text(row.bidNtceNo)}:${text(row.bidNtceOrd).padStart(3, '0')}`;

export function mapNotice(row: Row, type: G2bBusinessType, now = Date.now()): BidNotice {
  const number = text(row.bidNtceNo);
  const revision = text(row.bidNtceOrd).padStart(3, '0');
  const title = text(row.bidNtceNm) || '공고명 미제공';
  const deadline = koreanTimestamp(row.bidClseDt);
  const begin = koreanTimestamp(row.bidBeginDt);
  const cancelled = /취소/.test(text(row.ntceKindNm));
  const status = cancelled ? '취소' : !deadline ? '확인필요'
    : Date.parse(deadline) <= now ? '마감' : begin && Date.parse(begin) > now ? '접수예정' : '접수중';
  const documents: BidNotice['documents'] = [];
  for (let index = 1; index <= 10; index++) {
    const name = text(row[`ntceSpecFileNm${index}`]);
    const url = safeG2bUrl(row[`ntceSpecDocUrl${index}`]);
    if (name || url) documents.push({ name: name || `공고 첨부파일 ${index}`, size: '크기 미제공', ...(url ? { url } : {}) });
  }
  const standardUrl = safeG2bUrl(row.stdNtceDocUrl);
  if (standardUrl && !documents.some(doc => doc.url === standardUrl)) documents.push({ name: '표준 공고서', size: '크기 미제공', url: standardUrl });
  for (let index = 1; index <= 5; index++) {
    const url = safeG2bUrl(row[`sptDscrptDocUrl${index}`]);
    if (url && !documents.some(doc => doc.url === url)) documents.push({ name: `현장설명서 ${index}`, size: '크기 미제공', url });
  }
  const site = text(row.cnstrtsiteRgnNm).split(/\s+/);
  const special = row.rgnDutyJntcontrctYn === 'Y' || row.cmmnSpldmdCorpRgnLmtYn === 'Y' || row.brffcBidprcPermsnYn === 'Y'
    || /지사/.test(text(row.rgnLmtBidLocplcJdgmBssNm))
    || [1, 2, 3].some(index => Boolean(text(row[`jntcontrctDutyRgnNm${index}`])));
  return {
    id: `g2b:${type}:${number}:${revision}`, number, revision, title,
    agency: text(row.ntceInsttNm) || text(row.dminsttNm) || '기관 미제공', type,
    demandAgency: text(row.dminsttNm), noticeKind: text(row.ntceKindNm),
    category: categoryFromTitle(title), province: site[0] || '', district: site.slice(1).join(' '),
    allowedRegions: null,
    // presmptPrce is the official estimated-price field. Never fall back to budget/base price.
    estimatedPrice: money(row.presmptPrce), plannedAmount: money(row.bdgtAmt), contractMethod: text(row.cntrctCnclsMthdNm) || '미제공', status,
    postedAt: koreanTimestamp(row.bidNtceDt), biddingStartAt: begin, deadline, openingAt: koreanTimestamp(row.opengDt),
    registrationDeadline: koreanTimestamp(row.bidQlfctRgstDt), licenses: [], duration: '원문 확인',
    description: text(row.chgNtceRsn) || '나라장터에서 수집한 실제 공고입니다. 세부 공사 범위와 참가조건은 원문 및 첨부파일을 확인해 주세요.',
    requirements: unique([text(row.aplBssCntnts), special ? '공동수급 또는 지사 투찰 관련 조건이 있어 원문 확인이 필요합니다.' : '', '공종 분류는 공고명에서 추정한 참고용 분류입니다.']),
    documents, revised: Number(revision) > 0 || row.reNtceYn === 'Y' || /변경|정정/.test(text(row.ntceKindNm)),
    specialRegionCondition: special, source: 'live', detailUrl: safeG2bUrl(row.bidNtceDtlUrl) || safeG2bUrl(row.bidNtceUrl),
  };
}

export function mapResult(row: Row, type: G2bBusinessType, index = 0): G2bOpeningResult {
  return {
    id: `${type}:${identity(row)}:${text(row.bidprcCorpBizrno)}:${text(row.opengRank)}:${index}`,
    number: text(row.bidNtceNo), revision: text(row.bidNtceOrd).padStart(3, '0'), title: text(row.bidNtceNm), type,
    agency: text(row.ntceInsttNm), openingAt: combineDate(row.opengDate, row.opengTm),
    result: text(row.opengRsltDivNm) || '결과 미제공', rank: text(row.opengRank),
    companyName: text(row.bidprcCorpNm), businessNumber: text(row.bidprcCorpBizrno),
    bidAmount: money(row.bidprcAmt), bidRate: percentage(row.bidprcRt),
    winnerName: text(row.fnlSucsfCorpNm), winnerBusinessNumber: text(row.fnlSucsfCorpBizrno),
    winningAmount: money(row.fnlSucsfAmt), awarded: row.sucsfYn === 'Y' ? true : row.sucsfYn === 'N' ? false : null,
    disqualificationReason: text(row.dqlfctnRsn), dataAsOf: text(row.dataBssDate),
  };
}

export interface SearchQuery { type: G2bBusinessType; from: string; to: string; page: number; pageSize: number; keyword: string }
function integerParam(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw new G2bError(400, 'INVALID_QUERY', '페이지 또는 조회 건수가 올바르지 않습니다.');
  return Number(value);
}
export function parseSearch(params: URLSearchParams, maximumDays = 31): SearchQuery {
  const type = params.get('type');
  if (type !== '공사' && type !== '용역') throw new G2bError(400, 'INVALID_QUERY', '업무 구분은 공사 또는 용역으로 선택해 주세요.');
  const from = params.get('from') || '', to = params.get('to') || '';
  const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  if (!validDay(from) || !validDay(to) || from > to || Date.parse(to) - Date.parse(from) >= maximumDays * 86400_000) {
    throw new G2bError(400, 'INVALID_DATE_RANGE', `조회 기간은 올바른 날짜로 최대 ${maximumDays}일 이내를 선택해 주세요.`);
  }
  const keyword = params.get('keyword')?.trim() || '';
  if (keyword.length > 100 || /[\u0000-\u001f]/.test(keyword)) throw new G2bError(400, 'INVALID_QUERY', '검색어는 100자 이내로 입력해 주세요.');
  return { type, from, to, keyword, page: integerParam(params.get('page'), 1, 10_000), pageSize: integerParam(params.get('pageSize'), 100, 100) };
}
function providerError(code: string): G2bError | ProviderQuotaError {
  if (['20', '30', '31'].includes(code)) return new G2bError(503, 'G2B_AUTH_ERROR', '나라장터 API 인증 또는 이용 권한을 확인해 주세요. 서버 인증키와 활용신청 승인 상태 확인이 필요합니다.');
  if (['22', '23'].includes(code)) return new ProviderQuotaError(PROVIDER_QUOTA_COOLDOWN_MS / 1000);
  return new G2bError(502, 'G2B_PROVIDER_ERROR', '나라장터에서 정상 응답을 받지 못했습니다. 잠시 후 다시 조회해 주세요.');
}
export function readProviderPayload(payload: unknown): { items: Row[]; totalCount: number } {
  const root = object(payload), gateway = object(object(root.OpenAPI_ServiceResponse).cmmMsgHeader);
  if (text(gateway.returnReasonCode)) throw providerError(text(gateway.returnReasonCode));
  const response = object(root.response ?? root), header = object(response.header), body = object(response.body);
  const code = text(header.resultCode);
  if (code === '03') return { items: [], totalCount: 0 };
  if (!['00', '0', '000'].includes(code)) throw providerError(code);
  const totalCount = Number(body.totalCount);
  if (body.totalCount === undefined || !Number.isSafeInteger(totalCount) || totalCount < 0) throw providerError('INVALID');
  const rawItems = Array.isArray(body.items) ? body.items : object(body.items).item;
  const items = (Array.isArray(rawItems) ? rawItems : rawItems && typeof rawItems === 'object' ? [rawItems] : []).map(object);
  if (totalCount > 0 && items.length === 0) throw new G2bError(502, 'G2B_INCOMPLETE_RESPONSE', '나라장터 응답의 목록과 전체 건수가 일치하지 않습니다. 다시 조회해 주세요.');
  return { items, totalCount };
}

interface ClientOptions {
  serviceKey?: string; fetcher?: typeof fetch; now?: () => number;
  quotaGuard?: { assertAvailable: typeof checkProviderQuota; trip: typeof recordProviderQuota };
}
export function createG2bClient({ serviceKey, fetcher = fetch, now = Date.now, quotaGuard = { assertAvailable: checkProviderQuota, trip: recordProviderQuota } }: ClientOptions) {
  const cache = new Map<string, { until: number; value: unknown }>();
  const pending = new Map<string, Promise<unknown>>();
  async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value as T;
    if (pending.has(key)) return pending.get(key) as Promise<T>;
    const job = loader().then(value => {
      cache.delete(key); cache.set(key, { until: now() + CACHE_TTL, value });
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }
  async function request(base: string, operation: string, params: Record<string, string>, timeoutMs = 15_000) {
    if (!serviceKey?.trim()) throw new G2bError(503, 'G2B_NOT_CONFIGURED', '실제 공고 연동을 위한 나라장터 API 인증키가 아직 서버에 설정되지 않았습니다.');
    return cached(`provider:${base}:${operation}:${new URLSearchParams(params)}`, async () => {
      const url = new URL(operation, base);
      let key = serviceKey.trim();
      try { if (key.includes('%')) key = decodeURIComponent(key); } catch { throw providerError('30'); }
      // Cached successes remain usable. Only a new provider request needs quota permission.
      await quotaGuard.assertAvailable(key, base, now);
      url.search = new URLSearchParams({ ...params, type: 'json', serviceKey: key }).toString();
      let response: Response;
      try { response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { Accept: 'application/json' } }); }
      catch { throw new G2bError(504, 'G2B_UNAVAILABLE', '나라장터에 연결할 수 없거나 응답 시간이 초과되었습니다. 잠시 후 다시 조회해 주세요.'); }
      try {
        if (response.status === 429) throw new ProviderQuotaError(PROVIDER_QUOTA_COOLDOWN_MS / 1000);
        // Never forward provider bodies/errors/URLs: they can contain the service key.
        let body: string;
        try { body = await response.text(); } catch { throw providerError('INVALID'); }
        if (body.length > 15_000_000) throw providerError('INVALID');
        let payload: unknown;
        try { payload = JSON.parse(body); }
        catch { throw providerError(body.match(/<(?:returnReasonCode|resultCode)>\s*(\d+)\s*<\/(?:returnReasonCode|resultCode)>/)?.[1] || 'INVALID'); }
        const parsed = readProviderPayload(payload);
        if (!response.ok) throw providerError(String(response.status));
        return parsed;
      } catch (error) {
        if (error instanceof ProviderQuotaError) await quotaGuard.trip(key, base, now);
        throw error;
      }
    });
  }
  async function allRegions(query: SearchQuery, deadline = Infinity) {
    return cached(`regions:${query.from}:${query.to}`, async () => {
      const rows: Row[] = [];
      // Keep the complete request below the deployed 60s function limit, even if every page is slow.
      const finishBy = Math.min(now() + 30_000, deadline);
      for (let page = 1; page <= MAX_REGION_PAGES; page++) {
        const remaining = finishBy - now();
        if (remaining <= 0) break;
        const result = await request(BID_BASE, 'getBidPblancListInfoPrtcptPsblRgn', {
          inqryDiv: '1', inqryBgnDt: query.from.replaceAll('-', '') + '0000', inqryEndDt: query.to.replaceAll('-', '') + '2359',
          // The provider silently resets 1000 to 10; live verification confirms 999 is supported.
          bidNtceOrd: '000', pageNo: String(page), numOfRows: '999',
        }, Math.min(15_000, remaining));
        // This bounded lookup cannot be complete; avoid downloading pages that would be discarded.
        if (result.totalCount > MAX_REGION_PAGES * 999) return { rows: [] as Row[], complete: false };
        rows.push(...result.items);
        if (rows.length >= result.totalCount) return { rows, complete: true };
        if (!result.items.length) break;
      }
      // Partial membership lists must not exclude a company that may match a missing region.
      return { rows: [] as Row[], complete: false };
    });
  }
  async function notices(query: SearchQuery): Promise<G2bNoticePage> {
    const result = await request(BID_BASE, query.type === '공사' ? 'getBidPblancListInfoCnstwkPPSSrch' : 'getBidPblancListInfoServcPPSSrch', {
      inqryDiv: '1', inqryBgnDt: query.from.replaceAll('-', '') + '0000', inqryEndDt: query.to.replaceAll('-', '') + '2359',
      pageNo: String(query.page), numOfRows: String(query.pageSize), ...(query.keyword ? { bidNtceNm: query.keyword } : {}),
    });
    const warnings: string[] = [];
    const items = result.items.map(row => mapNotice(row, query.type, now()));
    if (items.length) {
      try {
        const regions = await allRegions(query);
        if (!regions.complete) warnings.push('지역조건 조회량이 많아 일부 지역 판정을 보류했습니다. 조회 기간을 줄이거나 공고 상세에서 확인해 주세요.');
        const index = new Map<string, string[]>();
        for (const row of regions.rows) {
          if (text(row.bsnsDivNm) && text(row.bsnsDivNm) !== query.type) continue;
          const names = index.get(identity(row)) || [];
          const name = text(row.prtcptPsblRgnNm);
          if (name) names.push(name);
          index.set(identity(row), names);
        }
        items.forEach(item => { const names = unique(index.get(`${item.number}:${item.revision}`) || []); item.allowedRegions = names.length ? names : null; });
      } catch (error) {
        warnings.push(error instanceof ProviderQuotaError ? '나라장터 호출 한도로 지역조건 추가 조회를 중단했습니다. 확인되지 않은 지역은 공고 상세에서 확인해 주세요.'
          : '참가 가능 지역을 불러오지 못했습니다. 확인되지 않은 공고는 제외하지 않고 확인 필요로 표시합니다.');
      }
    }
    return { items, totalCount: result.totalCount, page: query.page, pageSize: query.pageSize,
      hasMore: query.page * query.pageSize < result.totalCount, fetchedAt: new Date(now()).toISOString(), source: '나라장터 입찰공고정보서비스', warnings };
  }
  async function detail(number: string, revision: string, type: G2bBusinessType): Promise<G2bNoticeDetail> {
    const params = { inqryDiv: '2', bidNtceNo: number, bidNtceOrd: revision, pageNo: '1', numOfRows: '999' };
    const [general, baseAmounts, regions, licenses] = await Promise.allSettled([
      request(BID_BASE, type === '공사' ? 'getBidPblancListInfoCnstwk' : 'getBidPblancListInfoServc', params),
      request(BID_BASE, type === '공사' ? 'getBidPblancListInfoCnstwkBsisAmount' : 'getBidPblancListInfoServcBsisAmount', params),
      request(BID_BASE, 'getBidPblancListInfoPrtcptPsblRgn', params),
      request(BID_BASE, 'getBidPblancListInfoLicenseLimit', params),
    ]);
    const quotaFailure = [general, baseAmounts, regions, licenses].find(result => result.status === 'rejected' && result.reason instanceof ProviderQuotaError);
    const matches = (row: Row) => text(row.bidNtceNo) === number && /^\d{1,3}$/.test(text(row.bidNtceOrd))
      && text(row.bidNtceOrd).padStart(3, '0') === revision && (!text(row.bsnsDivNm) || text(row.bsnsDivNm) === type);
    const regionComplete = regions.status === 'fulfilled' && regions.value.items.length >= regions.value.totalCount;
    const licenseComplete = licenses.status === 'fulfilled' && licenses.value.items.length >= licenses.value.totalCount;
    if ([general, baseAmounts, regions, licenses].every(result => result.status === 'rejected')) {
      if (general.status === 'rejected') throw general.reason;
    }
    const regionRows = regionComplete && regions.status === 'fulfilled' ? regions.value.items.filter(matches) : [];
    const licenseRows = licenseComplete && licenses.status === 'fulfilled' ? licenses.value.items.filter(matches) : [];
    const generalComplete = general.status === 'fulfilled' && general.value.items.length >= general.value.totalCount;
    const generalRows = generalComplete && general.status === 'fulfilled' ? general.value.items.filter(matches) : [];
    // Do not silently pick the first item when a provider returns duplicate/ambiguous identities.
    const noticeRow = generalRows.length === 1 ? generalRows[0] : undefined;
    if (!noticeRow && quotaFailure?.status === 'rejected') throw quotaFailure.reason;
    const baseComplete = baseAmounts.status === 'fulfilled' && baseAmounts.value.items.length >= baseAmounts.value.totalCount;
    const baseRows = baseComplete && baseAmounts.status === 'fulfilled' ? baseAmounts.value.items.filter(matches) : [];
    const names = unique(regionRows.map(row => text(row.prtcptPsblRgnNm)));
    const licenseNames = unique(licenseRows.map(row => text(row.lcnsLmtNm)));
    const sourceUrl = `https://www.g2b.go.kr/link/PNPE027_01/?${new URLSearchParams({ bidPbancNo: number, bidPbancOrd: revision })}`;
    const notice = noticeRow ? { ...mapNotice(noticeRow, type, now()), allowedRegions: names.length ? names : null, licenses: licenseNames, detailUrl: sourceUrl } : undefined;
    return { number, revision, allowedRegions: names.length ? names : null, licenses: licenseNames,
      regionComplete, licenseComplete, fetchedAt: new Date(now()).toISOString(),
      ...(notice ? { notice } : {}), sourceUrl,
      sections: mapDetailSections({ row: noticeRow, type, regionRows, licenseRows, baseRows }),
      warnings: [
        ...(quotaFailure ? ['나라장터 호출 한도로 일부 부가정보 조회를 중단했습니다. 확인된 공고 정보를 표시합니다.'] : []),
        ...(!noticeRow ? ['해당 공고의 일반 상세정보를 확인하지 못했습니다. 공고번호·차수와 나라장터 원문을 확인해 주세요.'] : []),
        ...(!baseComplete ? ['기초금액 공개정보를 모두 불러오지 못했습니다. 금액 상세는 나라장터 원문을 확인해 주세요.'] : []),
        ...(!regionComplete ? ['지역조건을 모두 확인하지 못했습니다. 공고 원문을 확인해 주세요.'] : []),
        ...(!licenseComplete ? ['면허조건을 모두 확인하지 못했습니다. 공고 원문을 확인해 주세요.'] : []),
      ] };
  }
  async function results(query: SearchQuery): Promise<G2bResultPage> {
    const result = await request(STANDARD_BASE, 'getDataSetOpnStdScsbidInfo', {
      bsnsDivCd: query.type === '공사' ? '3' : '5', opengBgnDt: query.from.replaceAll('-', '') + '0000',
      opengEndDt: query.to.replaceAll('-', '') + '2359', pageNo: String(query.page), numOfRows: String(query.pageSize),
    });
    return { items: result.items.map((row, index) => mapResult(row, query.type, (query.page - 1) * query.pageSize + index)),
      totalCount: result.totalCount, page: query.page, pageSize: query.pageSize, hasMore: query.page * query.pageSize < result.totalCount,
      fetchedAt: new Date(now()).toISOString(), source: '나라장터 공공데이터개방표준서비스' };
  }
  const related = createRelatedLoader(request, now);
  async function resultSummary(number: string, revision: string, type: G2bBusinessType, openingAt: string): Promise<G2bResultSummary> {
    return cached(`result-summary:${type}:${number}:${revision}:${openingAt}`, async () => {
      const date = new Date(Date.parse(openingAt) + 9 * 3600_000).toISOString().slice(0, 16).replace(/[-T:]/g, '');
      const rows: Row[] = [];
      let complete = false;
      const finishBy = now() + 30_000;
      // The approved standard service filters by opening time, not notice number.
      // Fetch only this minute; always join exact number, revision and business type locally.
      for (let page = 1; page <= 10; page++) {
        const remaining = finishBy - now();
        if (remaining <= 0) break;
        const result = await request(STANDARD_BASE, 'getDataSetOpnStdScsbidInfo', {
          bsnsDivCd: type === '공사' ? '3' : '5', opengBgnDt: date, opengEndDt: date,
          pageNo: String(page), numOfRows: '999',
        }, Math.min(15_000, remaining));
        rows.push(...result.items);
        if (rows.length >= result.totalCount) { complete = true; break; }
        if (!result.items.length) break;
      }
      const matched = rows.filter(row => text(row.bidNtceNo) === number && /^\d{1,3}$/.test(text(row.bidNtceOrd))
        && text(row.bidNtceOrd).padStart(3, '0') === revision && text(row.bsnsDivNm) === type);
      const states = unique(matched.map(row => text(row.opengRsltDivNm)));
      return { number, revision, type, complete, fetchedAt: new Date(now()).toISOString(),
        firstCompanies: unique(matched.filter(row => /^0*1$/.test(text(row.opengRank))).map(row => text(row.bidprcCorpNm))),
        winnerCompanies: unique(matched.map(row => text(row.fnlSucsfCorpNm) || (row.sucsfYn === 'Y' ? text(row.bidprcCorpNm) : ''))),
        result: states.length === 1 ? states[0] : '',
      };
    });
  }
  async function startNotices(query: SearchQuery, windowIndex: number): Promise<G2bNoticePage> {
    if (!query.keyword.trim()) throw new G2bError(400, 'KEYWORD_REQUIRED', '철거·석면 등 검색할 공고명을 입력해 주세요.');
    const window = startSearchWindows(query.from, query.to)[windowIndex];
    if (!window || !Number.isInteger(windowIndex) || windowIndex < 0) throw new G2bError(400, 'INVALID_QUERY', '조회 구간이 올바르지 않습니다.');
    return cached(`start:${query.type}:${query.from}:${query.to}:${query.keyword}:${windowIndex}`, async () => {
      const finishBy = now() + 40_000;
      const operation = query.type === '공사' ? 'getBidPblancListInfoCnstwkPPSSrch' : 'getBidPblancListInfoServcPPSSrch';
      const getPage = async (page: number) => {
        // A transient provider failure must not force the user to restart the whole search.
        for (let attempt = 0; ; attempt++) {
          const remaining = finishBy - now();
          if (remaining <= 0) throw new G2bError(504, 'SEARCH_INCOMPLETE', '전체 공고 조회가 끝나지 않았습니다. 다시 조회하거나 기간·검색어를 좁혀 주세요.');
          try {
            return await request(BID_BASE, operation, { inqryDiv: '1', inqryBgnDt: window.from.replaceAll('-', '') + '0000', inqryEndDt: window.to.replaceAll('-', '') + '2359', pageNo: String(page), numOfRows: '100', ...(query.keyword ? { bidNtceNm: query.keyword } : {}) }, Math.min(15_000, remaining));
          } catch (error) {
            if (attempt >= 1 || !(error instanceof G2bError) || !['G2B_PROVIDER_ERROR', 'G2B_UNAVAILABLE', 'G2B_INCOMPLETE_RESPONSE'].includes(error.code) || finishBy - now() < 5000) throw error;
          }
        }
      };
      const first = await getPage(1);
      const pages = Math.ceil(first.totalCount / 100);
      if (pages > 300) throw new G2bError(422, 'SEARCH_TOO_BROAD', '조회할 원본 공고가 많습니다. 공고명 검색어를 입력해 주세요. 일부만 표시하지 않도록 조회를 중단했습니다.');
      const rows = [...first.items];
      let next = 2;
      await Promise.all(Array.from({ length: Math.min(6, Math.max(0, pages - 1)) }, async () => {
        while (next <= pages) {
          const result = await getPage(next++);
          if (result.totalCount !== first.totalCount) throw new G2bError(409, 'SEARCH_CHANGED', '조회 중 원본 공고가 변경되었습니다. 다시 조회해 주세요.');
          rows.push(...result.items);
        }
      }));
      if (rows.length !== first.totalCount || new Set(rows.map(identity)).size !== rows.length) throw new G2bError(502, 'SEARCH_INCOMPLETE', '전체 공고 수집을 확인하지 못했습니다. 다시 조회해 주세요.');
      const start = Date.parse(`${query.from}T00:00:00+09:00`), end = Date.parse(`${query.to}T23:59:59+09:00`);
      const items = rows.filter(row => { const timestamp = Date.parse(koreanTimestamp(row.bidBeginDt)); return timestamp >= start && timestamp <= end; }).map(row => mapNotice(row, query.type, now()));
      // Membership stays unknown unless all region pages were obtained. Detail lookup can refine it.
      const warnings: string[] = [];
      if (items.length && finishBy - now() > 5000) {
        try {
          const regions = await allRegions({ ...query, ...window }, finishBy);
          const index = new Map<string, string[]>();
          for (const row of regions.rows) {
            if (text(row.bsnsDivNm) && text(row.bsnsDivNm) !== query.type) continue;
            index.set(identity(row), [...(index.get(identity(row)) ?? []), text(row.prtcptPsblRgnNm)]);
          }
          items.forEach(item => { const names = unique(index.get(`${item.number}:${item.revision}`) ?? []); item.allowedRegions = names.length ? names : null; });
          if (!regions.complete) warnings.push('일부 참가 가능 지역은 상세 공고에서 확인해 주세요.');
        } catch (error) {
          warnings.push(error instanceof ProviderQuotaError ? '나라장터 호출 한도로 지역조건 추가 조회를 중단했습니다. 확인되지 않은 지역은 공고 상세에서 확인해 주세요.'
            : '참가 가능 지역 조회에 실패했습니다. 상세 공고에서 확인해 주세요.');
        }
      }
      return { items, totalCount: items.length, page: 1, pageSize: items.length, hasMore: false, fetchedAt: new Date(now()).toISOString(), source: '나라장터 입찰공고정보서비스', warnings };
    });
  }
  return { notices, startNotices, detail, results, related, resultSummary };
}
