import { AlertError } from './alert-store.ts';
import type { AlertNotice } from '../src/alerts/types.ts';
import type { ActiveCatalogClaim, ActiveCatalogCommit, ActiveCatalogPage, ActiveCatalogPageQuery, DeadlineCatalogPage, DeadlineCatalogQuery, DeadlineIndexBatch, SearchVerifiedBatch, SearchPublicationResult, VerifiedNoticeSearchPage, VerifiedNoticeSearchQuery, VerifiedNoticeSearchResults, VerifiedNoticeSearchStatus, VerifiedNoticeSearchStatusQuery } from '../src/live/active-catalog-types.ts';

/** Server-only catalog access. The shared worker token never reaches browser clients. */
export function createActiveCatalogStore(options: { url?: string; key?: string; token?: string; fetcher?: typeof fetch } = {}) {
  const url = options.url ?? process.env.VITE_SUPABASE_URL;
  const key = options.key ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  const token = options.token ?? process.env.ALERT_WORKER_TOKEN;
  const fetcher = options.fetcher ?? fetch;
  let deadline = Number.POSITIVE_INFINITY;
  async function rpc<T>(action: string, payload: unknown = {}): Promise<T> {
    if (!url || !key || !token || key.startsWith('sb_secret_')) throw new AlertError(503, 'CATALOG_NOT_CONFIGURED', '전체 공고 수집 저장소 설정을 확인해 주세요.');
    if (key.split('.').length === 3) {
      try { if (JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role !== 'anon') throw new Error(); }
      catch { throw new AlertError(503, 'CATALOG_NOT_CONFIGURED', '전체 공고 수집 저장소 설정을 확인해 주세요.'); }
    }
    let response: Response;
    try {
      const remaining = deadline - Date.now();
      if (remaining < 100) throw new Error('Storage deadline reached');
      response = await fetcher(new URL('/rest/v1/rpc/bid_active_catalog_worker', url), {
        method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_token: token, p_action: action, p_payload: payload }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(8_000, Math.floor(remaining)))), cache: 'no-store', redirect: 'error',
      });
    } catch { throw new AlertError(503, 'CATALOG_STORAGE_UNAVAILABLE', '전체 공고 저장소에 연결하지 못했습니다. 잠시 후 다시 조회해 주세요.'); }
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { code?: string; message?: string };
      if (error.message === 'SEARCH_CHANGED') throw new AlertError(409, 'SEARCH_CHANGED', '공고가 갱신되었습니다. 누락 없이 확인하려면 처음부터 다시 검색해 주세요.');
      if (['search_page', 'search_results', 'search_status'].includes(action) && error.code === '22023') throw new AlertError(400, 'INVALID_SEARCH_QUERY', '검색 조건이나 다음 페이지 정보를 확인해 주세요.');
      throw new AlertError(503, 'CATALOG_STORAGE_ERROR', '전체 공고 저장소 요청을 처리하지 못했습니다. 확인 범위는 유지됩니다.');
    }
    return await response.json() as T;
  }
  return {
    setDeadline: (absoluteDeadline: number) => { deadline = absoluteDeadline; },
    claim: (_options: { force?: boolean } = {}) => rpc<ActiveCatalogClaim>('claim'),
    commit: (leaseId: string, payload: ActiveCatalogCommit) => rpc<{ ok: boolean; storageFull?: boolean; restartRequired?: boolean }>('commit', { leaseId, ...payload }),
    finish: (leaseId: string, payload: { error?: string; retryAfterSeconds?: number } = {}) => rpc<{ ok: boolean }>('finish', { leaseId, ...payload }),
    page: (query: ActiveCatalogPageQuery = {}) => rpc<ActiveCatalogPage>('page', query),
    alarmPage: (query: ActiveCatalogPageQuery = {}) => rpc<ActiveCatalogPage>('alarm_page', query),
    deadlinePage: (query: DeadlineCatalogQuery) => rpc<DeadlineCatalogPage>('deadline_page', query),
    searchPage: (query: VerifiedNoticeSearchQuery) => rpc<VerifiedNoticeSearchPage>('search_page', query),
    searchResults: (query: VerifiedNoticeSearchQuery) => rpc<VerifiedNoticeSearchResults>('search_results', query),
    searchStatus: (query: VerifiedNoticeSearchStatusQuery) => rpc<VerifiedNoticeSearchStatus>('search_status', query),
    publishSearchVerified: (leaseId: string, batch: SearchVerifiedBatch) => rpc<SearchPublicationResult>('search_publish', {leaseId, ...batch}),
    indexUpsert: (leaseId: string, batch: DeadlineIndexBatch) => rpc<{ ok: boolean; storageFull?: boolean }>('index_upsert', { leaseId, ...batch }),
    publishVerified: (notices: AlertNotice[]) => rpc<{ ok: boolean; storageFull?: boolean }>('publish_verified', { notices }),
    enrich: (notice: AlertNotice) => rpc<{ ok: boolean }>('enrich', { notice }),
  };
}
export type ActiveCatalogStore = ReturnType<typeof createActiveCatalogStore>;

/** Public facts only. Source checkpoints and worker credentials stay server-side. */
export async function readDeadlineCatalog(query: DeadlineCatalogQuery, store = createActiveCatalogStore()): Promise<DeadlineCatalogPage> {
  return store.deadlinePage(query);
}

export async function readVerifiedNoticeSearch(query: VerifiedNoticeSearchQuery, store = createActiveCatalogStore()): Promise<VerifiedNoticeSearchPage> {
  return store.searchPage(query);
}

export async function readVerifiedNoticeSearchResults(query: VerifiedNoticeSearchQuery, store = createActiveCatalogStore()): Promise<VerifiedNoticeSearchResults> {
  return store.searchResults(query);
}

export async function readVerifiedNoticeSearchStatus(query: VerifiedNoticeSearchStatusQuery, store = createActiveCatalogStore()): Promise<VerifiedNoticeSearchStatus> {
  return store.searchStatus(query);
}
