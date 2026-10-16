/* Visible Web Push only. This worker does not cache pages or intercept fetches. */
'use strict';
// This push-only worker owns no page or response cache, so its update can activate immediately.
self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
function canonicalEventId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
}
function noticeIdentity(value) {
  if (!value || typeof value !== 'object' || typeof value.number !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(value.number)
    || typeof value.revision !== 'string' || !/^\d{1,3}$/.test(value.revision) || (value.type !== '공사' && value.type !== '용역')) return null;
  return { number: value.number, revision: value.revision.padStart(3, '0'), type: value.type };
}
function alertTarget(data) {
  const notice = noticeIdentity(data && data.notice);
  const target = new URL(notice ? '/notice-detail.html' : '/#alerts', self.location.origin);
  if (notice) for (const key of ['number', 'revision', 'type']) target.searchParams.set(key, notice[key]);
  return target.href;
}
self.addEventListener('push', event => {
  let data = {};
  try { const payload = event.data && event.data.json(); if (payload && typeof payload === 'object') data = payload; } catch { /* Always show a visible fallback. */ }
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.slice(0, 100) : '공사입찰 맞춤 알림';
  const body = typeof data.body === 'string' && data.body.trim() ? data.body.slice(0, 240) : '새 맞춤 알림이 있습니다. 알림함에서 확인해 주세요.';
  const eventId = canonicalEventId(data.eventId) || (typeof data.eventId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(data.eventId) ? data.eventId : 'latest');
  // Every push must show a notification for userVisibleOnly. Silent duplicate suppression
  // can trigger a browser-generated notification or subscription revocation.
  event.waitUntil(self.registration.showNotification(title, { body, tag: 'bid-alert-' + eventId, renotify: false,
    icon: '/alert-icon-192.png', badge: '/alert-icon-192.png', data: { notice: noticeIdentity(data.notice) } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = alertTarget(event.notification.data);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if (client.url === target && 'focus' in client) return client.focus();
    return self.clients.openWindow(target);
  })());
});
