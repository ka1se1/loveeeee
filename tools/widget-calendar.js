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

// eagle（スプレッドシートの練習）で場所を出すジャンル。この順に並べます。
// ふたりのスマホで違うジャンルを出したいときは、それぞれここを変えてください。
// 例: ['break']、['hiphop', 'jazz']。空にすると場所は出しません。
const GENRES = ['break', 'hiphop'];

/* ---------- 配色（アプリと同じ） ----------
   Color.dynamic で明るい・暗いの両方を持たせると、iOS が外観に
   合わせて切りかえます（スクリプトを走らせ直さなくても変わります）。
   どれも背景に対して 4.5:1 以上あることを測って決めています。 */
const C = (light, dark) => Color.dynamic(new Color(light), new Color(dark));
const INK = C('#2f2a2c', '#f4eeeb');     // 本文
const INK2 = C('#685e61', '#c4b6ba');    // 時刻・日付
const INK3 = C('#756b6e', '#a3959a');    // 場所・件数（以前は 2.45:1 で読めませんでした）
const ACCENT = C('#c2185b', '#ff8fb4');  // 今日
const LINE = C('#ebe1da', '#3d3437');    // 区切り線
const CHIP_BG = C('#fdeef4', '#4a2231');
const CHIP_FG = C('#c2185b', '#ffb3cc');
const BG_TOP = C('#fffbf8', '#1f1a1c');
const BG_BOTTOM = C('#fdf1f4', '#2a2024');

const WD = ['日', '月', '火', '水', '木', '金', '土'];
const family = (typeof config !== 'undefined' && config.widgetFamily) || 'medium';
const CACHE_KEY = 'our-memories-widget';

/* ---------- 日付まわり ---------- */

/** 端末の今日。前回の内容を出すときも、今日を基準に言い直すため */
function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shortDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${m}/${d}(${WD[new Date(y, m - 1, d).getDay()]})`;
}

/** 何時から何時まで。アプリと同じく「〜」でつなぎます（幅が狭いので空白なし）。
 *  日をまたぐ予定は、終わりの日付も付けます。
 *  終わりの時刻が無い予定（古いデータを含む）は、始まりだけ。 */
function timeRange(item) {
  if (item.allDay || !item.start) return '終日';
  if (!item.end) return item.start;
  const endDay = item.endYmd && item.endYmd !== item.ymd
    ? item.endYmd.split('-').slice(1).map(Number).join('/') + ' '
    : '';
  return item.start + '〜' + endDay + item.end;
}

/** 今日から何日後か。複数日にまたがって続いている予定は負になる */
function daysFrom(ymd, today) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
}

/** 今日（または今日も続いている）予定か */
function isToday(item, today) {
  return daysFrom(item.ymd, today) <= 0;
}

/** 行に出す日時。
 *  今日の予定には「今日」を付けません。見出しに今日の日付があるので、
 *  付けると同じことを何度も言うことになります（色で今日だと分かります）。 */
function whenLabel(item, today) {
  const diff = daysFrom(item.ymd, today);
  const time = timeRange(item);
  if (diff < 0) {
    // 前の日から続いている予定は、いつ終わるかだけを出す
    const until = '〜' + shortDate(item.endYmd || item.ymd);
    return (item.allDay || !item.end) ? until : until + ' ' + item.end;
  }
  if (diff === 0) return time;
  const day = diff === 1 ? '明日' : diff === 2 ? '明後日' : shortDate(item.ymd);
  return day + ' ' + time;
}

function headerDate(today) {
  const [y, m, d] = today.split('-').map(Number);
  return `${m}月${d}日(${WD[new Date(y, m - 1, d).getDay()]})`;
}

/** 窓口と同じ基準で、もう終わった予定を落とす（前回の内容を出すとき用） */
function stillUpcoming(item, today) {
  const end = item.endYmd || item.ymd;
  if (end < today) return false;
  if (item.ymd !== today || item.allDay || !item.start) return true;
  const [h, m] = item.start.split(':').map(Number);
  const now = new Date();
  return h * 60 + m >= now.getHours() * 60 + now.getMinutes() - 60;
}

/** 次に描き直してほしい時刻。
 *  指定しないと iOS 任せになり、終わった予定が何時間も残っていました。
 *  iOS は目安として扱うので、きっかりには来ません。 */
function nextRefresh(items, today) {
  const now = Date.now();
  const cands = [now + 30 * 60000];                // 少なくとも30分に一度
  const midnight = new Date();
  midnight.setHours(24, 0, 30, 0);                 // 日付が変わると「明日」が今日になる
  cands.push(midnight.getTime());
  const first = items[0];
  if (first && first.ymd === today && first.start && !first.allDay) {
    // 窓口は始まって1時間で一覧から外すので、その直後
    const [h, m] = first.start.split(':').map(Number);
    const t = new Date();
    t.setHours(h, m, 0, 0);
    cands.push(t.getTime() + 61 * 60000);
  }
  const next = Math.min(...cands.filter(t => t > now + 60000));
  return new Date(Number.isFinite(next) ? next : now + 30 * 60000);
}

/* ---------- 取得と、前回の内容 ---------- */
async function load() {
  const req = new Request(`${API}?limit=8`);
  req.headers = { 'x-widget-token': TOKEN };
  req.timeoutInterval = 15;
  const data = await req.loadJSON();
  if (!data || data.error) throw new Error((data && data.error) || '空の応答');
  return data;
}

// 通信できないときに白紙にしないよう、うまく取れた内容を取っておきます
function saveCache(data) {
  try { Keychain.set(CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch (e) { }
}

function loadCache() {
  try {
    if (!Keychain.contains(CACHE_KEY)) return null;
    return JSON.parse(Keychain.get(CACHE_KEY));
  } catch (e) { return null; }
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
function whoMark(item) {
  return item.who || (item.whoNames ? item.whoNames.slice(0, 1) : '');
}

/** 誰の予定か。行の右端に置く */
function who(stack, item, size) {
  const mark = whoMark(item);
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

/** 見出し：今日の日付と、この先7日の件数 */
function header(w, data, today, stale) {
  const head = w.addStack();
  head.centerAlignContent();

  const d = head.addText(headerDate(today));
  d.font = Font.semiboldSystemFont(11);
  d.textColor = INK2;

  head.addSpacer();

  // 前回の内容を出しているときは、件数がもう合っていないので出しません
  const n = stale ? 0 : (data.この先7日 ?? data.今週);
  if (n) {
    const chip = head.addStack();
    chip.setPadding(2, 8, 2, 8);
    chip.cornerRadius = 9;
    chip.backgroundColor = CHIP_BG;
    // 「今週」と書くと日曜（土曜）までと読めますが、中身は今日から7日です
    const c = chip.addText('この先7日 ' + n + '件');
    c.font = Font.boldSystemFont(10);
    c.textColor = CHIP_FG;
  }
}

/** 次の予定。いちばん大きく出す */
function hero(w, item, today) {
  const top = w.addStack();
  top.centerAlignContent();
  dot(top, item.color, 7);
  top.addSpacer(6);

  const t = top.addText(whenLabel(item, today));
  t.font = Font.boldSystemFont(12);
  // 色の意味はひとつだけ：今日
  t.textColor = isToday(item, today) ? ACCENT : INK2;
  top.addSpacer();
  who(top, item, 13);

  w.addSpacer(4);

  const title = w.addText(item.title);
  title.font = Font.boldSystemFont(17);
  title.textColor = INK;
  title.lineLimit = 1;
  title.minimumScaleFactor = 0.7;

  // eagle は、選んだジャンルの場所を1行ずつ
  const places = placesOf(item);
  if (places.length) {
    places.forEach(d => {
      w.addSpacer(2);
      const line = w.addStack();
      line.centerAlignContent();
      const g = line.addText(d.genre);
      g.font = Font.semiboldSystemFont(10);
      g.textColor = INK3;
      line.addSpacer(5);
      const p = line.addText(d.place || '場所未定');
      p.font = Font.mediumSystemFont(11);
      p.textColor = INK2;
      p.lineLimit = 1;
      p.minimumScaleFactor = 0.7;
      const own = ownTime(d, item);
      if (own) {
        line.addSpacer(5);
        const o = line.addText(own);
        o.font = Font.systemFont(10);
        o.textColor = INK3;
      }
      line.addSpacer();
    });
  } else if (item.location) {
    w.addSpacer(2);
    const loc = w.addText('📍 ' + item.location);
    loc.font = Font.systemFont(10);
    loc.textColor = INK3;
    loc.lineLimit = 1;
  }
}

/* ---------- eagle の場所 ---------- */

/** 選んだジャンルの場所。その日にそのジャンルが無ければ飛ばす */
function placesOf(item) {
  if (!item.dance || !item.dance.length) return [];
  return GENRES
    .map(name => item.dance.find(d => String(d.genre).toLowerCase() === name.toLowerCase()))
    .filter(Boolean);
}

/** そのジャンルだけ時間が違うときの時間（同じなら空） */
function ownTime(d, item) {
  if (d.start) {
    return (d.start === item.start && d.end === item.end) ? '' : d.start + '〜' + d.end;
  }
  return d.time || '';
}

/** 一覧の行の下に出す、場所の1行 */
function placesLine(item) {
  return placesOf(item).map(d => {
    const own = ownTime(d, item);
    return d.genre + ' ' + (d.place || '場所未定') + (own ? '（' + own + '）' : '');
  }).join('　');
}

/* 高さの見積もり（行1本 = 1）。
   ウィジェットは中身が多いと下が切れてしまうので、場所の行が増えた
   ぶん、一覧に出す件数を減らします。場所の行は字が小さいので 0.9。 */
const SUB_LINE = 0.9;
function rowCost(item) { return 1 + (placesOf(item).length ? SUB_LINE : 0); }
function heroExtra(item) {
  // 場所（📍）1行までは、もともとの作りに入っている
  const lines = placesOf(item).length || (item.location ? 1 : 0);
  return Math.max(0, lines - 1) * SUB_LINE;
}

/** 2件目以降。小さく並べる */
function row(stack, item, today) {
  const sub = placesLine(item);
  let line = stack.addStack();
  let wrap = null;
  if (sub) {
    // eagle は、行の下に場所をもう1行
    wrap = line;
    wrap.layoutVertically();
    wrap.spacing = 2;
    line = wrap.addStack();
  }
  line.centerAlignContent();

  dot(line, item.color, 5);
  line.addSpacer(6);

  const when = line.addText(whenLabel(item, today));
  when.font = Font.mediumSystemFont(10);
  when.textColor = isToday(item, today) ? ACCENT : INK2;
  when.lineLimit = 1;

  line.addSpacer(7);

  const title = line.addText(item.title);
  title.font = Font.semiboldSystemFont(11);
  title.textColor = INK;
  title.lineLimit = 1;
  title.minimumScaleFactor = 0.8;

  line.addSpacer();
  who(line, item, 11);

  if (wrap) {
    const second = wrap.addStack();
    second.addSpacer(11);          // 色の丸のぶん下げて、時刻の頭に揃える
    const p = second.addText(sub);
    p.font = Font.systemFont(10);
    p.textColor = INK2;
    p.lineLimit = 1;
    p.minimumScaleFactor = 0.7;
    second.addSpacer();
  }
}

function small(stack, text, color) {
  const t = stack.addText(text);
  t.font = Font.systemFont(9);
  t.textColor = color || INK3;
  t.lineLimit = 1;
  return t;
}

/* ---------- 組み立て ----------
   cachedAt があるときは、通信できずに前回の内容を出しています */
function build(data, today, cachedAt) {
  const w = new ListWidget();
  w.url = SHORTCUT
    ? 'shortcuts://run-shortcut?name=' + encodeURIComponent(SHORTCUT)
    : APP;

  // 平らな一色より、わずかに階調があるほうが落ち着きます
  const g = new LinearGradient();
  g.colors = [BG_TOP, BG_BOTTOM];
  g.locations = [0, 1];
  g.startPoint = new Point(0, 0);
  g.endPoint = new Point(1, 1);
  w.backgroundGradient = g;

  w.setPadding(14, 15, 12, 15);

  // 通信できず、前回の内容も無い
  if (!data) {
    header(w, {}, today, true);
    w.addSpacer();
    const t = w.addText('読み込めませんでした');
    t.font = Font.semiboldSystemFont(13);
    t.textColor = INK;
    w.addSpacer(2);
    small(w, '通信を確かめてください');
    w.addSpacer();
    w.refreshAfterDate = new Date(Date.now() + 10 * 60000);
    return w;
  }

  const stale = !!cachedAt;
  let items = data.予定 || [];
  if (stale) items = items.filter(it => stillUpcoming(it, today));

  header(w, data, today, stale);

  if (!items.length) {
    w.addSpacer();
    const t = w.addText('予定はありません');
    t.font = Font.semiboldSystemFont(13);
    t.textColor = INK2;
    w.addSpacer(2);
    small(w, 'ゆっくりしましょう');
    w.addSpacer();
  } else {
    w.addSpacer(11);
    hero(w, items[0], today);

    // 小さいサイズは次の1件だけ。残りは件数で伝える
    const rest = items.slice(1);
    // 場所の行が増えたぶんは件数を減らす。日付の順は崩さない
    // （入らない行が出たら、そこで止める）
    const room = (family === 'small' ? 0 : family === 'large' ? 6 : 3) - heroExtra(items[0]);
    const shown = [];
    let used = 0;
    for (const it of rest) {
      const c = rowCost(it);
      if (used + c > room + 1e-9) break;
      shown.push(it);
      used += c;
    }

    if (shown.length) {
      w.addSpacer(11);
      divider(w);
      w.addSpacer(9);
      const body = w.addStack();
      body.layoutVertically();
      body.spacing = 7;
      shown.forEach(it => row(body, it, today));
    }

    w.addSpacer();

    const foot = w.addStack();
    foot.centerAlignContent();

    // 窓口は上限を付けて返すので、items の長さではなく全体の件数から、
    // いま出している件数を引きます。
    // 見出しの数（7日）と取り違えないよう、期間も書きます。
    if (!stale) {
      const total = data.件数 || 0;
      const hidden = total - 1 - shown.length;
      if (hidden > 0) small(foot, 'この先30日で ほか ' + hidden + ' 件');
    }
    foot.addSpacer();
    if (stale) {
      const at = new Date(cachedAt);
      small(foot, 'オフライン・' + (at.getMonth() + 1) + '/' + at.getDate() + ' '
        + String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0') + ' 時点');
    }
  }

  w.refreshAfterDate = stale
    ? new Date(Date.now() + 10 * 60000)   // 通信が戻ったらすぐ直したい
    : nextRefresh(items, today);
  return w;
}

/* ---------- 実行 ---------- */
const today = todayYmd();
let widget;
try {
  const data = await load();
  saveCache(data);
  widget = build(data, today, null);
} catch (e) {
  const cache = loadCache();
  widget = cache ? build(cache.data, today, cache.at) : build(null, today, null);
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
