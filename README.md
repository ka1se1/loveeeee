１

# Our Memories — 作り直し版のセットアップ

順番どおりに進めてください。**旧アプリは動かしたまま**、最後に切り替えます。

---

## 0. 先に済ませること（5分）

### ImgBB の鍵を失効させる

旧 `index.html` の先頭に書いてあった `IMGBB_API_KEY` は、ページを見た人全員に見えていました。
すでにコードからは消してありますが、鍵そのものは生きています。
ImgBB にログインして、**このキーを削除または再発行**してください。

---

## 1. データベースを作る

Supabase ダッシュボード → **SQL Editor** で `sql/01_schema.sql` を貼って実行します。
一度だけでかまいません（何度流しても壊れないように書いてあります）。

次に、**ふたりのユーザーIDを名簿に入れます。**
これを入れない人は、ログインできてもデータが一切見えません。ここが新しい防御の要です。

```sql
-- ユーザーIDを調べる
select id, email from auth.users;

-- 名簿に追加（ふたりぶん）
insert into space_members (user_id, name) values
  ('ここに1人目のuuid', 'あなたの名前'),
  ('ここに2人目のuuid', '相手の名前');
```

---

## 2. データを移す

1. `migrate.html` と `js/` を本番と同じ場所（`/loveeeee/`）に置きます
2. ブラウザで `https://あなたのドメイン/loveeeee/migrate.html` を開きます
3. ログイン → **「下見だけする」** で件数を確認
4. 問題なければ **「移行を実行」**

途中で失敗しても、もう一度押せば続きから移ります。二重登録はされません。
**旧 `memories` テーブルは消しません。** 新しいアプリをしばらく使って問題がないと確信できてから、手で削除してください。

---

## 3. 通知の設定

> **Windows の PowerShell を使っている場合**
> `npx` とだけ打つと「スクリプトの実行が無効になっている」と出て止まります。
> この節のコマンドは、すべて **`npx` を `npx.cmd` に置きかえて**ください（`npx.cmd supabase login` のように）。
> 設定を変えずに済みます。毎回打つのが面倒なら、一度だけ次を実行してもかまいません:
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

### VAPID 鍵を作る

手元のパソコンで一度だけ実行します。

```bash
npx web-push generate-vapid-keys
```

`Public Key` と `Private Key` が出ます。
（この作業は済んでいます。公開鍵は `js/config.js` に入れてあります）

### 公開鍵をアプリに入れる

`js/config.js` の次の行に、**Public Key** を貼ります。

```js
export const VAPID_PUBLIC_KEY = 'ここに公開鍵';
```

### Edge Function を置く

```bash
npx supabase login
npx supabase link --project-ref あなたのプロジェクトref

npx supabase secrets set \
  VAPID_PUBLIC_KEY=公開鍵 \
  VAPID_PRIVATE_KEY=秘密鍵 \
  VAPID_SUBJECT=mailto:あなたのメール

npx supabase functions deploy send-push
```

秘密鍵は Supabase の Secrets にだけ置きます。**`config.js` には絶対に書かないでください。**

### 使いかた

アプリの「🔔 通知」カードにあるボタンを押すと、その端末で通知が有効になります。
iPhone の場合は、**ホーム画面に追加したアプリとして開いてから**押してください（Safari のタブのままでは iOS が通知を許可しません）。

---

## 4. ファイルを配置する

`/loveeeee/` の下に、この構成で置きます。

```
/loveeeee/
├── index.html
├── manifest.json
├── sw.js
├── migrate.html          ← 移行が済んだら消して構いません
├── icon.png              ← 既存のものをそのまま
├── css/
│   └── styles.css
└── js/
    ├── config.js  supabase.js  util.js  actions.js  data.js
    ├── auth.js    main.js      photos.js  diary.js   shops.js
    ├── voice.js   weather.js   anniversary.js  love.js
    ├── game.js    push.js      sakura.js  words.js   calendar.js
```

**注意**: `js/` は ES モジュールなので、`file://` で直接開くと動きません。必ずサーバー経由（https）で開いてください。

`sw.js` と `manifest.json` の中のパスは `/loveeeee/` 前提です。別の場所に置く場合は、
`js/config.js` の `BASE_PATH`、`sw.js` の `APP_URL` / `ICON`、`manifest.json`、`index.html` の各パスを揃えて変えてください。

---

## 5. 動作を確かめる

ふたつの端末（またはブラウザ2つ）で開いて、次を試してください。

| 確認すること                                         | 期待する結果                                   |
| ---------------------------------------------------- | ---------------------------------------------- |
| 片方でメッセージを書く                               | もう片方に数秒で出る／「新着」が付く           |
| **同時に**片方で写真追加、もう片方で日記追加   | **どちらも消えない**（ここが今回の本丸） |
| メッセージに`<b>test</b>` と書く                   | そのまま文字として表示される（太字にならない） |
| 名簿に入れていないアカウントでログイン               | 「まだ招待されていません」と出て何も見えない   |
| ふたりとも「はじめる」を押す                         | 役が自動で決まり、ゲームが始まる               |
| ラウンド終了後「次のお題へ」                         | 役が入れ替わる                                 |
| 通知をオンにして、アプリを閉じる → 相手がメッセージ | 通知が届く                                     |

---

## 主な変更点

| 前                                          | 後                                      |
| ------------------------------------------- | --------------------------------------- |
| 全データを1行のJSONにまとめて毎回上書き     | テーブルを分割し、変わった1行だけ保存   |
| 添字で削除（並びが変わると別物が消える）    | idで削除                                |
| いいねが配列（同時押しで消える）            | `shop_likes` の行                     |
| ハートが「読んで足して書く」                | DB側で加算する RPC                      |
| `innerHTML` に文字列を直接差し込み        | 要素を組み立てて`textContent`         |
| インライン`onclick` が99箇所              | `data-action` の委譲に統一            |
| 起動処理が2本（ログイン前にも読み込み）     | `main.js` 1本                         |
| Service Worker 登録のみ（通知は実質動かず） | Web Push + Edge Function                |
| 単一 7,127行 / 277KB                        | HTML + CSS + JSモジュール19本           |
| RLS任せで名簿なし                           | `space_members` で明示的に2人だけ許可 |
| `voices` バケットが公開                   | 非公開 + 署名付きURL                    |

---

## 困ったときに見るところ

- **画面が真っ白** → ブラウザの開発者ツールのコンソール。`js/` のパスが合っているかをまず疑ってください
- **「データを読み込めませんでした」** → `space_members` に自分のIDが入っているか
- **写真が上がらない** → `storage.objects` のポリシーが入っているか（`sql/01_schema.sql` の末尾）
- **通知が来ない** → `npx supabase functions logs send-push` でEdge Functionのログを確認
