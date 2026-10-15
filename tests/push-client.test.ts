import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('../src/member/client', () => ({ getMemberClient: () => ({ auth }) }));
const publicKey = 'B' + 'A'.repeat(86);
let push: typeof import('../src/alerts/push-client');
const endpoint = 'https://fcm.googleapis.com/fcm/send/current';
const subscription = { endpoint, unsubscribe: vi.fn(), toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: publicKey, auth: 'AgICAgICAgICAgICAgICAg' } }) };
let current: typeof subscription | null;
const subscribe = vi.fn();
const registration = { pushManager: { getSubscription: vi.fn(async () => current), subscribe } };
const fetcher = vi.fn();
beforeEach(async () => {
  vi.resetModules(); current = null;
  subscription.unsubscribe.mockReset().mockImplementation(async () => { current = null; return true; });
  subscribe.mockReset().mockImplementation(async () => { current = subscription; return subscription; });
  registration.pushManager.getSubscription.mockClear();
  auth.getSession.mockReset().mockResolvedValue({ data: { session: { access_token: 'session-token', user: { id: 'user-1' } } }, error: null });
  fetcher.mockReset().mockResolvedValue(Response.json({ ok: true, subscribed: true }));
  vi.stubGlobal('window', { isSecureContext: true, location: { origin: 'https://app.example.com' } });
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn() });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => registration), ready: Promise.resolve(registration), getRegistration: vi.fn(async () => registration) } });
  vi.stubGlobal('fetch', fetcher);
  push = await import('../src/alerts/push-client');
});
afterEach(() => vi.unstubAllGlobals());

describe('explicit browser push enrollment', () => {
  it('prepares a worker without requesting permission or subscribing on mount', async () => {
    await push.prepareBrowserPush(publicKey);
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith('/alert-sw.js', { scope: '/', updateViaCache: 'none' });
    expect(subscribe).not.toHaveBeenCalled();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });
  it('starts subscribe synchronously before any session/network await, then binds authenticated subscription', async () => {
    await push.prepareBrowserPush(publicKey);
    auth.getSession.mockClear();
    const pending = push.enableBrowserPush(publicKey);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(auth.getSession).not.toHaveBeenCalled();
    await pending;
    expect(fetcher.mock.calls[0][0]).toBe('/api/alerts');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer session-token');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ action: 'subscribe', subscription: { endpoint } });
  });
  it('refuses an unprepared click without initiating a late permission prompt', async () => {
    await expect(push.enableBrowserPush(publicKey)).rejects.toThrow();
    expect(subscribe).not.toHaveBeenCalled();
  });
  it('unsubscribes a conflicting account endpoint and requires the next explicit gesture for a fresh subscription', async () => {
    await push.prepareBrowserPush(publicKey);
    fetcher.mockResolvedValueOnce(Response.json({ error: { message: '다른 계정 구독' } }, { status: 409 }));
    await expect(push.enableBrowserPush(publicKey)).rejects.toThrow();
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledTimes(1);
    await push.enableBrowserPush(publicKey);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
  it('always unsubscribes locally when server removal fails at logout', async () => {
    current = subscription; await push.prepareBrowserPush(publicKey);
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await push.detachBrowserPushOnLogout();
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: 'unsubscribe', endpoint });
  });
  it('checks server ownership without registering an existing browser subscription automatically', async () => {
    current = subscription; await push.prepareBrowserPush(publicKey);
    fetcher.mockResolvedValueOnce(Response.json({ subscribed: false }));
    expect(await push.getBrowserPushState()).toMatchObject({ supported: true, subscribed: false, endpoint });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: 'subscription-status', endpoint });
    expect(subscribe).not.toHaveBeenCalled();
  });
  it('cancels an enrollment resolved after logout before it can bind the endpoint', async () => {
    await push.prepareBrowserPush(publicKey);
    let resolve!: (value: typeof subscription) => void;
    subscribe.mockImplementationOnce(() => new Promise<typeof subscription>(yes => { resolve = yes; }));
    const enrolling = push.enableBrowserPush(publicKey);
    await push.detachBrowserPushOnLogout();
    resolve(subscription);
    await expect(enrolling).rejects.toThrow();
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects a changed account while a permission prompt is pending', async () => {
    await push.prepareBrowserPush(publicKey);
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 'different-token', user: { id: 'user-2' } } }, error: null });
    await expect(push.enableBrowserPush(publicKey)).rejects.toThrow();
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
