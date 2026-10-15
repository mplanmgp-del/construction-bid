import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMemberClient } from '../member/client';
import { APP_MENUS, isMenuKey, type MenuKey, type MenuSetting } from './types';

const PUBLIC_COLUMNS = 'menu_key,locked,message,updated_at';
export type MenuAccessSnapshot = {
  userId: string | null; ready: boolean; isAdmin: boolean; settings: MenuSetting[];
  error: string | null; saving: MenuKey | null;
};
export type MenuAccessRepository = {
  load: (userId: string | null, signal: AbortSignal) => Promise<{ settings: unknown; isAdmin: boolean }>;
  update: (key: MenuKey, locked: boolean, message: string, signal: AbortSignal) => Promise<unknown>;
};
const empty = (userId: string | null): MenuAccessSnapshot => ({ userId, ready: false, isAdmin: false, settings: [], error: null, saving: null });

export function validateMenuSetting(value: unknown): MenuSetting {
  if (!value || typeof value !== 'object') throw new Error('Invalid menu setting');
  const row = value as Record<string, unknown>;
  if (typeof row.menu_key !== 'string' || !isMenuKey(row.menu_key) || typeof row.locked !== 'boolean'
    || typeof row.message !== 'string' || row.message.length > 300
    || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) throw new Error('Invalid menu setting');
  return { menu_key: row.menu_key, locked: row.locked, message: row.message, updated_at: row.updated_at };
}
export function validateMenuSettings(value: unknown): MenuSetting[] {
  if (!Array.isArray(value) || value.length !== APP_MENUS.length) throw new Error('Missing menu settings');
  const settings = value.map(validateMenuSetting);
  if (new Set(settings.map(row => row.menu_key)).size !== APP_MENUS.length) throw new Error('Duplicate menu settings');
  return APP_MENUS.map(menu => settings.find(row => row.menu_key === menu.key)!);
}

/** Role checks come only from the RLS-protected admin table, never from a profile or browser storage. */
export class MenuAccessController {
  private snapshot = empty(null);
  private listeners = new Set<() => void>();
  private generation = 0;
  private reading: AbortController | null = null;
  private writing: AbortController | null = null;
  constructor(private repository: MenuAccessRepository | null) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(snapshot: MenuAccessSnapshot) { this.snapshot = snapshot; this.listeners.forEach(listener => listener()); }
  setUser(userId?: string) {
    this.generation += 1; this.reading?.abort(); this.writing?.abort();
    this.publish(empty(userId || null));
  }
  async refresh(): Promise<void> {
    if (!this.repository) { this.publish({ ...empty(this.snapshot.userId), error: '메뉴 설정에 연결하지 못했습니다. 다시 확인해 주세요.' }); return; }
    this.reading?.abort();
    const request = new AbortController(); this.reading = request;
    const generation = this.generation; const userId = this.snapshot.userId;
    try {
      const response = await this.repository.load(userId, request.signal);
      const settings = validateMenuSettings(response.settings);
      if (request.signal.aborted || generation !== this.generation) return;
      this.publish({ ...this.snapshot, userId, ready: true, settings, isAdmin: Boolean(userId && response.isAdmin), error: null });
    } catch {
      if (request.signal.aborted || generation !== this.generation) return;
      this.publish({ ...empty(userId), error: '메뉴 설정을 확인하지 못했습니다. 다시 확인해 주세요.' });
    } finally { if (this.reading === request) this.reading = null; }
  }
  async update(key: MenuKey, locked: boolean, message: string): Promise<boolean> {
    if (!this.repository || !this.snapshot.ready || !this.snapshot.isAdmin || !this.snapshot.userId || this.snapshot.saving) return false;
    const text = message.trim();
    if (text.length > 300) { this.publish({ ...this.snapshot, error: '안내 문구는 300자 이내로 입력해 주세요.' }); return false; }
    const generation = this.generation; const request = new AbortController(); this.writing = request;
    this.publish({ ...this.snapshot, saving: key, error: null });
    try {
      const returned = validateMenuSetting(await this.repository.update(key, locked, text, request.signal));
      if (request.signal.aborted || generation !== this.generation) return false;
      if (returned.menu_key !== key || returned.locked !== locked || returned.message !== text) throw new Error('Menu update not confirmed');
      this.reading?.abort();
      this.publish({ ...this.snapshot, settings: this.snapshot.settings.map(row => row.menu_key === key ? returned : row), saving: null, error: null });
      return true;
    } catch {
      if (request.signal.aborted || generation !== this.generation) return false;
      this.publish({ ...this.snapshot, saving: null, error: '저장하지 못했습니다. 관리자 권한과 연결 상태를 확인한 뒤 다시 저장해 주세요.' });
      return false;
    } finally { if (this.writing === request) this.writing = null; }
  }
  dispose() { this.generation += 1; this.reading?.abort(); this.writing?.abort(); }
}

function createMenuRepository(): MenuAccessRepository | null {
  const client = getMemberClient(); if (!client) return null;
  return {
    async load(userId, signal) {
      const settingsQuery = client.from('bid_menu_settings').select(PUBLIC_COLUMNS).abortSignal(signal);
      const adminQuery = userId
        ? client.from('bid_admin_users').select('user_id').eq('user_id', userId).abortSignal(signal).maybeSingle()
        : Promise.resolve({ data: null, error: null });
      const [settings, admin] = await Promise.all([settingsQuery, adminQuery]);
      if (settings.error) throw settings.error;
      if (admin.error) throw admin.error;
      return { settings: settings.data, isAdmin: Boolean(userId && admin.data?.user_id === userId) };
    },
    async update(key, locked, message, signal) {
      const response = await client.from('bid_menu_settings').update({ locked, message }).eq('menu_key', key)
        .select(PUBLIC_COLUMNS).abortSignal(signal).maybeSingle();
      if (response.error) throw response.error;
      // RLS can yield zero updated rows without a transport error. Never call that a successful save.
      if (!response.data) throw new Error('Menu update was not authorized');
      return response.data;
    },
  };
}

export function useMenuAccess(userId?: string) {
  const controller = useMemo(() => new MenuAccessController(createMenuRepository()), []);
  const [snapshot, setSnapshot] = useState(controller.getSnapshot);
  useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller]);
  useEffect(() => {
    controller.setUser(userId); void controller.refresh();
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void controller.refresh(); };
    window.addEventListener('focus', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    const timer = window.setInterval(visibleRefresh, 30_000);
    return () => { window.removeEventListener('focus', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh); window.clearInterval(timer); controller.dispose(); };
  }, [controller, userId]);
  // A changed account cannot inherit even one render of the previous account's administrator status.
  const current = snapshot.userId === (userId || null) ? snapshot : empty(userId || null);
  const refresh = useCallback(async () => { if (controller.getSnapshot().userId === (userId || null)) await controller.refresh(); }, [controller, userId]);
  const update = useCallback(async (key: MenuKey, locked: boolean, message: string) => {
    if (controller.getSnapshot().userId !== (userId || null)) return false;
    return controller.update(key, locked, message);
  }, [controller, userId]);
  return { ready: current.ready, isAdmin: current.isAdmin, settings: current.settings, error: current.error, saving: current.saving, refresh, update };
}
