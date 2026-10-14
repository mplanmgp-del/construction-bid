import type { CompanyHistory, CompanyIndexedPage, PublicCompany } from '../src/company-types.ts';
import type { CompanyContract } from '../src/company-contract-types.ts';
import { CompanyLookupError } from './g2b-company.ts';

export function parseCompanyHistoryQuery(params: URLSearchParams) {
  const businessNumber = (params.get('businessNumber') || '').replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(businessNumber)) throw new CompanyLookupError(400, 'INVALID_COMPANY', '사업자등록번호 10자리를 입력해 주세요.');
  const from = params.get('from') || null, to = params.get('to') || null;
  const valid = (day: string | null) => !day || (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day);
  if (!valid(from) || !valid(to) || (from && to && from > to)) throw new CompanyLookupError(400, 'INVALID_DATE_RANGE', '시작일과 종료일을 확인해 주세요.');
  const page = params.get('page') || '1', contractsPage = params.get('contractsPage') || '1', awardsPage = params.get('awardsPage') || '1', outcome = params.get('outcome') || 'all';
  if (![page, contractsPage, awardsPage].every(value => /^[1-9]\d{0,7}$/.test(value)) || !['all', 'won', 'lost', 'pending'].includes(outcome)) throw new CompanyLookupError(400, 'INVALID_QUERY', '조회 조건을 확인해 주세요.');
  // Deliberately no maximum date span: this queries the permanent index, not the provider.
  return { businessNumber, from, to, page: Number(page), contractsPage: Number(contractsPage), awardsPage: Number(awardsPage), outcome };
}

const unavailable = (): never => { throw new CompanyLookupError(503, 'ARCHIVE_UNAVAILABLE', '업체 이력 저장소를 확인 중입니다. 잠시 후 다시 조회해 주세요.'); };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function validatePage(value: unknown) {
  if (!record(value) || !Array.isArray(value.items) || !validCount(value.totalCount)
    || !record(value.coverage) || !['collecting', 'ready', 'unavailable'].includes(String(value.coverage.status))
    || typeof value.coverage.message !== 'string') unavailable();
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
    if (!response.ok) unavailable();
    try { return await response.json(); } catch { return unavailable(); }
  }
  async function search(query: string): Promise<PublicCompany[]> {
    const term = query.trim();
    if (term.length < 2 || term.length > 100 || /[\u0000-\u001f]/.test(term)) throw new CompanyLookupError(400, 'INVALID_QUERY', '업체명은 2자 이상 100자 이하로 입력해 주세요.');
    const rows = await read('bid_archive_companies', { select: 'business_number,name,updated_at', name: `ilike.*${term.replace(/[\\%_*]/g, '\\$&')}*`, order: 'name.asc,business_number.asc', limit: '30' });
    if (!Array.isArray(rows) || rows.some(row => !/^\d{10}$/.test(row.business_number) || typeof row.name !== 'string')) unavailable();
    return (rows as { business_number: string; name: string; updated_at: string }[]).map(row => ({ businessNumber: row.business_number, name: row.name, representative: '', address: '', phone: '', registrationDate: '', companyType: '', licenses: [], products: [], updatedAt: row.updated_at }));
  }
  async function collectorHealth(): Promise<{ status: string; message: string } | null> {
    try {
      const health = await read('bid_archive_health', { select: 'status,message', singleton: 'eq.true' });
      return Array.isArray(health) && health[0] && typeof health[0].message === 'string' ? health[0] : null;
    } catch { return null; }
  }
  function includeHealth(result: CompanyHistory, health: Awaited<ReturnType<typeof collectorHealth>>) {
    if (health && health.status !== 'collecting') result.coverage.message += ` ${health.message}`;
  }
  async function history(query: ReturnType<typeof parseCompanyHistoryQuery>, includeCollectorHealth = true): Promise<CompanyHistory> {
    const result = await read('rpc/bid_company_history', { bizno: query.businessNumber, page_no: String(query.page), page_size: '30', outcome: query.outcome, ...(query.from ? { from_date: query.from } : {}), ...(query.to ? { to_date: query.to } : {}) });
    validatePage(result);
    if (includeCollectorHealth) includeHealth(result, await collectorHealth());
    return result as CompanyHistory;
  }
  async function company(bizno: string): Promise<PublicCompany | null> {
    if (!/^\d{10}$/.test(bizno)) throw new CompanyLookupError(400, 'INVALID_COMPANY', '사업자등록번호 10자리를 입력해 주세요.');
    const rows = await read('bid_archive_companies', { select: 'business_number,name,updated_at', business_number: `eq.${bizno}`, limit: '1' });
    if (!Array.isArray(rows) || rows.some(row => !record(row) || row.business_number !== bizno || typeof row.name !== 'string')) unavailable();
    const row = rows[0];
    return row ? { businessNumber: row.business_number, name: row.name, representative: '', address: '', phone: '', registrationDate: '', companyType: '', licenses: [], products: [], updatedAt: row.updated_at } : null;
  }
  async function profile(bizno: string): Promise<{ company: PublicCompany | null; warnings: string[] }> {
    if (!/^\d{10}$/.test(bizno)) throw new CompanyLookupError(400, 'INVALID_COMPANY', '사업자등록번호 10자리를 입력해 주세요.');
    const rows = await read('bid_company_profiles', { select: 'profile,warnings,updated_at', business_number: `eq.${bizno}`, limit: '1' });
    if (!Array.isArray(rows)) unavailable();
    if (!rows.length) return { company: null, warnings: [] };
    const value = rows[0].profile;
    if (!record(value) || value.businessNumber !== bizno || typeof value.name !== 'string') unavailable();
    // Keep the browser DTO allowlisted even if the storage schema gains private fields later.
    const string = (key: string) => typeof value[key] === 'string' ? value[key] as string : '';
    const list = (key: string) => Array.isArray(value[key]) ? value[key].filter((item): item is string => typeof item === 'string') : [];
    return { company: { businessNumber: bizno, name: string('name'), representative: string('representative'), address: string('address'),
      phone: string('phone'), registrationDate: string('registrationDate'), companyType: string('companyType'),
      licenses: list('licenses'), products: list('products'), updatedAt: string('updatedAt') },
      warnings: Array.isArray(rows[0].warnings) ? rows[0].warnings.filter((item: unknown): item is string => typeof item === 'string') : [] };
  }
  async function watch(bizno: string): Promise<boolean> {
    if (!options.url || !options.key || !/^\d{10}$/.test(bizno)) return false;
    try {
      const response = await fetcher(new URL('/rest/v1/rpc/bid_watch_company', options.url), { method: 'POST',
        headers: { apikey: options.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_business_number: bizno }),
        signal: AbortSignal.timeout(3_000) });
      if (!response.ok) return false;
      const value = await response.json();
      return record(value) && ['queued', 'current'].includes(String(value.status));
    } catch { return false; }
  }
  async function contracts(query: ReturnType<typeof parseCompanyHistoryQuery>): Promise<CompanyIndexedPage<CompanyContract>> {
    const result = await read('rpc/bid_company_contract_history', { bizno: query.businessNumber, page_no: String(query.contractsPage), page_size: '30',
      ...(query.from ? { from_date: query.from } : {}), ...(query.to ? { to_date: query.to } : {}) });
    validatePage(result);
    if (result.items.some((item: CompanyContract) => item.businessNumber !== query.businessNumber)) unavailable();
    return { items: result.items, totalCount: result.totalCount, page: result.page, pageSize: result.pageSize,
      coverage: result.coverage, source: '나라장터 계약정보서비스 · 수집된 계약 체결일 기준' };
  }
  async function combinedHistory(query: ReturnType<typeof parseCompanyHistoryQuery>): Promise<CompanyHistory> {
    // Queue only the identifier, concurrently with index reads. Observe its
    // result so a rejected/unknown queue request never looks like active work.
    const [participation, contractResult, awardResult, profileResult, health, watched] = await Promise.all([
      history(query, false), contracts(query).catch(() => null),
      history({ ...query, page: query.awardsPage, outcome: 'won' }, false).catch(() => null),
      profile(query.businessNumber).catch(() => null), collectorHealth(), watch(query.businessNumber),
    ]);
    includeHealth(participation, health);
    if (awardResult) includeHealth(awardResult, health);
    const missing = (page: number, message: string) => ({ items: [], totalCount: 0, page, pageSize: 30,
      coverage: { status: 'unavailable' as const, from: null, to: null, updatedAt: null, message } });
    if (!watched) participation.coverage.message += ' 추가 이력 수집 신청이 등록되었는지 확인하지 못했습니다. 저장된 이력만 표시하며, 잠시 후 다시 조회해 주세요.';
    return { ...participation, company: profileResult?.company || participation.company,
      contracts: contractResult || missing(query.contractsPage, '계약 저장소를 조회하지 못했습니다. 계약이 0건이라는 의미는 아닙니다.'),
      awards: awardResult ? { items: awardResult.items, totalCount: awardResult.totalCount, page: awardResult.page, pageSize: awardResult.pageSize,
        coverage: awardResult.coverage, source: '수집된 공식 참여 이력 중 낙찰' }
        : missing(query.awardsPage, '낙찰 확인 이력을 조회하지 못했습니다. 낙찰이 0건이라는 의미는 아닙니다.') };
  }
  return { search, history, company, profile, watch, contracts, combinedHistory };
}
