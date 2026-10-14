import type { CompanyHistory, PublicCompany } from '../src/company-types.ts';
import { CompanyLookupError } from './g2b-company.ts';

export function parseCompanyHistoryQuery(params: URLSearchParams) {
  const businessNumber = (params.get('businessNumber') || '').replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(businessNumber)) throw new CompanyLookupError(400, 'INVALID_COMPANY', '사업자등록번호 10자리를 입력해 주세요.');
  const from = params.get('from') || null, to = params.get('to') || null;
  const valid = (day: string | null) => !day || (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day);
  if (!valid(from) || !valid(to) || (from && to && from > to)) throw new CompanyLookupError(400, 'INVALID_DATE_RANGE', '시작일과 종료일을 확인해 주세요.');
  const page = params.get('page') || '1', outcome = params.get('outcome') || 'all';
  if (!/^[1-9]\d{0,7}$/.test(page) || !['all', 'won', 'lost', 'pending'].includes(outcome)) throw new CompanyLookupError(400, 'INVALID_QUERY', '조회 조건을 확인해 주세요.');
  // Deliberately no maximum date span: this queries the permanent index, not the provider.
  return { businessNumber, from, to, page: Number(page), outcome };
}

export function createCompanyArchiveReader(options: { url?: string; key?: string; fetcher?: typeof fetch }) {
  const fetcher = options.fetcher ?? fetch;
  async function read(path: string, params: Record<string, string>) {
    if (!options.url || !options.key) throw new CompanyLookupError(503, 'ARCHIVE_UNAVAILABLE', '업체 이력 저장소 연결을 준비 중입니다. 잠시 후 다시 확인해 주세요.');
    const url = new URL(`/rest/v1/${path}`, options.url);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try { response = await fetcher(url, { headers: { apikey: options.key }, signal: AbortSignal.timeout(15_000) }); }
    catch { throw new CompanyLookupError(503, 'ARCHIVE_UNAVAILABLE', '저장된 업체 이력을 불러오지 못했습니다. 다시 조회해 주세요.'); }
    if (!response.ok) throw new CompanyLookupError(503, 'ARCHIVE_UNAVAILABLE', '업체 이력 저장소를 확인 중입니다. 잠시 후 다시 조회해 주세요.');
    return response.json();
  }
  async function search(query: string): Promise<PublicCompany[]> {
    const term = query.trim();
    if (term.length < 2 || term.length > 100 || /[\u0000-\u001f]/.test(term)) throw new CompanyLookupError(400, 'INVALID_QUERY', '업체명은 2자 이상 100자 이하로 입력해 주세요.');
    const rows = await read('bid_archive_companies', { select: 'business_number,name,updated_at', name: `ilike.*${term.replace(/[\\%_*]/g, '\\$&')}*`, order: 'name.asc,business_number.asc', limit: '30' });
    return (rows as { business_number: string; name: string; updated_at: string }[]).map(row => ({ businessNumber: row.business_number, name: row.name, representative: '', address: '', phone: '', registrationDate: '', companyType: '', licenses: [], products: [], updatedAt: row.updated_at }));
  }
  async function history(query: ReturnType<typeof parseCompanyHistoryQuery>): Promise<CompanyHistory> {
    const result = await read('rpc/bid_company_history', { bizno: query.businessNumber, page_no: String(query.page), page_size: '30', outcome: query.outcome, ...(query.from ? { from_date: query.from } : {}), ...(query.to ? { to_date: query.to } : {}) });
    try {
      const health = await read('bid_archive_health', { select: 'status,message', singleton: 'eq.true' });
      if (health[0] && !['collecting'].includes(health[0].status)) result.coverage.message += ` ${health[0].message}`;
    } catch { /* Older deployments may not have collector health yet; the coverage remains incomplete. */ }
    return result as CompanyHistory;
  }
  async function company(bizno: string): Promise<PublicCompany | null> {
    const rows = await read('bid_archive_companies', { select: 'business_number,name,updated_at', business_number: `eq.${bizno}`, limit: '1' });
    const row = rows[0];
    return row ? { businessNumber: row.business_number, name: row.name, representative: '', address: '', phone: '', registrationDate: '', companyType: '', licenses: [], products: [], updatedAt: row.updated_at } : null;
  }
  return { search, history, company };
}
