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
};

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
    .from('settings').select('value').eq('key', 'upcoming').maybeSingle();
  if (error) return json({ error: error.message }, 500);

  const all: Item[] = Array.isArray(row?.value) ? row!.value : [];
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

  return json({
    today,
    件数: items.length,
    予定: items.slice(0, limit)
  });
});
