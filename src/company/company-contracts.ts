import type { CompanyContract, CompanyContractPage, CompanyContractQuery } from '../company-contract-types';
import { normalizeAwardDay, splitCompanyAwardRange } from './company-awards';

export type ContractJobStatus = 'idle' | 'loading' | 'complete' | 'partial' | 'error';
export interface ContractJob {
  query: CompanyContractQuery;
  status: ContractJobStatus;
  items: CompanyContract[];
  previousItems: CompanyContract[];
  sourceCount: number;
  expectedTotal?: number;
  fingerprints: string[];
  warnings: string[];
  error?: string;
  restartRequired: boolean;
}
export class ContractPageError extends Error {}
function fail(message: string): never { throw new ContractPageError(message); }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeAmount = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
function safeLink(value: string) {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password
    && (!url.port || url.port === '443') && (url.hostname === 'g2b.go.kr' || url.hostname.endsWith('.g2b.go.kr')); }
  catch { return false; }
}

export function contractJobKey(job: Pick<ContractJob, 'query'>): string {
  const q = job.query;
  return [q.businessNumber, q.type, q.from, q.to].join('|');
}
export function createContractJobs(businessNumber: string, from: string, to: string): ContractJob[] {
  if (!/^\d{10}$/.test(businessNumber)) throw new Error('사업자등록번호 10자리를 확인해 주세요.');
  return splitCompanyAwardRange(from, to).flatMap(range => (['공사', '용역'] as const).map(type => ({
    query: { businessNumber, type, ...range, page: 1 }, status: 'idle' as const,
    items: [], previousItems: [], sourceCount: 0, fingerprints: [], warnings: [], restartRequired: false,
  })));
}

/** Validate the page before it can change a cursor or the displayed company. */
export function validateContractPage(job: ContractJob, input: unknown): asserts input is CompanyContractPage {
  const value = object(input), q = job.query;
  if (value.businessNumber !== q.businessNumber || value.type !== q.type || value.from !== q.from || value.to !== q.to || value.page !== q.page) {
    fail('요청한 업체·기간의 계약 자료인지 확인하지 못했습니다. 해당 구간을 다시 조회해 주세요.');
  }
  if (value.pageSize !== 999 || !Number.isSafeInteger(value.totalCount) || Number(value.totalCount) < 0
    || !Number.isSafeInteger(value.sourceCount) || Number(value.sourceCount) < 0
    || !Array.isArray(value.items) || !Array.isArray(value.warnings) || value.warnings.some(warning => typeof warning !== 'string')
    || typeof value.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)
    || typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt)) || typeof value.source !== 'string') {
    fail('계약 목록의 응답 형식을 확인하지 못했습니다. 해당 구간을 다시 조회해 주세요.');
  }
  const total = Number(value.totalCount), sourceCount = Number(value.sourceCount);
  const hasMore = q.page * 999 < total;
  if (q.page > Math.max(1, Math.ceil(total / 999)) || sourceCount !== Math.min(999, Math.max(0, total - (q.page - 1) * 999))
    || value.items.length > sourceCount || value.hasMore !== hasMore || value.complete !== (!hasMore && value.warnings.length === 0)) {
    fail('계약 원본의 건수와 조회 진행 정보가 일치하지 않습니다. 해당 구간을 처음부터 다시 확인해 주세요.');
  }
  if (job.expectedTotal !== undefined && job.expectedTotal !== total) fail('조회 중 계약 원본 건수가 변경되었습니다. 해당 구간을 처음부터 다시 확인해 주세요.');
  if (job.fingerprints.includes(value.sourceFingerprint)) fail('앞서 받은 계약 목록이 반복되어 해당 구간의 조회를 중단했습니다. 처음부터 다시 확인해 주세요.');
  const ids = new Set(job.items.map(item => item.id));
  for (const raw of value.items) {
    const item = object(raw);
    const strings = ['id', 'companyName', 'title', 'agency', 'contractDate', 'contractNumber', 'unifiedContractNumber', 'referenceNumber', 'noticeNumber', 'method', 'sourceUrl', 'registeredAt', 'changedAt'];
    if (strings.some(key => typeof item[key] !== 'string') || item.businessNumber !== q.businessNumber || item.type !== q.type
      || !/^contract:[a-f0-9]{64}$/.test(String(item.id)) || !safeAmount(item.contractAmount) || !safeAmount(item.totalContractAmount)
      || !(item.shareRate === null || (typeof item.shareRate === 'number' && Number.isFinite(item.shareRate) && item.shareRate >= 0 && item.shareRate <= 100))
      || normalizeAwardDay(String(item.contractDate)) !== item.contractDate || String(item.contractDate) < q.from || String(item.contractDate) > q.to
      || !safeLink(String(item.sourceUrl))) {
      fail('업체 또는 계약 항목이 일치하지 않아 이 구간을 다시 확인해야 합니다.');
    }
    if (ids.has(String(item.id))) fail('같은 계약이 여러 페이지에 반복되어 이 구간을 처음부터 다시 확인해야 합니다.');
    ids.add(String(item.id));
  }
}

export function appendContractPage(job: ContractJob, input: unknown): ContractJob {
  validateContractPage(job, input);
  const warnings = [...new Set([...job.warnings, ...input.warnings])];
  const complete = !input.hasMore && warnings.length === 0;
  return { ...job, query: { ...job.query, page: job.query.page + (input.hasMore ? 1 : 0) },
    items: [...job.items, ...input.items], previousItems: complete ? [] : job.previousItems,
    sourceCount: job.sourceCount + input.sourceCount, expectedTotal: input.totalCount,
    fingerprints: [...job.fingerprints, input.sourceFingerprint], warnings,
    status: input.hasMore ? 'idle' : complete ? 'complete' : 'partial', error: undefined,
    restartRequired: !input.hasMore && !complete };
}

/** Keep prior visible rows until a replacement traversal really completes. */
export function restartContractJob(job: ContractJob): ContractJob {
  return { ...job, query: { ...job.query, page: 1 }, status: 'idle',
    previousItems: mergeCompanyContracts(job.previousItems, job.items), items: [],
    sourceCount: 0, expectedTotal: undefined, fingerprints: [], warnings: [], error: undefined, restartRequired: false };
}
export function mergeCompanyContracts(...collections: CompanyContract[][]): CompanyContract[] {
  const unique = new Map<string, CompanyContract>();
  for (const rows of collections) for (const row of rows) unique.set(`${row.businessNumber}|${row.id}`, row);
  return [...unique.values()].sort((a, b) => b.contractDate.localeCompare(a.contractDate) || b.contractNumber.localeCompare(a.contractNumber) || a.id.localeCompare(b.id));
}
