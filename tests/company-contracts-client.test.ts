import { describe, expect, it } from 'vitest';
import type { CompanyContract, CompanyContractPage } from '../src/company-contract-types';
import { appendContractPage, contractJobKey, createContractJobs, mergeCompanyContracts, restartContractJob, type ContractJob } from '../src/company/company-contracts';

const biz = '8488802470';
const item = (changes: Partial<CompanyContract> = {}): CompanyContract => ({
  id: `contract:${'a'.repeat(64)}`, type: '공사', businessNumber: biz, companyName: '함께하는개발',
  title: '송파문화예술회관 여가교실 철거공사', agency: '서울특별시 송파구', contractDate: '2026-10-07',
  contractNumber: 'R26TA0229571200', unifiedContractNumber: 'R26TE18812747', referenceNumber: 'R26TA0229571200',
  noticeNumber: '', method: '수의계약', contractAmount: 40640000, totalContractAmount: 40640000, shareRate: 100,
  sourceUrl: 'https://www.g2b.go.kr/link/FIUA027_01/single/?ctrtNo=R26TA02295712',
  registeredAt: '2026-10-12T09:58:56+09:00', changedAt: '', ...changes,
});
const job = (): ContractJob => createContractJobs(biz, '2026-10-01', '2026-10-14')[0];
const response = (target: ContractJob, changes: Partial<CompanyContractPage> = {}): CompanyContractPage => ({
  ...target.query, items: [item()], pageSize: 999, sourceCount: 1, totalCount: 1, hasMore: false,
  complete: true, sourceFingerprint: '1'.repeat(64), warnings: [], fetchedAt: '2026-10-15T00:00:00Z',
  source: '나라장터 계약정보서비스 · 계약 체결일 기준', ...changes,
});
const first = (target: ContractJob, changes: Partial<CompanyContractPage> = {}) => response(target, {
  sourceCount: 999, totalCount: 1000, hasMore: true, complete: false, ...changes,
});

describe('direct company contract continuation', () => {
  it('covers all calendar months newest first without an overall date limit', () => {
    const jobs = createContractJobs(biz, '2001-08-26', '2026-10-14');
    expect(jobs).toHaveLength(303 * 2);
    expect(jobs.slice(0, 2).map(value => value.query)).toEqual([
      { businessNumber: biz, type: '공사', from: '2026-10-01', to: '2026-10-14', page: 1 },
      { businessNumber: biz, type: '용역', from: '2026-10-01', to: '2026-10-14', page: 1 },
    ]);
    expect(jobs.at(-1)?.query.from).toBe('2001-08-26');
    expect(jobs.at(-1)?.query.to).toBe('2001-08-31');
    expect(createContractJobs(biz, '2024-02-29', '2024-03-01').map(value => value.query.from))
      .toEqual(['2024-03-01', '2024-03-01', '2024-02-29', '2024-02-29']);
    expect(() => createContractJobs('848880247', '2026-01-01', '2026-02-01')).toThrow();
  });

  it('continues a full nationwide page even when it contains zero company matches', () => {
    const initial = job();
    const next = appendContractPage(initial, first(initial, { items: [] }));
    expect(next.query.page).toBe(2); expect(next.status).toBe('idle');
    expect(next.items).toHaveLength(0); expect(next.sourceCount).toBe(999);
    const finished = appendContractPage(next, response(next, { totalCount: 1000, sourceFingerprint: '2'.repeat(64) }));
    expect(finished.status).toBe('complete'); expect(finished.items).toHaveLength(1);
    expect(finished.sourceCount).toBe(1000); expect(finished.query.page).toBe(2);
    expect(initial.query.page).toBe(1); expect(initial.items).toEqual([]);
  });

  it('refuses a changing national total without advancing the existing cursor or losing rows', () => {
    const initial = job(), next = appendContractPage(initial, first(initial));
    expect(() => appendContractPage(next, response(next, { items: [], totalCount: 1001, sourceCount: 2, sourceFingerprint: '2'.repeat(64) })))
      .toThrow('원본 건수가 변경');
    expect(next.query.page).toBe(2); expect(next.items).toEqual([item()]); expect(next.sourceCount).toBe(999);
  });

  it('detects repeated pages even when neither page matches the company', () => {
    const initial = job(), next = appendContractPage(initial, first(initial, { items: [], totalCount: 1998 }));
    expect(() => appendContractPage(next, response(next, { items: [], totalCount: 1998, sourceCount: 999 })))
      .toThrow('계약 목록이 반복');
  });

  it('rejects duplicate matching contracts crossing pages instead of silently counting twice', () => {
    const initial = job(), next = appendContractPage(initial, first(initial));
    expect(() => appendContractPage(next, response(next, { totalCount: 1000, sourceFingerprint: '2'.repeat(64) })))
      .toThrow('계약이 여러 페이지에 반복');
    expect(next.items).toHaveLength(1);
  });

  it('retains earlier unresolved warnings even if the final page alone is complete', () => {
    const initial = job();
    const next = appendContractPage(initial, first(initial, { items: [], warnings: ['일부 업체 목록을 확인하지 못했습니다.'] }));
    const finished = appendContractPage(next, response(next, { totalCount: 1000, sourceFingerprint: '2'.repeat(64) }));
    expect(finished.status).toBe('partial'); expect(finished.restartRequired).toBe(true);
    expect(finished.warnings).toHaveLength(1); expect(finished.items).toHaveLength(1);
  });

  it('retains previously displayed contracts during a restarted traversal until its full replacement completes', () => {
    const initial = job(), prior = appendContractPage(initial, first(initial));
    const restarting = restartContractJob({ ...prior, status: 'error', restartRequired: true });
    expect(restarting.query.page).toBe(1); expect(restarting.sourceCount).toBe(0);
    expect(restarting.items).toEqual([]); expect(restarting.previousItems).toEqual([item()]);
    const next = appendContractPage(restarting, first(restarting, { items: [] }));
    expect(mergeCompanyContracts(next.previousItems, next.items)).toEqual([item()]);
    const changed = item({ contractAmount: 50000000 });
    const finished = appendContractPage(next, response(next, { items: [changed], totalCount: 1000, sourceFingerprint: '2'.repeat(64) }));
    expect(finished.previousItems).toEqual([]); expect(finished.items).toEqual([changed]);
    expect(prior.items[0].contractAmount).toBe(40640000);
  });

  it('keeps partial replacement rows visible and does not drop old rows before a warned zero completes', () => {
    const initial = job(), completed = appendContractPage(initial, response(initial));
    const restarted = restartContractJob(completed);
    const partial = appendContractPage(restarted, response(restarted, {
      items: [], warnings: ['일부 계약 업체 목록이 없습니다.'], complete: false,
    }));
    expect(partial.status).toBe('partial'); expect(partial.previousItems).toHaveLength(1);
    const retry = restartContractJob(partial);
    const verifiedEmpty = appendContractPage(retry, response(retry, { items: [], totalCount: 0, sourceCount: 0 }));
    expect(verifiedEmpty.status).toBe('complete'); expect(verifiedEmpty.previousItems).toHaveLength(0);
  });

  it('rejects wrong companies, types, dates, cursor and inconsistent counts before displaying rows', () => {
    const initial = job();
    for (const changed of [
      { businessNumber: '3028128785' }, { type: '용역' }, { from: '2026-10-02' }, { page: 2 },
      { sourceCount: 0 }, { totalCount: -1 }, { hasMore: true }, { complete: false },
      { pageSize: 1000 }, { sourceFingerprint: 'not-a-hash' }, { items: null }, { warnings: [null] },
      { items: [item({ businessNumber: '3028128785' })] }, { items: [item({ contractDate: '2026-09-30' })] },
    ]) expect(() => appendContractPage(initial, { ...response(initial), ...changed })).toThrow();
    expect(initial.items).toEqual([]);
    expect(contractJobKey(initial)).not.toBe(contractJobKey({ query: { ...initial.query, businessNumber: '3028128785' } }));
  });

  it('validates public fields and safe links while preserving explicit zero and unknown amounts', () => {
    const initial = job();
    expect(appendContractPage(initial, response(initial, { items: [item({ contractAmount: 0, totalContractAmount: null, shareRate: 0 })] })).items[0])
      .toMatchObject({ contractAmount: 0, totalContractAmount: null, shareRate: 0 });
    for (const changed of [{ sourceUrl: 'javascript:alert(1)' }, { sourceUrl: 'https://g2b.go.kr.evil.test/' },
      { contractAmount: -1 }, { contractAmount: Infinity }, { shareRate: 101 }, { shareRate: -1 },
      { contractDate: '2026-02-29' }, { id: 'a-raw-provider-key' }]) {
      expect(() => appendContractPage(initial, response(initial, { items: [item(changed)] }))).toThrow();
    }
  });

  it('deduplicates replacements by exact contract identity and keeps amendments and companies distinct', () => {
    const rows = mergeCompanyContracts([item()], [item({ contractAmount: 50000000 }),
      item({ id: `contract:${'b'.repeat(64)}`, contractNumber: 'R26TA0229571201', contractDate: '2026-10-08' }),
      item({ businessNumber: '3028128785' }),
    ]);
    expect(rows).toHaveLength(3); expect(rows[0].contractNumber).toBe('R26TA0229571201');
    expect(rows.find(row => row.businessNumber === biz && row.id === item().id)?.contractAmount).toBe(50000000);
  });
});
