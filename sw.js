// Felt Right service worker: shows push notifications from the server (game
// starting, your turn, set Away). It caches nothing; the page always loads fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (err) { msg = { title: 'Felt Right', body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    // Not while Felt Right is on screen: the table already shows it
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(msg.title || 'Felt Right', {
      body: msg.body || '',
      tag: msg.tag || 'felt-right',
      renotify: true,
      icon: 'icon-192.png',
      badge: 'icon-badge.png',
      data: { url: msg.url || self.registration.scope },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (open) return open.focus();
    return self.clients.openWindow(url);
  })());
});
