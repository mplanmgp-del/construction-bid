import { describe, expect, it } from 'vitest';
import { regionKey, regionLabel, selectedRegions, selectedStatuses, toggleSearchRegion } from '../src/search-filters';

describe('복수 검색조건과 기존 단일 검색조건', () => {
  it('새 배열을 우선하고 빈 배열도 전체 선택으로 보존한다', () => {
    expect(selectedStatuses({ status: '예정', statuses: ['진행중', '마감 임박', '진행중'] })).toEqual(['진행중', '마감 임박']);
    expect(selectedStatuses({ status: '예정', statuses: [] })).toEqual([]);
    expect(selectedRegions({ siteProvince: '부산', regions: [{ province: '서울' }, { province: '서울특별시' }] })).toEqual([{ province: '서울특별시' }]);
    expect(selectedRegions({ siteProvince: '부산', regions: [] })).toEqual([]);
  });

  it('새 배열이 없는 기존 저장조건의 상태와 시도를 유지한다', () => {
    expect(selectedStatuses({ status: '마감 임박' })).toEqual(['마감 임박']);
    expect(selectedStatuses({ status: '전체' })).toEqual([]);
    expect(selectedRegions({ siteProvince: '경기' })).toEqual([{ province: '경기도' }]);
    expect(selectedRegions({ siteProvince: '전체' })).toEqual([]);
  });

  it('지역 명칭과 키는 공백 및 시도 약칭을 정규화한다', () => {
    expect(regionLabel({ province: ' 경기 ', district: ' 수원시 ', locality: '장안구  파장동' })).toBe('경기도 수원시 장안구 파장동');
    expect(regionKey({ province: '서울', district: '강서구' })).toBe(regionKey({ province: '서울특별시', district: '강서구' }));
    expect(regionKey({ province: '서울', district: '강서구' })).not.toBe(regionKey({ province: '부산', district: '강서구' }));
    expect(regionLabel({ province: '세종시', district: '세종시', locality: '조치원읍' })).toBe('세종특별자치시 조치원읍');
  });
});

describe('계층 지역 체크박스 선택', () => {
  it('상위 선택은 같은 경로의 하위만 대체하고 다른 시도는 유지한다', () => {
    const current = [{ province: '서울', district: '강서구', locality: '등촌1동' }, { province: '서울', district: '강남구' }, { province: '경기' }];
    expect(toggleSearchRegion(current, { province: '서울' })).toEqual([{ province: '경기도' }, { province: '서울특별시' }]);
    expect(current).toHaveLength(3);
  });

  it('하위 선택은 같은 경로 상위 선택을 제거하며 형제 지역은 중복 선택한다', () => {
    const child = { province: '서울특별시', district: '강서구', locality: '등촌1동' };
    const first = toggleSearchRegion([{ province: '서울' }, { province: '부산', district: '강서구' }], child);
    expect(first).toEqual([{ province: '부산광역시', district: '강서구' }, child]);
    const sibling = { ...child, locality: '등촌2동' };
    expect(toggleSearchRegion(first, sibling)).toEqual([...first, sibling]);
    expect(toggleSearchRegion(toggleSearchRegion(first, sibling), sibling)).toEqual(first);
  });

  it('시·구 토큰도 계층으로 비교하지만 동 이름의 일부는 상위로 취급하지 않는다', () => {
    const parent = { province: '경기도', district: '수원시' };
    const child = { province: '경기도', district: '수원시 장안구', locality: '파장동' };
    expect(toggleSearchRegion([parent], child)).toEqual([child]);
    expect(toggleSearchRegion([child], parent)).toEqual([parent]);
    expect(toggleSearchRegion([{ province: '서울', district: '강남구', locality: '삼성동' }], { province: '서울', district: '강남구', locality: '삼성1동' })).toHaveLength(2);
  });

  it('동일 지역을 다시 선택하면 제거하며 저장된 중복도 정리한다', () => {
    expect(toggleSearchRegion([{ province: '서울' }, { province: '서울특별시' }, { province: '경기' }], { province: '서울' })).toEqual([{ province: '경기도' }]);
  });

  it('도시 경유와 일반구 경유로 선택한 동일 행정동은 하나의 선택으로 취급한다', () => {
    const viaCity = { province: '경기도', district: '수원시', locality: '장안구 파장동' };
    const viaWard = { province: '경기도', district: '수원시 장안구', locality: '파장동' };
    expect(regionKey(viaCity)).toBe(regionKey(viaWard));
    expect(toggleSearchRegion([viaCity], viaWard)).toEqual([]);
    expect(selectedRegions({ siteProvince: '전체', regions: [viaCity, viaWard] })).toHaveLength(1);
  });
});
