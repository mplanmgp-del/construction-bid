import type { CompanyProfile } from './types';
import { isOptionalBusinessNumber, normalizeBusinessNumber } from './company-profile';

export const STORAGE_KEY = 'construction-bid.prototype.v1';
export interface PrototypeState {
  version: 1;
  activeProfileId: string;
  profiles: CompanyProfile[];
  bookmarks: Record<string, string[]>;
  preferences: Record<string, { autoRegion: boolean }>;
}
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; }

function initialState(defaultProfiles: CompanyProfile[]): PrototypeState {
  const profiles = defaultProfiles.map(profile => ({ ...profile, licenses: [...profile.licenses] }));
  return {
    version: 1, activeProfileId: profiles[0].id, profiles,
    bookmarks: Object.fromEntries(profiles.map(profile => [profile.id, []])),
    preferences: Object.fromEntries(profiles.map(profile => [profile.id, { autoRegion: false }])),
  };
}

function isProfile(value: unknown): value is CompanyProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Record<string, unknown>;
  return ['id', 'companyName', 'province', 'district', 'address', 'contactName', 'email'].every(key => typeof profile[key] === 'string')
    && isOptionalBusinessNumber(profile.businessNumber)
    && Array.isArray(profile.licenses) && profile.licenses.every(license => typeof license === 'string');
}

export function loadPrototypeState(defaultProfiles: CompanyProfile[], storage?: StorageLike): { state: PrototypeState; warning: string | null } {
  const fallback = initialState(defaultProfiles);
  try {
    const raw = (storage ?? window.localStorage).getItem(STORAGE_KEY);
    if (!raw) return { state: fallback, warning: null };
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Array.isArray(saved.profiles) || !saved.profiles.every(isProfile)) throw new Error('invalid state');
    const profiles = defaultProfiles.map(profile => saved.profiles.find((item: CompanyProfile) => item.id === profile.id) ?? profile)
      .map(profile => ({ ...profile, licenses: [...profile.licenses],
        ...(profile.businessNumber === undefined ? {} : { businessNumber: normalizeBusinessNumber(profile.businessNumber)! }),
      }));
    const bookmarks: PrototypeState['bookmarks'] = {};
    const preferences: PrototypeState['preferences'] = {};
    for (const profile of profiles) {
      const ids = saved.bookmarks?.[profile.id];
      bookmarks[profile.id] = Array.isArray(ids) ? [...new Set(ids.filter((id: unknown): id is string => typeof id === 'string'))] as string[] : [];
      preferences[profile.id] = { autoRegion: typeof saved.preferences?.[profile.id]?.autoRegion === 'boolean' ? saved.preferences[profile.id].autoRegion : false };
    }
    return {
      state: { version: 1, profiles, bookmarks, preferences, activeProfileId: profiles.some(profile => profile.id === saved.activeProfileId) ? saved.activeProfileId : profiles[0].id },
      warning: null,
    };
  } catch {
    return { state: fallback, warning: '저장된 정보를 읽을 수 없어 예시 업체로 시작했습니다. 기존 저장값은 삭제하지 않았습니다.' };
  }
}

export function savePrototypeState(state: PrototypeState, storage?: StorageLike): boolean {
  try {
    if (!state.profiles.every(profile => isOptionalBusinessNumber(profile.businessNumber))) return false;
    const profiles = state.profiles.map(profile => ({ ...profile,
      ...(profile.businessNumber === undefined ? {} : { businessNumber: normalizeBusinessNumber(profile.businessNumber)! }),
    }));
    (storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify({ ...state, profiles }));
    return true;
  }
  catch { return false; }
}
