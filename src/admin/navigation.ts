import type { MenuKey, MenuSetting } from './types';

export type AppView = MenuKey | 'admin' | 'account' | 'alerts' | 'custom';
const hashes: Record<AppView, string> = {
  notices: '', bookmarks: '#bookmarks', profile: '#profile', results: '#my-bids', admin: '#admin', account: '#account', alerts: '#alerts', custom: '#custom-search',
};
export function appViewFromHash(hash: string): AppView {
  return (Object.keys(hashes) as AppView[]).find(key => hashes[key] === hash) ?? 'notices';
}
export function appViewHash(view: AppView): string { return hashes[view]; }
export function menuIsLocked(view: AppView, ready: boolean, isAdmin: boolean, settings: MenuSetting[]): boolean {
  if (view === 'admin' || view === 'account' || view === 'alerts') return false;
  const menu = view === 'custom' ? 'notices' : view;
  return !ready || (!isAdmin && settings.find(setting => setting.menu_key === menu)?.locked !== false);
}
