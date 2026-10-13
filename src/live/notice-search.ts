import type { G2bBusinessType, G2bNoticePage } from '../g2b-types';
import { ApiError, fetchApi, mergeById } from './client';
import { startSearchWindows } from './start-range';

export interface NoticeQuery { type: G2bBusinessType | '공사·용역'; from: string; to: string; keyword: string }

export async function fetchStartedNotices(query: NoticeQuery, signal: AbortSignal, progress: (done: number, total: number) => void, options: { force?: boolean } = {}): Promise<G2bNoticePage> {
  if (!query.keyword.trim()) throw new ApiError('검색할 공고명을 입력해 주세요.', 'KEYWORD_REQUIRED', 400);
  const types: G2bBusinessType[] = query.type === '공사·용역' ? ['공사', '용역'] : [query.type];
  const jobs = startSearchWindows(query.from, query.to).flatMap((_, window) => types.map(type => ({ type, window })));
  const results: G2bNoticePage[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  let next = 0;
  progress(0, jobs.length);
  try {
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < jobs.length && !controller.signal.aborted) {
        const job = jobs[next++];
        const params = new URLSearchParams({ ...query, type: job.type, window: String(job.window), ...(options.force ? { refresh: '1' } : {}) });
        const result = await fetchApi<G2bNoticePage>(`/api/notices-start?${params}`, controller.signal);
        if (result.hasMore || result.items.length !== result.totalCount) throw new Error('전체 공고 조회가 완료되지 않았습니다. 다시 조회해 주세요.');
        results.push(result); progress(results.length, jobs.length);
      }
    }));
    if (controller.signal.aborted) throw new Error('조회가 취소되었습니다.');
    const items = mergeById([], results.flatMap(result => result.items));
    return { items, totalCount: items.length, page: 1, pageSize: items.length, hasMore: false, fetchedAt: results.map(result => result.fetchedAt).sort()[0], source: '나라장터 입찰공고정보서비스', warnings: [...new Set(results.flatMap(result => result.warnings ?? []))] };
  } catch (error) { controller.abort(); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}

export async function fetchNoticePage(query: NoticeQuery, page: number, signal?: AbortSignal): Promise<G2bNoticePage> {
  const types: G2bBusinessType[] = query.type === '공사·용역' ? ['공사', '용역'] : [query.type];
  // Fail visibly if either source fails, rather than presenting a partial total as complete.
  const results = await Promise.all(types.map(async type => {
    const params = new URLSearchParams({ ...query, type, page: String(page), pageSize: '100' });
    try { return await fetchApi<G2bNoticePage>(`/api/notices?${params}`, signal); }
    catch (cause) { throw new Error(`${type} 조회 실패: ${cause instanceof Error ? cause.message : '다시 조회해 주세요.'}`); }
  }));
  return {
    items: mergeById([], results.flatMap(result => result.items)),
    totalCount: results.reduce((sum, result) => sum + result.totalCount, 0),
    page, pageSize: 100 * types.length, hasMore: results.some(result => result.hasMore),
    fetchedAt: results.map(result => result.fetchedAt).sort()[0],
    source: results[0].source,
    warnings: [...new Set(results.flatMap((result, index) => (result.warnings ?? []).map(warning => `${types[index]}: ${warning}`)))],
  };
}
