import { createHash } from 'node:crypto';
import type { CompanyContract, CompanyContractPage, CompanyContractQuery } from '../src/company-contract-types.ts';
import { CompanyLookupError } from './g2b-company.ts';
import { readOfficialList, type RelatedRequest } from './g2b-related.ts';

const BASE = 'https://apis.data.go.kr/1230000/ao/CntrctInfoService/';
const PAGE_SIZE = 999;
type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
function day(value: unknown): string {
  const match = text(value).match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  const result = match ? `${match[1]}-${match[2]}-${match[3]}` : '';
  return validDay(result) ? result : '';
}
function timestamp(value: unknown): string {
  const match = text(value).match(/^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?$/);
  if (!match) return '';
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}+09:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms + 9 * 3600_000).toISOString().slice(0, 19) === iso.slice(0, 19) ? iso : '';
}
function money(value: unknown): number | null {
  const raw = text(value).replaceAll(',', '');
  return /^\d+(?:\.0+)?$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null;
}
function share(value: string): number | null {
  return /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) <= 100 ? Number(value) : null;
}
function sourceUrl(value: unknown): string {
  try {
    const url = new URL(text(value));
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && (url.hostname === 'g2b.go.kr' || url.hostname.endsWith('.g2b.go.kr')) ? url.href : '';
  } catch { return ''; }
}
const fail = (code: string, message: string): never => { throw new CompanyLookupError(502, code, message); };

export function validateCompanyContractQuery(query: CompanyContractQuery): void {
  if (!/^\d{10}$/.test(query.businessNumber) || !['공사', '용역'].includes(query.type)
    || !Number.isSafeInteger(query.page) || query.page < 1 || query.page > 1_000_000) {
    throw new CompanyLookupError(400, 'INVALID_QUERY', '사업자등록번호 10자리, 업무 구분과 페이지를 확인해 주세요.');
  }
  if (!validDay(query.from) || !validDay(query.to) || query.from > query.to
    || Date.parse(query.to) - Date.parse(query.from) >= 31 * 86400_000) {
    throw new CompanyLookupError(400, 'INVALID_DATE_RANGE', '개별 계약 조회 구간은 올바른 날짜로 최대 31일 이내여야 합니다.');
  }
}

/** The official contract operations have NO business-number filter. Read exactly
 * one requested source page, then match the published corpList business number.
 * The caller advances pages/months; this function does not scan or store history. */
export function createCompanyContractsLoader(request: RelatedRequest, now = Date.now) {
  return async (query: CompanyContractQuery): Promise<CompanyContractPage> => {
    validateCompanyContractQuery(query);
    const result = await request(BASE,
      query.type === '공사' ? 'getCntrctInfoListCnstwkPPSSrch' : 'getCntrctInfoListServcPPSSrch', {
        inqryDiv: '1', inqryBgnDate: query.from.replaceAll('-', ''), inqryEndDate: query.to.replaceAll('-', ''),
        pageNo: String(query.page), numOfRows: String(PAGE_SIZE),
      }, 25_000);
    const { totalCount, items: rows } = result;
    if (!Number.isSafeInteger(totalCount) || totalCount < 0
      || rows.length !== Math.max(0, Math.min(PAGE_SIZE, totalCount - (query.page - 1) * PAGE_SIZE))) {
      fail('COMPANY_CONTRACTS_INCOMPLETE', '계약 원본의 전체 건수와 페이지 응답 건수가 일치하지 않습니다. 같은 페이지를 다시 조회해 주세요.');
    }
    if (query.page > Math.max(1, Math.ceil(totalCount / PAGE_SIZE))) {
      fail('COMPANY_CONTRACTS_CHANGED', '조회 중 계약 목록의 페이지 범위가 변경되었습니다. 이 구간을 다시 조회해 주세요.');
    }
    const items: CompanyContract[] = [], warnings = new Set<string>(), sourceIds = new Set<string>();
    for (const row of rows) {
      const kind = text(row.bsnsDivNm);
      if (kind && !(query.type === '공사' ? ['공사'] : ['용역', '일반용역', '기술용역']).includes(kind)) {
        fail('COMPANY_CONTRACTS_CHANGED', '요청한 업무와 다른 계약 자료가 포함되어 조회를 중단했습니다.');
      }
      const contractDate = day(row.cntrctCnclsDate) || day(row.cntrctDate);
      if (!contractDate || contractDate < query.from || contractDate > query.to) {
        fail('COMPANY_CONTRACTS_CHANGED', '요청한 계약 체결일과 다른 자료가 포함되어 조회를 중단했습니다.');
      }
      const unifiedContractNumber = text(row.untyCntrctNo), contractNumber = text(row.dcsnCntrctNo);
      if ((!unifiedContractNumber && !contractNumber)
        || [unifiedContractNumber, contractNumber].some(value => value && !/^[A-Za-z0-9_-]{1,80}$/.test(value))) {
        fail('COMPANY_CONTRACTS_INCOMPLETE', '계약 식별번호를 확인할 수 없어 이 페이지의 조회를 완료하지 못했습니다.');
      }
      // Retain the full confirmed number (including amendment order). Amount,
      // company name and mutable title never become an identity discriminator.
      const sourceId = hash([query.type, unifiedContractNumber, contractNumber]);
      if (sourceIds.has(sourceId)) fail('COMPANY_CONTRACTS_INCOMPLETE', '계약 원본에 같은 계약 식별자가 반복되어 이 페이지를 다시 조회해야 합니다.');
      sourceIds.add(sourceId);
      const companies = readOfficialList(row.corpList, 10);
      if (companies.malformed || !text(row.corpList)
        || companies.rows.some(cells => !/^\d{10}$/.test(cells[9].replace(/[\s-]/g, '')))) {
        warnings.add('일부 계약의 업체 목록을 확인하지 못했습니다. 이 페이지에 해당 업체의 추가 계약이 있을 수 있습니다.');
      }
      const parties = companies.rows.filter(cells => cells[9].replace(/[\s-]/g, '') === query.businessNumber);
      if (!parties.length) continue;
      const contractAmount = money(row.thtmCntrctAmt), totalContractAmount = money(row.totCntrctAmt);
      if ((text(row.thtmCntrctAmt) && contractAmount === null) || (text(row.totCntrctAmt) && totalContractAmount === null)) {
        warnings.add('일부 계약금액의 형식을 확인하지 못해 해당 금액을 표시하지 않았습니다.');
      }
      items.push({
        id: `contract:${hash([query.type, unifiedContractNumber, contractNumber, query.businessNumber])}`,
        businessNumber: query.businessNumber, type: query.type,
        companyName: parties.find(cells => cells[3])?.[3] || '',
        title: text(row.cnstwkNm) || text(row.cntrctNm) || text(row.servcNm), agency: text(row.cntrctInsttNm),
        contractDate, contractNumber, unifiedContractNumber, referenceNumber: text(row.cntrctRefNo),
        noticeNumber: text(row.ntceNo), method: text(row.cntrctCnclsMthdNm), contractAmount, totalContractAmount,
        // Multiple rows for one firm can describe different work classifications.
        // Summing their shares would overstate a joint-contract share.
        shareRate: parties.length === 1 ? share(parties[0][6]) : null,
        sourceUrl: sourceUrl(row.cntrctDtlInfoUrl) || sourceUrl(row.cntrctInfoUrl),
        registeredAt: timestamp(row.rgstDt), changedAt: timestamp(row.chgDt),
      });
    }
    const hasMore = query.page * PAGE_SIZE < totalCount;
    return { ...query, items, pageSize: PAGE_SIZE, sourceCount: rows.length, totalCount, hasMore,
      complete: !hasMore && warnings.size === 0, warnings: [...warnings],
      sourceFingerprint: hash([query.type, query.from, query.to, [...sourceIds].sort()]),
      fetchedAt: new Date(now()).toISOString(), source: '나라장터 계약정보서비스 · 계약 체결일 기준' };
  };
}
