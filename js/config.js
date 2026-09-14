// ============================================================
//  設定
//  ここに書いてよいのは「見られても困らないもの」だけです。
//  anon キーはブラウザに配られる前提の鍵で、RLS と space_members が
//  本当の防御になっています。秘密鍵のたぐいは絶対に置かないでください。
// ============================================================

/* ---------- Supabase ---------- */
// Supabase ダッシュボード → Project Settings → API で確認できます
export const SUPABASE_URL = 'https://aelvmpvgzvaiomqimzgo.supabase.co';        // 例: https://xxxxxxxx.supabase.co
export const SUPABASE_ANON_KEY = 'sb_publishable_q0Zo34coaQEx57ey6DO84w_E71EljZD';          // 例: eyJhbGciOi...

/* ---------- 置き場所 ---------- */
// アプリを置くパス。末尾のスラッシュは必ず付けてください。
// ここを変えたら sw.js の APP_URL / ICON、manifest.json、index.html も揃えます。
export const BASE_PATH = '/loveeeee/';

/* ---------- プッシュ通知 ---------- */
// npx web-push generate-vapid-keys で出た「Public Key」を貼ります。
// Private Key は Supabase の Secrets にだけ置きます（ここには書かない）。
export const VAPID_PUBLIC_KEY = 'BC6JAyVtjHthuodWpfguL2twWqCw-H-CY_gn_AwPXpfaBGQ1gdVxq4bvelYxrvVI5HI6HzXlbtCjiz5HwxRPG70';

/* ---------- Storage ---------- */
export const PHOTO_BUCKET = 'photos';   // 公開バケット
export const VOICE_BUCKET = 'voices';   // 非公開。署名付きURLで聞く
export const VOICE_URL_TTL = 60 * 60;   // 署名付きURLの有効期間（秒）

/* ---------- 写真の縮小 ---------- */
// スマホの写真をそのまま上げると数MBになるので、上げる前に縮めます。
export const PHOTO_MAX_EDGE = 1600;     // 長辺の上限（px）
export const THUMB_MAX_EDGE = 480;      // 一覧用サムネの長辺（px）
export const PHOTO_QUALITY = 0.82;      // JPEG の品質
export const GALLERY_PREVIEW = 9;       // 「すべて見る」を押す前に出す枚数（3行）

/* ---------- ボイスメッセージ ---------- */
export const VOICE_MAX_MS = 90 * 1000;  // 最長90秒

/* ---------- お絵かきゲーム ---------- */
export const GAME_CANVAS = 300;         // index.html の canvas と同じ値にすること
export const GAME_ROUND_SEC = 30;

/* ---------- 天気 ---------- */
// 位置情報が使えないときに使う場所（既定は東京駅のあたり）
export const WEATHER_FALLBACK = { lat: 35.681, lon: 139.767, name: '東京' };
