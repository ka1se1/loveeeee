// ============================================================
//  dance-schedule
//  ダンスの練習場所を、共有されているスプレッドシートから読みます。
//
//  読むのは「まとめ」タブの、日付・ジャンル・場所・時間だけです。
//  ジャンル別のタブには値段や予約した人の名前が入っていますが、
//  それは読みません。
//
//  スプレッドシートのアドレスは、公開リポジトリに載せないよう
//  秘密の設定に置きます:
//    DANCE_SHEET_ID   … URL の /d/ と /edit のあいだ
//    DANCE_SHEET_GID  … 「まとめ」タブの gid
//
//  ブラウザから直接読まないのは、Google の制限（CORS）で読めない
//  ことがあるのと、アドレスをアプリのコードに書かずに済むからです。
//
//  デプロイ:
//    npx supabase functions deploy dance-schedule
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SHEET_ID = Deno.env.get('DANCE_SHEET_ID') ?? '';
const SHEET_GID = Deno.env.get('DANCE_SHEET_GID') ?? '0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export type Genre = {
  genre: string;
  place: string;   // 空なら場所未定
  start: string;   // '18:00'。読めなければ空
  end: string;
  time: string;    // 読めなかったときの元の文字（'深夜' など）
};
export type Day = { date: string; genres: Genre[] };

/* ---------- CSV ----------
   セルの中のカンマ（"ワークル大久保302,301"）や改行、"" を正しく読むため、
   split(',') ではなく1文字ずつ読みます。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** 前後の空白と、全角の空白・続いた空白をならす */
function tidy(s: string) {
  return (s || '').replace(/[\s　]+/g, ' ').trim();
}

const pad = (n: number) => String(n).padStart(2, '0');

/** '17:00-20:00'、'１８：００〜２１：００' などを読む。読めなければ null */
export function parseTime(s: string): { start: string; end: string } | null {
  const t = tidy(s).normalize('NFKC');
  const m = t.match(/(\d{1,2}):(\d{2})\s*[-~〜–−ー]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return { start: pad(+m[1]) + ':' + m[2], end: pad(+m[3]) + ':' + m[4] };
}

/** '9/19(土)' には年が無いので、今日にいちばん近い年を当てる
 *  （12月に1月の分が載っていても、翌年として読めるように） */
export function parseDate(s: string, todayYmd: string): string | null {
  const m = tidy(s).normalize('NFKC').match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const mo = +m[1], d = +m[2];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  const today = Date.UTC(ty, tm - 1, td);
  let best = '', bestGap = Infinity;
  for (const y of [ty - 1, ty, ty + 1]) {
    const t = Date.UTC(y, mo - 1, d);
    const gap = Math.abs(t - today);
    if (gap < bestGap) { bestGap = gap; best = `${y}-${pad(mo)}-${pad(d)}`; }
  }
  return best;
}

/** 「まとめ」の表を読む。
 *  1行目: 空, hiphop, 空, lock, 空, …（ジャンルごとに 場所・時間 の2列）
 *  2行目から: 日付, 場所, 時間, 場所, 時間, … */
export function parseSheet(rows: string[][], todayYmd: string): { genres: string[]; days: Day[] } {
  const headIdx = rows.findIndex(r => r.slice(1).some(c => tidy(c)));
  if (headIdx < 0) return { genres: [], days: [] };
  const head = rows[headIdx];
  const cols: { genre: string; at: number }[] = [];
  for (let i = 1; i < head.length; i++) {
    const g = tidy(head[i]);
    if (g) cols.push({ genre: g, at: i });
  }

  const days: Day[] = [];
  for (const r of rows.slice(headIdx + 1)) {
    const date = parseDate(r[0] || '', todayYmd);
    if (!date) continue;
    const genres: Genre[] = [];
    for (const { genre, at } of cols) {
      const place = tidy(r[at] || '');
      const rawTime = tidy(r[at + 1] || '');
      if (!place && !rawTime) continue;          // そのジャンルはこの日なし
      const t = parseTime(rawTime);
      genres.push({ genre, place, start: t ? t.start : '', end: t ? t.end : '', time: t ? '' : rawTime });
    }
    if (genres.length) days.push({ date, genres });
  }
  days.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { genres: cols.map(c => c.genre), days };
}

function todayInTokyo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // 1. 呼び出した本人を確かめる
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'unauthorized' }, 401);

  // 2. メンバー名簿にいるかを確認
  const { data: member } = await userClient
    .from('space_members').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!member) return json({ error: 'forbidden' }, 403);

  if (!SHEET_ID) return json({ error: 'DANCE_SHEET_ID が未設定です' }, 500);

  // 3. 読む
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (e) {
    return json({ error: 'スプレッドシートに繋がりませんでした', detail: String(e) }, 502);
  }
  // 共有が切られると、CSV ではなくログイン画面（HTML）が返ってきます
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('text/csv')) {
    return json({
      error: 'スプレッドシートを読めませんでした。共有の設定が「リンクを知っている全員」から変わったのかもしれません',
      status: res.status
    }, 502);
  }

  const { genres, days } = parseSheet(parseCsv(await res.text()), todayInTokyo());
  return json({
    genres,
    days,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${SHEET_GID}`,
    fetchedAt: new Date().toISOString()
  });
});
