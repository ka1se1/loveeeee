// ============================================================
//  notify-anniversaries
//  毎朝1回、その日の記念日を探して、ふたりに通知を送ります。
//
//  アプリを開いていないときにも届く必要があるので、端末側の
//  setTimeout ではなく、サーバー側の定期実行から呼びます。
//  呼び出しは sql/02_cron.sql で仕込みます。
//
//  デプロイ:
//    npx supabase functions deploy notify-anniversaries --no-verify-jwt
//  ※ 定期実行はログインしていないので JWT を持ちません。
//    かわりに CRON_SECRET で呼び出し元を確かめます。
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

/** 日本時間の「今日」を {y, m, d} で得る */
function todayInTokyo() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

const DAY = 24 * 60 * 60 * 1000;
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

/**
 * 次にその日が来るまでの日数。
 * 毎年くり返すものは、今年ぶんが過ぎていれば来年を見ます。
 * カウントダウン（1回だけ）は、その日そのものを見ます。
 */
function daysUntil(row: { date: string; type: string }, today: { y: number; m: number; d: number }) {
  const [by, bm, bd] = row.date.slice(0, 10).split('-').map(Number);
  if (!by || !bm || !bd) return null;
  const now = utc(today.y, today.m, today.d);

  if (row.type === 'countdown') return Math.round((utc(by, bm, bd) - now) / DAY);

  let next = utc(today.y, bm, bd);
  if (next < now) next = utc(today.y + 1, bm, bd);
  return Math.round((next - now) / DAY);
}

function message(row: { title: string; type: string; date: string }, days: number, todayYear: number) {
  const icon = row.type === 'birthday' ? '🎂' : row.type === 'countdown' ? '⏰' : '🎉';
  const baseYear = Number(row.date.slice(0, 4));

  if (days === 0) {
    if (row.type === 'birthday') {
      const age = todayYear - baseYear;
      return { title: `${icon} 今日は${row.title}`, body: age > 0 ? `${age}歳の誕生日です。おめでとう！` : 'おめでとう！' };
    }
    if (row.type === 'countdown') return { title: `${icon} 今日は「${row.title}」`, body: 'いよいよ当日です' };
    const years = todayYear - baseYear;
    return { title: `${icon} 今日は${row.title}`, body: years > 0 ? `${years}周年です。おめでとう！` : 'おめでとう！' };
  }
  return { title: `${icon} ${row.title}まであと${days}日`, body: '忘れないうちに準備しておきましょう' };
}

Deno.serve(async (req) => {
  // 定期実行はログインしていないので、合言葉で呼び出し元を確かめます。
  // 合言葉が設定されていないときは、誰でも呼べてしまうので拒否します。
  if (!CRON_SECRET) return json({ error: 'CRON_SECRET が未設定です' }, 500);
  if ((req.headers.get('x-cron-secret') ?? '') !== CRON_SECRET) {
    return json({ error: 'forbidden' }, 403);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const today = todayInTokyo();
  const { data: rows, error } = await admin.from('anniversaries').select('title, date, type');
  if (error) return json({ error: error.message }, 500);

  // 当日と、3日前に知らせます
  const NOTIFY_ON = [0, 3];
  const hits = (rows ?? [])
    .map(r => ({ row: r, days: daysUntil(r, today) }))
    .filter(x => x.days !== null && NOTIFY_ON.includes(x.days as number));

  if (!hits.length) return json({ checked: rows?.length ?? 0, sent: 0, note: '今日は知らせる記念日がありません' });

  const { data: subs, error: subErr } = await admin.from('push_subscriptions').select('*');
  if (subErr) return json({ error: subErr.message }, 500);

  let sent = 0;
  const dead: string[] = [];

  for (const hit of hits) {
    const { title, body } = message(hit.row, hit.days as number, today.y);
    const payload = JSON.stringify({ title, body, url: '/loveeeee/', tag: 'anniversary' });

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

  return json({
    checked: rows?.length ?? 0,
    matched: hits.map(h => ({ title: h.row.title, days: h.days })),
    sent, removed: dead.length
  });
});
