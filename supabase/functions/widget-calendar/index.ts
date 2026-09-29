// ============================================================
//  widget-calendar
//  ホーム画面のウィジェットに、これからの予定を返します。
//
//  iOS のウィジェットは WidgetKit（ネイティブ専用）なので、
//  Web アプリからは作れません。かわりに Scriptable という
//  アプリの JavaScript ウィジェットから、ここを読みます。
//
//  くり返しの展開（毎週の複数曜日・隔週・第◯曜日・除外日など）の
//  正しい実装はカレンダー側にしかありません。ここで書き直すと
//  2つがずれるので、展開はクライアントに任せ、結果を置いた
//  settings['upcoming'] を読むだけにします。
//
//  読み取り専用です。ここから何かを書きかえることはできません。
//
//  デプロイ:
//    npx supabase functions deploy widget-calendar --no-verify-jwt
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

const WIDGET_TOKEN = Deno.env.get('WIDGET_TOKEN') ?? '';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

type Item = {
  ymd: string; endYmd?: string; start: string; allDay: boolean;
  title: string; color: string; location?: string;
  who?: string; whoNames?: string;
  回数?: number;
};

/** YYYY-MM-DD に日数を足す */
function addDays(ymd: string, n: number) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return t.toISOString().slice(0, 10);
}

function todayInTokyo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function minutesNowInTokyo() {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date());
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

Deno.serve(async (req) => {
  // 合言葉が設定されていないときは、誰でも読めてしまうので拒否します
  if (!WIDGET_TOKEN) return json({ error: 'WIDGET_TOKEN が未設定です' }, 500);

  const url = new URL(req.url);
  const given = req.headers.get('x-widget-token') ?? url.searchParams.get('token') ?? '';
  if (given !== WIDGET_TOKEN) return json({ error: 'forbidden' }, 403);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data: row, error } = await admin
    .from('settings').select('value, updated_at').eq('key', 'upcoming').maybeSingle();
  if (error) return json({ error: error.message }, 500);

  // 0件のとき、原因が「アプリがまだ書いていない」のか
  // 「ここで落としている」のか分かるようにしておきます
  if (!row) {
    return json({
      today: todayInTokyo(), 件数: 0, 予定: [],
      診断: 'アプリがまだ予定の一覧を書き出していません。アプリを一度開いてください'
    });
  }

  // 以前は配列をそのまま置いていました。いまは
  // { 総数, 予定 } で、予定は上限で切ってあり、総数は切る前の数です。
  // アプリを開き直すまでは古い形のままなので、両方読めるようにします。
  const v = row.value as unknown;
  const all: Item[] = Array.isArray(v) ? v
    : Array.isArray((v as { 予定?: Item[] })?.予定) ? (v as { 予定: Item[] }).予定 : [];
  const storedTotal = Array.isArray(v) ? v.length
    : Number((v as { 総数?: number })?.総数 ?? all.length);
  // 上限で切られて、ここに来ていない予定の数。どれも一覧の最後より先の予定です
  const cut = Math.max(0, storedTotal - all.length);

  const today = todayInTokyo();
  const nowMin = minutesNowInTokyo();

  // 今日の、もう終わった時刻の予定は出しません
  const items = all.filter(it => {
    if (it.ymd > today) return true;
    const end = it.endYmd || it.ymd;
    if (end < today) return false;          // 過ぎた予定
    if (it.ymd < today) return true;        // 複数日にまたがって今日も続いている
    if (it.allDay || !it.start) return true;
    const [h, m] = it.start.split(':').map(Number);
    return (h * 60 + m) >= nowMin - 60;     // 始まって1時間は残す
  });

  const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit') || 5)));

  // 30日ぶんの合計だと、くり返しの予定でふくらんで実感と合いません。
  // 今日から7日ぶんも数えて返します。
  // 「今週」と呼ぶと日曜（土曜）で切ると読めてしまうので、名前も
  // 中身どおり「この先7日」にしています。
  const weekEnd = addDays(today, 6);
  const weekCount = items.filter(it => it.ymd <= weekEnd).length;

  // 同じ予定のくり返しで一覧が埋まらないよう、同じ名前・同じ人の
  // 予定は最初の1回だけ残し、何回あるかを添えます。
  // 件数（混み具合）は間引く前の数のままです。
  const seen = new Map<string, Item>();
  const distinct: Item[] = [];
  for (const it of items) {
    const key = JSON.stringify([it.title, it.who || it.whoNames || '']);
    const first = seen.get(key);
    if (first) { first.回数 = (first.回数 || 1) + 1; continue; }
    const copy = { ...it, 回数: 1 };
    seen.set(key, copy);
    distinct.push(copy);
  }

  return json({
    today,
    件数: items.length + cut,
    この先7日: weekCount,
    今週: weekCount,         // 古いウィジェット用。貼りかえたら使いません
    予定: distinct.slice(0, limit),
    診断: {
      保存されている件数: all.length,
      上限で切られた件数: cut,
      これから: items.length,
      まとめたあと: distinct.length,
      七日目: weekEnd,
      最終更新: row.updated_at
    }
  });
});
