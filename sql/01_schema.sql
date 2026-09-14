-- ============================================================
--  Our Memories — 新スキーマ
--  Supabase の SQL Editor に貼って、上から順に一度だけ実行してください。
--  既存の memories テーブルは消しません（移行が終わるまで残します）。
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- 0. このアプリを使える人の名簿
--    ここに入っている auth.users だけが全データにアクセスできます。
--    新規登録しただけの第三者は何も見えません。
-- ------------------------------------------------------------
create table if not exists public.space_members (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  name        text not null default 'わたし',
  created_at  timestamptz not null default now()
);

-- 「自分はメンバーか？」を判定する関数。全ポリシーがこれ1本を見ます。
-- security definer にしないと space_members 自身のポリシーと無限再帰します。
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.space_members m where m.user_id = auth.uid());
$$;

-- ------------------------------------------------------------
-- 1. 写真
-- ------------------------------------------------------------
create table if not exists public.photos (
  id          uuid primary key default gen_random_uuid(),
  full_path   text not null,
  thumb_path  text,
  orig_url    text,
  w           int,
  h           int,
  author_name text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists photos_created_at_idx on public.photos (created_at desc);

-- ------------------------------------------------------------
-- 2. メッセージ（旧: 交換日記）と返信
-- ------------------------------------------------------------
create table if not exists public.diaries (
  id          uuid primary key default gen_random_uuid(),
  author      text not null,
  content     text not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists diaries_created_at_idx on public.diaries (created_at desc);

create table if not exists public.replies (
  id          uuid primary key default gen_random_uuid(),
  diary_id    uuid not null references public.diaries(id) on delete cascade,
  author      text not null,
  content     text not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists replies_diary_idx on public.replies (diary_id, created_at);

-- ------------------------------------------------------------
-- 3. お店リスト と いいね
--    いいねを配列でなく行にすることで、同時押しでも消えなくなります。
-- ------------------------------------------------------------
create table if not exists public.shops (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  note        text default '',
  insta       text default '',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.shop_likes (
  shop_id     uuid not null references public.shops(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (shop_id, user_id)
);

-- ------------------------------------------------------------
-- 4. ボイスメッセージ
--    URL ではなく Storage のパスを持ちます（署名付きURLを都度発行するため）
-- ------------------------------------------------------------
create table if not exists public.voices (
  id          uuid primary key default gen_random_uuid(),
  author      text not null,
  path        text not null,
  duration_ms int,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists voices_created_at_idx on public.voices (created_at desc);

-- ------------------------------------------------------------
-- 5. 予定
--    カレンダーの予定は項目が多く今後も増えるので、1予定1行 + jsonb にします。
--    「1行まるごと上書き」ではなく「1予定だけ上書き」になるのが肝心な点です。
-- ------------------------------------------------------------
create table if not exists public.events (
  id          text primary key,
  data        jsonb not null,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 6. 記念日
-- ------------------------------------------------------------
create table if not exists public.anniversaries (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  date        date not null,
  type        text not null default 'anniversary',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 7. ふたりで共有する設定（ラベル・メンバーなど）
-- ------------------------------------------------------------
create table if not exists public.settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 8. カウンタ（ハートの数）
--    加算は RPC 経由にして「読んで足して書く」競合をなくします。
-- ------------------------------------------------------------
create table if not exists public.counters (
  key    text primary key,
  value  bigint not null default 0
);
insert into public.counters (key, value) values ('love', 0) on conflict (key) do nothing;

create or replace function public.bump_counter(p_key text, p_by int default 1)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v bigint;
begin
  if not public.is_member() then
    raise exception 'not a member';
  end if;
  insert into public.counters(key, value) values (p_key, p_by)
    on conflict (key) do update set value = public.counters.value + p_by
    returning value into v;
  return v;
end;
$$;

-- ------------------------------------------------------------
-- 9. プッシュ通知の宛先
-- ------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

-- ============================================================
--  RLS: メンバーだけが読み書きできる
-- ============================================================
alter table public.space_members      enable row level security;
alter table public.photos             enable row level security;
alter table public.diaries            enable row level security;
alter table public.replies            enable row level security;
alter table public.shops              enable row level security;
alter table public.shop_likes         enable row level security;
alter table public.voices             enable row level security;
alter table public.events             enable row level security;
alter table public.anniversaries      enable row level security;
alter table public.settings           enable row level security;
alter table public.counters           enable row level security;
alter table public.push_subscriptions enable row level security;

-- 名簿そのものは「自分の行を読む」「自分の名前を変える」だけ許可。
-- 名簿への追加は下の手順どおり管理者が手で入れます（自己登録させない）。
drop policy if exists sm_select on public.space_members;
create policy sm_select on public.space_members
  for select using (public.is_member());
drop policy if exists sm_update on public.space_members;
create policy sm_update on public.space_members
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 共有データは全部おなじルール
do $$
declare t text;
begin
  foreach t in array array['photos','diaries','replies','shops','shop_likes',
                           'voices','events','anniversaries','settings','counters']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_all', t);
    execute format(
      'create policy %I on public.%I for all using (public.is_member()) with check (public.is_member())',
      t || '_all', t);
  end loop;
end $$;

-- プッシュの宛先は自分のものだけ触れる。送信側（Edge Function）は
-- service_role で動くので RLS を通りません。
drop policy if exists ps_own on public.push_subscriptions;
create policy ps_own on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
--  Realtime: 変更を相手の画面へ流す
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['photos','diaries','replies','shops','shop_likes',
                           'voices','events','anniversaries','settings','counters']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when others then
        raise notice '⚠ % を realtime に足せませんでした（%）。ダッシュボードの Database → Replication から手で入れてください', t, sqlerrm;
    end;
  end loop;
end $$;

-- 削除イベントで id を受け取るために必要
alter table public.photos        replica identity full;
alter table public.diaries       replica identity full;
alter table public.replies       replica identity full;
alter table public.shops         replica identity full;
alter table public.shop_likes    replica identity full;
alter table public.voices        replica identity full;
alter table public.events        replica identity full;
alter table public.anniversaries replica identity full;

-- ============================================================
--  Storage
-- ============================================================
-- photos は公開バケット（画像は推測困難なパスで十分）
insert into storage.buckets (id, name, public)
  values ('photos', 'photos', true)
  on conflict (id) do update set public = true;

-- voices は非公開。署名付きURLでしか聞けません。
insert into storage.buckets (id, name, public)
  values ('voices', 'voices', false)
  on conflict (id) do update set public = false;

-- storage.objects と realtime.messages は Supabase 自身が所有しているテーブルです。
-- プロジェクトによっては、ここにポリシーを作る権限がありません。
-- そのときに上の本体まで巻き戻ってしまわないよう、失敗しても続けるようにしています。
-- 失敗した場合は下の NOTICE が出るので、その部分だけ手で入れてください。
do $$
begin
  drop policy if exists photos_rw on storage.objects;
  create policy photos_rw on storage.objects
    for all to authenticated
    using (bucket_id = 'photos' and public.is_member())
    with check (bucket_id = 'photos' and public.is_member());

  drop policy if exists voices_rw on storage.objects;
  create policy voices_rw on storage.objects
    for all to authenticated
    using (bucket_id = 'voices' and public.is_member())
    with check (bucket_id = 'voices' and public.is_member());

  raise notice '✅ Storage のポリシーを作りました';
exception when others then
  raise notice '⚠ Storage のポリシーを作れませんでした（%）。写真とボイスが使えないので、ダッシュボードの Storage → Policies から手で追加してください', sqlerrm;
end $$;

-- ============================================================
--  Realtime の broadcast（お絵かきゲーム）
--  private チャンネルを使うので、メンバーだけが送受信できるようにする
--
--  ※ realtime.messages の RLS は Supabase 側で最初から有効です。
--    ALTER TABLE ... ENABLE ROW LEVEL SECURITY は実行してはいけません
--    （テーブルの所有者ではないため「must be owner of table messages」で止まります）
-- ============================================================
do $$
begin
  drop policy if exists rt_members on realtime.messages;
  create policy rt_members on realtime.messages
    for all to authenticated
    using (public.is_member())
    with check (public.is_member());

  raise notice '✅ お絵かきゲームのポリシーを作りました';
exception when others then
  raise notice '⚠ realtime.messages のポリシーを作れませんでした（%）。お絵かきゲームだけが使えません。js/game.js の private: true を false にすれば動きます', sqlerrm;
end $$;

-- ============================================================
--  最後に、ちゃんと入ったかを目で確かめる
--  期待する結果:  テーブル 12 / RPC 2 / Storageのバケット 2 /
--                 Storageのポリシー 2 / ゲームのポリシー 1
--  ここが足りないときは、その行だけ手当てすれば大丈夫です。
-- ============================================================
select
  (select count(*) from pg_tables
     where schemaname = 'public'
       and tablename in ('space_members','photos','diaries','replies','shops','shop_likes',
                         'voices','events','anniversaries','settings','counters',
                         'push_subscriptions'))                         as "テーブル",
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('is_member','bump_counter')) as "RPC",
  (select count(*) from storage.buckets where id in ('photos','voices')) as "バケット",
  (select count(*) from pg_policies
     where schemaname = 'storage' and policyname in ('photos_rw','voices_rw')) as "Storageのポリシー",
  (select count(*) from pg_policies
     where schemaname = 'realtime' and policyname = 'rt_members')       as "ゲームのポリシー";
