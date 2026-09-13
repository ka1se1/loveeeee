// ============================================================
//  プッシュ通知（本物）
//  以前は Service Worker を登録するだけで pushManager.subscribe を
//  呼んでいなかったため、アプリを開いている間しか通知が出ませんでした。
//  ここで購読を作り、宛先を DB に保存し、Edge Function から送ります。
// ============================================================
import { db, userId } from './supabase.js';
import { BASE_PATH, VAPID_PUBLIC_KEY } from './config.js';
import { $, showToast, showError } from './util.js';
import { registerActions } from './actions.js';

let registration = null;

function supported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/** 起動時。許可を求めず、Service Worker の登録だけしておく */
export async function initPush() {
  if (!supported()) { updateButton('unsupported'); return; }
  try {
    registration = await navigator.serviceWorker.register(BASE_PATH + 'sw.js');
  } catch (e) {
    console.warn('Service Worker を登録できませんでした', e);
    updateButton('unsupported');
    return;
  }

  if (Notification.permission === 'granted') {
    await subscribe({ silent: true });
  }
  updateButton();

  registerActions({ 'push:enable': enablePush });
}

function updateButton(state) {
  const btn = $('pushBtn');
  if (!btn) return;
  const s = state || (supported() ? Notification.permission : 'unsupported');
  if (s === 'unsupported') { btn.style.display = 'none'; return; }
  btn.style.display = '';
  if (s === 'granted') { btn.textContent = '🔔 通知オン'; btn.disabled = true; }
  else if (s === 'denied') { btn.textContent = '🔕 通知はブラウザ側で拒否中'; btn.disabled = true; }
  else { btn.textContent = '🔔 通知をオンにする'; btn.disabled = false; }
}

/** ボタンを押したときにだけ許可を求める（iOS はユーザー操作が必須） */
async function enablePush() {
  if (!supported()) { showToast('このブラウザは通知に対応していません'); return; }
  const permission = await Notification.requestPermission();
  updateButton();
  if (permission !== 'granted') { showToast('通知は使えません。ブラウザの設定から許可できます'); return; }
  await subscribe({ silent: false });
}

async function subscribe({ silent }) {
  if (!registration || !VAPID_PUBLIC_KEY) {
    if (!silent) showToast('通知の設定（VAPID鍵）がまだです');
    return;
  }
  try {
    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    const json = sub.toJSON();
    const { error } = await db.from('push_subscriptions').upsert({
      user_id: userId,
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent.slice(0, 200)
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    if (!silent) showToast('通知をオンにしました');
  } catch (e) {
    if (!silent) showError('通知をオンにできませんでした', e);
    else console.warn('プッシュ購読に失敗', e);
  }
}

/**
 * 相手に通知を送る。
 * 自分自身には届かないよう、Edge Function 側で呼び出した人を除外します。
 * 失敗しても本来の処理は止めません。
 */
export async function notifyPartner(title, body) {
  try {
    await db.functions.invoke('send-push', { body: { title, body, url: BASE_PATH } });
  } catch (e) {
    console.warn('通知を送れませんでした（本体の保存は成功しています）', e);
  }
}
