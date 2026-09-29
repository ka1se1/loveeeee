// ============================================================
//  Our Memories — ホーム画面ウィジェット（カレンダー）
//
//  iOS のウィジェットは WidgetKit（ネイティブ専用）なので、
//  Web アプリからは作れません。無料アプリ「Scriptable」に
//  このスクリプトを貼って、ウィジェットとして置きます。
//
//  置きかた:
//   1. App Store で「Scriptable」を入れる
//   2. Scriptable を開いて右上の ＋ → このファイルの中身を貼る
//   3. 下の TOKEN を、別途お伝えした文字列に置きかえる
//   4. 名前を「Our Memories」にして保存
//   5. Scriptable の中で一度実行すると、その場で見た目を確認できます
//   6. ホーム画面を長押し → ＋ → Scriptable → 中サイズを選ぶ
//   7. ウィジェットを長押し → 「ウィジェットを編集」→
//      Script に「Our Memories」を選ぶ
//
//  ※ このファイルは公開リポジトリに入るので、合言葉は
//    書き込んでいません。
// ============================================================

const TOKEN = 'ここに合言葉';
const API = 'https://aelvmpvgzvaiomqimzgo.supabase.co/functions/v1/widget-calendar';
const APP = 'https://ka1se1.github.io/loveeeee/';

// 押したときに Safari ではなくホーム画面のアプリを開きたい場合のみ、
// ショートカットApp で「App を開く」を作り、その名前をここに入れます。
// ただし iOS によっては Web アプリが一覧に出ません。その場合は空のまま。
// 空なら Safari で開きます。名前が合っていないと何も起きないので注意。
const SHORTCUT = '';

/* ---------- 配色（アプリと同じ） ---------- */
const INK = new Color('#2f2a2c');   // 本文
const INK2 = new Color('#7a6e71');  // 補足
const INK3 = new Color('#a89a9e');  // さらに弱い
const ACCENT = new Color('#c2185b'); // ピンク
const LINE = new Color('#ebe1da');  // 区切り線

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const family = (typeof config !== 'undefined' && config.widgetFamily) || 'medium';

/* ---------- 日付まわり ---------- */

/** 2026-09-29 → { 相対: '今日'|'明日'|'', 表記: '9/29(火)' } */
function whenOf(ymd, todayYmd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
  const wd = WD[new Date(y, m - 1, d).getDay()];
  return {
    差: diff,
    相対: diff === 0 ? '今日' : diff === 1 ? '明日' : diff === 2 ? '明後日' : '',
    表記: `${m}/${d}(${wd})`
  };
}

/** 一覧の行に出す文字。今日・明日は日付より相対を優先する */
function whenLabel(item, todayYmd) {
  const w = whenOf(item.ymd, todayYmd);
  const day = w.相対 || w.表記;
  if (item.allDay || !item.start) return day + ' 終日';
  return day + ' ' + item.start;
}

function headerDate(todayYmd) {
  const [y, m, d] = todayYmd.split('-').map(Number);
  return `${m}月${d}日(${WD[new Date(y, m - 1, d).getDay()]})`;
}

/* ---------- 取得 ---------- */
async function load() {
  const req = new Request(`${API}?limit=8`);
  req.headers = { 'x-widget-token': TOKEN };
  req.timeoutInterval = 15;
  return await req.loadJSON();
}

/* ---------- 部品 ---------- */

/** 小さな丸（ラベルの色） */
function dot(stack, color, size) {
  const d = stack.addStack();
  d.size = new Size(size, size);
  d.cornerRadius = size / 2;
  d.backgroundColor = new Color(color || '#c2185b');
}

/** 誰の予定か。絵文字があればそれ、無ければ名前の頭文字 */
function who(stack, item, size) {
  const mark = item.who || (item.whoNames ? item.whoNames.slice(0, 1) : '');
  if (!mark) return;
  const t = stack.addText(mark);
  t.font = Font.systemFont(size);
  t.lineLimit = 1;
}

/** 区切り線。
 *  幅を 0 のままにすると中身ぶんに潰れて見えないので、
 *  中にスペーサーを入れて横いっぱいに広げます。 */
function divider(stack) {
  const line = stack.addStack();
  line.size = new Size(0, 1);
  line.backgroundColor = LINE;
  line.addSpacer();
}

/** 見出し：今日の日付と、これからの件数 */
function header(w, data) {
  const head = w.addStack();
  head.centerAlignContent();

  const d = head.addText(headerDate(data.today));
  d.font = Font.semiboldSystemFont(11);
  d.textColor = INK2;

  head.addSpacer();

  // 30日ぶんの合計だと、くり返しの予定でふくらんで実感と合いません。
  // 直近7日ぶんを出します。
  const n = data.今週;
  if (n) {
    const chip = head.addStack();
    chip.setPadding(2, 8, 2, 8);
    chip.cornerRadius = 9;
    chip.backgroundColor = new Color('#fdeef4');
    const c = chip.addText('今週 ' + n + '件');
    c.font = Font.boldSystemFont(10);
    c.textColor = ACCENT;
  }
}

/** 次の予定。いちばん大きく出す */
function hero(w, item, todayYmd) {
  const when = whenOf(item.ymd, todayYmd);

  const top = w.addStack();
  top.centerAlignContent();
  dot(top, item.color, 7);
  top.addSpacer(6);

  const t = top.addText(whenLabel(item, todayYmd));
  t.font = Font.boldSystemFont(12);
  // 今日と明日は色を変えて、ひと目で分かるようにする
  t.textColor = when.差 <= 1 ? ACCENT : INK2;
  top.addSpacer();
  who(top, item, 13);

  w.addSpacer(4);

  const title = w.addText(item.title);
  title.font = Font.boldSystemFont(17);
  title.textColor = INK;
  title.lineLimit = 1;
  title.minimumScaleFactor = 0.7;

  if (item.location) {
    w.addSpacer(2);
    const loc = w.addText('📍 ' + item.location);
    loc.font = Font.systemFont(10);
    loc.textColor = INK3;
    loc.lineLimit = 1;
  }
}

/** 2件目以降。小さく並べる */
function row(stack, item, todayYmd) {
  const line = stack.addStack();
  line.centerAlignContent();

  dot(line, item.color, 5);
  line.addSpacer(6);

  const when = line.addText(whenLabel(item, todayYmd));
  when.font = Font.mediumSystemFont(10);
  when.textColor = INK2;
  when.lineLimit = 1;

  line.addSpacer(7);

  const title = line.addText(item.title);
  title.font = Font.semiboldSystemFont(11);
  title.textColor = INK;
  title.lineLimit = 1;
  title.minimumScaleFactor = 0.8;

  line.addSpacer();
  who(line, item, 11);
}

/* ---------- 組み立て ---------- */
function build(data, error) {
  const w = new ListWidget();
  w.url = SHORTCUT
    ? 'shortcuts://run-shortcut?name=' + encodeURIComponent(SHORTCUT)
    : APP;

  // 平らな一色より、わずかに階調があるほうが落ち着きます
  const g = new LinearGradient();
  g.colors = [new Color('#fffbf8'), new Color('#fdf1f4')];
  g.locations = [0, 1];
  g.startPoint = new Point(0, 0);
  g.endPoint = new Point(1, 1);
  w.backgroundGradient = g;

  w.setPadding(14, 15, 12, 15);

  if (error) {
    const t = w.addText('読み込めませんでした');
    t.font = Font.semiboldSystemFont(13);
    t.textColor = INK;
    w.addSpacer(4);
    const s = w.addText('通信を確かめてください');
    s.font = Font.systemFont(10);
    s.textColor = INK3;
    w.addSpacer();
    return w;
  }

  const items = (data && data.予定) || [];

  if (!items.length) {
    header(w, data);
    w.addSpacer();
    const t = w.addText('予定はありません');
    t.font = Font.semiboldSystemFont(13);
    t.textColor = INK2;
    w.addSpacer(2);
    const s = w.addText('ゆっくりしましょう');
    s.font = Font.systemFont(10);
    s.textColor = INK3;
    w.addSpacer();
    return w;
  }

  header(w, data);
  w.addSpacer(11);
  hero(w, items[0], data.today);

  // 小さいサイズは次の1件だけ。残りは件数で伝える
  const rest = items.slice(1);
  const room = family === 'small' ? 0 : family === 'large' ? 6 : 3;

  if (room && rest.length) {
    w.addSpacer(11);
    divider(w);
    w.addSpacer(9);
    const body = w.addStack();
    body.layoutVertically();
    body.spacing = 7;
    rest.slice(0, room).forEach(it => row(body, it, data.today));
  }

  w.addSpacer();

  // 窓口は上限を付けて返すので、rest の長さで数えると実際より
  // 少なくなります（上の「19件」と食い違っていました）。
  // 全体の件数から、いま出している件数を引きます。
  const total = data.件数 || (rest.length + 1);
  const hidden = total - 1 - Math.min(room, rest.length);
  if (hidden > 0) {
    const more = w.addText('ほか ' + hidden + ' 件');
    more.font = Font.systemFont(9);
    more.textColor = INK3;
  }

  return w;
}

/* ---------- 実行 ---------- */
let widget;
try {
  widget = build(await load(), null);
} catch (e) {
  widget = build(null, e);
}

if (typeof config !== 'undefined' && config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // Scriptable の中で実行したときは、その場で見た目を確かめられます
  if (family === 'small') await widget.presentSmall();
  else if (family === 'large') await widget.presentLarge();
  else await widget.presentMedium();
}
Script.complete();
