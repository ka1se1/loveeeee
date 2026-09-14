-- ============================================================
--  記念日の通知を、毎朝1回じぶんで動かす
--
--  Supabase の SQL Editor に貼って、一度だけ実行してください。
--  何度流しても重複しないように書いてあります。
--
--  これを入れると、アプリを開いていなくても
--    ・記念日／誕生日／カウントダウンの当日
--    ・その3日前
--  に、ふたりの端末へ通知が届きます。
--
--  ⚠ 下の「ここに合言葉」を、別途お伝えした文字列に置きかえてから
--    実行してください。このファイルは公開リポジトリに入るので、
--    合言葉そのものは書き込んでいません。
-- ============================================================

-- 定期実行(pg_cron)と、そこからHTTPを叩く仕組み(pg_net)を使えるようにする
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- 前に登録したものがあれば消す（無ければ何もしない）
do $$
begin
  perform cron.unschedule('anniversary-notify');
exception when others then null;   -- まだ無いだけなので気にしない
end $$;

-- 毎日 UTC 23:00 = 日本時間の翌朝 8:00 に実行する
select cron.schedule(
  'anniversary-notify',
  '0 23 * * *',
  $job$
    select net.http_post(
      url := 'https://aelvmpvgzvaiomqimzgo.supabase.co/functions/v1/notify-anniversaries',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', 'ここに合言葉'
      ),
      body := '{}'::jsonb
    );
  $job$
);

-- ============================================================
--  ちゃんと登録できたか、目で確かめる
--  期待する結果: 1行返り、「有効」が true
-- ============================================================
select jobname as "名前", schedule as "実行時刻(UTC)", active as "有効"
from cron.job
where jobname = 'anniversary-notify';
