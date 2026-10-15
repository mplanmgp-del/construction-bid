import { createECDH } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAlertPushPublicKey, readAlertPushConfig, sendAlertPush, validatePushEndpoint, validatePushSubscription } from '../server/alert-push';
import type { AlertInboxItem, BrowserPushSubscription } from '../src/alerts/types';

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('web-push', () => ({ default: { sendNotification: transport.send } }));
const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(Buffer.alloc(32, 1));
const config = { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url'), subject: 'https://app.example.com' };
const subscription: BrowserPushSubscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/example', expirationTime: null,
  keys: { p256dh: config.publicKey, auth: Buffer.alloc(16, 2).toString('base64url') } };
const item: AlertInboxItem = { id: 'notification-1', kind: 'test', notice: null, message: '브라우저 알림 테스트입니다.', changeFields: [], createdAt: '2026-10-15T01:00:00.000Z', readAt: null };
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe('push endpoint and key validation', () => {
  it.each(['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/abc'])('accepts a supported HTTPS provider: %s', endpoint => {
    expect(validatePushEndpoint(endpoint)).toBe(endpoint);
  });
  it.each(['http://fcm.googleapis.com/fcm/send/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://169.254.169.254/latest/meta-data',
    'https://fcm.googleapis.com.evil.test/a', 'https://evilpush.apple.com/a', 'https://push.apple.com.evil.test/a',
    'https://user:pass@fcm.googleapis.com/a', 'https://@fcm.googleapis.com/a', 'https:\\fcm.googleapis.com/a',
    'https://fcm.googleapis.com:444/a', 'https://fcm.googleapis.com/a#secret', 'file:///etc/passwd'])('rejects SSRF and ambiguous endpoints: %s', endpoint => {
    expect(() => validatePushEndpoint(endpoint)).toThrow();
  });
  it('rejects malformed encryption keys and copies only subscription fields', () => {
    expect(validatePushSubscription({ ...subscription, user_id: 'another-user' })).toEqual(subscription);
    expect(() => validatePushSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'bad' } })).toThrow();
    expect(() => validatePushSubscription({ ...subscription, expirationTime: 'tomorrow' })).toThrow();
  });
  it('keeps private configuration server-side and defaults subject to the explicit HTTPS app origin', () => {
    const env = { ALERT_VAPID_PUBLIC_KEY: config.publicKey, ALERT_VAPID_PRIVATE_KEY: config.privateKey, ALERT_APP_ORIGIN: 'https://app.example.com/path' };
    const result = readAlertPushConfig(env);
    expect(result).toEqual(config);
    expect(getAlertPushPublicKey(result)).toBe(config.publicKey);
    expect(readAlertPushConfig({ ...env, ALERT_VAPID_PRIVATE_KEY: 'invalid' })).toBeNull();
    expect(readAlertPushConfig({ ...env, ALERT_APP_ORIGIN: 'http://localhost:5281' })).toBeNull();
  });
});

describe('push send outcome', () => {
  it('encrypts and signs with the pinned real package without opening a network connection', async () => {
    const actual = await vi.importActual<{ default: typeof import('web-push') }>('web-push');
    const details = actual.default.generateRequestDetails(subscription, JSON.stringify({ eventId: item.id, body: item.message }), { vapidDetails: config, contentEncoding: 'aes128gcm', TTL: 3600 });
    expect(details.endpoint).toBe(subscription.endpoint);
    expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    expect(details.headers.Authorization).toMatch(/^vapid /);
    expect(details.body).toBeInstanceOf(Buffer);
  });
  it('encrypts a visible structured payload without passing arbitrary destinations', async () => {
    transport.send.mockResolvedValue({ statusCode: 201 });
    expect(await sendAlertPush(subscription, item, config)).toEqual({ status: 'sent' });
    expect(JSON.parse(transport.send.mock.calls[0][1])).toMatchObject({ eventId: item.id, body: item.message, notice: null });
    expect(transport.send.mock.calls[0][2]).toMatchObject({ contentEncoding: 'aes128gcm', vapidDetails: config, TTL: 3600 });
  });
  it.each([404, 410])('marks unavailable subscriptions expired after HTTP %i', async statusCode => {
    transport.send.mockRejectedValue({ statusCode });
    expect(await sendAlertPush(subscription, item, config)).toEqual({ status: 'expired' });
  });
  it('retains a transient subscription and carries bounded retry-after', async () => {
    transport.send.mockRejectedValue({ statusCode: 429, headers: { 'retry-after': '120' } });
    expect(await sendAlertPush(subscription, item, config)).toEqual({ status: 'retry', retryAfterSeconds: 120 });
    transport.send.mockRejectedValue({ statusCode: 503 });
    expect(await sendAlertPush(subscription, item, config)).toMatchObject({ status: 'retry' });
  });
  it('does not transmit invalid endpoints or missing server configuration', async () => {
    expect(await sendAlertPush({ ...subscription, endpoint: 'https://localhost/test' }, item, config)).toEqual({ status: 'failed' });
    expect(await sendAlertPush(subscription, item, null)).toEqual({ status: 'failed' });
    expect(transport.send).not.toHaveBeenCalled();
  });
});
