// ============================================================
//  Service Worker
//  役目は2つだけ:
//   1. プッシュを受け取って通知を出す
//   2. 通知をタップしたらアプリを開く
//  ※ ここでファイルをキャッシュすると「更新したのに古いまま」の
//     原因になりやすいので、あえてキャッシュはしていません。
// ============================================================

const APP_URL = '/loveeeee/';
const ICON = '/loveeeee/icon.png';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = { title: 'Our Memories', body: '新しい更新があります', url: APP_URL };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: ICON,
      badge: ICON,
      tag: data.tag || 'memories',
      renotify: true,
      data: { url: data.url || APP_URL }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || APP_URL;

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.includes(APP_URL) && 'focus' in client) return client.focus();
    }
    return self.clients.openWindow(url);
  })());
});
