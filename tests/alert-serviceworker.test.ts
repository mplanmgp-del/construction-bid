import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** A small transactional IndexedDB harness; shared records survive worker contexts. */
function deliveryLedger(options: { openFailure?: boolean } = {}) {
  const records = new Map<string, any>();
  const queue: (() => void)[] = [];
  let created = false, active = false;
  const begin = () => { if (!active && queue.length) { active = true; queueMicrotask(queue.shift()!); } };
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore: () => { created = true; }, close: vi.fn(),
    transaction: () => {
      let working = new Map<string, any>(), started = false, scheduled = false;
      const jobs: (() => void)[] = [];
      const tx: any = { error: null };
      const drain = () => {
        scheduled = false;
        if (jobs.length) { jobs.shift()!(); schedule(); return; }
        records.clear(); working.forEach((value, key) => records.set(key, structuredClone(value)));
        tx.oncomplete?.(); active = false; begin();
      };
      const schedule = () => { if (started && !scheduled) { scheduled = true; queueMicrotask(drain); } };
      const request = (read: () => any) => {
        const result: any = {};
        jobs.push(() => { result.result = read(); result.onsuccess?.(); }); schedule(); return result;
      };
      tx.objectStore = () => ({ get: (id: string) => request(() => structuredClone(working.get(id))),
        put: (row: any) => request(() => { working.set(row.id, structuredClone(row)); }),
        delete: (id: string) => request(() => { working.delete(id); }) });
      queue.push(() => { working = new Map([...records].map(([key, value]) => [key, structuredClone(value)])); started = true; schedule(); }); begin();
      return tx;
    },
  };
  const indexedDB = { open: vi.fn(() => {
    const request: any = {};
    queueMicrotask(() => {
      if (options.openFailure) { request.error = new Error('IndexedDB denied'); request.onerror?.(); return; }
      request.result = db; if (!created) request.onupgradeneeded?.(); request.onsuccess?.();
    });
    return request;
  }) };
  return { indexedDB, records };
}
function worker(options: { ledger?: ReturnType<typeof deliveryLedger>; databaseUnavailable?: boolean } = {}) {
  const listeners: Record<string, (event: any) => void> = {};
  const openWindow = vi.fn(async (_url: string) => null), focus = vi.fn(async () => null), showNotification = vi.fn(async (): Promise<void> => undefined);
  const skipWaiting = vi.fn(async () => undefined), claim = vi.fn(async () => undefined);
  const origin = 'https://app.example.com';
  const clients = { matchAll: vi.fn(async () => [] as any[]), openWindow, claim };
  const self = { location: { origin }, clients, skipWaiting, ...(options.databaseUnavailable ? {} : { indexedDB: options.ledger?.indexedDB ?? deliveryLedger().indexedDB }), registration: { showNotification }, addEventListener: (name: string, handler: (event: any) => void) => { listeners[name] = handler; } };
  runInNewContext(readFileSync(new URL('../public/alert-sw.js', import.meta.url), 'utf8'), { self, clients, URL });
  async function invoke(name: string, extra: object) {
    let pending = Promise.resolve();
    listeners[name]({ ...extra, waitUntil: (value: Promise<void>) => { pending = value; } });
    await pending;
  }
  return { listeners, invoke, openWindow, focus, showNotification, clients, origin, skipWaiting, claim };
}
describe('visible push and safe notification clicks', () => {
  it('activates a push-only worker update and claims existing clients without reloading their pages', async () => {
    const sw = worker();
    await sw.invoke('install', {}); expect(sw.skipWaiting).toHaveBeenCalledOnce(); expect(sw.claim).not.toHaveBeenCalled();
    await sw.invoke('activate', {}); expect(sw.claim).toHaveBeenCalledOnce();
    expect(sw.listeners.fetch).toBeUndefined(); expect(sw.openWindow).not.toHaveBeenCalled();
  });
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

describe('durable event idempotency across visible push lifetimes', () => {
  const eventId = '1601db2e-5bcc-4bfd-981a-0b951f1de785';
  const push = (id = eventId) => ({ data: { json: () => ({ eventId: id, title: '신규 공고', body: '비공개 본문', notice: { number: 'R26BK01234567', revision: '000', type: '공사' } }) } });
  it('suppresses the same event after dismissal and a complete worker restart', async () => {
    const ledger = deliveryLedger();
    const first = worker({ ledger }); await first.invoke('push', push());
    expect(first.showNotification).toHaveBeenCalledOnce();
    const restarted = worker({ ledger }); await restarted.invoke('push', push());
    expect(restarted.showNotification).not.toHaveBeenCalled();
    await restarted.invoke('push', push('1601db2e-5bcc-4bfd-981a-0b951f1de786'));
    expect(restarted.showNotification).toHaveBeenCalledOnce();
  });
  it('atomically claims concurrent deliveries from separate worker instances', async () => {
    const ledger = deliveryLedger(); const first = worker({ ledger }), second = worker({ ledger });
    let finish!: () => void; first.showNotification.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = first.invoke('push', push());
    await vi.waitFor(() => expect(first.showNotification).toHaveBeenCalledOnce());
    await second.invoke('push', push()); expect(second.showNotification).not.toHaveBeenCalled();
    finish(); await pending;
    await second.invoke('push', push()); expect(second.showNotification).not.toHaveBeenCalled();
  });
  it('joins concurrent duplicate events within the same worker', async () => {
    const sw = worker(); let finish!: () => void;
    sw.showNotification.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = sw.invoke('push', push()), second = sw.invoke('push', push());
    await vi.waitFor(() => expect(sw.showNotification).toHaveBeenCalledOnce());
    finish(); await Promise.all([first, second]); expect(sw.showNotification).toHaveBeenCalledOnce();
  });
  it('releases an unsuccessful visible display so a resend can retry', async () => {
    const ledger = deliveryLedger(); const sw = worker({ ledger });
    sw.showNotification.mockRejectedValueOnce(new Error('OS display unavailable'));
    await expect(sw.invoke('push', push())).rejects.toThrow('OS display unavailable');
    await sw.invoke('push', push()); expect(sw.showNotification).toHaveBeenCalledTimes(2);
    const restarted = worker({ ledger }); await restarted.invoke('push', push()); expect(restarted.showNotification).not.toHaveBeenCalled();
  });
  it('recovers an expired unfinished claim while suppressing a still-active claim', async () => {
    const ledger = deliveryLedger();
    ledger.records.set(eventId, { id: eventId, state: 'showing', token: 'crashed-worker', leaseUntil: Date.now() + 60_000 });
    const sw = worker({ ledger }); await sw.invoke('push', push()); expect(sw.showNotification).not.toHaveBeenCalled();
    ledger.records.set(eventId, { ...ledger.records.get(eventId), leaseUntil: Date.now() - 1 });
    await sw.invoke('push', push()); expect(sw.showNotification).toHaveBeenCalledOnce();
  });
  it('stores only the canonical event identity and delivery metadata', async () => {
    const ledger = deliveryLedger(); const sw = worker({ ledger });
    await sw.invoke('push', push(eventId.toUpperCase()));
    const entry = ledger.records.get(eventId);
    expect(entry).toMatchObject({ id: eventId, state: 'delivered', deliveredAt: expect.any(Number) });
    expect(Object.keys(entry).sort()).toEqual(['deliveredAt', 'id', 'state']);
    expect(JSON.stringify([...ledger.records.values()])).not.toContain('비공개');
    await sw.invoke('push', push()); expect(sw.showNotification).toHaveBeenCalledOnce();
  });
  it('keeps a visible fallback for invalid payload identities and unavailable browser storage', async () => {
    const sw = worker({ databaseUnavailable: true });
    await sw.invoke('push', push()); await sw.invoke('push', push('invalid event id'));
    expect(sw.showNotification).toHaveBeenCalledTimes(2);
    const ledger = deliveryLedger(); const invalid = worker({ ledger });
    await invalid.invoke('push', push('event-1')); await invalid.invoke('push', push('event-1'));
    expect(invalid.showNotification).toHaveBeenCalledTimes(2); expect(ledger.records.size).toBe(0);
  });
  it('still displays a visible notification when opening IndexedDB is denied', async () => {
    const ledger = deliveryLedger({ openFailure: true }); const sw = worker({ ledger });
    await sw.invoke('push', push()); expect(sw.showNotification).toHaveBeenCalledOnce(); expect(ledger.records.size).toBe(0);
  });
  it.each([false, true])('does not overwrite or release a newer claim when an old display completes with failure=%s', async failed => {
    const ledger = deliveryLedger(); const first = worker({ ledger });
    let finish!: () => void, fail!: (error: Error) => void;
    first.showNotification.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
    const pending = first.invoke('push', push());
    await vi.waitFor(() => expect(first.showNotification).toHaveBeenCalledOnce());
    const newer = { id: eventId, state: 'showing', token: 'newer-worker', leaseUntil: Date.now() + 60_000 };
    ledger.records.set(eventId, newer);
    if (failed) { fail(new Error('late display failure')); await expect(pending).rejects.toThrow('late display failure'); }
    else { finish(); await pending; }
    expect(ledger.records.get(eventId)).toEqual(newer);
    const restarted = worker({ ledger }); await restarted.invoke('push', push()); expect(restarted.showNotification).not.toHaveBeenCalled();
    ledger.records.set(eventId, { ...newer, leaseUntil: Date.now() - 1 });
    await restarted.invoke('push', push()); expect(restarted.showNotification).toHaveBeenCalledOnce();
  });
});
