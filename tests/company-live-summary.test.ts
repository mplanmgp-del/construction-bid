import { describe, expect, it } from 'vitest';
import type { CompanyParticipation, PublicCompany } from '../src/company-types';
import type { CompanyParticipationPage } from '../src/company-live-types';
import { companyParticipationTasks, liveCompanyHistory, participationPageRestartReason } from '../src/company/company-live-summary';

const company: PublicCompany = { businessNumber: '8488802470', name: '테스트', address: '', phone: '', representative: '', companyType: '', registrationDate: '2023-01-01', licenses: [], products: [], updatedAt: '' };
const row = (changes: Partial<CompanyParticipation> = {}): CompanyParticipation => ({ id: '1', number: 'R1', revision: '000', type: '공사', title: '공고', agency: '기관', openingAt: '2026-10-14 10:00:00', rank: '1', participantCount: null, bidAmount: null, bidRate: null, awarded: null, winningAmount: null, method: '', ...changes });
const options = { from: '2023-01-01', to: '2026-10-14', page: 1, outcome: 'all' as const, complete: false, fetchedAt: '' };
const page = (changes: Partial<CompanyParticipationPage> = {}): CompanyParticipationPage => ({ businessNumber: company.businessNumber, type: '공사', day: '2026-10-14', page: 1, pageSize: 999, totalCount: 2000, sourceCount: 999, hasMore: true, complete: true, pageFingerprint: 'first', items: [], warnings: [], source: 'public-api', fetchedAt: '2026-10-14T10:00:00Z', ...changes });

describe('direct company participation ranges and local summaries', () => {
  it('splits unlimited ranges into one-day construction and service tasks newest first', () => {
    const jobs = companyParticipationTasks(company.businessNumber, '2023-01-01', '2026-10-14');
    const days = (Date.parse('2026-10-14') - Date.parse('2023-01-01')) / 86400000 + 1;
    expect(jobs).toHaveLength(days * 2);
    expect(jobs.slice(0, 2).map(job => [job.day, job.type, job.page])).toEqual([['2026-10-14', '공사', 1], ['2026-10-14', '용역', 1]]);
    expect(jobs.at(-1)?.day).toBe('2023-01-01');
    expect(jobs.filter(job => job.day === '2024-02-29')).toHaveLength(2);
    expect(() => companyParticipationTasks(company.businessNumber, '2026-10-15', '2026-10-14')).toThrow();
  });
  it('deduplicates retried source rows and keeps unknown outcomes and amounts unknown', () => {
    const history = liveCompanyHistory(company, [row(), row()], options);
    expect(history.summary).toEqual({ participationCount: 1, winCount: 0, pendingCount: 1, winningAmount: null, bidAmount: null, averageBidRate: null });
    expect(history.items[0].awarded).toBeNull();
    expect(history.summary.winCount).toBe(0); // First rank alone never becomes a final award.
    expect(history.coverage.status).toBe('collecting');
    expect(history.competitors).toEqual([]);
  });
  it('aggregates only this response data and pages locally without treating national totals as company counts', () => {
    const rows = Array.from({ length: 62 }, (_, index) => row({ id: String(index), type: index % 2 ? '용역' : '공사', awarded: index < 2, winningAmount: index < 2 ? 100 : null, bidRate: 88 }));
    const history = liveCompanyHistory(company, rows, { ...options, page: 3, complete: true });
    expect(history.totalCount).toBe(62); expect(history.items).toHaveLength(2);
    expect(history.summary.winningAmount).toBe(200); expect(history.summary.averageBidRate).toBe(88);
    expect(history.businessTypes?.map(group => group.participationCount)).toEqual([31, 31]);
    expect(history.monthly[0].participationCount).toBe(62);
    expect(history.coverage.status).toBe('ready');
    const won = liveCompanyHistory(company, rows, { ...options, page: 10, outcome: 'won' });
    expect(won.totalCount).toBe(2); expect(won.page).toBe(1); expect(won.items).toHaveLength(2);
  });
  it('reports a verified empty whole range distinctly from an unfinished empty response', () => {
    expect(liveCompanyHistory(company, [], options).coverage.status).toBe('collecting');
    const complete = liveCompanyHistory(company, [], { ...options, complete: true });
    expect(complete.coverage.status).toBe('ready'); expect(complete.summary.participationCount).toBe(0);
  });
  it('requires restarting the affected date when national totals change between pages', () => {
    expect(participationPageRestartReason([page()], page({ page: 2, totalCount: 2001, pageFingerprint: 'second' }))).toContain('전체 건수가 바뀌었습니다');
    expect(participationPageRestartReason([page()], page({ page: 2, pageFingerprint: 'second' }))).toBeNull();
    expect(participationPageRestartReason([], page({ totalCount: 2001 }))).toBeNull();
  });
  it('rejects repeated provider pages but permits retrying the same page and distinct empty company matches', () => {
    expect(participationPageRestartReason([page()], page({ page: 2 }))).toContain('같은 페이지');
    expect(participationPageRestartReason([page()], page())).toBeNull();
    expect(participationPageRestartReason([page()], page({ page: 2, pageFingerprint: 'different-national-rows' }))).toBeNull();
  });
});
