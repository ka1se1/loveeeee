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
//   3. 名前を「Our Memories」にして保存
//   4. 下の TOKEN を、別途お伝えした文字列に置きかえる
//   5. ホーム画面を長押し → ＋ → Scriptable → 中サイズを選ぶ
//   6. ウィジェットを長押し → 「ウィジェットを編集」→
//      Script に「Our Memories」を選ぶ
//
//  ※ このファイルは公開リポジトリに入るので、合言葉は
//    書き込んでいません。
// ============================================================

const TOKEN = 'ここに合言葉';
const API = 'https://aelvmpvgzvaiomqimzgo.supabase.co/functions/v1/widget-calendar';
const APP = 'https://ka1se1.github.io/loveeeee/';

// アプリと同じ配色
const BG = new Color('#fbf7f4');
const CARD = new Color('#ffffff');
const INK = new Color('#2f2a2c');
const INK2 = new Color('#6b5d61');
const ACCENT = new Color('#c2185b');
const LINE = new Color('#ece3db');

const family = (typeof config !== 'undefined' && config.widgetFamily) || 'medium';
const MAX = family === 'small' ? 2 : family === 'large' ? 8 : 4;

const WD = ['日', '月', '火', '水', '木', '金', '土'];

/** 2026-09-29 → 今日 / 明日 / 9/29(火) */
function dayLabel(ymd, todayYmd) {
  if (ymd === todayYmd) return '今日';
  const [y, m, d] = ymd.split('-').map(Number);
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
  if (diff === 1) return '明日';
  const wd = WD[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${wd})`;
}

async function load() {
  const req = new Request(`${API}?limit=${MAX}`);
  req.headers = { 'x-widget-token': TOKEN };
  req.timeoutInterval = 15;
  return await req.loadJSON();
}

function row(stack, item, todayYmd) {
  const line = stack.addStack();
  line.centerAlignContent();
  line.spacing = 6;

  // ラベルの色を細い帯で
  const bar = line.addStack();
  bar.size = new Size(3, 16);
  bar.cornerRadius = 2;
  bar.backgroundColor = new Color(item.color || '#c2185b');
  line.addSpacer(2);

  const when = line.addText(
    dayLabel(item.ymd, todayYmd) + (item.allDay || !item.start ? '' : ' ' + item.start)
  );
  when.font = Font.mediumSystemFont(11);
  when.textColor = INK2;
  when.lineLimit = 1;
  when.minimumScaleFactor = 0.9;

  line.addSpacer(4);

  const title = line.addText(item.title);
  title.font = Font.semiboldSystemFont(12);
  title.textColor = INK;
  title.lineLimit = 1;
  title.minimumScaleFactor = 0.85;

  line.addSpacer();
}

function build(data, error) {
  const w = new ListWidget();
  w.backgroundColor = BG;
  w.url = APP;                       // 押すとアプリが開く
  w.setPadding(12, 13, 12, 13);

  const head = w.addStack();
  head.centerAlignContent();
  const t = head.addText('これからの予定');
  t.font = Font.boldSystemFont(11);
  t.textColor = ACCENT;
  head.addSpacer();
  if (!error) {
    const c = head.addText(String((data && data.件数) || 0) + '件');
    c.font = Font.systemFont(10);
    c.textColor = INK2;
  }
  w.addSpacer(8);

  if (error) {
    const e = w.addText('読み込めませんでした');
    e.font = Font.systemFont(12);
    e.textColor = INK2;
    w.addSpacer();
    const s = w.addText('通信を確かめて、少し待つと直ります');
    s.font = Font.systemFont(9);
    s.textColor = INK2;
    return w;
  }

  const items = (data && data.予定) || [];
  if (!items.length) {
    const e = w.addText('予定はまだありません');
    e.font = Font.systemFont(12);
    e.textColor = INK2;
    w.addSpacer();
    return w;
  }

  const body = w.addStack();
  body.layoutVertically();
  body.spacing = 7;
  items.slice(0, MAX).forEach(it => row(body, it, data.today));

  w.addSpacer();
  return w;
}

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
  await widget.presentMedium();
}
Script.complete();
