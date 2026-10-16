import { describe, expect, it } from 'vitest';
import { currentNotice, dateRangeError, koreanToday, mergeById, recentDates, safeG2bUrl } from '../src/live/client';
import { buildBidCsv, daysUntil, filterNotices } from '../src/domain';
import { DEFAULT_FILTERS, DEMO_PROFILES, NOTICES } from '../src/data';
import { buildBidWorkbook } from '../src/excel-export';

describe('real notice browser boundary', () => {
  it('accepts only secure official attachment hosts without credentials', () => {
    expect(safeG2bUrl('https://www.g2b.go.kr/file?a=1')).toBe('https://www.g2b.go.kr/file?a=1');
    for (const url of ['javascript:alert(1)', 'https://g2b.go.kr.evil.test/a', 'https://evil.test/g2b.go.kr', 'http://www.g2b.go.kr/a', 'https://u:p@www.g2b.go.kr/a', 'https://www.g2b.go.kr:8443/a']) expect(safeG2bUrl(url)).toBeUndefined();
  });
  it('computes real dates in Korea independently of host timezone and demo date', () => {
    expect(koreanToday(new Date('2026-10-12T15:01:00Z'))).toBe('2026-10-13');
    expect(recentDates(7, new Date('2026-10-12T15:01:00Z'))).toEqual({ from: '2026-10-07', to: '2026-10-13' });
    expect(daysUntil('2026-10-20T00:00:00+09:00', '2026-10-19')).toBe(1);
  });
  it('validates inclusive bounded ranges and invalid calendar dates', () => {
    expect(dateRangeError('2026-10-01', '2026-10-31', 31)).toBeNull();
    expect(dateRangeError('2026-10-01', '2026-11-01', 31)).toBeTruthy();
    expect(dateRangeError('2026-10-01', '2026-10-07', 7)).toBeNull();
    expect(dateRangeError('2026-10-01', '2026-10-08', 7)).toBeTruthy();
    expect(dateRangeError('2026-02-30', '2026-03-01', 31)).toBeTruthy();
    expect(dateRangeError('', '', 31)).toBeTruthy();
  });
  it('deduplicates pages while keeping revised records by distinct id', () => {
    expect(mergeById([{ id: 'A-000', value: 1 }], [{ id: 'A-000', value: 2 }, { id: 'A-001', value: 3 }])).toEqual([{ id: 'A-000', value: 2 }, { id: 'A-001', value: 3 }]);
  });
  it('matches official license display with dot variants and provider code suffix', () => {
    const bid = { ...NOTICES[0], licenseCodes: undefined, licenses: ['구조물해체ㆍ비계공사업/4995'] };
    expect(filterNotices([bid], { ...DEFAULT_FILTERS, category: '전체', status: '전체', autoRegion: false, license: '구조물해체·비계공사업' }, DEMO_PROFILES[0])).toHaveLength(1);
  });
  it('expires saved live snapshots but preserves cancellations and demos', () => {
    const bid = { ...NOTICES[0], deadline: '2026-10-12T09:00:00+09:00', source: 'live' as const };
    expect(currentNotice(bid, new Date('2026-10-12T10:00:00+09:00')).status).toBe('마감');
    expect(currentNotice({ ...bid, status: '취소' }, new Date('2026-10-12T10:00:00+09:00')).status).toBe('취소');
    expect(currentNotice({ ...bid, source: 'demo' }, new Date('2026-10-12T10:00:00+09:00')).status).toBe(bid.status);
  });
  it('exports provider text as literal cells and keeps won grouping', () => {
    const bid = { ...NOTICES[0], source: 'live' as const, title: '=HYPERLINK("https://bad.test")', agency: ' @SUM(A1)', estimatedPrice: 1200000 };
    const csv = buildBidCsv([bid]);
    expect(csv).toContain(`"'=HYPERLINK(""https://bad.test"")"`);
    expect(csv).toContain(`"' @SUM(A1)"`);
    expect(csv).toContain('"1,200,000"');
    const sheet = buildBidWorkbook([bid], DEMO_PROFILES[0], new Date('2026-10-12T00:00:00Z')).worksheets[0];
    expect(sheet.getCell('A3').value).toContain('나라장터 공개 데이터');
    expect(sheet.getCell('B6').value).toBe(bid.title);
  });
});
