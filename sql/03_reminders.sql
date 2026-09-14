-- ============================================================
--  予定のリマインダーを、本当に届くようにする
--
--  Supabase の SQL Editor に貼って、一度だけ実行してください。
--  何度流しても重複しないように書いてあります。
--
--  これまでリマインダーは端末側の setTimeout で仕掛けていたため、
--  アプリを開きっぱなしにしていないと発火しませんでした。
--  「1週間前に知らせて」と設定しても、1週間ずっと開いていないと
--  来ません。ここからはサーバー側が10分おきに見て送ります。
--
--  ⚠ 下の「ここに合言葉」を、別途お伝えした文字列に置きかえてから
--    実行してください（記念日の通知と同じ合言葉です）。
-- ============================================================

-- 同じ知らせを二度送らないための記録。
-- 誰も直接触る必要がないので、ポリシーを作りません。
-- （＝アプリからは読み書きできない。Edge Function は service_role
--   で動くので RLS を通らず、これだけが触れます）
create table if not exists public.notify_log (
  key         text primary key,
  created_at  timestamptz not null default now()
);
alter table public.notify_log enable row level security;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

do $$
begin
  perform cron.unschedule('reminder-notify');
exception when others then null;
end $$;

-- 10分おきに見にいく
select cron.schedule(
  'reminder-notify',
  '*/10 * * * *',
  $job$
    select net.http_post(
      url := 'https://aelvmpvgzvaiomqimzgo.supabase.co/functions/v1/notify-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', 'ここに合言葉'
      ),
      body := '{}'::jsonb
    );
  $job$
);

-- ============================================================
--  ちゃんと登録できたか確かめる
--  期待する結果: 2行（記念日と予定）返り、どちらも「有効」が true
-- ============================================================
select jobname as "名前", schedule as "実行間隔(UTC)", active as "有効"
from cron.job
where jobname in ('anniversary-notify', 'reminder-notify')
order by jobname;
