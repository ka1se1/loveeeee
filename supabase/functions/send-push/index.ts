// ============================================================
//  send-push
//  呼び出した本人以外のメンバー全員にプッシュを送る Edge Function。
//
//  デプロイ:
//    npx supabase functions deploy send-push
//  秘密情報:
//    npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // 1. 呼び出した本人を確かめる（誰でも送れると迷惑通知になる）
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

  const { title, body, url, tag } = await req.json().catch(() => ({}));
  if (!title) return json({ error: 'title is required' }, 400);

  // 3. 宛先の取得は service_role で（RLS を跨いで相手の購読を読む）
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  const { data: subs, error } = await admin
    .from('push_subscriptions').select('*').neq('user_id', user.id);
  if (error) return json({ error: error.message }, 500);

  const payload = JSON.stringify({ title, body: body ?? '', url: url ?? '/loveeeee/', tag });
  let sent = 0;
  const dead: string[] = [];

  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      );
      sent++;
    } catch (e) {
      // 404/410 は端末側で購読が消えている。掃除する。
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) dead.push(s.endpoint);
      else console.error('送信に失敗', code, e);
    }
  }));

  if (dead.length) {
    await admin.from('push_subscriptions').delete().in('endpoint', dead);
  }

  return json({ sent, removed: dead.length });
});
