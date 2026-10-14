import { createG2bClient, G2bError, parseSearch } from './g2b.ts';
import { loadPublicSearch } from './public-search-cache.ts';
import { ProviderQuotaError } from './provider-quota.ts';
import { CompanyLookupError } from './g2b-company.ts';
import { OpeningResultsError } from './g2b-results.ts';
import { validateCompanyAwardQuery } from './company-awards.ts';
import { loadCompanyAwards } from './company-award-cache.ts';
import type { CompanyAwardQuery } from '../src/company-award-types.ts';
import { queueOpeningArchive } from './opening-archive-queue.ts';
import { waitUntil } from '@vercel/functions';
import { createCompanyArchiveReader, parseCompanyHistoryQuery } from './company-history.ts';
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

// Award snapshots have their own shared freshness clock. On a cache miss, use a
// fresh provider client so its five-minute raw cache cannot renew old data.
export async function handleG2bRequest(path: string, params: URLSearchParams, api: Client = serverClient(path === '/api/company-awards' || params.get('refresh') === '1')): Promise<{ status: number; body: unknown; cacheStatus?: string; retryAfterSeconds?: number }> {
  try {
    if (path === '/api/company-awards') {
      const query: CompanyAwardQuery = { businessNumber: (params.get('businessNumber') || '').replace(/[\s-]/g, ''),
        type: params.get('type') as CompanyAwardQuery['type'], from: params.get('from') || '', to: params.get('to') || '' };
      validateCompanyAwardQuery(query);
      const result = await loadCompanyAwards(query, () => api.companyAwards(query), { force: params.get('refresh') === '1' });
      return { status: 200, body: result.body, cacheStatus: result.status };
    }
    if (path === '/api/companies' || path === '/api/company-history') {
      const archive = createCompanyArchiveReader({ url: process.env.VITE_SUPABASE_URL, key: process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY });
      if (path === '/api/company-history') {
        const query = parseCompanyHistoryQuery(params);
        const body = await archive.history(query);
        return { status: 200, body };
      }
      const q = params.get('q')?.trim() || '';
      const bizno = q.replace(/[\s-]/g, '');
      if (/^\d{10}$/.test(bizno)) {
        try {
          const result = await api.company(bizno);
          if (result.company) return { status: 200, body: { items: [result.company], message: result.warnings.join(' ') } };
          const stored = await archive.company(bizno);
          return { status: 200, body: { items: stored ? [stored] : [], message: stored ? '현재 등록정보가 없어 공개 이력에 기록된 업체명을 표시합니다.' : '' } };
        } catch (error) {
          let stored = null;
          try { stored = await archive.company(bizno); } catch { /* Preserve the original provider error. */ }
          if (!stored) throw error;
          return { status: 200, body: { items: [stored], message: '최신 업체 등록정보를 확인하지 못해 저장된 공개 업체 정보를 표시합니다.' } };
        }
      }
      const items = await archive.search(q);
      return { status: 200, body: { items, message: '수집된 공개 업체명에서 검색합니다. 목록에 없는 업체는 사업자등록번호 10자리로 직접 조회해 주세요.' } };
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
  // Region hydration uses bounded batches and must not consume the search/result allowance.
  const regionBatch = url.pathname === '/api/notice-regions';
  const awardBatch = url.pathname === '/api/company-awards';
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
  if (url.pathname === '/api/opening-results' && url.searchParams.get('archive') !== '1' && result.status === 200) {
    const body = result.body as { complete: boolean; warnings: string[] };
    if (body.complete && !body.warnings.length) {
      const job = queueOpeningArchive({ number: url.searchParams.get('number') || '', revision: (url.searchParams.get('revision') || '').padStart(3, '0'), type: url.searchParams.get('type') as '공사' | '용역' });
      try { waitUntil(job); } catch { await job; }
    }
  }
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
  if (url.pathname === '/api/company-awards' && result.status === 200 && url.searchParams.get('refresh') !== '1' && result.cacheStatus !== 'STALE') {
    const body = result.body as { complete: boolean; warnings: string[]; to: string; fetchedAt: string };
    if (body.complete && !body.warnings.length) {
      const recent = body.to >= new Date(Date.now() + 9 * 3600_000 - 7 * 86400_000).toISOString().slice(0, 10);
      const age = Date.now() - Date.parse(body.fetchedAt);
      const remaining = Math.floor(((recent ? 180_000 : 86400_000) - age) / 1000);
      if (age >= 0 && remaining > 0) res.setHeader('Vercel-CDN-Cache-Control', `public, max-age=${remaining}`);
    }
  }
  res.end(JSON.stringify(result.body));
}
