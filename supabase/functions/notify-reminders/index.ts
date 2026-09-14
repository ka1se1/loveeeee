// ============================================================
//  notify-reminders
//  予定のリマインダーを、時刻が来たものから送ります。
//
//  これまでは端末側の setTimeout で仕掛けていたので、アプリを
//  開きっぱなしにしていないと発火しませんでした。「1週間前に
//  知らせて」と設定しても、1週間ずっと開いていないと来ません。
//
//  くり返しの展開（毎週の複数曜日・隔週・第◯曜日・除外日など）は
//  カレンダー側に正しい実装があります。それをサーバーにもう一度
//  書くと2つがずれるので、展開はクライアントに任せ、結果だけを
//  settings['reminders'] に置いてもらい、ここは「時刻が来たものを
//  送る」ことだけをします。
//
//  デプロイ:
//    npx supabase functions deploy notify-reminders --no-verify-jwt
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Reminder = {
  id: string;        // 予定id + 日付。同じ通知を二度送らないための目印
  at: string;        // 知らせる時刻（ISO）
  title: string;
  date: string;      // 予定の日 YYYY-MM-DD
  when: string;      // '19:00' か '終日'
  before: number;    // 何分前の設定か
  location?: string;
};

/** 「1時間前」のような言い方に直す */
function beforeText(minutes: number) {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}日前`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}時間前`;
  return `${minutes}分前`;
}

function dayText(date: string, todayYmd: string) {
  if (date === todayYmd) return '今日';
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(todayYmd + 'T00:00:00Z').getTime();
  const x = Date.UTC(y, m - 1, d);
  if (x - t === 86400000) return '明日';
  return `${m}/${d}`;
}

function todayInTokyo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

Deno.serve(async (req) => {
  if (!CRON_SECRET) return json({ error: 'CRON_SECRET が未設定です' }, 500);
  if ((req.headers.get('x-cron-secret') ?? '') !== CRON_SECRET) {
    return json({ error: 'forbidden' }, 403);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data: row, error } = await admin
    .from('settings').select('value').eq('key', 'reminders').maybeSingle();
  if (error) return json({ error: error.message }, 500);

  const all: Reminder[] = Array.isArray(row?.value) ? row!.value : [];
  const now = Date.now();

  // 定期実行が遅れても拾えるよう、少し広めに見ます。
  // 二度送らないのは notify_log が担保します。
  const WINDOW = 40 * 60 * 1000;
  const due = all.filter(r => {
    const at = Date.parse(r.at);
    return !isNaN(at) && at <= now && now - at < WINDOW;
  });

  if (!due.length) return json({ held: all.length, sent: 0, note: 'いま知らせるものはありません' });

  const { data: subs } = await admin.from('push_subscriptions').select('*');
  const todayYmd = todayInTokyo();
  let sent = 0, skipped = 0;
  const dead: string[] = [];

  for (const r of due) {
    // 同じ通知を二度送らない。入らなかった＝すでに送ってある。
    const { data: claimed } = await admin
      .from('notify_log')
      .upsert({ key: 'rem:' + r.id }, { onConflict: 'key', ignoreDuplicates: true })
      .select();
    if (!claimed || !claimed.length) { skipped++; continue; }

    const when = [dayText(r.date, todayYmd), r.when].filter(Boolean).join(' ');
    const body = [when, r.location].filter(Boolean).join(' ・ ')
      + `（${beforeText(r.before)}のお知らせ）`;
    const payload = JSON.stringify({
      title: '⏰ ' + (r.title || '予定'), body, url: '/loveeeee/', tag: 'reminder-' + r.id
    });

    await Promise.all((subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(s.endpoint);
        else console.error('送信に失敗', code, e);
      }
    }));
  }

  if (dead.length) await admin.from('push_subscriptions').delete().in('endpoint', dead);

  // 古い記録は置いておいても仕方がないので片づける
  const old = new Date(now - 30 * 86400000).toISOString();
  await admin.from('notify_log').delete().lt('created_at', old);

  return json({ held: all.length, due: due.length, sent, skipped, removed: dead.length });
});
