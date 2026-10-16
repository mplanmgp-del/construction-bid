import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker() {
  const listeners: Record<string, (event: any) => void> = {};
  const openWindow = vi.fn(async (_url: string) => null), focus = vi.fn(async () => null);
  const showNotification = vi.fn<(title: string, options: { tag: string; renotify: boolean }) => Promise<void>>(async () => undefined);
  const skipWaiting = vi.fn(async () => undefined), claim = vi.fn(async () => undefined);
  const origin = 'https://app.example.com';
  const clients = { matchAll: vi.fn(async () => [] as any[]), openWindow, claim };
  const self = { location: { origin }, clients, skipWaiting, registration: { showNotification },
    addEventListener: (name: string, handler: (event: any) => void) => { listeners[name] = handler; } };
  runInNewContext(readFileSync(new URL('../public/alert-sw.js', import.meta.url), 'utf8'), { self, clients, URL });
  async function invoke(name: string, extra: object) {
    let pending = Promise.resolve();
    listeners[name]({ ...extra, waitUntil: (value: Promise<void>) => { pending = value; } });
    await pending;
  }
  return { listeners, invoke, openWindow, focus, showNotification, clients, origin, skipWaiting, claim };
}

describe('visible push and safe notification clicks', () => {
  const eventId = '1601db2e-5bcc-4bfd-981a-0b951f1de785';
  const push = (id = eventId) => ({ data: { json: () => ({ eventId: id, title: '새 공고', body: '철거 공고', notice: null }) } });
  it('activates a push-only worker update and claims existing clients without reloading their pages', async () => {
    const sw = worker();
    await sw.invoke('install', {}); expect(sw.skipWaiting).toHaveBeenCalledOnce(); expect(sw.claim).not.toHaveBeenCalled();
    await sw.invoke('activate', {}); expect(sw.claim).toHaveBeenCalledOnce();
    expect(sw.listeners.fetch).toBeUndefined(); expect(sw.openWindow).not.toHaveBeenCalled();
  });
  it('always displays a visible notification with a stable event tag, including invalid payload fallback', async () => {
    const sw = worker();
    await sw.invoke('push', push('event-1'));
    expect(sw.showNotification).toHaveBeenCalledWith('새 공고', expect.objectContaining({ body: '철거 공고', tag: 'bid-alert-event-1', renotify: false }));
    await sw.invoke('push', { data: { json: () => { throw new Error('invalid payload'); } } });
    expect(sw.showNotification).toHaveBeenCalledTimes(2);
  });
  it('renders every received push after worker restart with the same canonical tag and no replacement alert sound', async () => {
    const first = worker(), restarted = worker();
    await first.invoke('push', push(eventId.toUpperCase())); await restarted.invoke('push', push());
    for (const sw of [first, restarted]) expect(sw.showNotification).toHaveBeenCalledExactlyOnceWith('새 공고',
      expect.objectContaining({ tag: 'bid-alert-' + eventId, renotify: false }));
    await restarted.invoke('push', push('1601db2e-5bcc-4bfd-981a-0b951f1de786'));
    expect(restarted.showNotification.mock.calls[1][1]).toMatchObject({ tag: 'bid-alert-1601db2e-5bcc-4bfd-981a-0b951f1de786' });
  });
  it('waits for each concurrent push display instead of silently dropping a duplicate push', async () => {
    const sw = worker(); const releases: (() => void)[] = [];
    sw.showNotification.mockImplementation(() => new Promise<void>(resolve => { releases.push(resolve); }));
    let firstDone = false, secondDone = false;
    const first = sw.invoke('push', push()).then(() => { firstDone = true; });
    const second = sw.invoke('push', push()).then(() => { secondDone = true; });
    await vi.waitFor(() => expect(sw.showNotification).toHaveBeenCalledTimes(2));
    expect(firstDone).toBe(false); expect(secondDone).toBe(false);
    releases[0](); await first; expect(firstDone).toBe(true); expect(secondDone).toBe(false);
    releases[1](); await second;
    expect(sw.showNotification.mock.calls.map(call => call[1].tag)).toEqual(['bid-alert-' + eventId, 'bid-alert-' + eventId]);
  });
  it('retries a failed visible display when the push is resent', async () => {
    const sw = worker(); sw.showNotification.mockRejectedValueOnce(new Error('OS display failed'));
    await expect(sw.invoke('push', push())).rejects.toThrow('OS display failed');
    await sw.invoke('push', push()); expect(sw.showNotification).toHaveBeenCalledTimes(2);
  });
  it('constructs the exact same-origin number/revision/type deep link', async () => {
    const sw = worker();
    await sw.invoke('notificationclick', { notification: { close: vi.fn(), data: { notice: { number: 'R26BK01234567', revision: '003', type: '용역' }, url: 'https://evil.example/' } } });
    const target = new URL(sw.openWindow.mock.calls[0][0]!);
    expect(target.origin).toBe(sw.origin); expect(target.pathname).toBe('/notice-detail.html');
    expect(Object.fromEntries(target.searchParams)).toEqual({ number: 'R26BK01234567', revision: '003', type: '용역' });
  });
  it('uses the app alerts page when malicious notice data attempts URL injection', async () => {
    const sw = worker();
    await sw.invoke('notificationclick', { notification: { close: vi.fn(), data: { notice: { number: '//evil.example', revision: '000', type: '공사' }, url: 'javascript:alert(1)' } } });
    expect(sw.openWindow).toHaveBeenCalledWith(sw.origin + '/#alerts');
  });
  it('focuses only an already-open exact detail URL', async () => {
    const sw = worker(); const notice = { number: 'R26BK01234567', revision: '000', type: '공사' };
    const href = sw.origin + '/notice-detail.html?' + new URLSearchParams(notice);
    sw.clients.matchAll.mockResolvedValue([{ url: sw.origin + '/', focus: vi.fn() }, { url: href, focus: sw.focus }]);
    await sw.invoke('notificationclick', { notification: { close: vi.fn(), data: { notice } } });
    expect(sw.focus).toHaveBeenCalledOnce(); expect(sw.openWindow).not.toHaveBeenCalled();
  });
});
