import type { OpeningResultsQuery } from '../src/opening-result-types.ts';

/** Queue only public notice identifiers. The database worker fetches and verifies
 * the official response itself; callers cannot supply company or bid records. */
export async function queueOpeningArchive(query: OpeningResultsQuery, options: {
  url?: string; key?: string; fetcher?: typeof fetch;
} = {}): Promise<boolean> {
  const url = options.url ?? process.env.VITE_SUPABASE_URL;
  const key = options.key ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key || !/^[A-Za-z0-9_-]{1,40}$/.test(query.number) || !/^\d{3}$/.test(query.revision) || !['공사', '용역'].includes(query.type)) return false;
  try {
    const response = await (options.fetcher ?? fetch)(new URL('/rest/v1/rpc/bid_queue_opening_notice', url), {
      method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_type: query.type, p_number: query.number, p_revision: query.revision }),
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch { return false; }
}
