import type { PublicCompany } from '../src/company-types.ts';
import type { RelatedRequest } from './g2b-related.ts';

const USER_BASE = 'https://apis.data.go.kr/1230000/ao/UsrInfoService02/';
const PAGE_LIMIT = 10;
const PAGE_SIZE = 100;
type Row = Record<string, unknown>;
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const exactCompany = (row: Row, businessNumber: string) => text(row.bizno) === businessNumber;
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

export interface CompanyLookup { company: PublicCompany | null; warnings: string[] }
export class CompanyLookupError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Official name candidates. The provider accepts at most one year of registration dates. */
export function createCompanyNameLoader(request: RelatedRequest, now: () => number = Date.now) {
  return async (keyword: string, year: number, page = 1) => {
    const query = keyword.trim();
    const currentYear = new Date(now() + 9 * 3600_000).getUTCFullYear();
    if (query.length < 2 || query.length > 100 || /[\u0000-\u001f]/.test(query)
      || !Number.isInteger(year) || year < 1900 || year > currentYear
      || !Number.isInteger(page) || page < 1 || page > 100000) {
      throw new CompanyLookupError(400, 'INVALID_QUERY', '업체명은 2자 이상 입력하고 조회 연도를 확인해 주세요.');
    }
    const result = await request(USER_BASE, 'getPrcrmntCorpBasicInfo02', {
      inqryDiv: '1', corpNm: query, inqryBgnDt: `${year}01010000`, inqryEndDt: `${year}12312359`,
      pageNo: String(page), numOfRows: '100',
    }, 25_000);
    if (!Number.isSafeInteger(result.totalCount) || result.totalCount < 0
      || result.items.length !== Math.min(100, Math.max(0, result.totalCount - (page - 1) * 100))) {
      throw new CompanyLookupError(502, 'G2B_COMPANY_INCOMPLETE', '업체 후보를 모두 확인하지 못했습니다. 다시 조회해 주세요.');
    }
    const candidates = new Map<string, PublicCompany>();
    const normalizedQuery = query.replace(/\s/g, '').toLocaleLowerCase();
    for (const row of result.items) {
      const biz = text(row.bizno), name = text(row.corpNm);
      if (!/^\d{10}$/.test(biz) || !name.replace(/\s/g, '').toLocaleLowerCase().includes(normalizedQuery)) continue;
      candidates.set(biz, { businessNumber: biz, name, representative: text(row.ceoNm),
        address: [text(row.adrs), text(row.dtlAdrs)].filter(Boolean).join(' ') || text(row.rgnNm),
        phone: text(row.telNo), registrationDate: text(row.rgstDt), companyType: text(row.corpBsnsDivNm),
        licenses: [], products: [], updatedAt: text(row.chgDt) || new Date(now()).toISOString() });
    }
    return { items: [...candidates.values()], year, page, hasMore: page * 100 < result.totalCount, totalCount: result.totalCount };
  };
}

/** Public registration data only. Member-owned profile fields are never read or modified. */
export function createCompanyLoader(request: RelatedRequest, now: () => number = Date.now) {
  return async (businessNumber: string): Promise<CompanyLookup> => {
    if (!/^\d{10}$/.test(businessNumber)) throw new CompanyLookupError(400, 'INVALID_COMPANY', '사업자등록번호 10자리를 입력해 주세요.');
    const warnings: string[] = [];
    const finishBy = now() + 40_000;
    async function collect(operation: string, inqryDiv: string, label: string, required: boolean) {
      const rows: Row[] = [];
      const pageSignatures = new Set<string>();
      let received = 0;
      let expected: number | undefined;
      let complete = false;
      let mismatched = false;
      for (let pageNo = 1; pageNo <= PAGE_LIMIT; pageNo++) {
        const remaining = finishBy - now();
        if (remaining <= 0) break;
        let result: Awaited<ReturnType<RelatedRequest>>;
        try {
          result = await request(USER_BASE, operation, { inqryDiv, bizno: businessNumber, pageNo: String(pageNo), numOfRows: String(PAGE_SIZE) }, Math.min(12_000, remaining));
        } catch (error) {
          if (required) throw error;
          break;
        }
        if (!Number.isSafeInteger(result.totalCount) || result.totalCount < 0 || (expected !== undefined && result.totalCount !== expected)) break;
        expected = result.totalCount;
        if (expected === 0) { complete = result.items.length === 0; break; }
        if (!result.items.length) break;
        const signature = JSON.stringify(result.items);
        if (pageSignatures.has(signature)) break;
        pageSignatures.add(signature);
        received += result.items.length;
        mismatched ||= result.items.some(row => !exactCompany(row, businessNumber));
        rows.push(...result.items.filter(row => exactCompany(row, businessNumber)));
        if (received >= expected) { complete = received === expected; break; }
      }
      if (!complete || mismatched) warnings.push(`${label} 전체 정보를 확인하지 못했습니다. 확인된 정보만 표시합니다.`);
      if (required && (!complete || mismatched) && !rows.length) {
        throw new CompanyLookupError(502, 'G2B_COMPANY_INCOMPLETE', '요청한 사업자등록번호의 업체 정보를 확인하지 못했습니다. 다시 조회해 주세요.');
      }
      return rows;
    }

    const basics = await collect('getPrcrmntCorpBasicInfo02', '3', '업체 기본', true);
    if (!basics.length) return { company: null, warnings };
    const row = [...basics].sort((a, b) => Number(text(b.hdoffceDivNm) === '본사') - Number(text(a.hdoffceDivNm) === '본사') || text(b.chgDt).localeCompare(text(a.chgDt)))[0];
    const [licenses, products] = await Promise.all([
      collect('getPrcrmntCorpIndstrytyInfo02', '1', '등록 업종', false),
      collect('getPrcrmntCorpSplyPrdctInfo02', '1', '공급품목', false),
    ]);
    const registrationLabel = (name: unknown, code: unknown) => [text(name), text(code) ? `(${text(code)})` : ''].filter(Boolean).join(' ');
    return {
      company: {
        businessNumber, name: text(row.corpNm), representative: text(row.ceoNm),
        address: [text(row.adrs), text(row.dtlAdrs)].filter(Boolean).join(' ') || text(row.rgnNm),
        phone: text(row.telNo), registrationDate: text(row.rgstDt), companyType: text(row.corpBsnsDivNm),
        licenses: unique(licenses.map(item => [registrationLabel(item.indstrytyNm, item.indstrytyCd), text(item.indstrytyStatsNm)].filter(Boolean).join(' · '))),
        products: unique(products.map(item => registrationLabel(item.dtilPrdctClsfcNoNm, item.dtilPrdctClsfcNo))),
        updatedAt: text(row.chgDt) || new Date(now()).toISOString(),
      },
      warnings,
    };
  };
}
