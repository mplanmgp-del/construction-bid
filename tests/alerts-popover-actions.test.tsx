import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { AlertsAccess } from '../src/alerts/useAlerts';
import type { AlertInboxItem, AlertOverview } from '../src/alerts/types';
const hooks = vi.hoisted(() => {
  const slots: { value?: unknown; deps?: unknown[] }[] = []; let cursor = 0, dirty = false; let effects: (() => void)[] = [];
  return {
    state<T>(initial: T | (() => T)) { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? (initial as () => T)() : initial };
      return [slots[index].value as T, (value: T | ((previous: T) => T)) => { slots[index].value = typeof value === 'function' ? (value as (previous: T) => T)(slots[index].value as T) : value; dirty = true; }] as const; },
    ref(value: unknown) { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: value } }; return slots[index].value; },
    effect(callback: () => void, deps: unknown[]) { const index = cursor++; if (!slots[index] || !slots[index].deps || deps.some((value, i) => value !== slots[index].deps![i])) { slots[index] = { deps }; effects.push(callback); } },
    begin() { cursor = 0; dirty = false; }, commit() { const pending = effects; effects = []; pending.forEach(callback => callback()); }, dirty: () => dirty,
    reset() { slots.length = 0; effects = []; cursor = 0; dirty = false; },
  };
});
vi.mock('react', () => ({ useState: hooks.state, useRef: hooks.ref, useEffect: hooks.effect, useLayoutEffect: hooks.effect, useId: () => 'alerts-test' }));
import { AlertsPopoverContent } from '../src/alerts/AlertsPopover';
import { DEFAULT_ALERT_SETTINGS } from '../src/alerts/types';
import { NOTICES } from '../src/data';
type Target = { id: string } | { all: true };
type Access = AlertsAccess & { remove: (target: Target) => Promise<boolean>; restore: (target: Target) => Promise<boolean>; loadDeleted: () => Promise<boolean> };
const item = (id = 'one'): AlertInboxItem => ({ id, kind: 'new', notice: { ...NOTICES[0], title: '학교 철거 공사', sourceUpdatedAt: '', regionComplete: true, licenseComplete: true }, message: '새 맞춤 공고', changeFields: [], createdAt: '', readAt: null });
function access(patch: Partial<AlertOverview> = {}): Access {
  return { userId: 'a', overview: { settings: structuredClone(DEFAULT_ALERT_SETTINGS), notifications: [item()], unreadCount: 1, hasMore: false, existingMatches: [], existingHasMore: false,
    status: { configured: true, lastCheckedAt: null, coverageFrom: null, backfillPending: false, error: null, paused: false, pushConfigured: false }, subscriptionCount: 0, publicKey: null, ...patch },
    loading: false, loadingMore: false, loadingExisting: false, saving: false, reading: false, settingUp: false, error: null, message: '',
    refresh: vi.fn(async () => true), save: vi.fn(async () => true), read: vi.fn(async () => true), setup: vi.fn(async () => true), loadMore: vi.fn(async () => true), loadExisting: vi.fn(async () => true),
    remove: vi.fn(async () => true), restore: vi.fn(async () => true), loadDeleted: vi.fn(async () => true), };
}
type Node = ReactElement<Record<string, unknown>>;
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (typeof node === 'string' || typeof node === 'number') return String(node); return node && typeof node === 'object' && 'props' in node ? text((node as Node).props.children) : ''; }
function find(node: unknown, test: (node: Node) => boolean): Node | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, test)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const element = node as Node; return test(element) ? element : find(element.props.children, test);
}
function mount(alerts = access()) {
  const onClose = vi.fn(), onBookmark = vi.fn(); let tree: unknown;
  const render = () => { hooks.begin(); tree = AlertsPopoverContent({ alerts, signedIn: true, headingId: 'heading', onLogin: vi.fn(), onClose, onOpenSettings: vi.fn(), onOpenExisting: vi.fn(), onBookmark }); hooks.commit(); };
  const settle = async () => { for (let i = 0; i < 15; i++) { if (hooks.dirty()) render(); await Promise.resolve(); } };
  render();
  return { alerts, onClose, onBookmark, settle, render, get tree() { return tree; }, button(label: string) { const found = find(tree, node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label)); if (!found) throw new Error(`Missing button: ${label}`); return found; }, content: () => text(tree), async click(label: string) { const button = this.button(label); const result = (button.props.onClick as () => unknown)(); await settle(); return result; } };
}
beforeEach(() => hooks.reset());
it('deletes one inbox item only after server success and moves focus to the safe heading', async () => {
  const view = mount(); await view.settle(); let resolve!: (value: boolean) => void;
  vi.mocked(view.alerts.remove).mockImplementation(() => new Promise(done => { resolve = done; }));
  const focus = vi.fn(); const heading = find(view.tree, node => node.type === 'h2')!; (heading.props.ref as { current: unknown }).current = { focus };
  await view.click('학교 철거 공사 알림 삭제');
  expect(view.alerts.remove).toHaveBeenCalledWith({ id: 'one' });
  expect(view.content()).not.toContain('알림을 삭제했습니다');
  expect(view.button('학교 철거 공사 알림 삭제').props.disabled).toBe(true);
  const preventDefault = vi.fn();
  (find(view.tree, node => node.type === 'a')!.props.onClick as (event: { preventDefault: () => void }) => void)({ preventDefault });
  const bookmark = find(view.tree, node => typeof node.type === 'function' && node.type.name === 'BookmarkButton')!;
  (bookmark.props.onToggle as () => void)();
  expect(preventDefault).toHaveBeenCalled();
  view.alerts.overview!.notifications = []; resolve(true); await view.settle();
  expect(view.content()).toContain('알림을 삭제했습니다.'); expect(view.content()).toContain('삭제한 알림에서 복원할 수 있습니다.'); expect(focus).toHaveBeenCalled();
  expect(view.onBookmark).not.toHaveBeenCalled(); expect(view.onClose).not.toHaveBeenCalled();
});
it('requires inline confirmation for deleting every inbox page, including unloaded older alerts', async () => {
  const view = mount(access({ notifications: [], unreadCount: 0, hasMore: true })); await view.settle();
  expect(view.button('전체 삭제').props.disabled).toBeFalsy(); await view.click('전체 삭제');
  expect(view.alerts.remove).not.toHaveBeenCalled(); expect(view.content()).toContain('받은 알림을 모두 삭제할까요?');
  await view.click('전체 알림 삭제'); expect(view.alerts.remove).toHaveBeenCalledWith({ all: true });
});
it('disables delete controls while a read mutation occupies the same account writer', async () => {
  const alerts = access(); alerts.reading = true; const view = mount(alerts); await view.settle();
  expect(view.button('학교 철거 공사 알림 삭제').props.disabled).toBe(true);
  expect(view.button('전체 삭제').props.disabled).toBe(true);
  await view.click('학교 철거 공사 알림 삭제'); expect(alerts.remove).not.toHaveBeenCalled();
});
it('keeps a failed deletion visible without reporting success', async () => {
  const view = mount(); await view.settle(); vi.mocked(view.alerts.remove).mockImplementation(async () => { view.alerts.error = '최신 삭제 상태 확인 실패'; return false; });
  await view.click('학교 철거 공사 알림 삭제');
  expect(view.content()).toContain('최신 삭제 상태 확인 실패'); expect(view.content()).not.toContain('알림을 삭제했습니다'); expect(view.content()).toContain('학교 철거 공사');
});
it('preserves safe keyboard focus if server deletion succeeded but the authoritative refresh failed', async () => {
  const view = mount(); await view.settle(); const focus = vi.fn();
  (find(view.tree, node => node.type === 'h2')!.props.ref as { current: unknown }).current = { focus };
  vi.mocked(view.alerts.remove).mockImplementation(async () => { view.alerts.overview!.notifications = []; view.alerts.error = '최신 삭제 상태 확인 실패'; return false; });
  await view.click('학교 철거 공사 알림 삭제');
  expect(view.content()).not.toContain('알림을 삭제했습니다'); expect(view.content()).toContain('최신 삭제 상태 확인 실패');
  expect(focus).toHaveBeenCalled();
});
it('loads deleted alerts on demand, restores one and all, and returns to the received inbox', async () => {
  const view = mount(); await view.settle();
  vi.mocked(view.alerts.loadDeleted).mockImplementation(async () => { Object.assign(view.alerts.overview!, { deletedNotifications: [item('deleted')], deletedHasMore: true, deletedCount: 2 }); return true; });
  await view.click('삭제한 알림'); expect(view.alerts.loadDeleted).toHaveBeenCalledOnce(); expect(view.content()).toContain('학교 철거 공사');
  await view.click('학교 철거 공사 알림 복원'); expect(view.alerts.restore).toHaveBeenCalledWith({ id: 'deleted' }); expect(view.content()).toContain('알림을 복원했습니다.');
  await view.click('전체 복원'); expect(view.alerts.restore).toHaveBeenCalledWith({ all: true });
  await view.click('삭제한 알림 더 보기'); expect(view.alerts.loadDeleted).toHaveBeenCalledTimes(2);
  await view.click('받은 알림'); expect(view.content()).toContain('새 맞춤 공고'); expect(view.alerts.read).not.toHaveBeenCalled();
});
it('resets the trash view and its confirmation when the signed-in account changes', async () => {
  const view = mount(); await view.settle(); await view.click('삭제한 알림');
  view.alerts.userId = 'b'; view.alerts.overview = { ...view.alerts.overview!, notifications: [], unreadCount: 0 }; view.render(); await view.settle();
  expect(view.content()).toContain('아직 받은 알림이 없습니다.'); expect(view.content()).not.toContain('알림을 삭제했습니다'); expect(view.button('삭제한 알림')).toBeTruthy();
});
