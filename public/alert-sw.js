/* Visible Web Push only. This worker does not cache pages or intercept fetches. */
'use strict';
// This push-only worker owns no page or response cache, so its update can activate immediately.
self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
const DELIVERY_LEASE_MS = 120000;
const deliveriesInFlight = new Map();
let deliveryDatabase;
function durableEventId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
}
function openDeliveryDatabase() {
  if (!deliveryDatabase) deliveryDatabase = new Promise((resolve, reject) => {
    if (!self.indexedDB) { reject(new Error('Notification delivery storage unavailable')); return; }
    const request = self.indexedDB.open('bid-alert-delivery', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('events')) request.result.createObjectStore('events', { keyPath: 'id' });
    };
    request.onerror = () => reject(request.error || new Error('Notification delivery storage unavailable'));
    request.onblocked = () => reject(new Error('Notification delivery storage blocked'));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); deliveryDatabase = null; };
      resolve(database);
    };
  }).catch(error => { deliveryDatabase = null; throw error; });
  return deliveryDatabase;
}
async function changeDelivery(id, update) {
  const database = await openDeliveryDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('events', 'readwrite');
    const store = transaction.objectStore('events');
    let result = false;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Notification delivery storage failed'));
    const request = store.get(id);
    request.onsuccess = () => { result = update(store, request.result); };
  });
}
async function showEventOnce(id, show) {
  const token = self.crypto && typeof self.crypto.randomUUID === 'function' ? self.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36);
  let claimed;
  try {
    claimed = await changeDelivery(id, (store, previous) => {
      if (previous && (previous.state === 'delivered' || previous.state === 'showing' && previous.leaseUntil > Date.now())) return false;
      store.put({ id, state: 'showing', token, leaseUntil: Date.now() + DELIVERY_LEASE_MS });
      return true;
    });
  } catch { return show(); } // Storage failure must not hide a new visible push.
  if (!claimed) return;
  try { await show(); }
  catch (error) {
    try { await changeDelivery(id, (store, previous) => { if (previous && previous.token === token) store.delete(id); }); } catch { /* The lease can recover if release fails. */ }
    throw error;
  }
  try {
    await changeDelivery(id, (store, previous) => {
      if (previous && previous.token === token) store.put({ id, state: 'delivered', deliveredAt: Date.now() });
    });
  } catch { /* The visible notification succeeded; an unfinished claim expires rather than blocking forever. */ }
}
function deliverVisibleEvent(id, show) {
  if (!id) return show();
  if (deliveriesInFlight.has(id)) return deliveriesInFlight.get(id);
  const pending = showEventOnce(id, show).finally(() => { if (deliveriesInFlight.get(id) === pending) deliveriesInFlight.delete(id); });
  deliveriesInFlight.set(id, pending);
  return pending;
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
  const durableId = durableEventId(data.eventId);
  const eventId = durableId || (typeof data.eventId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(data.eventId) ? data.eventId : 'latest');
  event.waitUntil(deliverVisibleEvent(durableId, () => self.registration.showNotification(title, { body, tag: 'bid-alert-' + eventId,
    icon: '/alert-icon-192.png', badge: '/alert-icon-192.png', data: { notice: noticeIdentity(data.notice) } })));
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
