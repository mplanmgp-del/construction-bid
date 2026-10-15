import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AlertsController, alertFilterFromSearch, type AlertRepository } from '../src/alerts/useAlerts';
import { AlertBell, AlertsPage } from '../src/alerts/AlertsPage';
import { DEFAULT_ALERT_SETTINGS, type AlertOverview } from '../src/alerts/types';
import { DEFAULT_FILTERS, NOTICES } from '../src/data';
import { appViewFromHash, appViewHash, menuIsLocked } from '../src/admin/navigation';

const overview = (overrides: Partial<AlertOverview> = {}): AlertOverview => ({
  settings: structuredClone(DEFAULT_ALERT_SETTINGS), notifications: [], unreadCount: 0, hasMore: false,
  existingMatches: [], existingHasMore: false,
  status: { configured: true, lastCheckedAt: null, coverageFrom: null, backfillPending: false, error: null, paused: false, pushConfigured: false },
  subscriptionCount: 0, publicKey: null, ...overrides,
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function repository(overrides: Partial<AlertRepository> = {}): AlertRepository {
  return { load: async () => overview(), mutate: async () => undefined, ...overrides };
}
function access(data = overview()) {
  return { userId: 'a', overview: data, loading: false, error: null, saving: false, reading: false, settingUp: false,
    loadingMore: false, loadingExisting: false, message: '', refresh: async () => true, save: async () => true,
    read: async () => true, setup: async () => true, loadMore: async () => true, loadExisting: async () => true };
}

describe('personal alert account lifecycle', () => {
  it('clears a previous account immediately and ignores its late response', async () => {
    const late = deferred<AlertOverview>();
    const load = vi.fn().mockResolvedValueOnce(overview({ unreadCount: 3 })).mockReturnValueOnce(late.promise).mockResolvedValueOnce(overview({ unreadCount: 7 }));
    const controller = new AlertsController(repository({ load }));
    controller.setUser('a'); await controller.refresh(); const pending = controller.refresh();
    controller.setUser('b');
    expect(controller.getSnapshot().overview).toBeNull();
    await controller.refresh(); late.resolve(overview({ unreadCount: 999 })); await pending;
    expect(controller.getSnapshot()).toMatchObject({ userId: 'b', overview: { unreadCount: 7 } });
    expect(load.mock.calls[1][2].aborted).toBe(true);
    controller.setUser(); expect(controller.getSnapshot().overview).toBeNull();
  });
  it('does not report saved when the server rejects settings and preserves the prior server state', async () => {
    const controller = new AlertsController(repository({ mutate: async () => { throw new Error('저장 권한을 확인해 주세요.'); } }));
    controller.setUser('a'); await controller.refresh();
    expect(await controller.save({ ...DEFAULT_ALERT_SETTINGS, enabled: true })).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ saving: false, message: '', error: '저장 권한을 확인해 주세요.', overview: { settings: { enabled: false } } });
  });
  it('marks reads through the server and refreshes authoritative unread count', async () => {
    const load = vi.fn().mockResolvedValueOnce(overview({ unreadCount: 1 })).mockResolvedValueOnce(overview({ unreadCount: 0 }));
    const mutate = vi.fn(async () => undefined); const controller = new AlertsController(repository({ load, mutate }));
    controller.setUser('a'); await controller.refresh();
    expect(await controller.read({ all: true })).toBe(true);
    expect(mutate.mock.calls[0].slice(0, 2)).toEqual(['read', { all: true }]);
    expect(controller.getSnapshot().overview?.unreadCount).toBe(0);
  });
  it('keeps the live search keyword and detailed conditions when preparing an alert filter', () => {
    const filter = alertFilterFromSearch({ ...DEFAULT_FILTERS, keyword: '', category: '석면', regions: [{ province: '경기도', district: '성남시' }], minAmount: '10000000' }, { type: '공사·용역', keyword: '철거', from: '2026-10-01', to: '2026-10-15' });
    expect(filter).toMatchObject({ keywords: ['철거'], types: ['공사', '용역'], categories: ['석면'], regions: ['경기도 성남시'], minAmount: 10000000 });
  });
  it('appends inbox pages without discarding existing matches and ignores duplicate inbox rows', async () => {
    const item = { id: 'one', kind: 'test' as const, notice: null, message: '첫 알림', changeFields: [], createdAt: '', readAt: null };
    const notice = { ...NOTICES[0], sourceUpdatedAt: '', regionComplete: true, licenseComplete: true };
    const load = vi.fn().mockResolvedValueOnce(overview({ notifications: [item], existingMatches: [notice], hasMore: true }))
      .mockResolvedValueOnce(overview({ notifications: [item, { ...item, id: 'two' }], existingMatches: [], hasMore: false }));
    const controller = new AlertsController(repository({ load })); controller.setUser('a'); await controller.refresh(); await controller.loadMore();
    expect(load.mock.calls[1].slice(0, 2)).toEqual([1, 0]);
    expect(controller.getSnapshot().overview?.notifications.map(row => row.id)).toEqual(['one', 'two']);
    expect(controller.getSnapshot().overview?.existingMatches).toEqual([notice]);
  });
  it('does not show a save confirmation if the authoritative reload fails', async () => {
    const load = vi.fn().mockResolvedValueOnce(overview()).mockRejectedValueOnce(new Error('최신 상태 확인 실패'));
    const controller = new AlertsController(repository({ load })); controller.setUser('a'); await controller.refresh();
    expect(await controller.save(DEFAULT_ALERT_SETTINGS)).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ message: '', error: '최신 상태 확인 실패', saving: false });
  });
  it('marks previously loaded older pages read after the server confirms read-all', async () => {
    const item = { id: 'one', kind: 'test' as const, notice: null, message: '알림', changeFields: [], createdAt: '', readAt: null };
    const load = vi.fn().mockResolvedValueOnce(overview({ notifications: [item, { ...item, id: 'older' }], unreadCount: 2 }))
      .mockResolvedValueOnce(overview({ notifications: [{ ...item, readAt: '2026-10-15T01:00:00Z' }], unreadCount: 0 }));
    const controller = new AlertsController(repository({ load })); controller.setUser('a'); await controller.refresh(); await controller.read({ all: true });
    expect(controller.getSnapshot().overview?.notifications.every(row => Boolean(row.readAt))).toBe(true);
  });
});

describe('alert presentation and direct links', () => {
  it('keeps alerts reachable independently of locked managed menus', () => {
    expect(appViewFromHash('#alerts')).toBe('alerts'); expect(appViewHash('alerts')).toBe('#alerts');
    expect(menuIsLocked('alerts', false, false, [])).toBe(false);
  });
  it('caps the visual bell badge while announcing the actual unread count', () => {
    const html = renderToStaticMarkup(<AlertBell unreadCount={123} onOpen={() => {}} />);
    expect(html).toContain('99+'); expect(html).toContain('알림, 읽지 않은 알림 123개');
  });
  it('shows a login affordance without editable personal controls to guests', () => {
    const html = renderToStaticMarkup(<AlertsPage alerts={access()} signedIn={false} onLogin={() => {}} />);
    expect(html).toContain('로그인하고 알림 받기'); expect(html).not.toContain('name="keywords"');
  });
  it('shows rule fields, real collection status, and escaped inbox content', () => {
    const notice = { ...NOTICES[0], sourceUpdatedAt: '', regionComplete: true, licenseComplete: true };
    const data = overview({ settings:{...DEFAULT_ALERT_SETTINGS,enabled:true}, notifications: [{ id: '1', kind: 'initial', notice: null, message: '<script>message</script>', changeFields: [], createdAt: '', readAt: null, existingCount: 5 },
      { id: '2', kind: 'changed', notice, message: '일정 변경', changeFields: ['마감일'], createdAt: '', readAt: null }],
      status: { ...overview().status, paused: true, error: '공공데이터 확인 대기', lastCheckedAt: '2026-10-15T01:00:00Z' } });
    const html = renderToStaticMarkup(<AlertsPage alerts={access(data)} signedIn onLogin={() => {}} isAdmin />);
    for (const field of ['keywords', 'excludeKeywords', 'regions', 'licenses', 'minAmount', 'maxAmount']) expect(html).toContain(`name="${field}"`);
    expect(html).toContain('기존 공고 5건 보기'); expect(html).toContain('공공데이터 확인 대기'); expect(html).toContain('수집 일시 중지');
    expect(html).toContain('&lt;script&gt;message&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('/notice-detail.html?number='); expect(html).toContain('마감일'); expect(html).toContain('서버 알림 설정');
  });
  it('distinguishes a disabled personal rule from a paused server',()=>{
    const data=overview({status:{...overview().status,configured:true,paused:true}});
    const html=renderToStaticMarkup(<AlertsPage alerts={access(data)} signedIn onLogin={()=>{}} />);
    expect(html).toContain('내 알림 꺼짐');
  });
});
