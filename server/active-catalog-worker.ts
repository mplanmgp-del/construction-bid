import { createHash } from 'node:crypto';
import { koreanTimestamp, mapNotice, readProviderPayload } from './g2b.ts';
import { mapPrivateNotice, matchesPrivateNotice, PRIVATE_BID_BASE, PRIVATE_NOTICE_DIVISIONS, privateNoticeOperation } from './g2b-private.ts';
import { createOpeningSummaryLoader } from './g2b-results.ts';
import { ProviderQuotaError, providerRetryAfter } from './provider-quota.ts';
import { matchAlarmNotice, noticeContentKey, noticeOmittedContentKey } from '../src/alerts/domain.ts';
import { isCatalogNotice, isOngoingNotice, noticeTimestamp } from '../src/notice-deadline-window.ts';
import type { ActiveCatalogStore } from './active-catalog-store.ts';
import type { ActiveCatalogCommit, ActiveCatalogIdentity, ActiveCatalogSourceJob } from '../src/live/active-catalog-types.ts';
import type { AlertNotice, WorkerRule } from '../src/alerts/types.ts';
import { compactNoticeRegionText } from './notice-region-text.ts';
import { noticeLicenseCodes } from './notice-license-codes.ts';

type Row = Record<string, unknown>;
class SourceSnapshotChanged extends Error {}
class WorkerBudgetExhausted extends Error {}
class SourcePublicationDeferred extends Error {
  constructor() { super('공고 원천 자료가 조회 도중 달라져 같은 공고를 다시 확인합니다.'); }
}
export type ActiveCatalogProvider = (operation: string, params: Record<string, string>, options?: { service: 'opening' }) => Promise<{ items: Row[]; totalCount: number }>;
export const CURRENT_NOTICE_KEYWORDS = ['철거', '해체', '석면', '건설폐기물'] as const;
const str = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const minuteKst = (value: string) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('공고 수집 기간을 확인하지 못했습니다.');
  return new Date(time + 9 * 3600_000).toISOString().slice(0, 16).replace(/[-T:]/g, '');
};
const safeError = (error: unknown) => error instanceof ProviderQuotaError ? error.message
  : error instanceof Error && /^(?:나라장터|공고 |조회 도중|전체 공고)/.test(error.message) ? error.message
  : '전체 공고 수집을 완료하지 못했습니다. 확인 범위를 유지하고 다시 시도합니다.';

/** Keep only searchable facts. Documents and full text stay in the on-demand detail API. */
export function compactCatalogNotice(notice: AlertNotice): AlertNotice {
  const supplied = (notice as AlertNotice & { sourceOmittedDigest?: string }).sourceOmittedDigest;
  const alreadyCompact = notice.description === '' && notice.documents.length === 0 && notice.requirements.length === 0;
  const sourceOmittedDigest = alreadyCompact && supplied && /^[a-f0-9]{64}$/.test(supplied) ? supplied
    : createHash('sha256').update(noticeOmittedContentKey(notice)).digest('hex');
  return compactNoticeRegionText({ ...notice, sourceOmittedDigest, description: '', documents: [], requirements: [], duration: '' });
}

export function createActiveCatalogProvider(
  key = process.env.G2B_SERVICE_KEY,
  fetcher: typeof fetch = fetch,
  options: { deadline?: number; clock?: () => number } = {},
): ActiveCatalogProvider {
  const clock = options.clock ?? Date.now;
  return async (operation, params, service) => {
    if (!key?.trim()) throw new Error('나라장터 인증키가 설정되지 않았습니다.');
    const remaining = (options.deadline ?? clock() + 20_000) - clock() - 8_000;
    if (remaining < 1_000) throw new WorkerBudgetExhausted('나라장터 조회 시간이 부족하여 다음 확인 때 이어서 수집합니다.');
    let decoded = key.trim();
    try { if (decoded.includes('%')) decoded = decodeURIComponent(decoded); }
    catch { throw new Error('나라장터 인증키 형식을 확인해 주세요.'); }
    const url = new URL(operation, service?.service === 'opening'
      ? 'https://apis.data.go.kr/1230000/as/ScsbidInfoService/'
      : operation.startsWith('getPrvt') ? PRIVATE_BID_BASE : 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService/');
    url.search = new URLSearchParams({ ...params, serviceKey: decoded, type: 'json' }).toString();
    let response: Response;
    try {
      response = await fetcher(url, { signal: AbortSignal.timeout(Math.min(25_000, remaining)), redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
    } catch { throw new Error('나라장터 응답이 지연되어 다음 확인 때 이어서 수집합니다.'); }
    if (response.status === 429) throw new ProviderQuotaError(providerRetryAfter(response.headers.get('Retry-After'), clock()));
    try {
      const text = await response.text();
      if (text.length > 15_000_000) throw new Error();
      const result = readProviderPayload(JSON.parse(text));
      if (!response.ok) throw new Error();
      return result;
    } catch (error) {
      if (error instanceof ProviderQuotaError) throw new ProviderQuotaError(providerRetryAfter(response.headers.get('Retry-After'), clock()));
      throw new Error('나라장터 목록 응답을 확인하지 못했습니다. 확인 범위를 유지합니다.');
    }
  };
}

function fact(row: Row, type: ActiveCatalogIdentity['type'], now: number, procurementSource?: 'public' | 'private'): AlertNotice {
  const number = str(row.bidNtceNo), revision = str(row.bidNtceOrd);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(number) || !/^\d{1,3}$/.test(revision)
    || (str(row.bsnsDivNm) && str(row.bsnsDivNm) !== type)
    || procurementSource === 'private' && !matchesPrivateNotice(row, number, type)) {
    throw new Error('공고 식별정보가 불완전하여 확인 범위를 유지합니다.');
  }
  const notice = procurementSource === 'private' ? mapPrivateNotice(row, type, now) : mapNotice(row, type, now);
  const sourceUpdatedAt = koreanTimestamp(row.chgDt) || koreanTimestamp(row.rgstDt) || notice.postedAt;
  if (!notice.postedAt || !sourceUpdatedAt) throw new Error('공고 일시가 불완전하여 확인 범위를 유지합니다.');
  return compactCatalogNotice({ ...notice, sourceUpdatedAt, regionComplete: false, licenseComplete: false });
}

/** Mirror the database source projection; condition/status enrichment is separate. */
function sourceProjection(notice: AlertNotice) {
  const excluded = new Set(['allowedRegions', 'licenses', 'licenseCodes', 'regionComplete', 'licenseComplete', 'openingCompleted', 'status', 'description', 'documents', 'requirements', 'duration', 'regionSearchText']);
  return JSON.stringify(Object.fromEntries(Object.entries(notice).filter(([key, value]) => !excluded.has(key) && value !== undefined).sort(([a], [b]) => a.localeCompare(b))));
}

function validPage(items: Row[], total: number, page: number, size: number) {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1) {
    throw new Error('나라장터 전체 건수와 조회 페이지를 확인하지 못했습니다.');
  }
  const offset = (page - 1) * size;
  if ((total > 0 && offset >= total) || items.length !== Math.min(size, Math.max(0, total - offset))) {
    throw new Error('나라장터 목록의 전체 건수와 페이지가 일치하지 않아 확인 범위를 유지합니다.');
  }
}

async function parallel<T>(items: T[], work: (item: T) => Promise<void>) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (index < items.length) await work(items[index++]);
  }));
}

/** Unknown participant facts remain candidates until the exact conditions are fetched. */
export function potentialCatalogRules(notice: AlertNotice, rules: WorkerRule[], now: number) {
  return rules.filter(rule => matchAlarmNotice(notice,
    { ...rule.settings, filter: { ...rule.settings.filter, includeUnknown: true,
      // A matching name can still exist only in the unfetched participant rows.
      ...(!notice.regionComplete ? { regions: [], useCompanyRegion: false } : {}),
    } }, rule.profile, now).matched);
}

async function participantConditions(notice: AlertNotice, request: ActiveCatalogProvider): Promise<AlertNotice> {
  const region = !notice.regionComplete, license = !notice.licenseComplete || !Array.isArray(notice.licenseCodes);
  const exact = { inqryDiv: '2', bidNtceNo: notice.number, bidNtceOrd: notice.revision };
  const load = async (operation: string, field: string): Promise<Row[]> => {
    const rows: Row[] = []; let total: number | undefined;
    // A single condition response can exceed 999 rows. Do not call it complete until every page arrives.
    for (let page = 1; page <= 12; page++) {
      const response = await request(operation, { ...exact, pageNo: String(page), numOfRows: '999' });
      if (total !== undefined && total !== response.totalCount) throw new Error('조회 도중 공고 참가조건의 전체 건수가 바뀌어 다시 확인합니다.');
      total = response.totalCount;
      validPage(response.items, total, page, 999);
      if (response.items.some(row => str(row.bidNtceNo) !== notice.number
        || !/^\d{1,3}$/.test(str(row.bidNtceOrd)) || str(row.bidNtceOrd).padStart(3, '0') !== notice.revision
        || str(row.bsnsDivNm) && str(row.bsnsDivNm) !== notice.type || !str(row[field]))) {
        throw new Error('공고 참가조건의 번호·차수 또는 항목을 확인하지 못했습니다.');
      }
      rows.push(...response.items);
      if (rows.length === total) return rows;
    }
    throw new Error('공고 참가조건을 모두 확인하지 못해 다음 확인 때 다시 시도합니다.');
  };
  // At most one provider call per verification lane: source and condition work share the four-call cap.
  let enriched = notice;
  const prefix = notice.procurementSource === 'private' ? 'getPrvtBidPblancListInfo' : 'getBidPblancListInfo';
  if (region) {
    const regions = [...new Set((await load(`${prefix}PrtcptPsblRgn`, 'prtcptPsblRgnNm')).map(row => str(row.prtcptPsblRgnNm)))];
    enriched = { ...enriched, allowedRegions: regions.length || notice.procurementSource !== 'private' ? regions : null, regionComplete: true };
  }
  if (license) {
    const rows = await load(`${prefix}LicenseLimit`, 'lcnsLmtNm');
    enriched = { ...enriched, licenses: [...new Set(rows.map(row => str(row.lcnsLmtNm)))], licenseCodes: noticeLicenseCodes(rows), licenseComplete: true };
  }
  return compactCatalogNotice(enriched);
}

/** Reuse only completed condition facts from the exact unchanged source version. */
function reuseParticipantConditions(notice: AlertNotice, cached?: AlertNotice): AlertNotice {
  if (!cached || cached.number !== notice.number || cached.type !== notice.type || cached.revision !== notice.revision
    || cached.sourceUpdatedAt !== notice.sourceUpdatedAt || cached.sourceOmittedDigest !== notice.sourceOmittedDigest
    || cached.regionSearchDigest !== notice.regionSearchDigest) return notice;
  const sourceKey = (value: AlertNotice) => noticeContentKey({ ...value, allowedRegions: null, licenses: [], licenseCodes: undefined });
  if (sourceKey(cached) !== sourceKey(notice)) return notice;
  const names = (values: unknown): values is string[] => Array.isArray(values) && values.every(value => typeof value === 'string' && Boolean(value.trim()));
  return compactCatalogNotice({ ...notice,
    ...(cached.regionComplete && (cached.allowedRegions === null || names(cached.allowedRegions))
      ? { allowedRegions: cached.allowedRegions, regionComplete: true } : {}),
    ...(cached.licenseComplete && names(cached.licenses) && Array.isArray(cached.licenseCodes)
      ? { licenses: cached.licenses, licenseCodes: cached.licenseCodes, licenseComplete: true } : {}),
  });
}

/** Discover live and current notices, drain their verification, and defer historical backlog. */
export async function runActiveCatalogWorker(store: ActiveCatalogStore, options: {
  provider?: ActiveCatalogProvider; now?: number; maxRequests?: number; budgetMs?: number; clock?: () => number;
} = {}) {
  const clock = options.clock ?? Date.now, now = options.now ?? clock();
  const deadline = clock() + Math.min(43_000, Math.max(1_000, options.budgetMs ?? 43_000));
  const maximum = Math.min(40, Math.max(0, options.maxRequests ?? 40));
  // Reserve one store commit and lease release (each RPC has an 8s timeout).
  const provider = options.provider ?? createActiveCatalogProvider(undefined, undefined, { deadline, clock });
  let requests = 0, sources = 0, groups = 0, versions = 0, searchGroups = 0, reconciledGroups = 0;
  const deferredIdentities = new Set<string>();
  const warnings: string[] = [];
  const claim = await store.claim();
  if (!claim.leaseId) return { ok: true, skipped: true, sources, groups, versions, requests };
  const leaseId = claim.leaseId;
  const rules = (claim.rules ?? []).filter(rule => rule.settings.enabled);
  // Every protected mutation locks the same database runtime row. Keep source
  // and verification provider calls parallel, but avoid competing RPC writes
  // inside this invocation. A failed write must not poison later queued work.
  let writeTail = Promise.resolve();
  const write = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = writeTail.then(operation);
    writeTail = pending.then(() => undefined, () => undefined);
    return pending;
  };
  let quotaFailure: ProviderQuotaError | undefined;
  let restartRequired = false;
  let activeRequests = 0;
  const requestWaiters: (() => void)[] = [];
  const acquireRequest = async () => {
    if (activeRequests < 4) { activeRequests++; return; }
    await new Promise<void>(resolve => requestWaiters.push(resolve));
  };
  const releaseRequest = () => {
    const next = requestWaiters.shift();
    if (next) next(); else activeRequests--;
  };
  const request: ActiveCatalogProvider = async (operation, params, service) => {
    await acquireRequest();
    try {
      // Opening summaries fan out into two requests; all work shares this global cap.
      if (quotaFailure) throw quotaFailure;
      if (restartRequired || clock() > deadline - 10_000 || requests >= maximum) throw new WorkerBudgetExhausted('나라장터 조회 시간 또는 호출 예산에 도달하여 다음 확인 때 이어서 수집합니다.');
      requests++;
      try { return await (service ? provider(operation, params, service) : provider(operation, params)); }
      catch (error) { if (error instanceof ProviderQuotaError) quotaFailure = error; throw error; }
    } finally { releaseRequest(); }
  };
  const openingSummary = createOpeningSummaryLoader((_base, operation, params) => request(operation, params, { service: 'opening' }), clock);
  const commit = async (payload: ActiveCatalogCommit) => {
    if (Buffer.byteLength(JSON.stringify(payload)) > 2_800_000) throw new Error('공고 한 구간의 저장 응답이 너무 커서 확인 범위를 유지합니다.');
    const result = await write(() => store.commit(leaseId, payload));
    if (result.storageFull) throw new Error('전체 공고 저장 한도에 도달하여 수집을 대기합니다. 기존 공고와 알림은 보존됩니다.');
    if (!result.ok) throw new Error('전체 공고 저장을 확인하지 못했습니다. 확인 범위를 유지합니다.');
    if (result.restartRequired) restartRequired = true;
    return result;
  };
  const groupPayload: ActiveCatalogCommit = { scopeVersion: claim.scopeVersion, groups: [], rejectedGroups: [], failedGroups: [] };
  const flushGroups = async () => {
    if (!groupPayload.failedGroups!.length && !groupPayload.rejectedGroups!.length) return;
    const payload = { ...groupPayload, failedGroups: [...groupPayload.failedGroups!], rejectedGroups: [...groupPayload.rejectedGroups!] };
    groupPayload.failedGroups = []; groupPayload.rejectedGroups = [];
    warnings.push(...payload.failedGroups.filter(item => !deferredIdentities.has(`${item.type}:${item.number}`)).map(item => item.error));
    // Failed retry/acknowledgment writes leave these identities queued. Other
    // claimed identities still get their own checked, bounded storage requests.
    try { await commit(payload); } catch (error) { warnings.push(safeError(error)); }
  };
  const completeHistory = async (identity: ActiveCatalogIdentity) => {
      let total: number | undefined;
      const all: AlertNotice[] = [];
      for (let page = 1; page <= 2; page++) {
        const privateSource = (identity.procurementSource ?? identity.notice?.procurementSource) === 'private';
        const result = await request(privateSource ? privateNoticeOperation(identity.type) : `getBidPblancListInfo${identity.type === '공사' ? 'Cnstwk' : 'Servc'}`,
          { inqryDiv: privateSource ? PRIVATE_NOTICE_DIVISIONS.number : '2', bidNtceNo: identity.number, pageNo: String(page), numOfRows: '999' });
        if (total !== undefined && total !== result.totalCount) throw new Error('조회 도중 공고 차수의 전체 건수가 바뀌어 다시 확인합니다.');
        total = result.totalCount;
        if (!total || total > 1000) throw new Error('공고 차수 이력을 모두 확인하지 못해 다시 확인합니다.');
        validPage(result.items, total, page, 999);
        const items = result.items.map(row => fact(row, identity.type, now, identity.procurementSource ?? identity.notice?.procurementSource));
        if (items.some(item => item.number !== identity.number)) throw new Error('공고 번호와 차수 응답이 일치하지 않아 다시 확인합니다.');
        all.push(...items);
        if (all.length === total) break;
      }
      if (all.length !== total || new Set(all.map(item => item.revision)).size !== all.length) throw new Error('공고 차수 이력이 누락되거나 중복되어 다시 확인합니다.');
      all.sort((a, b) => Number(a.revision) - Number(b.revision));
      const latest = all.at(-1)!;
      if (identity.revision !== undefined && (!/^\d{1,3}$/.test(identity.revision)
        || Number(latest.revision) < Number(identity.revision)
        || Number(latest.revision) === Number(identity.revision) && identity.sourceUpdatedAt
          && Date.parse(latest.sourceUpdatedAt) < Date.parse(identity.sourceUpdatedAt))) {
        throw new Error('공고 전체 이력이 이미 확인한 변경·취소 정보보다 오래되어 다시 확인합니다.');
      }
      return all;
  };
  const verifyIdentity = async (identity: ActiveCatalogIdentity) => {
    try {
      let all = await completeHistory(identity);
      const latest = all.at(-1)!;
      let checked = identity.refreshMatching ? latest : reuseParticipantConditions(latest, identity.notice);
      if (checked.procurementSource !== 'private' && isOngoingNotice(checked, now) && noticeTimestamp(checked.deadline) <= now && noticeTimestamp(checked.openingAt) > now) {
        const completion = await openingSummary({ number: checked.number, revision: checked.revision, type: checked.type });
        if (!(completion.openingComplete ?? completion.complete)) {
          if (quotaFailure) throw quotaFailure;
          if (requests >= maximum || clock() > deadline - 10_000) throw new WorkerBudgetExhausted();
          throw new Error('공고 개찰 상태를 모두 확인하지 못해 다음 확인 때 다시 시도합니다.');
        }
        if (/^(?:개찰\s*완료|유찰)$/.test(completion.result.trim())) checked = { ...checked, openingCompleted: true };
      }
      if (isCatalogNotice(checked, now)) checked = await participantConditions(checked, request);
      all[all.length - 1] = checked;
      // Public publication never keeps historical bodies or consumes the private queue.
      // Only after it succeeds may private retention acknowledge the verification job.
      const payload = { scopeVersion: claim.scopeVersion, groups: [all] };
      if (Buffer.byteLength(JSON.stringify(payload)) > 2_800_000) throw new Error('공고 차수의 저장 응답이 너무 커서 확인 범위를 유지합니다.');
      let published = await write(() => store.publishSearchVerified(leaseId, payload));
      if (!published.ok && published.retryRequired === true && published.reason === 'source_changed') {
        const indexed = published.indexedHead;
        // A same-clock attachment change can leave an old hash permanently queued.
        // Require two newly fetched official views to agree, then let the SQL CAS
        // validate the unchanged indexed/lease-owned version atomically.
        if (published.conflict === 'same_clock_content' && published.changedFields?.length === 1
          && published.changedFields[0] === 'sourceOmittedDigest' && /^[a-f0-9]{64}$/.test(published.sourceVersion ?? '')
          && indexed?.type === checked.type && indexed.number === checked.number && indexed.revision === checked.revision
          && Date.parse(indexed.sourceUpdatedAt) === Date.parse(checked.sourceUpdatedAt)) {
          try {
            const listing = await request(checked.procurementSource === 'private' ? privateNoticeOperation(identity.type) : `getBidPblancListInfo${identity.type === '공사' ? 'Cnstwk' : 'Servc'}`, {
              inqryDiv: checked.procurementSource === 'private' ? PRIVATE_NOTICE_DIVISIONS.posted : '1', inqryBgnDt: minuteKst(checked.postedAt),
              inqryEndDt: minuteKst(new Date(Date.parse(checked.postedAt) + 60_000).toISOString()), pageNo: '1', numOfRows: '999',
            });
            validPage(listing.items, listing.totalCount, 1, 999);
            if (listing.totalCount > 999) throw new SourcePublicationDeferred();
            const targets = listing.items.filter(row => str(row.bidNtceNo) === checked.number
              && str(row.bidNtceOrd).padStart(3, '0') === checked.revision).map(row => fact(row, identity.type, now, checked.procurementSource));
            if (targets.length !== 1 || sourceProjection(targets[0]) !== sourceProjection(checked)) throw new SourcePublicationDeferred();
            const refreshed = await completeHistory(identity);
            if (sourceProjection(refreshed.at(-1)!) !== sourceProjection(checked)) throw new SourcePublicationDeferred();
            // Enriched participant conditions belong to these exact same source facts.
            refreshed[refreshed.length - 1] = checked;
            published = await write(() => store.publishSearchVerified(leaseId, { ...payload, groups: [refreshed], expectedSourceVersion: published.sourceVersion }));
            if (published.ok) { all = refreshed; reconciledGroups++; }
          } catch (error) {
            if (error instanceof WorkerBudgetExhausted) throw new SourcePublicationDeferred();
            throw error;
          }
        }
        if (!published.ok && published.retryRequired === true && published.reason === 'source_changed') throw new SourcePublicationDeferred();
      }
      if (published.storageFull) throw new Error('전체 공고 저장 한도에 도달하여 수집을 대기합니다. 기존 공고와 알림은 보존됩니다.');
      if (!published.ok) throw new Error('공고 검색 색인 저장을 확인하지 못했습니다. 확인 범위를 유지합니다.');
      searchGroups++;
      const matched = potentialCatalogRules(checked, rules, now).some(rule => matchAlarmNotice(checked, rule.settings, rule.profile, now).matched);
      if (matched || identity.tracked) {
        await commit({ scopeVersion: claim.scopeVersion, groups: [all], refreshMatching: matched });
        groups++; versions += all.length;
      } else groupPayload.rejectedGroups!.push({ type: identity.type, number: identity.number });
    } catch (error) {
      if (error instanceof SourcePublicationDeferred) deferredIdentities.add(`${identity.type}:${identity.number}`);
      if (!(error instanceof WorkerBudgetExhausted)) groupPayload.failedGroups!.push({ type: identity.type, number: identity.number, error: safeError(error) });
    }
  };
  try {
    if (!claim.scopeVersion) throw new Error('공고 알림 조건의 수집 범위를 확인하지 못했습니다.');
    const failedSources: NonNullable<ActiveCatalogCommit['failedSources']> = [];
    // The public deadline index is shared across search and alerts. Its source
    // coverage must never depend on whether an individual has enabled alerts.
    const liveSources = claim.sources.filter(job => job.kind === 'registered' || job.kind === 'modified');
    const currentSources = claim.sources.filter(job => job.kind === 'current')
      .sort((a, b) => Date.parse(b.from) - Date.parse(a.from));
    const historySources = claim.sources.filter(job => job.kind === 'history')
      .sort((a, b) => Date.parse(b.from) - Date.parse(a.from));
    const discoverSources = async (jobs: ActiveCatalogSourceJob[]) => parallel(jobs, async (job: ActiveCatalogSourceJob) => {
      try {
        const suffix = job.type === '공사' ? 'Cnstwk' : 'Servc';
        const privateSource = job.procurementSource === 'private';
        const search = job.kind === 'history' || job.kind === 'current';
        const params: Record<string, string> = {
          inqryDiv: privateSource ? search ? '1' : job.kind === 'modified' ? PRIVATE_NOTICE_DIVISIONS.posted : PRIVATE_NOTICE_DIVISIONS.registered : job.kind === 'modified' ? '3' : '1',
          inqryBgnDt: minuteKst(job.from), inqryEndDt: minuteKst(job.to),
          pageNo: String(job.page), numOfRows: String(job.pageSize),
          ...(job.kind === 'current' && !privateSource ? { bidClseExcpYn: 'Y' } : {}),
        };
        const response = await request(privateSource ? privateNoticeOperation(job.type, search) : `getBidPblancListInfo${suffix}${search ? 'PPSSrch' : ''}`, params);
        if (job.totalCount !== null && job.totalCount !== response.totalCount) throw new SourceSnapshotChanged('조회 도중 전체 건수가 바뀌어 확인 범위를 다시 수집합니다.');
        validPage(response.items, response.totalCount, job.page, job.pageSize);
        const ids = new Set<string>(), observed = new Map<string, ActiveCatalogIdentity>(), items: AlertNotice[] = [];
        const rawIdentities: string[] = [];
        const indexFacts: AlertNotice[] = [];
        for (const row of response.items) {
          const notice = fact(row, job.type, now, job.procurementSource);
          if (ids.has(notice.id)) throw new SourceSnapshotChanged('공고 목록의 차수가 중복되어 확인 범위를 다시 수집합니다.');
          ids.add(notice.id);
          if (job.kind === 'current') rawIdentities.push(`${notice.number}:${notice.revision}`);
          // The current-only sweep completes the four requested work areas
          // first. Unrelated rows are still validated and observed below;
          // omission from this focused index is never a cancellation signal.
          if (job.kind !== 'current' || CURRENT_NOTICE_KEYWORDS.some(keyword => notice.title.normalize('NFKC').includes(keyword))) {
            indexFacts.push(notice);
          }
          const key = `${notice.type}:${notice.number}`, previous = observed.get(key);
          if (!previous || Number(notice.revision) > Number(previous.revision)
            || notice.revision === previous.revision && Date.parse(notice.sourceUpdatedAt) > Date.parse(previous.sourceUpdatedAt!)) {
            observed.set(key, { type: notice.type, number: notice.number, revision: notice.revision, sourceUpdatedAt: notice.sourceUpdatedAt,
              ...(privateSource ? { procurementSource: 'private' as const } : {}) });
          }
          if (potentialCatalogRules(notice, rules, now).length) items.push(notice);
        }
        // Store the small common index in bounded batches before acknowledging
        // the raw page. Closed/cancelled bodies are discarded; their minimal
        // identities can invalidate a previously indexed candidate.
        const batches = Math.max(1, Math.ceil(indexFacts.length / 200));
        for (let batch = 0; batch < batches; batch++) {
          if (clock() > deadline - 9_000) throw new WorkerBudgetExhausted('공고 색인 저장 시간이 부족하여 같은 구간에서 이어서 확인합니다.');
          const slice = indexFacts.slice(batch * 200, (batch + 1) * 200);
          const result = await write(() => store.indexUpsert(leaseId, { scopeVersion: claim.scopeVersion, sourceId: job.id, page: job.page,
            batch, batches, notices: slice.filter(notice => isCatalogNotice(notice, now)),
            removed: slice.filter(notice => !isCatalogNotice(notice, now)).map(notice => ({ type: notice.type,
              number: notice.number, revision: notice.revision, sourceUpdatedAt: notice.sourceUpdatedAt })) }));
          if (result.storageFull) {
            throw new Error('전체 공고 저장 한도에 도달하여 수집을 대기합니다. 기존 공고와 알림은 보존됩니다.');
          }
          if (!result.ok) throw new Error('공고 색인 저장을 확인하지 못했습니다. 확인 범위를 유지합니다.');
        }
        // Personal candidates and public verification work are kept separately.
        // Index batches remain unverified until the complete history is published.
        const completed = { id: job.id, page: job.page, totalCount: response.totalCount,
          receivedCount: response.items.length, observed: [...observed.values()], items,
          ...(job.kind === 'current' ? { rawIdentities } : {}),
          complete: (job.page - 1) * job.pageSize + response.items.length === response.totalCount };
        const stored = await commit({ scopeVersion: claim.scopeVersion, sources: [completed] });
        if (stored.restartRequired) warnings.push('공고 조회 순서가 바뀌어 해당 구간을 처음부터 다시 확인합니다.');
        else sources++;
      } catch (error) { if (!(error instanceof WorkerBudgetExhausted)) failedSources.push({ id: job.id, error: safeError(error), ...(error instanceof SourceSnapshotChanged ? { restart: true } : {}) }); }
    });
    // Every due live registration/modification window precedes the backlog.
    await discoverSources(liveSources);
    // Give urgent identities a first pass, then discover current candidates
    // before draining the rest. Both stages share the same request/time cap.
    await parallel(claim.verify.slice(0, 4), verifyIdentity);
    await flushGroups();
    await discoverSources(currentSources);
    await parallel(claim.verify.slice(4), verifyIdentity);
    await flushGroups();
    // A finished claim is only a bounded slice of the pending queue. Do not
    // infer current completeness from it or start historical work while any
    // current sweep, live catch-up, or current verification is unfinished.
    const currentCoverage = claim.status?.currentCoverage;
    if (claim.verify.length === 0 && currentSources.length === 0 && (!currentCoverage || currentCoverage.complete)) {
      await discoverSources(historySources.slice(0, 2));
    }
    if (failedSources.length) {
      warnings.push(...failedSources.map(item => item.error));
      // Discovery failure cannot acknowledge its source page or prevent an
      // unrelated verified head from fitting within the unchanged storage caps.
      // Accelerated current claims can contain 32 sources plus live streams;
      // the existing retry RPC still accepts at most 16 entries per array.
      for (let offset = 0; offset < failedSources.length; offset += 16) {
        try { await commit({ scopeVersion: claim.scopeVersion, sources: [], failedSources: failedSources.slice(offset, offset + 16) }); }
        catch (error) { warnings.push(safeError(error)); }
      }
    }
  } catch (error) { warnings.push(safeError(error)); }
  const uniqueWarnings = [...new Set(warnings)];
  try { await write(() => store.finish(leaseId, { ...(uniqueWarnings.length ? { error: uniqueWarnings[0] } : {}),
    ...(quotaFailure?.retryAfterSeconds ? { retryAfterSeconds: quotaFailure.retryAfterSeconds } : {}) })); }
  catch (error) { uniqueWarnings.push(safeError(error)); }
  return { ok: uniqueWarnings.length === 0, sources, groups, versions, searchGroups, reconciledGroups, deferredGroups: deferredIdentities.size, requests, ...(restartRequired ? { restartRequired: true } : {}),
    ...(uniqueWarnings.length ? { error: uniqueWarnings[0], warnings: uniqueWarnings } : {}) };
}
