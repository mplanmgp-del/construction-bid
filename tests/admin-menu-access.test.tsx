import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AdminPage, LockedMenu } from '../src/admin/AdminPage';
import { MenuAccessController, validateMenuSettings, type MenuAccessRepository } from '../src/admin/useMenuAccess';
import { APP_MENUS, type MenuKey, type MenuSetting } from '../src/admin/types';

const rows = (): MenuSetting[] => APP_MENUS.map(menu => ({ menu_key: menu.key, locked: menu.key === 'results', message: '점검 중입니다.', updated_at: '2026-10-15T01:00:00.000Z' }));
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function repository(overrides: Partial<MenuAccessRepository> = {}): MenuAccessRepository {
  return { load: async userId => ({ settings: rows(), isAdmin: userId === 'admin' }), update: async (key, locked, message) => ({ menu_key: key, locked, message, updated_at: '2026-10-15T02:00:00.000Z' }), ...overrides };
}

describe('menu access validation and permission lifecycle', () => {
  it('accepts exactly the four known menu rows and ignores unnecessary actor identifiers', () => {
    const parsed = validateMenuSettings(rows().map(row => ({ ...row, updated_by: 'private-admin-id' })).reverse());
    expect(parsed.map(row => row.menu_key)).toEqual(APP_MENUS.map(menu => menu.key));
    expect(parsed.every(row => !('updated_by' in row))).toBe(true);
    expect(() => validateMenuSettings(rows().slice(1))).toThrow();
    expect(() => validateMenuSettings([...rows().slice(0, 3), rows()[0]])).toThrow();
    expect(() => validateMenuSettings(rows().map(row => row.menu_key === 'results' ? { ...row, locked: 'false' } : row))).toThrow();
  });

  it('fails closed until authoritative settings and role checks both finish', async () => {
    const response = deferred<{ settings: unknown; isAdmin: boolean }>();
    const controller = new MenuAccessController(repository({ load: () => response.promise }));
    controller.setUser('admin'); const pending = controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ ready: false, isAdmin: false, settings: [] });
    response.resolve({ settings: rows(), isAdmin: true }); await pending;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, isAdmin: true });
  });

  it('does not grant administrator privileges to an anonymous response', async () => {
    const controller = new MenuAccessController(repository({ load: async () => ({ settings: rows(), isAdmin: true }) }));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ ready: true, isAdmin: false });
    expect(await controller.update('results', false, '')).toBe(false);
  });

  it('removes prior admin state immediately and ignores a late response after changing accounts', async () => {
    const old = deferred<{ settings: unknown; isAdmin: boolean }>();
    const load = vi.fn().mockResolvedValueOnce({ settings: rows(), isAdmin: true }).mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce({ settings: rows(), isAdmin: false });
    const controller = new MenuAccessController(repository({ load }));
    controller.setUser('admin'); await controller.refresh();
    const oldPending = controller.refresh();
    controller.setUser('ordinary');
    expect(controller.getSnapshot()).toMatchObject({ ready: false, isAdmin: false, userId: 'ordinary', settings: [] });
    await controller.refresh(); old.resolve({ settings: rows().map(row => ({ ...row, locked: false })), isAdmin: true }); await oldPending;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, isAdmin: false, userId: 'ordinary' });
    expect(controller.getSnapshot().settings.find(row => row.menu_key === 'results')?.locked).toBe(true);
  });

  it('closes menus if settings are missing or a later permission refresh fails', async () => {
    const load = vi.fn().mockResolvedValueOnce({ settings: rows(), isAdmin: true }).mockResolvedValueOnce({ settings: rows().slice(1), isAdmin: true });
    const controller = new MenuAccessController(repository({ load })); controller.setUser('admin'); await controller.refresh(); await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ ready: false, isAdmin: false, settings: [] });
    expect(controller.getSnapshot().error).toContain('확인하지 못했습니다');
  });

  it('does not optimistically unlock and requires a confirmed returned row', async () => {
    const returned = deferred<unknown>(); const controller = new MenuAccessController(repository({ update: () => returned.promise }));
    controller.setUser('admin'); await controller.refresh();
    const pending = controller.update('results', false, '새 안내');
    expect(controller.getSnapshot().saving).toBe('results');
    expect(controller.getSnapshot().settings.find(row => row.menu_key === 'results')?.locked).toBe(true);
    returned.resolve(null); expect(await pending).toBe(false);
    expect(controller.getSnapshot().settings.find(row => row.menu_key === 'results')?.locked).toBe(true);
    expect(controller.getSnapshot().saving).toBeNull();
    expect(controller.getSnapshot().error).toContain('저장하지 못했습니다');
  });

  it('rejects a mismatched updated row and preserves the previous setting on permission errors', async () => {
    const update = vi.fn().mockResolvedValueOnce(rows()[0]).mockRejectedValueOnce(new Error('42501 permission denied'));
    const controller = new MenuAccessController(repository({ update })); controller.setUser('admin'); await controller.refresh();
    expect(await controller.update('results', false, '')).toBe(false);
    expect(await controller.update('results', false, '')).toBe(false);
    expect(controller.getSnapshot().settings.find(row => row.menu_key === 'results')?.locked).toBe(true);
  });

  it('applies successful persisted settings and rejects overlapping saves', async () => {
    const returned = deferred<unknown>(); const update = vi.fn(() => returned.promise);
    const controller = new MenuAccessController(repository({ update })); controller.setUser('admin'); await controller.refresh();
    const pending = controller.update('results', false, '  정상 운영  ');
    expect(await controller.update('profile', true, '다른 메뉴')).toBe(false);
    returned.resolve({ ...rows()[3], locked: false, message: '정상 운영' });
    expect(await pending).toBe(true); expect(update).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().settings[3]).toMatchObject({ locked: false, message: '정상 운영' });
  });

  it('ignores a save result after sign-out and forbids a non-admin write', async () => {
    const returned = deferred<unknown>(); const update = vi.fn(() => returned.promise);
    const controller = new MenuAccessController(repository({ update })); controller.setUser('admin'); await controller.refresh();
    const pending = controller.update('results', false, ''); controller.setUser();
    returned.resolve({ ...rows()[3], locked: false, message: '' });
    expect(await pending).toBe(false); expect(controller.getSnapshot()).toMatchObject({ ready: false, isAdmin: false, saving: null, settings: [] });
    controller.setUser('ordinary'); await controller.refresh(); expect(await controller.update('results', false, '')).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('admin and locked-menu presentation', () => {
  function access(overrides = {}) { return { ready: true, isAdmin: true, settings: rows(), error: null, saving: null as MenuKey | null, refresh: async () => {}, update: async () => true, ...overrides }; }
  it('renders the four menu controls with explicit saves and admin preview guidance', () => {
    const markup = renderToStaticMarkup(<AdminPage access={access()} onLogin={() => {}} />);
    expect((markup.match(/role="switch"/g) || [])).toHaveLength(4);
    for (const menu of APP_MENUS) expect(markup).toContain(`${menu.label} 설정 저장`);
    expect(markup).toContain('관리자 계정은 잠긴 메뉴도 확인할 수 있습니다');
  });
  it('shows a restricted screen and no editable controls to non-admins', () => {
    const markup = renderToStaticMarkup(<AdminPage access={access({ isAdmin: false })} onLogin={() => {}} />);
    expect(markup).toContain('관리자 전용 페이지'); expect(markup).not.toContain('role="switch"'); expect(markup).not.toContain('<textarea');
  });
  it('keeps login available on a locked profile menu and escapes the maintenance message', () => {
    const markup = renderToStaticMarkup(<LockedMenu menu="profile" setting={{ ...rows()[2], locked: true, message: '<script>test</script>' }} onLogin={() => {}} onRetry={() => {}} />);
    expect(markup).toContain('관리자 로그인'); expect(markup).toContain('다시 확인'); expect(markup).toContain('&lt;script&gt;'); expect(markup).not.toContain('<script>');
    const loading = renderToStaticMarkup(<LockedMenu menu="results" loading onLogin={() => {}} onRetry={() => {}} />);
    expect(loading).toContain('이용 상태를 확인하고 있습니다'); expect(loading).not.toContain('서비스 점검 중입니다');
  });
});
