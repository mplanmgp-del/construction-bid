import { createG2bClient, G2bError, parseSearch } from './g2b.ts';
import { loadPublicSearch } from './public-search-cache.ts';
import { ProviderQuotaError } from './provider-quota.ts';
import { CompanyLookupError } from './g2b-company.ts';
import { OpeningResultsError } from './g2b-results.ts';
import { validateCompanyAwardQuery } from './company-awards.ts';
import type { CompanyAwardQuery } from '../src/company-award-types.ts';
import type { G2bApiError, G2bNoticeRegionsPage } from '../src/g2b-types.ts';

type Client = ReturnType<typeof createG2bClient>;
let currentKey: string | undefined;
let client: Client | undefined;
function serverClient(force = false) {
  const key = process.env.G2B_SERVICE_KEY;
  if (force) return createG2bClient({ serviceKey: key });
  if (!client || key !== currentKey) { currentKey = key; client = createG2bClient({ serviceKey: key }); }
  return client;
}

// MY history is read from the provider on demand, without an archive or a persistent result cache.
export async function handleG2bRequest(path: string, params: URLSearchParams, api: Client = serverClient(path.startsWith('/api/company-') || path === '/api/companies' || params.get('refresh') === '1')): Promise<{ status: number; body: unknown; cacheStatus?: string; retryAfterSeconds?: number }> {
  try {
    if (path === '/api/company-participation') {
      return { status: 200, body: await api.companyParticipation({ businessNumber: (params.get('businessNumber') || '').replace(/[\s-]/g, ''),
        type: params.get('type') as '공사' | '용역', day: params.get('day') || '', page: Number(params.get('page') || '1') }) };
    }
    if (path === '/api/company-contracts') {
      return { status: 200, body: await api.companyContracts({ businessNumber: (params.get('businessNumber') || '').replace(/[\s-]/g, ''),
        type: params.get('type') as '공사' | '용역', from: params.get('from') || '', to: params.get('to') || '', page: Number(params.get('page') || '1') }) };
    }
    if (path === '/api/company-awards') {
      const query: CompanyAwardQuery = { businessNumber: (params.get('businessNumber') || '').replace(/[\s-]/g, ''),
        type: params.get('type') as CompanyAwardQuery['type'], from: params.get('from') || '', to: params.get('to') || '' };
      validateCompanyAwardQuery(query);
      return { status: 200, body: await api.companyAwards(query) };
    }
    if (path === '/api/companies' || path === '/api/company-history') {
      if (path === '/api/company-history') {
        throw new CompanyLookupError(410, 'LIVE_HISTORY_REQUIRED', 'MY입찰관리가 실시간 조회 방식으로 변경되었습니다. 페이지를 새로고침해 주세요.');
      }
      const q = params.get('q')?.trim() || '';
      const bizno = q.replace(/[\s-]/g, '');
      if (/^\d{10}$/.test(bizno)) {
        const result = await api.company(bizno);
        return { status: 200, body: { items: result.company ? [result.company] : [], message: result.warnings.join(' ') } };
      }
      const year = Number(params.get('year') || new Date(Date.now() + 9 * 3600_000).getUTCFullYear());
      const page = Number(params.get('page') || '1');
      return { status: 200, body: await api.companyNames(q, year, page) };
    }
    if (path === '/api/archive-page') {
      const day = params.get('day') || '';
      const query = parseSearch(new URLSearchParams({ type: params.get('type') || '', from: day, to: day, page: params.get('page') || '1' }), 1);
      return { status: 200, body: await api.archivePage({ type: query.type, day, page: query.page }) };
    }
    if (path === '/api/notice-regions') {
      const type = params.get('type');
      const values = (params.get('notices') || '').split(',');
      if ((type !== '공사' && type !== '용역') || values.length > 10 || values.some(value => !/^[a-zA-Z0-9_-]{1,40}:\d{1,3}$/.test(value))) {
        throw new G2bError(400, 'INVALID_QUERY', '지역조건은 공고번호와 차수를 지정하여 최대 10건씩 조회해 주세요.');
      }
      const notices = values.map(value => { const [number, revision] = value.split(':'); return { number, revision: revision.padStart(3, '0') }; });
      if (new Set(notices.map(notice => `${notice.number}:${notice.revision}`)).size !== notices.length) {
        throw new G2bError(400, 'INVALID_QUERY', '중복된 공고번호와 차수가 포함되어 있습니다.');
      }
      const body = await api.noticeRegions(notices, type);
      return { status: 200, body, ...(body.retryAfterSeconds ? { retryAfterSeconds: body.retryAfterSeconds } : {}) };
    }
    if (path === '/api/notices') return { status: 200, body: await api.notices(parseSearch(params)) };
    if (path === '/api/notices-start') {
      const index = params.get('window') ?? '';
      if (!/^[0-3]$/.test(index)) throw new G2bError(400, 'INVALID_QUERY', '조회 구간이 올바르지 않습니다.');
      const query = parseSearch(params);
      if (!query.keyword) throw new G2bError(400, 'KEYWORD_REQUIRED', '철거·석면 등 검색할 공고명을 입력해 주세요.');
      const key = JSON.stringify([query.type, query.from, query.to, query.keyword, Number(index)]);
      const result = await loadPublicSearch(key, () => api.startNotices(query, Number(index)), { force: params.get('refresh') === '1' });
      return { status: 200, body: result.body, cacheStatus: result.status,
        ...(result.body.retryAfterSeconds ? { retryAfterSeconds: result.body.retryAfterSeconds } : {}) };
    }
    if (path === '/api/results') return { status: 200, body: await api.results(parseSearch(params, 7)) };
    if (path === '/api/detail' || path === '/api/related' || path === '/api/result-summary' || path === '/api/opening-results') {
      const number = params.get('number') || '', revision = params.get('revision') || '', type = params.get('type');
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(number) || !/^\d{1,3}$/.test(revision) || (type !== '공사' && type !== '용역')) {
        throw new G2bError(400, 'INVALID_QUERY', '공고번호, 차수, 업무 구분을 확인해 주세요.');
      }
      if (path === '/api/opening-results') return { status: 200, body: await api.openingResults({ number, revision: revision.padStart(3, '0'), type }, { archive: params.get('archive') === '1' }) };
      if (path === '/api/result-summary') {
        const openingAt = params.get('openingAt') || '';
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\+09:00|Z)$/.test(openingAt) || !Number.isFinite(Date.parse(openingAt))) {
          throw new G2bError(400, 'INVALID_QUERY', '개찰 일시를 확인해 주세요.');
        }
        return { status: 200, body: await api.resultSummary(number, revision.padStart(3, '0'), type, openingAt) };
      }
      return { status: 200, body: await (path === '/api/related' ? api.related : api.detail)(number, revision.padStart(3, '0'), type) };
    }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: '존재하지 않는 API입니다.' } } };
  } catch (error) {
    const known = error instanceof G2bError || error instanceof ProviderQuotaError || error instanceof CompanyLookupError || error instanceof OpeningResultsError ? error : new G2bError(500, 'INTERNAL_ERROR', '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    const retryAfterSeconds = known instanceof ProviderQuotaError ? known.retryAfterSeconds : undefined;
    const body: G2bApiError = { error: { code: known.code, message: known.message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } };
    return { status: known.status, body, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
  }
}

export interface NodeRequest { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }
export interface NodeResponse { statusCode: number; setHeader(name: string, value: string): unknown; end(value?: string): unknown }

// A small per-instance burst guard complements upstream quotas and the shared response cache.
const clients = new Map<string, { start: number; count: number }>();
const regionClients = new Map<string, { start: number; count: number }>();
const awardClients = new Map<string, { start: number; count: number }>();
export async function nodeApiHandler(req: NodeRequest, res: NodeResponse) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.statusCode = 405; res.setHeader('Allow', 'GET');
    res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: '조회 요청만 지원합니다.' } })); return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/api/company-data') {
    const companyRoutes: Record<string, string> = { awards: '/api/company-awards', contracts: '/api/company-contracts',
      participation: '/api/company-participation', history: '/api/company-history' };
    url.pathname = companyRoutes[url.searchParams.get('_companyAction') || ''] || url.pathname;
    url.searchParams.delete('_companyAction');
  }
  // Region hydration uses bounded batches and must not consume the search/result allowance.
  const regionBatch = url.pathname === '/api/notice-regions';
  const awardBatch = ['/api/company-awards', '/api/company-participation', '/api/company-contracts', '/api/companies'].includes(url.pathname);
  const buckets = regionBatch ? regionClients : awardBatch ? awardClients : clients;
  const forwarded = req.headers['x-forwarded-for'];
  const address = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || 'local';
  const now = Date.now(), previous = buckets.get(address);
  const bucket = previous && now - previous.start < 60_000 ? previous : { start: now, count: 0 };
  bucket.count++; buckets.set(address, bucket);
  while (buckets.size > 500) buckets.delete(buckets.keys().next().value!);
  if (bucket.count > (regionBatch ? 12 : awardBatch ? 120 : 40)) {
    res.statusCode = 429; res.setHeader('Retry-After', '60');
    res.end(JSON.stringify({ error: { code: 'TOO_MANY_REQUESTS', message: '조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.' } })); return;
  }
  const result = await handleG2bRequest(url.pathname, url.searchParams);
  res.statusCode = result.status;
  if (result.retryAfterSeconds) res.setHeader('Retry-After', String(result.retryAfterSeconds));
  if (result.cacheStatus) res.setHeader('X-Search-Cache', result.cacheStatus);
  // Only public, complete search snapshots are shared. Errors and explicit refreshes never enter CDN cache.
  if (url.pathname === '/api/notices-start' && result.status === 200 && url.searchParams.get('refresh') !== '1' && result.cacheStatus !== 'STALE') {
    res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=60');
  }
  if (url.pathname === '/api/notice-regions' && result.status === 200 && url.searchParams.get('refresh') !== '1') {
    const body = result.body as G2bNoticeRegionsPage;
    if (!body.retryAfterSeconds && body.items.length > 0 && body.items.every(item => item.complete && !item.error)) {
      res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=300');
    }
  }
  // These contain public procurement data only. Share complete responses; a partial
  // response or an explicit retry must reach the server so missing data can recover.
  if (['/api/opening-results', '/api/result-summary'].includes(url.pathname) && result.status === 200 && url.searchParams.get('refresh') !== '1') {
    const body = result.body as { complete?: boolean; warnings?: string[] };
    if (body.complete && !body.warnings?.length) res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=120');
  }
  res.end(JSON.stringify(result.body));
}
