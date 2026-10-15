import { createECDH, ECDH } from 'node:crypto';
import webpush from 'web-push';
import type { AlertInboxItem, BrowserPushSubscription } from '../src/alerts/types.ts';

export interface AlertPushConfig { publicKey: string; privateKey: string; subject: string }
export type AlertPushResult = { status: 'sent' | 'expired' | 'retry' | 'failed'; retryAfterSeconds?: number };

export class InvalidPushSubscription extends Error {
  readonly code = 'INVALID_PUSH_SUBSCRIPTION';
  constructor() { super('브라우저 알림 구독 정보가 올바르지 않습니다. 알림을 다시 설정해 주세요.'); }
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function decodeKey(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 128) throw new InvalidPushSubscription();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== length || decoded.toString('base64url') !== value) throw new InvalidPushSubscription();
  return decoded;
}

/** Push endpoints are capabilities. Never log them or accept an arbitrary URL. */
export function validatePushEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || !/^https:\/\//i.test(value)
    || /[\\\s\u0000-\u001f\u007f]/.test(value) || /^https:\/\/[^/?#]*@/i.test(value)) throw new InvalidPushSubscription();
  let url: URL;
  try { url = new URL(value); } catch { throw new InvalidPushSubscription(); }
  const host = url.hostname;
  const provider = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
    || (host.endsWith('.push.apple.com') && host.length > '.push.apple.com'.length);
  if (url.protocol !== 'https:' || !provider || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new InvalidPushSubscription();
  return value;
}
export function validatePushSubscription(value: unknown): BrowserPushSubscription {
  if (!record(value) || !record(value.keys)) throw new InvalidPushSubscription();
  const endpoint = validatePushEndpoint(value.endpoint);
  const p256dh = decodeKey(value.keys.p256dh, 65);
  if (p256dh[0] !== 4) throw new InvalidPushSubscription();
  try { ECDH.convertKey(p256dh, 'prime256v1'); } catch { throw new InvalidPushSubscription(); }
  decodeKey(value.keys.auth, 16);
  const expirationTime = value.expirationTime ?? null;
  if (expirationTime !== null && (typeof expirationTime !== 'number' || !Number.isSafeInteger(expirationTime) || expirationTime < 0)) throw new InvalidPushSubscription();
  return { endpoint, expirationTime, keys: { p256dh: value.keys.p256dh as string, auth: value.keys.auth as string } };
}

function validSubject(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'mailto:') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url.pathname) && !url.search && !url.hash;
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}
/** Read only at runtime. This object contains a private key and must stay server-side. */
export function readAlertPushConfig(env: Record<string, string | undefined> = process.env, appOrigin?: string): AlertPushConfig | null {
  const publicKey = env.ALERT_VAPID_PUBLIC_KEY?.trim(), privateKey = env.ALERT_VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  let subject = env.ALERT_VAPID_SUBJECT?.trim();
  if (!subject) {
    const base = appOrigin || env.ALERT_APP_ORIGIN || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
    if (!base) return null;
    try { subject = new URL(base).origin; } catch { return null; }
  }
  if (!validSubject(subject)) return null;
  try {
    const pair = createECDH('prime256v1'); pair.setPrivateKey(decodeKey(privateKey, 32));
    if (!pair.getPublicKey().equals(decodeKey(publicKey, 65))) return null;
  } catch { return null; }
  return { publicKey, privateKey, subject };
}
export function getAlertPushPublicKey(config: AlertPushConfig | null = readAlertPushConfig()): string | null { return config?.publicKey ?? null; }
export function isAlertPushConfigured(config: AlertPushConfig | null = readAlertPushConfig()): boolean { return config !== null; }

function retryAfter(error: Record<string, unknown>): number {
  const headers = record(error.headers) ? error.headers : {};
  const raw = headers['retry-after'];
  const numeric = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  const seconds = Number.isFinite(numeric) ? numeric : typeof raw === 'string' ? Math.ceil((Date.parse(raw) - Date.now()) / 1000) : 60;
  return Number.isFinite(seconds) ? Math.max(1, Math.min(3600, seconds)) : 60;
}
function pushPayload(notification: AlertInboxItem) {
  const source = notification.notice;
  const notice = source && /^[a-zA-Z0-9_-]{1,40}$/.test(source.number) && /^\d{1,3}$/.test(source.revision)
    && (source.type === '공사' || source.type === '용역')
    ? { number: source.number, revision: source.revision.padStart(3, '0'), type: source.type } : null;
  return JSON.stringify({ eventId: notification.id.slice(0, 120), title: (source?.title || '공사입찰 맞춤 알림').slice(0, 100),
    body: notification.message.slice(0, 240), notice });
}
export async function sendAlertPush(subscription: BrowserPushSubscription, notification: AlertInboxItem,
  config: AlertPushConfig | null = readAlertPushConfig()): Promise<AlertPushResult> {
  if (!config) return { status: 'failed' };
  let safe: BrowserPushSubscription;
  try { safe = validatePushSubscription(subscription); } catch { return { status: 'failed' }; }
  if (safe.expirationTime !== null && safe.expirationTime <= Date.now()) return { status: 'expired' };
  try {
    // web-push uses node:https directly; non-2xx responses, including redirects,
    // are rejected rather than followed to an unvalidated destination.
    await webpush.sendNotification(safe, pushPayload(notification), { vapidDetails: config,
      contentEncoding: 'aes128gcm', TTL: 3600, urgency: 'normal', timeout: 10_000 });
    return { status: 'sent' };
  } catch (error) {
    const result = record(error) ? error : {};
    const status = typeof result.statusCode === 'number' ? result.statusCode : null;
    if (status === 404 || status === 410) return { status: 'expired' };
    if (status === null || status === 408 || status === 429 || status >= 500) return { status: 'retry', retryAfterSeconds: retryAfter(result) };
    return { status: 'failed' };
  }
}
