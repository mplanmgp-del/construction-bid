import { describe, expect, it } from 'vitest';
import directory from '../src/data/administrative-regions.json';
import { REGION_DIRECTORY_SOURCE, REGION_PROVINCES, regionDistricts, regionLocalities } from '../src/region-directory';

describe('official administrative region directory', () => {
  it('keeps a complete, uniquely coded official snapshot with its source and reference date', () => {
    expect(REGION_DIRECTORY_SOURCE.url).toBe('https://www.data.go.kr/data/3033254/fileData.do');
    expect(REGION_DIRECTORY_SOURCE.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(directory.rows.length).toBeGreaterThan(3_500);
    expect(new Set(directory.rows.map(row => row[0])).size).toBe(directory.rows.length);
    expect(directory.rows.every(([code, province, , locality]) => /^\d{10}$/.test(code) && province && locality)).toBe(true);
    expect(REGION_PROVINCES).toContain('서울특별시');
    expect(REGION_PROVINCES).toContain('전남광주통합특별시');
  });

  it('offers a whole city and each ward without losing the ward in child paths', () => {
    expect(regionDistricts('경기도')).toEqual(expect.arrayContaining(['수원시', '수원시 장안구', '성남시', '성남시 분당구', '화성시 동탄구']));
    expect(regionLocalities('경기도', '수원시 장안구')).toContain('파장동');
    expect(regionLocalities('경기도', '수원시')).toContain('장안구 파장동');
    expect(regionLocalities('경기도', '수원시')).not.toContain('파장동');
  });

  it('keeps administrative dong names distinct from legal dong names and similarly named districts', () => {
    expect(regionLocalities('서울특별시', '종로구')).toContain('청운효자동');
    expect(regionLocalities('서울특별시', '종로구')).not.toContain('청운동');
    expect(regionLocalities('서울특별시', '강서구')).toContain('염창동');
    expect(regionLocalities('부산광역시', '강서구')).not.toContain('염창동');
  });

  it('supports Sejong despite its officially empty district and preserves the source value', () => {
    expect(regionDistricts('세종특별자치시')).toEqual(['세종시']);
    expect(regionLocalities('세종특별자치시', '세종시')).toContain('조치원읍');
    expect(directory.rows.filter(row => row[1] === '세종특별자치시').every(row => row[2] === '')).toBe(true);
  });

  it('does not invent localities for an unknown region or expose mutable internal collections', () => {
    expect(regionDistricts('없는 시도')).toEqual([]);
    expect(regionLocalities('서울특별시', '없는 구')).toEqual([]);
    const districts = regionDistricts('서울특별시');
    districts.length = 0;
    expect(regionDistricts('서울특별시')).toContain('종로구');
  });
});
