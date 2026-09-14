// ============================================================
//  プッシュ通知（本物）
//  以前は Service Worker を登録するだけで pushManager.subscribe を
//  呼んでいなかったため、アプリを開いている間しか通知が出ませんでした。
//  ここで購読を作り、宛先を DB に保存し、Edge Function から送ります。
// ============================================================
import { db, userId } from './supabase.js';
import { BASE_PATH, VAPID_PUBLIC_KEY } from './config.js';
import { $, el, showToast, showError } from './util.js';
import { registerActions } from './actions.js';

let registration = null;

function supported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** ホーム画面に追加したアプリとして開いているか */
function standalone() {
  return window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * なぜ使えないのかを、読める言葉で返す。
 * 使えるときは null。
 * iOS は「ホーム画面に追加したアプリ」でないと通知APIが存在しません。
 * 以前はここで黙ってボタンを消していたので、理由が誰にも分かりませんでした。
 */
function unsupportedReason() {
  if (supported()) return null;
  if (isIOS() && !standalone()) {
    return 'iPhone・iPad では、ホーム画面に追加したアプリとして開いたときだけ通知を使えます。'
      + '\n共有ボタン → 「ホーム画面に追加」でアプリとして開いてから、もう一度押してください。';
  }
  if (!('serviceWorker' in navigator)) {
    return 'このブラウザは通知のしくみ（Service Worker）に対応していません。'
      + '\nプライベートブラウズ中の場合は、通常のウィンドウで開いてみてください。';
  }
  return 'このブラウザは通知に対応していません。Chrome や Safari の最新版でお試しください。';
}

/** ボタンの下に置く説明。無ければ作る */
function hintNode() {
  let node = $('pushHint');
  if (node) return node;
  const btn = $('pushBtn');
  if (!btn || !btn.parentNode) return null;
  node = el('p', { id: 'pushHint', class: 'section-note' });
  node.style.marginTop = '10px';
  node.style.marginBottom = '0';
  node.style.whiteSpace = 'pre-wrap';
  btn.parentNode.insertBefore(node, btn.nextSibling);
  return node;
}

function setHint(text) {
  const node = hintNode();
  if (node) { node.textContent = text || ''; node.hidden = !text; }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/** 起動時。許可を求めず、Service Worker の登録だけしておく */
export async function initPush() {
  // 何よりも先に受け手を登録する。
  // 以前はこれが関数の最後にあり、途中で return するとボタンが
  // 「押しても何も起きない」状態になっていました。
  registerActions({ 'push:enable': enablePush });

  const reason = unsupportedReason();
  if (reason) { updateButton(); return; }

  try {
    registration = await navigator.serviceWorker.register(BASE_PATH + 'sw.js');
  } catch (e) {
    console.warn('Service Worker を登録できませんでした', e);
    updateButton('swfailed');
    return;
  }

  if (Notification.permission === 'granted') {
    await subscribe({ silent: true });
  }
  updateButton();
}

function updateButton(state) {
  const btn = $('pushBtn');
  if (!btn) return;

  // ボタンは消さない。消すと、なぜ使えないのかが誰にも分からなくなります。
  btn.style.display = '';
  const card = $('notifyCard');
  if (card) card.hidden = false;

  if (state === 'swfailed') {
    btn.textContent = '🔔 通知を準備できませんでした';
    btn.disabled = false;
    setHint('通知のしくみを読み込めませんでした。画面を更新してもう一度お試しください。');
    return;
  }

  const reason = unsupportedReason();
  if (reason) {
    btn.textContent = '🔔 通知を使うには';
    btn.disabled = false;      // 押せるままにして、押したら理由を出す
    setHint(reason);
    return;
  }

  if (Notification.permission === 'granted') {
    // もう使わないボタンのために、カード1枚ぶんの高さを占め続ける必要はありません
    if (card) card.hidden = true;
    btn.textContent = '🔔 通知オン';
    btn.disabled = true;
    setHint('この端末では通知がオンになっています。');
  } else if (Notification.permission === 'denied') {
    btn.textContent = '🔕 通知はブラウザ側で拒否中';
    btn.disabled = false;      // 押せるままにして、直しかたを出す
    setHint('この端末のブラウザ設定で通知が拒否されています。'
      + '\niPhone: 設定 → アプリ → 通知'
      + '\nAndroid / PC: アドレスバーの鍵アイコン → 通知 → 許可');
  } else {
    btn.textContent = '🔔 通知をオンにする';
    btn.disabled = false;
    setHint('');
  }
}

/** ボタンを押したときにだけ許可を求める（iOS はユーザー操作が必須） */
async function enablePush() {
  const reason = unsupportedReason();
  if (reason) { showToast(reason.split('\n')[0], 5000); setHint(reason); return; }

  if (Notification.permission === 'denied') {
    showToast('ブラウザ側で拒否されています。下の手順で許可してください', 5000);
    updateButton();
    return;
  }

  if (!registration) {
    try { registration = await navigator.serviceWorker.register(BASE_PATH + 'sw.js'); }
    catch (e) { showError('通知を準備できませんでした', e); return; }
  }

  let permission;
  try {
    permission = await Notification.requestPermission();
  } catch (e) {
    showError('通知の許可を求められませんでした', e);
    return;
  }

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
