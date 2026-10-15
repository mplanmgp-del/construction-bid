import { createHash } from 'node:crypto';
import { koreanTimestamp, mapNotice, readProviderPayload } from './g2b.ts';
import { ProviderQuotaError, providerRetryAfter } from './provider-quota.ts';
import { matchAlarmNotice, noticeOmittedContentKey } from '../src/alerts/domain.ts';
import { isOngoingNotice } from '../src/notice-deadline-window.ts';
import type { ActiveCatalogStore } from './active-catalog-store.ts';
import type { ActiveCatalogCommit, ActiveCatalogIdentity, ActiveCatalogSourceJob } from '../src/live/active-catalog-types.ts';
import type { AlertNotice, WorkerRule } from '../src/alerts/types.ts';

type Row = Record<string, unknown>;
class SourceSnapshotChanged extends Error {}
class WorkerBudgetExhausted extends Error {}
export type ActiveCatalogProvider = (operation: string, params: Record<string, string>) => Promise<{ items: Row[]; totalCount: number }>;
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
  return { ...notice, sourceOmittedDigest, description: '', documents: [], requirements: [], duration: '' };
}

export function createActiveCatalogProvider(
  key = process.env.G2B_SERVICE_KEY,
  fetcher: typeof fetch = fetch,
  options: { deadline?: number; clock?: () => number } = {},
): ActiveCatalogProvider {
  const clock = options.clock ?? Date.now;
  return async (operation, params) => {
    if (!key?.trim()) throw new Error('나라장터 인증키가 설정되지 않았습니다.');
    const remaining = (options.deadline ?? clock() + 20_000) - clock() - 8_000;
    if (remaining < 1_000) throw new WorkerBudgetExhausted('나라장터 조회 시간이 부족하여 다음 확인 때 이어서 수집합니다.');
    let decoded = key.trim();
    try { if (decoded.includes('%')) decoded = decodeURIComponent(decoded); }
    catch { throw new Error('나라장터 인증키 형식을 확인해 주세요.'); }
    const url = new URL(operation, 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService/');
    url.search = new URLSearchParams({ ...params, serviceKey: decoded, type: 'json' }).toString();
    let response: Response;
    try {
      response = await fetcher(url, { signal: AbortSignal.timeout(Math.min(12_000, remaining)), redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
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

function fact(row: Row, type: ActiveCatalogIdentity['type'], now: number): AlertNotice {
  const number = str(row.bidNtceNo), revision = str(row.bidNtceOrd);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(number) || !/^\d{1,3}$/.test(revision)
    || (str(row.bsnsDivNm) && str(row.bsnsDivNm) !== type)) {
    throw new Error('공고 식별정보가 불완전하여 확인 범위를 유지합니다.');
  }
  const notice = mapNotice(row, type, now);
  const sourceUpdatedAt = koreanTimestamp(row.chgDt) || koreanTimestamp(row.rgstDt) || notice.postedAt;
  if (!notice.postedAt || !sourceUpdatedAt) throw new Error('공고 일시가 불완전하여 확인 범위를 유지합니다.');
  return compactCatalogNotice({ ...notice, sourceUpdatedAt, regionComplete: false, licenseComplete: false });
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
function potentialRules(notice: AlertNotice, rules: WorkerRule[], now: number) {
  return rules.filter(rule => matchAlarmNotice(notice,
    { ...rule.settings, filter: { ...rule.settings.filter, includeUnknown: true } }, rule.profile, now).matched);
}

async function participantConditions(notice: AlertNotice, rules: WorkerRule[], request: ActiveCatalogProvider): Promise<AlertNotice> {
  let region = false, license = false;
  for (const rule of rules) {
    const filter = rule.settings.filter, basis = filter.regionBasis ?? 'auto';
    region ||= !notice.regionComplete && (filter.useCompanyRegion || filter.regions.length > 0
      && (basis === 'participation' || basis === 'either' || basis === 'both' || basis === 'auto' && notice.type === '용역'));
    license ||= !notice.licenseComplete && (filter.licenses.length > 0 || filter.useCompanyLicenses === true);
  }
  const exact = { inqryDiv: '2', bidNtceNo: notice.number, bidNtceOrd: notice.revision };
  const load = async (operation: string, field: string): Promise<string[]> => {
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
      if (rows.length === total) return [...new Set(rows.map(row => str(row[field])))];
    }
    throw new Error('공고 참가조건을 모두 확인하지 못해 다음 확인 때 다시 시도합니다.');
  };
  // At most one provider call per verification lane: source and condition work share the four-call cap.
  let enriched = notice;
  if (region) enriched = { ...enriched, allowedRegions: await load('getBidPblancListInfoPrtcptPsblRgn', 'prtcptPsblRgnNm'), regionComplete: true };
  if (license) enriched = { ...enriched, licenses: await load('getBidPblancListInfoLicenseLimit', 'lcnsLmtNm'), licenseComplete: true };
  return enriched;
}

/** One durable claim; independent live sources finish before historical verification work. */
export async function runActiveCatalogWorker(store: ActiveCatalogStore, options: {
  provider?: ActiveCatalogProvider; now?: number; maxRequests?: number; budgetMs?: number; clock?: () => number;
} = {}) {
  const clock = options.clock ?? Date.now, now = options.now ?? clock();
  const deadline = clock() + Math.min(43_000, Math.max(1_000, options.budgetMs ?? 43_000));
  const maximum = Math.min(40, Math.max(0, options.maxRequests ?? 40));
  // Reserve one store commit and lease release (each RPC has an 8s timeout).
  const provider = options.provider ?? createActiveCatalogProvider(undefined, undefined, { deadline: deadline - 8_000, clock });
  let requests = 0, sources = 0, groups = 0, versions = 0;
  const warnings: string[] = [];
  const claim = await store.claim();
  if (!claim.leaseId) return { ok: true, skipped: true, sources, groups, versions, requests };
  const leaseId = claim.leaseId;
  const rules = (claim.rules ?? []).filter(rule => rule.settings.enabled);
  let quotaFailure: ProviderQuotaError | undefined;
  let storageFailure: unknown;
  let restartRequired = false;
  const request: ActiveCatalogProvider = async (operation, params) => {
    if (storageFailure) throw storageFailure;
    if (quotaFailure) throw quotaFailure;
    if (restartRequired || clock() > deadline - 17_000 || requests >= maximum) throw new WorkerBudgetExhausted('나라장터 조회 시간 또는 호출 예산에 도달하여 다음 확인 때 이어서 수집합니다.');
    requests++;
    try { return await provider(operation, params); }
    catch (error) { if (error instanceof ProviderQuotaError) quotaFailure = error; throw error; }
  };
  const commit = async (payload: ActiveCatalogCommit) => {
    if (storageFailure) throw storageFailure;
    try {
      if (Buffer.byteLength(JSON.stringify(payload)) > 2_800_000) throw new Error('공고 한 구간의 저장 응답이 너무 커서 확인 범위를 유지합니다.');
      const result = await store.commit(leaseId, payload);
      if (result.storageFull) throw new Error('전체 공고 저장 한도에 도달하여 수집을 대기합니다. 기존 공고와 알림은 보존됩니다.');
      if (!result.ok) throw new Error('전체 공고 저장을 확인하지 못했습니다. 확인 범위를 유지합니다.');
      if (result.restartRequired) restartRequired = true;
      return result;
    } catch (error) { storageFailure = error; throw error; }
  };
  try {
    if (!claim.scopeVersion) throw new Error('공고 알림 조건의 수집 범위를 확인하지 못했습니다.');
    const failedSources: NonNullable<ActiveCatalogCommit['failedSources']> = [];
    // The public deadline index is shared across search and alerts. Its source
    // coverage must never depend on whether an individual has enabled alerts.
    const jobs = [...claim.sources].sort((a, b) => Number(a.kind === 'history') - Number(b.kind === 'history'));
    await parallel(jobs, async (job: ActiveCatalogSourceJob) => {
      try {
        const suffix = job.type === '공사' ? 'Cnstwk' : 'Servc';
        const params: Record<string, string> = {
          inqryDiv: job.kind === 'modified' ? '3' : '1', inqryBgnDt: minuteKst(job.from), inqryEndDt: minuteKst(job.to),
          pageNo: String(job.page), numOfRows: String(job.pageSize),
        };
        const response = await request(`getBidPblancListInfo${suffix}${job.kind === 'history' ? 'PPSSrch' : ''}`, params);
        if (job.totalCount !== null && job.totalCount !== response.totalCount) throw new SourceSnapshotChanged('조회 도중 전체 건수가 바뀌어 확인 범위를 다시 수집합니다.');
        validPage(response.items, response.totalCount, job.page, job.pageSize);
        const ids = new Set<string>(), observed = new Map<string, ActiveCatalogIdentity>(), items: AlertNotice[] = [];
        const indexFacts: AlertNotice[] = [];
        for (const row of response.items) {
          const notice = fact(row, job.type, now);
          if (ids.has(notice.id)) throw new SourceSnapshotChanged('공고 목록의 차수가 중복되어 확인 범위를 다시 수집합니다.');
          ids.add(notice.id);
          indexFacts.push(notice);
          const key = `${notice.type}:${notice.number}`, previous = observed.get(key);
          if (!previous || Number(notice.revision) > Number(previous.revision)
            || notice.revision === previous.revision && Date.parse(notice.sourceUpdatedAt) > Date.parse(previous.sourceUpdatedAt!)) {
            observed.set(key, { type: notice.type, number: notice.number, revision: notice.revision, sourceUpdatedAt: notice.sourceUpdatedAt });
          }
          if (potentialRules(notice, rules, now).length) items.push(notice);
        }
        // Store the small common index in bounded batches before acknowledging
        // the raw page. Closed/cancelled bodies are discarded; their minimal
        // identities can invalidate a previously indexed candidate.
        const batches = Math.max(1, Math.ceil(indexFacts.length / 200));
        for (let batch = 0; batch < batches; batch++) {
          if (clock() > deadline - 9_000) throw new WorkerBudgetExhausted('공고 색인 저장 시간이 부족하여 같은 구간에서 이어서 확인합니다.');
          const slice = indexFacts.slice(batch * 200, (batch + 1) * 200);
          const result = await store.indexUpsert(leaseId, { scopeVersion: claim.scopeVersion, sourceId: job.id, page: job.page,
            batch, batches, notices: slice.filter(notice => isOngoingNotice(notice, now)),
            removed: slice.filter(notice => !isOngoingNotice(notice, now)).map(notice => ({ type: notice.type,
              number: notice.number, revision: notice.revision, sourceUpdatedAt: notice.sourceUpdatedAt })) });
          if (result.storageFull) {
            storageFailure = new Error('전체 공고 저장 한도에 도달하여 수집을 대기합니다. 기존 공고와 알림은 보존됩니다.');
            throw storageFailure;
          }
          if (!result.ok) throw new Error('공고 색인 저장을 확인하지 못했습니다. 확인 범위를 유지합니다.');
        }
        // Only personal potential matches persist in the revision-verification
        // queue. The independent public index already contains all candidates.
        const completed = { id: job.id, page: job.page, totalCount: response.totalCount,
          receivedCount: response.items.length, observed: [...observed.values()], items,
          complete: (job.page - 1) * job.pageSize + response.items.length === response.totalCount };
        const stored = await commit({ scopeVersion: claim.scopeVersion, sources: [completed] });
        if (stored.restartRequired) warnings.push('공고 조회 순서가 바뀌어 해당 구간을 처음부터 다시 확인합니다.');
        else sources++;
      } catch (error) { if (!(error instanceof WorkerBudgetExhausted)) failedSources.push({ id: job.id, error: safeError(error), ...(error instanceof SourceSnapshotChanged ? { restart: true } : {}) }); }
    });
    if (failedSources.length) {
      warnings.push(...failedSources.map(item => item.error));
      await commit({ scopeVersion: claim.scopeVersion, sources: [], failedSources });
    }

    const groupPayload: ActiveCatalogCommit = { scopeVersion: claim.scopeVersion, groups: [], rejectedGroups: [], failedGroups: [] };
    // Unstarted claims remain pending in SQL; finish releases the shared lease.
    // Do not spend two more store RPCs when the time reserved for them is gone.
    const verify = rules.length && !restartRequired && clock() <= deadline - 17_000 ? claim.verify : [];
    await parallel(verify, async identity => {
      try {
        let total: number | undefined;
        const all: AlertNotice[] = [];
        for (let page = 1; page <= 2; page++) {
          const result = await request(`getBidPblancListInfo${identity.type === '공사' ? 'Cnstwk' : 'Servc'}`, { inqryDiv: '2', bidNtceNo: identity.number, pageNo: String(page), numOfRows: '999' });
          if (total !== undefined && total !== result.totalCount) throw new Error('조회 도중 공고 차수의 전체 건수가 바뀌어 다시 확인합니다.');
          total = result.totalCount;
          if (!total || total > 1000) throw new Error('공고 차수 이력을 모두 확인하지 못해 다시 확인합니다.');
          validPage(result.items, total, page, 999);
          const items = result.items.map(row => fact(row, identity.type, now));
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
        const potential = potentialRules(latest, rules, now);
        const checked = potential.length ? await participantConditions(latest, potential, request) : latest;
        const matched = potential.some(rule => matchAlarmNotice(checked, rule.settings, rule.profile, now).matched);
        if (matched || identity.tracked) {
          all[all.length - 1] = checked;
          await commit({ scopeVersion: claim.scopeVersion, groups: [all] });
          groups++; versions += all.length;
        } else groupPayload.rejectedGroups!.push({ type: identity.type, number: identity.number });
      } catch (error) { if (!(error instanceof WorkerBudgetExhausted)) groupPayload.failedGroups!.push({ type: identity.type, number: identity.number, error: safeError(error) }); }
    });
    if (groupPayload.failedGroups!.length || groupPayload.rejectedGroups!.length) {
      await commit(groupPayload);
      warnings.push(...groupPayload.failedGroups!.map(item => item.error));
    }
  } catch (error) { warnings.push(safeError(error)); }
  const uniqueWarnings = [...new Set(warnings)];
  try { await store.finish(leaseId, { ...(uniqueWarnings.length ? { error: uniqueWarnings[0] } : {}),
    ...(quotaFailure?.retryAfterSeconds ? { retryAfterSeconds: quotaFailure.retryAfterSeconds } : {}) }); }
  catch (error) { uniqueWarnings.push(safeError(error)); }
  return { ok: uniqueWarnings.length === 0, sources, groups, versions, requests, ...(restartRequired ? { restartRequired: true } : {}),
    ...(uniqueWarnings.length ? { error: uniqueWarnings[0], warnings: uniqueWarnings } : {}) };
}
