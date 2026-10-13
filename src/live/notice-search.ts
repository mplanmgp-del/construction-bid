import type { G2bBusinessType, G2bNoticePage } from '../g2b-types';
import { fetchApi, mergeById } from './client';

export interface NoticeQuery { type: G2bBusinessType | '공사·용역'; from: string; to: string; keyword: string }

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
