import { describe, expect, it } from 'vitest';
import type { CompanyAward } from '../src/company-award-types';
import { companyAwardTasks, companyAwardTaskKey, mergeCompanyAwards, normalizeAwardDay, splitCompanyAwardRange } from '../src/company/company-awards';

const award = (changes: Partial<CompanyAward> = {}): CompanyAward => ({
  id: 'provider-row-1', number: 'R26BK00001', revision: '000', type: '공사', title: '공사', agency: '기관',
  openingAt: '2026-10-01T10:00:00+09:00', rank: '', participantCount: null, bidAmount: null, bidRate: null,
  awarded: true, winningAmount: 55968000, method: '일반경쟁', businessNumber: '3028128785',
  classification: '1', rebid: '0', awardDate: '2026-10-02', awardRate: 88.1, ...changes,
});

describe('company award periods', () => {
  it('accepts documented registration-date forms and rejects calendar rollover', () => {
    expect(normalizeAwardDay('20210826')).toBe('2021-08-26');
    expect(normalizeAwardDay('2021-08-26 10:30:00')).toBe('2021-08-26');
    expect(normalizeAwardDay('2024-02-29T00:00:00+09:00')).toBe('2024-02-29');
    expect(normalizeAwardDay('2026-02-29')).toBeNull();
    expect(normalizeAwardDay('')).toBeNull();
    expect(normalizeAwardDay(undefined)).toBeNull();
  });
  it('covers a multi-year range without imposing a history limit or exceeding a provider month', () => {
    const slices = splitCompanyAwardRange('2021-08-26', '2026-10-15');
    expect(slices).toHaveLength(63);
    expect(slices[0]).toEqual({ from: '2026-10-01', to: '2026-10-15' });
    expect(slices.at(-1)).toEqual({ from: '2021-08-26', to: '2021-08-31' });
    let days = 0;
    for (const [index, slice] of slices.entries()) {
      const length = (Date.parse(slice.to) - Date.parse(slice.from)) / 86400000 + 1;
      expect(length).toBeGreaterThan(0); expect(length).toBeLessThanOrEqual(31);
      days += length;
      if (index > 0) expect(Date.parse(slices[index - 1].from) - Date.parse(slice.to)).toBe(86400000);
    }
    expect(days).toBe((Date.parse('2026-10-15') - Date.parse('2021-08-26')) / 86400000 + 1);
  });
  it('keeps leap days and one-day intervals exactly once', () => {
    expect(splitCompanyAwardRange('2024-02-29', '2024-03-01')).toEqual([{ from: '2024-03-01', to: '2024-03-01' }, { from: '2024-02-29', to: '2024-02-29' }]);
    expect(splitCompanyAwardRange('2026-10-15', '2026-10-15')).toEqual([{ from: '2026-10-15', to: '2026-10-15' }]);
    expect(() => splitCompanyAwardRange('2026-10-16', '2026-10-15')).toThrow();
    expect(() => splitCompanyAwardRange('', '2026-10-15')).toThrow();
  });
  it('queries both business types newest first and keeps company identities separate', () => {
    const tasks = companyAwardTasks('3028128785', '2026-09-30', '2026-10-15');
    expect(tasks.map(task => [task.type, task.from])).toEqual([['공사', '2026-10-01'], ['용역', '2026-10-01'], ['공사', '2026-09-30'], ['용역', '2026-09-30']]);
    expect(companyAwardTaskKey(tasks[0])).not.toBe(companyAwardTaskKey({ ...tasks[0], businessNumber: '8488802470' }));
  });
});

describe('company award identity', () => {
  it('deduplicates retried ranges while preserving lot, rebid, revision, type and company', () => {
    const initial = award();
    const rows = mergeCompanyAwards([initial], [award({ id: 'retried-provider-id', winningAmount: 60000000 }), award({ classification: '2' }), award({ rebid: '1' }), award({ revision: '001' }), award({ type: '용역' }), award({ businessNumber: '8488802470' })]);
    expect(rows).toHaveLength(6);
    expect(rows.find(row => row.id === 'retried-provider-id')?.winningAmount).toBe(60000000);
    expect(initial.winningAmount).toBe(55968000);
  });
  it('sorts by award date and never substitutes winning amount for bid amount', () => {
    const rows = mergeCompanyAwards([award(), award({ number: 'R26BK00002', awardDate: '2026-10-14', winningAmount: 0 })]);
    expect(rows[0].number).toBe('R26BK00002');
    expect(rows[0].winningAmount).toBe(0);
    expect(rows[0].bidAmount).toBeNull();
    expect(rows[0].bidRate).toBeNull();
    expect(rows[0].rank).toBe('');
  });
});
