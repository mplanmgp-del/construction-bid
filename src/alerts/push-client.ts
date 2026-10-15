import { getMemberClient } from '../member/client';
import type { BrowserPushSubscription } from './types';

export interface BrowserPushState {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  endpoint: string | null;
  prepared: boolean;
}
interface PreparedPush { key: string; userId: string; applicationServerKey: Uint8Array<ArrayBuffer>; registration: ServiceWorkerRegistration }
let prepared: PreparedPush | null = null;
let preparation: Promise<void> | null = null;
let preparingKey: string | null = null;
let enrollmentGeneration = 0;

function supported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext !== false && typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator && typeof Notification !== 'undefined' && typeof PushManager !== 'undefined';
}
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{87}$/.test(key)) throw new Error('브라우저 알림 공개키가 올바르지 않습니다.');
  const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '=');
  const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('브라우저 알림 공개키가 올바르지 않습니다.');
  return bytes;
}
export async function prepareBrowserPush(publicKey: string): Promise<void> {
  if (!supported()) throw new Error('이 브라우저에서는 푸시 알림을 지원하지 않습니다. 아이폰·아이패드는 홈 화면에 추가한 뒤 열어 주세요.');
  const identity = await getMemberClient()?.auth.getSession();
  const userId = identity?.data.session?.user.id;
  if (identity?.error || !userId) throw new Error('로그인한 뒤 브라우저 알림을 설정해 주세요.');
  if (prepared?.key === publicKey && prepared.userId === userId) return;
  const preparationKey = `${publicKey}:${userId}`;
  if (preparation && preparingKey === preparationKey) return preparation;
  const applicationServerKey = keyBytes(publicKey);
  preparingKey = preparationKey;
  preparation = (async () => {
    const registration = await navigator.serviceWorker.register('/alert-sw.js', { scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    // Readiness is prepared before the button can be clicked. No permission
    // request or subscription enrollment occurs in this path.
    prepared = { key: publicKey, userId, applicationServerKey, registration };
  })();
  try { await preparation; } finally { preparation = null; preparingKey = null; }
}
class PushRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request(action: string, values: Record<string, unknown>, expectedUserId?: string): Promise<Record<string, unknown>> {
  const client = getMemberClient();
  const session = client ? await client.auth.getSession() : null;
  if (!session || session.error || !session.data.session?.access_token) throw new Error('로그인한 뒤 브라우저 알림을 설정해 주세요.');
  if (expectedUserId && session.data.session.user.id !== expectedUserId) throw new Error('로그인 계정이 변경되었습니다. 현재 계정에서 알림을 다시 설정해 주세요.');
  const response = await fetch('/api/alerts', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.data.session.access_token}` },
    body: JSON.stringify({ action, ...values }), signal: AbortSignal.timeout(12_000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new PushRequestError(typeof data?.error?.message === 'string' ? data.error.message : '브라우저 알림 설정을 저장하지 못했습니다. 다시 시도해 주세요.', response.status);
  return data && typeof data === 'object' ? data : {};
}
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  return prepared?.registration ?? await navigator.serviceWorker.getRegistration('/alert-sw.js') ?? null;
}
export async function getBrowserPushState(): Promise<BrowserPushState> {
  if (!supported()) return { supported: false, permission: 'unsupported', subscribed: false, endpoint: null, prepared: false };
  const local = await (await registration())?.pushManager.getSubscription();
  const state: BrowserPushState = { supported: true, permission: Notification.permission, subscribed: false, endpoint: local?.endpoint ?? null, prepared: Boolean(prepared) };
  if (!local) return state;
  const ownership = await request('subscription-status', { endpoint: local.endpoint }, prepared?.userId);
  return { ...state, subscribed: ownership.subscribed === true };
}
/** Must be called directly by a click handler, before awaiting any other work. */
export async function enableBrowserPush(publicKey: string): Promise<BrowserPushState> {
  if (!supported() || !prepared || prepared.key !== publicKey) throw new Error('브라우저 알림을 준비하고 있습니다. 잠시 후 버튼을 다시 눌러 주세요.');
  if (Notification.permission === 'denied') throw new Error('브라우저에서 알림이 차단되어 있습니다. 사이트 설정에서 알림을 허용한 뒤 다시 눌러 주세요.');
  const active = prepared;
  const generation = enrollmentGeneration;
  // Keep this call before the first await: Safari requires a user gesture.
  const pendingSubscription = active.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: active.applicationServerKey });
  let subscription: PushSubscription;
  try { subscription = await pendingSubscription; }
  catch { throw new Error('알림 권한을 허용하지 않았거나 브라우저가 알림을 지원하지 않습니다. 아이폰·아이패드는 홈 화면에 추가한 앱에서 열어 주세요.'); }
  try {
    if (generation !== enrollmentGeneration) throw new Error('로그아웃하여 브라우저 알림 설정을 취소했습니다.');
    await request('subscribe', { subscription: subscription.toJSON() as BrowserPushSubscription }, active.userId);
    if (generation !== enrollmentGeneration) throw new Error('로그아웃하여 브라우저 알림 설정을 취소했습니다.');
    return { supported: true, permission: Notification.permission, subscribed: true, endpoint: subscription.endpoint, prepared: true };
  } catch (error) {
    // Failed bindings must not leave an unowned active browser subscription.
    await subscription.unsubscribe().catch(() => false);
    if (error instanceof PushRequestError && error.status === 409) throw new Error('이 브라우저의 이전 계정 알림을 해제했습니다. 알림 켜기를 다시 눌러 현재 계정에 연결해 주세요.');
    throw error;
  }
}
export async function disableBrowserPush(): Promise<void> {
  const subscription = await (await registration())?.pushManager.getSubscription();
  if (!subscription) return;
  let failure: unknown;
  try { await request('unsubscribe', { endpoint: subscription.endpoint }); } catch (error) { failure = error; }
  // Also run offline: the provider must stop delivering to this browser even
  // when the application database cannot be reached during logout.
  const removed = await subscription.unsubscribe();
  if (!removed) throw new Error('브라우저 구독을 해제하지 못했습니다. 브라우저 사이트 설정에서 알림을 차단해 주세요.');
  if (failure) throw new Error('이 브라우저의 알림은 해제했습니다. 서버 설정 정리는 연결 후 다시 확인해 주세요.');
}
export async function detachBrowserPushOnLogout(): Promise<void> {
  enrollmentGeneration++;
  try { await disableBrowserPush(); } catch { /* Local unsubscribe was still attempted. Logout remains usable offline. */ }
  prepared = null;
}
export async function testBrowserPush(): Promise<void> {
  const subscription = await (await registration())?.pushManager.getSubscription();
  if (!subscription) throw new Error('이 브라우저에서 알림을 먼저 켜 주세요.');
  await request('test', { endpoint: subscription.endpoint });
}
