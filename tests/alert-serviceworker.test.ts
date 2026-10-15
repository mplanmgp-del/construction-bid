import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function worker() {
  const listeners: Record<string, (event: any) => void> = {};
  const openWindow = vi.fn(async (_url: string) => null), focus = vi.fn(async () => null), showNotification = vi.fn(async () => undefined);
  const origin = 'https://app.example.com';
  const clients = { matchAll: vi.fn(async () => [] as any[]), openWindow };
  const self = { location: { origin }, clients, registration: { showNotification }, addEventListener: (name: string, handler: (event: any) => void) => { listeners[name] = handler; } };
  runInNewContext(readFileSync(new URL('../public/alert-sw.js', import.meta.url), 'utf8'), { self, clients, URL });
  async function invoke(name: string, extra: object) {
    let pending = Promise.resolve();
    listeners[name]({ ...extra, waitUntil: (value: Promise<void>) => { pending = value; } });
    await pending;
  }
  return { listeners, invoke, openWindow, focus, showNotification, clients, origin };
}
describe('visible push and safe notification clicks', () => {
  it('always displays a visible notification with a stable event tag', async () => {
    const sw = worker();
    await sw.invoke('push', { data: { json: () => ({ eventId: 'event-1', title: '새 공고', body: '철거 공고', notice: null }) } });
    expect(sw.showNotification).toHaveBeenCalledWith('새 공고', expect.objectContaining({ body: '철거 공고', tag: 'bid-alert-event-1' }));
    await sw.invoke('push', { data: { json: () => { throw new Error('invalid payload'); } } });
    expect(sw.showNotification).toHaveBeenCalledTimes(2);
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
