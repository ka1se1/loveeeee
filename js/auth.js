// ============================================================
//  ログイン
//
//  新しい考えかた:
//    「ログインできた人」ではなく「名簿(space_members)に載っている人」
//    だけが中身を見られます。名簿への追加は SQL で手作業です。
//    知らない人が勝手に登録しても、何も見えません。
// ============================================================
import { db, setSessionUser, clearSessionUser } from './supabase.js';
import { $, val, showToast, showError } from './util.js';
import { registerActions } from './actions.js';

const PANELS = ['loginUI', 'nameSetup', 'notMember'];

function showPanel(which) {
  const screen = $('authScreen');
  if (screen) screen.style.display = 'flex';
  PANELS.forEach(id => {
    const node = $(id);
    if (node) node.style.display = (id === which) ? 'block' : 'none';
  });
}

function hideAuthScreen() {
  const screen = $('authScreen');
  if (screen) screen.style.display = 'none';
}

/** 押している間くるくる回す。二度押しも防ぐ */
async function busy(button, work) {
  if (button) { button.classList.add('btn-loading'); button.disabled = true; }
  try { return await work(); }
  finally { if (button) { button.classList.remove('btn-loading'); button.disabled = false; } }
}

/**
 * 起動時の入口。
 * 'ok' のときだけ、呼び出し元はデータを読みにいきます。
 * それ以外は、この関数が出した画面をそのまま見せます。
 */
export async function checkLogin() {
  let session = null;
  try {
    const { data, error } = await db.auth.getSession();
    if (error) throw error;
    session = data.session;
  } catch (e) {
    showError('ログイン状態を確認できませんでした', e);
    showPanel('loginUI');
    return 'error';
  }

  if (!session) { showPanel('loginUI'); return 'anon'; }

  // 名簿にいるか。ここが新しい防御の要です。
  let member = null;
  try {
    const { data, error } = await db.from('space_members')
      .select('user_id, name').eq('user_id', session.user.id).maybeSingle();
    if (error) throw error;
    member = data;
  } catch (e) {
    console.warn('名簿を読めませんでした', e);
  }

  if (!member) { showPanel('notMember'); return 'notmember'; }

  setSessionUser(session.user, member, session.access_token);

  // 名前がまだ既定のままなら、一度だけ聞く
  if (!member.name || member.name === 'わたし') {
    showPanel('nameSetup');
    return 'needname';
  }

  hideAuthScreen();
  return 'ok';
}

/* ---------- ボタンの中身 ---------- */

async function signIn() {
  const email = val('email');
  const password = $('password') ? $('password').value : '';
  if (!email || !password) { showToast('メールアドレスとパスワードを入れてね'); return; }

  await busy($('loginBtn'), async () => {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
      showError(error.message.includes('Invalid')
        ? 'メールアドレスかパスワードが違うようです'
        : 'ログインできませんでした', error);
      return;
    }
    // 読み込みは最初からやり直すのがいちばん確実
    location.reload();
  });
}

async function signUp() {
  const email = val('email');
  const password = $('password') ? $('password').value : '';
  if (!email || !password) { showToast('メールアドレスとパスワードを入れてね'); return; }
  if (password.length < 6) { showToast('パスワードは6文字以上にしてね'); return; }

  await busy($('signupBtn'), async () => {
    const { data, error } = await db.auth.signUp({ email, password });
    if (error) { showError('登録できませんでした', error); return; }
    if (data.session) { location.reload(); return; }
    showToast('確認メールを送りました。メールのリンクを開いてから、ログインしてね', 6000);
  });
}

async function saveName() {
  const name = val('firstNameInput');
  if (!name) { showToast('名前を入れてね'); return; }

  await busy($('startBtn'), async () => {
    const { data: { session } } = await db.auth.getSession();
    if (!session) { location.reload(); return; }
    const { error } = await db.from('space_members')
      .update({ name: name.slice(0, 20) }).eq('user_id', session.user.id);
    if (error) { showError('名前を保存できませんでした', error); return; }
    location.reload();
  });
}

async function signOut() {
  try { await db.auth.signOut(); } catch (e) { console.warn('ログアウトに失敗', e); }
  clearSessionUser();
  location.reload();
}

export function initAuth() {
  registerActions({
    'auth:signin': signIn,
    'auth:signup': signUp,
    'auth:name': saveName,
    'auth:signout': signOut
  });

  // Enter でも進めるように
  const enterRuns = { password: signIn, email: signIn, firstNameInput: saveName };
  for (const [id, fn] of Object.entries(enterRuns)) {
    const node = $(id);
    if (node) node.addEventListener('keydown', e => { if (e.key === 'Enter') fn(); });
  }
}
