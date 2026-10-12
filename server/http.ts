import { createG2bClient, G2bError, parseSearch } from './g2b.ts';
import type { G2bApiError } from '../src/g2b-types.ts';

type Client = ReturnType<typeof createG2bClient>;
let currentKey: string | undefined;
let client: Client | undefined;
function serverClient() {
  const key = process.env.G2B_SERVICE_KEY;
  if (!client || key !== currentKey) { currentKey = key; client = createG2bClient({ serviceKey: key }); }
  return client;
}

export async function handleG2bRequest(path: string, params: URLSearchParams, api: Client = serverClient()): Promise<{ status: number; body: unknown }> {
  try {
    if (path === '/api/notices') return { status: 200, body: await api.notices(parseSearch(params)) };
    if (path === '/api/results') return { status: 200, body: await api.results(parseSearch(params, 7)) };
    if (path === '/api/detail' || path === '/api/related') {
      const number = params.get('number') || '', revision = params.get('revision') || '', type = params.get('type');
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(number) || !/^\d{1,3}$/.test(revision) || (type !== '공사' && type !== '용역')) {
        throw new G2bError(400, 'INVALID_QUERY', '공고번호, 차수, 업무 구분을 확인해 주세요.');
      }
      return { status: 200, body: await (path === '/api/related' ? api.related : api.detail)(number, revision.padStart(3, '0'), type) };
    }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: '존재하지 않는 API입니다.' } } };
  } catch (error) {
    const known = error instanceof G2bError ? error : new G2bError(500, 'INTERNAL_ERROR', '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    const body: G2bApiError = { error: { code: known.code, message: known.message } };
    return { status: known.status, body };
  }
}

export interface NodeRequest { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }
export interface NodeResponse { statusCode: number; setHeader(name: string, value: string): unknown; end(value?: string): unknown }

// A small per-instance burst guard complements upstream quotas and the shared response cache.
const clients = new Map<string, { start: number; count: number }>();
export async function nodeApiHandler(req: NodeRequest, res: NodeResponse) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.statusCode = 405; res.setHeader('Allow', 'GET');
    res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: '조회 요청만 지원합니다.' } })); return;
  }
  const forwarded = req.headers['x-forwarded-for'];
  const address = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || 'local';
  const now = Date.now(), previous = clients.get(address);
  const bucket = previous && now - previous.start < 60_000 ? previous : { start: now, count: 0 };
  bucket.count++; clients.set(address, bucket);
  while (clients.size > 500) clients.delete(clients.keys().next().value!);
  if (bucket.count > 40) {
    res.statusCode = 429; res.setHeader('Retry-After', '60');
    res.end(JSON.stringify({ error: { code: 'TOO_MANY_REQUESTS', message: '조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.' } })); return;
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const result = await handleG2bRequest(url.pathname, url.searchParams);
  res.statusCode = result.status;
  res.end(JSON.stringify(result.body));
}
