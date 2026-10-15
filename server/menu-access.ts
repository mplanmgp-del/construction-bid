import type { MenuKey } from '../src/admin/types.ts';

const noticeRoutes = new Set(['/api/notices', '/api/notices-start', '/api/detail', '/api/results', '/api/related', '/api/notice-regions', '/api/opening-results', '/api/result-summary']);
const companyRoutes = new Set(['/api/companies', '/api/company-awards', '/api/company-contracts', '/api/company-participation', '/api/company-history', '/api/archive-page']);
export function menuForApi(path: string): MenuKey | null {
  return noticeRoutes.has(path) ? 'notices' : companyRoutes.has(path) ? 'results' : null;
}

type Denied = { status: 403 | 503; body: { error: { code: 'MENU_LOCKED' | 'MENU_ACCESS_UNAVAILABLE'; message: string } } };
const unavailable = (): Denied => ({ status: 503, body: { error: { code: 'MENU_ACCESS_UNAVAILABLE', message: '메뉴 이용 상태를 확인하지 못했습니다. 잠시 후 다시 이용해 주세요.' } } });
const denied = (message: string): Denied => ({ status: 403, body: { error: { code: 'MENU_LOCKED', message: message || '기능을 점검하고 있습니다. 잠시 후 다시 이용해 주세요.' } } });
type Options = { url?: string; key?: string; fetcher?: typeof fetch };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Remote Auth validation plus the membership table are the only admin authority.
 * No browser role claim, decoded JWT payload, or signup metadata can bypass a lock.
 * Reads are deliberately not cached: a saved lock affects the very next request.
 */
export async function authorizeMenuRequest(path: string, authorization?: string | string[], options: Options = {}): Promise<Denied | null> {
  const menu = menuForApi(path);
  if (!menu) return null;
  const base = options.url ?? process.env.VITE_SUPABASE_URL;
  const key = options.key ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!base || !key || key.startsWith('sb_secret_')) return unavailable();
  // Reject accidentally configured privileged legacy keys, too.
  if (key.split('.').length === 3) {
    try { if (JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role !== 'anon') return unavailable(); }
    catch { return unavailable(); }
  }
  const fetcher = options.fetcher ?? fetch;
  async function read(endpoint: string, token?: string) {
    return fetcher(new URL(endpoint, base), { headers: { apikey: key!, ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(8_000) });
  }
  try {
    const settings = await read(`/rest/v1/bid_menu_settings?select=menu_key,locked,message&menu_key=eq.${menu}&limit=1`);
    if (!settings.ok) return unavailable();
    const rows: unknown = await settings.json();
    if (!Array.isArray(rows) || rows.length !== 1 || !record(rows[0]) || rows[0].menu_key !== menu || typeof rows[0].locked !== 'boolean' || typeof rows[0].message !== 'string') return unavailable();
    if (!rows[0].locked) return null;
    const locked = denied(rows[0].message);
    if (typeof authorization !== 'string' || authorization.length > 8192) return locked;
    const token = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(authorization)?.[1];
    if (!token) return locked;
    const identity = await read('/auth/v1/user', token);
    if (!identity.ok) return identity.status >= 500 ? unavailable() : locked;
    const user: unknown = await identity.json();
    if (!record(user) || typeof user.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)) return locked;
    const membership = await read(`/rest/v1/bid_admin_users?select=user_id&user_id=eq.${user.id}&limit=1`, token);
    if (!membership.ok) return unavailable();
    const admins: unknown = await membership.json();
    return Array.isArray(admins) && admins.length === 1 && record(admins[0]) && admins[0].user_id === user.id ? null : locked;
  } catch { return unavailable(); }
}
