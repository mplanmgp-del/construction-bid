import { describe, expect, it } from 'vitest';
import { loadPrototypeState, savePrototypeState, STORAGE_KEY } from '../src/storage';
import type { CompanyProfile } from '../src/types';

const profiles: CompanyProfile[] = [
  { id: 'seoul', companyName: '서울업체', province: '서울특별시', district: '마포구', address: '', licenses: [], contactName: '', email: '' },
  { id: 'gyeonggi', companyName: '경기업체', province: '경기도', district: '고양시', address: '', licenses: [], contactName: '', email: '' },
];

function memoryStorage(initial?: string) {
  const entries = new Map(initial ? [[STORAGE_KEY, initial]] : []);
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
}

describe('업체별 브라우저 저장', () => {
  it('새 브라우저에서 모든 예시 업체를 독립된 관심공고와 함께 시작한다', () => {
    const result = loadPrototypeState(profiles, memoryStorage());
    expect(result.state.profiles).toHaveLength(2);
    expect(result.state.activeProfileId).toBe('seoul');
    expect(result.state.bookmarks.seoul).toEqual([]);
    expect(result.state.bookmarks.gyeonggi).toEqual([]);
  });

  it('다른 업체의 관심공고를 섞지 않고 재열기 때 복원한다', () => {
    const storage = memoryStorage();
    const state = loadPrototypeState(profiles, storage).state;
    state.bookmarks.seoul = ['notice-1'];
    state.bookmarks.gyeonggi = ['notice-2'];
    state.profiles[0].companyName = '수정한 서울업체';
    state.activeProfileId = 'gyeonggi';
    expect(savePrototypeState(state, storage)).toBe(true);
    const restored = loadPrototypeState(profiles, storage).state;
    expect(restored.bookmarks.seoul).toEqual(['notice-1']);
    expect(restored.bookmarks.gyeonggi).toEqual(['notice-2']);
    expect(restored.profiles[0].companyName).toBe('수정한 서울업체');
    expect(restored.activeProfileId).toBe('gyeonggi');
    expect(profiles[0].companyName).toBe('서울업체');
  });

  it('잘못된 저장값은 오류를 알리고 원래 저장 문자열을 제거하지 않는다', () => {
    const storage = memoryStorage('not-valid-json');
    const result = loadPrototypeState(profiles, storage);
    expect(result.warning).toBeTruthy();
    expect(result.state.profiles).toHaveLength(2);
    expect(storage.getItem(STORAGE_KEY)).toBe('not-valid-json');
  });

  it('사업자등록번호를 숫자로 저장하고 다른 업체 및 예전 프로필을 그대로 보존한다', () => {
    const storage = memoryStorage();
    const state = loadPrototypeState(profiles, storage).state;
    state.profiles[0].businessNumber = '001-02-00003';
    state.bookmarks.seoul = ['notice-1'];
    expect(savePrototypeState(state, storage)).toBe(true);
    const restored = loadPrototypeState(profiles, storage);
    expect(restored.warning).toBeNull();
    expect(restored.state.profiles[0].businessNumber).toBe('0010200003');
    expect(restored.state.profiles[1]).toEqual(profiles[1]);
    expect(restored.state.bookmarks.seoul).toEqual(['notice-1']);
    expect(state.profiles[0].businessNumber).toBe('001-02-00003');
  });

  it('잘못된 사업자등록번호가 있는 저장값을 거부하고 원본을 보존한다', () => {
    const state = loadPrototypeState(profiles, memoryStorage()).state;
    const malformed = JSON.stringify({ ...state, profiles: [{ ...state.profiles[0], businessNumber: 1234567890 }] });
    const storage = memoryStorage(malformed);
    expect(loadPrototypeState(profiles, storage).warning).toBeTruthy();
    expect(storage.getItem(STORAGE_KEY)).toBe(malformed);
    state.profiles[0].businessNumber = '123';
    expect(savePrototypeState(state, storage)).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBe(malformed);
  });

  it('브라우저 저장이 막혀도 화면에서 사용할 초기값을 제공한다', () => {
    const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const result = loadPrototypeState(profiles, storage);
    expect(result.state.profiles[0].id).toBe('seoul');
    expect(result.warning).toBeTruthy();
    expect(savePrototypeState(result.state, storage)).toBe(false);
  });
});
