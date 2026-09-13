// ============================================================
//  Supabase クライアント
//  アプリ全体でひとつだけ作ります。
//  userId / userName は export let なので、ログイン後にここで書きかえると
//  読み込んでいる側にもそのまま反映されます（ES モジュールの live binding）。
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

if (!SUPABASE_URL.startsWith('http')) {
  console.error('js/config.js の SUPABASE_URL / SUPABASE_ANON_KEY がまだ設定されていません');
}

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  realtime: { params: { eventsPerSecond: 20 } }
});

/** ログインしている人の auth.users.id */
export let userId = null;
/** space_members に入っている表示名 */
export let userName = '';
/** メールアドレス（画面には出しません。取り違え防止の確認用） */
export let userEmail = '';

export function setSessionUser(user, memberRow, accessToken) {
  userId = user ? user.id : null;
  userEmail = user ? (user.email || '') : '';
  userName = memberRow && memberRow.name ? memberRow.name : '';
  // ゲームの private チャンネルは、この token を見てメンバー判定をします
  try { db.realtime.setAuth(accessToken); } catch (e) { console.warn('realtime の認証に失敗', e); }
}

export function clearSessionUser() {
  userId = null;
  userName = '';
  userEmail = '';
}
