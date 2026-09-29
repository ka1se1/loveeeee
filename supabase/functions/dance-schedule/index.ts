// ============================================================
//  dance-schedule
//  ダンスの練習場所を、共有されているスプレッドシートから読みます。
//
//  スプレッドシートは月ごとに新しく作られるので、アプリの中で
//  何枚でも登録できます。登録した一覧は settings['dance_sheets'] に
//  あります（公開リポジトリには載りません）。
//  一覧がまだ無いときだけ、最初に設定した DANCE_SHEET_ID を使います。
//
//  読むのは各シートの「まとめ」タブの、日付・ジャンル・場所・時間だけです。
//  ジャンル別のタブには値段や予約した人の名前が入っていますが、
//  それは読みません。タブの番号（gid）はシートごとに違うので、
//  名前で探します。
//
//  呼びかた:
//    {}                 登録してある全部を読んで、日付順にまとめて返す
//    { check: URL }     登録する前に、そのシートを読めるか確かめる
//
//  ブラウザから直接読まないのは、Google の制限（CORS）で読めない
//  ことがあるからです。
//
//  デプロイ:
//    npx supabase functions deploy dance-schedule
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

const FALLBACK_ID = Deno.env.get('DANCE_SHEET_ID') ?? '';
const MAX_SHEETS = 12;
const SUMMARY_TAB = 'まとめ';

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
export type Day = { date: string; genres: Genre[]; sheetUrl?: string };
export type Entry = { id: string; gid?: string; title?: string; addedAt?: string };

/* ---------- URL ---------- */

/** 貼られた URL からシートの ID を取り出す。ID だけ貼られても受け付ける */
export function sheetIdFrom(url: string): string | null {
  const s = (url || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{30,}$/.test(s) ? s : null;
}

/** URL に付いているタブの番号（#gid=123） */
export function gidFrom(url: string): string {
  const m = (url || '').match(/[#&?]gid=(\d+)/);
  return m ? m[1] : '';
}

const editUrl = (id: string, gid: string) =>
  `https://docs.google.com/spreadsheets/d/${id}/edit` + (gid ? `#gid=${gid}` : '');

/* ---------- シートの表紙（htmlview）からタブとタイトルを読む ---------- */

export function findTabs(html: string): { name: string; gid: string }[] {
  const re = /\{name:\s*"((?:[^"\\]|\\.)*)",\s*pageUrl:[^}]*?gid:\s*"(\d+)"/g;
  const tabs: { name: string; gid: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let name = m[1];
    try { name = JSON.parse('"' + m[1] + '"'); } catch (_e) { /* そのまま */ }
    if (!tabs.some(t => t.gid === m![2])) tabs.push({ name, gid: m[2] });
  }
  return tabs;
}

export function titleFrom(html: string): string {
  const m = html.match(/<title>([^<]*)<\/title>/);
  return m ? m[1].replace(/\s*-\s*Google\s*(スプレッドシート|ドライブ|Sheets|Drive)\s*$/i, '').trim() : '';
}

/** 読むタブを決める。「まとめ」を最優先に、無ければ URL に付いていたタブ。
 *  月によって並びが変わっても、名前で探せば同じところを読めます */
export function pickGid(tabs: { name: string; gid: string }[], urlGid: string): string | null {
  const named = tabs.find(t => t.name.trim() === SUMMARY_TAB) || tabs.find(t => t.name.includes(SUMMARY_TAB));
  if (named) return named.gid;
  if (urlGid) return urlGid;
  return tabs.length === 1 ? tabs[0].gid : null;
}

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

/** 登録した順に並べ、同じ日付はあとから登録したシートのほうを使う */
export function mergeSheets(results: { days: Day[]; genres: string[] }[]): { genres: string[]; days: Day[] } {
  const byDate = new Map<string, Day>();
  const genres: string[] = [];
  for (const r of results) {
    r.days.forEach(d => byDate.set(d.date, d));
    r.genres.forEach(g => { if (!genres.includes(g)) genres.push(g); });
  }
  const days = [...byDate.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { genres, days };
}

function todayInTokyo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

const SHARE_HINT = '共有が「リンクを知っている全員（閲覧者）」になっているか確かめてください';

type Read =
  | { id: string; gid: string; title: string; url: string; genres: string[]; days: Day[]; error?: undefined }
  | { id: string; gid: string; title: string; url: string; error: string };

/** 1枚読む。失敗しても投げずに、理由を返す（ほかのシートは読めるように） */
async function readSheet(entry: Entry, todayYmd: string): Promise<Read> {
  const base = { id: entry.id, gid: entry.gid || '', title: entry.title || '', url: editUrl(entry.id, entry.gid || '') };
  const get = (u: string) => fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(12000) });
  try {
    // 1. 表紙からタブの一覧を読んで、「まとめ」を探す
    const page = await get(`https://docs.google.com/spreadsheets/d/${entry.id}/htmlview`);
    // 共有されていないと、Google のログイン画面に飛ばされます
    if (!page.ok || page.url.includes('accounts.google.com')) {
      return { ...base, error: page.status === 404 ? 'シートが見つかりません（URL を確かめてください）' : '読めませんでした。' + SHARE_HINT };
    }
    const html = await page.text();
    const tabs = findTabs(html);
    const title = titleFrom(html) || base.title;
    const gid = pickGid(tabs, entry.gid || '');
    if (!gid) {
      return {
        ...base, title,
        error: '「' + SUMMARY_TAB + '」タブが見つかりません（タブ：' + tabs.map(t => t.name).join('・') +
          '）。読みたいタブを開いた状態の URL を貼ってください'
      };
    }

    // 2. そのタブを CSV で読む
    const res = await get(`https://docs.google.com/spreadsheets/d/${entry.id}/export?format=csv&gid=${gid}`);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('text/csv')) {
      return { ...base, title, gid, error: '読めませんでした。' + SHARE_HINT };
    }
    const parsed = parseSheet(parseCsv(await res.text()), todayYmd);
    const url = editUrl(entry.id, gid);
    if (!parsed.days.length) {
      return { ...base, title, gid, url, error: '練習の日付が1つも見つかりませんでした。「' + SUMMARY_TAB + '」の並び方が変わったのかもしれません' };
    }
    parsed.days.forEach(d => { d.sheetUrl = url; });
    return { ...base, title, gid, url, ...parsed };
  } catch (e) {
    return { ...base, error: 'スプレッドシートに繋がりませんでした（' + String((e as Error).message || e).slice(0, 60) + '）' };
  }
}

/** アプリに返す、シートごとの様子 */
function summary(r: Read, entry?: Entry) {
  const days = 'days' in r && !r.error ? r.days : [];
  return {
    id: r.id, gid: entry?.gid || '', title: r.title, url: r.url, addedAt: entry?.addedAt || '',
    from: days.length ? days[0].date : '', to: days.length ? days[days.length - 1].date : '',
    days: days.length, error: r.error || ''
  };
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

  const body = await req.json().catch(() => ({})) as { check?: string };
  const today = todayInTokyo();

  // 3a. 登録する前の確認
  if (body && typeof body.check === 'string') {
    const id = sheetIdFrom(body.check);
    if (!id) return json({ error: 'スプレッドシートの URL ではないようです' }, 400);
    const gid = gidFrom(body.check);
    const r = await readSheet({ id, gid }, today);
    return json({ sheet: summary(r, { id, gid }) });
  }

  // 3b. 登録してある全部を読む（読むのはメンバーとして。RLS がかかります）
  const { data: row } = await userClient
    .from('settings').select('value').eq('key', 'dance_sheets').maybeSingle();
  let list: Entry[] = Array.isArray(row?.value) ? (row!.value as Entry[]) : [];
  const fromSettings = !!row;
  // 一覧がまだ無いときだけ、最初に設定したシートを使う
  if (!fromSettings && FALLBACK_ID) list = [{ id: FALLBACK_ID }];
  list = list.filter(e => e && typeof e.id === 'string' && /^[a-zA-Z0-9_-]{20,}$/.test(e.id)).slice(0, MAX_SHEETS);

  const results = await Promise.all(list.map(e => readSheet(e, today)));
  const ok = results.filter((r): r is Extract<Read, { days: Day[] }> => 'days' in r && !r.error);
  const { genres, days } = mergeSheets(ok);

  return json({
    genres,
    days,
    sheets: results.map((r, i) => summary(r, list[i])),
    fromSettings,
    fetchedAt: new Date().toISOString()
  });
});
