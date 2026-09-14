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

/* ------------------------------------------------------------
   アプリアイコンの数字（バッジ）

   iOS 16.4 以降、ホーム画面に追加したアプリでだけ使えます。
   通知の許可が要ります。Safari のタブでは効きません。

   閉じているあいだも数を増やしたいので、Service Worker 側で
   数えます。数を置いておく場所として Cache を使います。
   （ファイルのキャッシュはしない方針のままです。ここは
     数字を1つ置くためだけの入れ物として使っています）
   ------------------------------------------------------------ */
const BADGE_STORE = 'badge';

async function readBadge() {
  try {
    const cache = await caches.open(BADGE_STORE);
    const res = await cache.match('count');
    return res ? (Number(await res.text()) || 0) : 0;
  } catch (e) { return 0; }
}

async function writeBadge(n) {
  try {
    const cache = await caches.open(BADGE_STORE);
    await cache.put('count', new Response(String(n)));
  } catch (e) { }
}

async function bumpBadge() {
  const n = await readBadge() + 1;
  await writeBadge(n);
  try {
    if (self.navigator && 'setAppBadge' in self.navigator) await self.navigator.setAppBadge(n);
  } catch (e) { }   // 許可がない端末では例外が出るが、通知自体は止めない
}

async function clearBadge() {
  await writeBadge(0);
  try {
    if (self.navigator && 'clearAppBadge' in self.navigator) await self.navigator.clearAppBadge();
  } catch (e) { }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = { title: 'Our Memories', body: '新しい更新があります', url: APP_URL };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }

  // バッジだけを更新するのは許されていません。通知の表示と必ずセットにします。
  event.waitUntil(Promise.all([
    bumpBadge(),
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: ICON,
      badge: ICON,
      tag: data.tag || 'memories',
      renotify: true,
      data: { url: data.url || APP_URL }
    })
  ]));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || APP_URL;

  event.waitUntil((async () => {
    await clearBadge();
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.includes(APP_URL) && 'focus' in client) return client.focus();
    }
    return self.clients.openWindow(url);
  })());
});

/* アプリを開いたときに、数字を消してもらう合図を受け取る */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'clear-badge') event.waitUntil(clearBadge());
});
