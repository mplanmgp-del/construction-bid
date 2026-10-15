export const APP_MENUS = [
  { key: 'notices', label: '입찰공고', description: '공고 검색과 상세 정보 조회' },
  { key: 'bookmarks', label: '관심공고', description: '회원이 저장한 관심공고 목록' },
  { key: 'profile', label: '내 정보', description: '업체 정보와 내 바로가기 설정' },
  { key: 'results', label: 'MY입찰관리', description: '업체 검색과 입찰·낙찰·계약 이력' },
] as const;

export type MenuKey = typeof APP_MENUS[number]['key'];
export type MenuSetting = {
  menu_key: MenuKey;
  locked: boolean;
  message: string;
  updated_at: string;
  updated_by?: string | null;
};

export const DEFAULT_MAINTENANCE_MESSAGE = '기능을 점검하고 있습니다. 잠시 후 다시 이용해 주세요.';
export function isMenuKey(value: string): value is MenuKey {
  return APP_MENUS.some(menu => menu.key === value);
}
