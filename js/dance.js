// ============================================================
//  ダンスの練習場所
//
//  サークルで共有されているスプレッドシートの「まとめ」タブを、
//  Edge Function（dance-schedule）が読んで、日付・ジャンル・場所・
//  時間だけにして返します。ここではそれを受け取って、
//   ・ホームの「次の練習」カード
//   ・カレンダー（読むだけの予定として。calendar.js 側）
//  に出します。
//
//  スプレッドシートは月ごとに新しく作られるので、カードの中から
//  何枚でも登録できます。登録した一覧は settings['dance_sheets'] に
//  置き、ふたりで同じものを見ます。アドレスはコードには書いていません。
// ============================================================
import { db } from './supabase.js';
import { saveSetting } from './data.js';
import { $, el, clear, showToast, showError, confirmDialog } from './util.js';

const CACHE_KEY = 'dance_cache_v1';
const SHEETS_KEY = 'dance_sheets';
const WD = ['日', '月', '火', '水', '木', '金', '土'];

let current = null;     // { genres, days, sheets, fetchedAt }
let lastError = '';
let loaded = false;     // 窓口から一度でも取れたか（前回の内容だけのときは false）
let inflight = null;
let panelOpen = false;
let busy = false;
let panelMsg = '';      // 登録欄の下に出す、うまくいかなかった理由
const listeners = [];

/** 新しい内容を読めたら知らせてもらう（カレンダーが使う） */
export function onDance(fn) { listeners.push(fn); }

const pad = n => String(n).padStart(2, '0');
function todayYmd() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysUntil(ymd) {
  return Math.round((parseYmd(ymd) - parseYmd(todayYmd())) / 86400000);
}
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/** その日のいちばん多い時間帯。カレンダーの予定の時刻と、カードの見出しに使う。
 *  ジャンルごとに違う時間は、それぞれの行に出します */
export function danceMainTime(day) {
  const count = new Map();
  day.genres.forEach(g => {
    if (!g.start) return;
    const k = g.start + '〜' + g.end;
    count.set(k, (count.get(k) || 0) + 1);
  });
  let best = null, n = 0;
  count.forEach((c, k) => { if (c > n) { n = c; best = k; } });
  if (!best) return null;
  const [start, end] = best.split('〜');
  return { start, end };
}

/** 今日の練習は、いちばん遅い終わりの時刻を過ぎるまで「次」に出す */
function nextDay(data) {
  if (!data || !data.days) return null;
  const today = todayYmd();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return data.days.find(d => {
    if (d.date > today) return true;
    if (d.date < today) return false;
    const ends = d.genres.filter(g => g.end).map(g => {
      const e = toMin(g.end);
      return e <= toMin(g.start) ? e + 1440 : e;   // 日をまたぐ（22:00〜02:00）
    });
    return !ends.length || Math.max(...ends) > nowMin;
  }) || null;
}

/* ---------- 取得 ---------- */

/** 前回うまく取れた内容。通信できなくても、起動してすぐ出せるように */
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/** 起動してすぐ、前回の内容でカードを描いて、その内容を返す */
export function primeDance() {
  if (!current) current = readCache();
  renderDanceCard();
  return current;
}

export function danceData() { return current; }

/** 窓口が返した理由（共有が切られた など）を読む */
async function reason(error) {
  let msg = error && error.message || String(error);
  try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (e) { }
  return msg;
}

/** 読み直す。何度呼ばれても、読んでいる最中なら同じものを待つ
 *  （自分で登録したときは、保存の通知もリアルタイムで届くので） */
export function loadDance() {
  if (inflight) return inflight;
  inflight = (async () => {
    if (!current) current = readCache();
    try {
      const { data, error } = await db.functions.invoke('dance-schedule');
      if (error) throw new Error(await reason(error));
      if (!data || !Array.isArray(data.days)) throw new Error('練習の予定を読めませんでした');
      current = data;
      loaded = true;
      lastError = '';
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { }
      listeners.forEach(fn => { try { fn(data); } catch (e) { console.warn(e); } });
    } catch (e) {
      console.warn('練習場所を取れませんでした', e);
      lastError = String(e && e.message || e);
    }
    renderDanceCard();
    return current;
  })().finally(() => { inflight = null; });
  return inflight;
}

/* ---------- 登録するシートの一覧 ---------- */

/** 貼られた URL からシートの ID を取り出す（窓口と同じ決まり） */
function sheetIdFrom(url) {
  const s = (url || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{30,}$/.test(s) ? s : null;
}

/** 保存する形。読めたかどうかなどは毎回窓口が確かめるので、覚えるのは最小限 */
function entriesNow() {
  return ((current && current.sheets) || []).map(s => ({
    id: s.id, gid: s.gid || '', title: s.title || '', addedAt: s.addedAt || ''
  }));
}

async function saveEntries(list) {
  await saveSetting(SHEETS_KEY, list);
}

async function addSheet(url) {
  panelMsg = '';
  const id = sheetIdFrom(url);
  if (!id) { panelMsg = 'スプレッドシートの URL を貼ってください（https://docs.google.com/spreadsheets/d/… の形です）'; renderDanceCard(); return; }
  if (!loaded) { panelMsg = 'いまの一覧をまだ読めていないので、少し待ってからもう一度お試しください'; renderDanceCard(); return; }
  const list = entriesNow();
  if (list.some(e => e.id === id)) { panelMsg = 'このスプレッドシートは、もう登録してあります'; renderDanceCard(); return; }

  busy = true; renderDanceCard();
  try {
    // 登録する前に、読めるかを確かめる
    const { data, error } = await db.functions.invoke('dance-schedule', { body: { check: url } });
    if (error) throw new Error(await reason(error));
    const s = data && data.sheet;
    if (!s) throw new Error('確かめられませんでした');
    if (s.error) { panelMsg = s.error; return; }

    const gidM = url.match(/[#&?]gid=(\d+)/);
    list.push({ id, gid: gidM ? gidM[1] : '', title: s.title || '', addedAt: new Date().toISOString() });
    await saveEntries(list);
    showToast('「' + (s.title || 'スプレッドシート') + '」を登録しました（' + rangeText(s) + '）', 4000);
    const input = $('danceUrlInput');
    if (input) input.value = '';
    await loadDance();
  } catch (e) {
    showError('登録できませんでした', e);
    panelMsg = '登録できませんでした：' + (e && e.message || e);
  } finally {
    busy = false;
    renderDanceCard();
  }
}

async function removeSheet(id) {
  const s = ((current && current.sheets) || []).find(x => x.id === id);
  const name = s && s.title ? '「' + s.title + '」' : 'このスプレッドシート';
  const yes = await confirmDialog(name + 'を一覧から外しますか？\nスプレッドシート自体は消えません。', { okText: '外す' });
  if (!yes) return;
  panelMsg = '';   // 前に失敗したときの理由は、もう関係ないので消す
  busy = true; renderDanceCard();
  try {
    await saveEntries(entriesNow().filter(e => e.id !== id));
    await loadDance();
  } catch (e) {
    showError('外せませんでした', e);
  } finally {
    busy = false;
    renderDanceCard();
  }
}

/* ---------- ホームのカード ---------- */

function mapLink(place) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place);
}

function dateLabel(ymd) {
  const d = parseYmd(ymd);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日(' + WD[d.getDay()] + ')';
}

function shortDate(ymd) {
  const d = parseYmd(ymd);
  return (d.getMonth() + 1) + '/' + d.getDate() + '(' + WD[d.getDay()] + ')';
}

function md(ymd) {
  const d = parseYmd(ymd);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

function rangeText(s) {
  return s.days ? md(s.from) + '〜' + md(s.to) + '・' + s.days + '日' : '練習日なし';
}

function untilLabel(ymd) {
  const n = daysUntil(ymd);
  return n <= 0 ? '今日' : n === 1 ? '明日' : n === 2 ? '明後日' : 'あと' + n + '日';
}

/** 次の練習日の中身 */
function renderNext(box, data) {
  const day = nextDay(data);
  if (!day) {
    box.appendChild(el('p', { class: 'dance-note', text: (data && data.sheets && data.sheets.length)
      ? '登録してあるスプレッドシートに、これからの練習はありません。新しい月のスプレッドシートを登録してください'
      : 'スプレッドシートがまだ登録されていません。下の「📄 スプレッドシート」から登録できます' }));
    return;
  }

  const main = danceMainTime(day);
  box.appendChild(el('div', { class: 'dance-head' }, [
    el('b', { class: 'dance-date', text: dateLabel(day.date) }),
    el('span', { class: 'dance-until' + (daysUntil(day.date) <= 0 ? ' is-today' : ''), text: untilLabel(day.date) }),
    main ? el('span', { class: 'dance-time', text: main.start + '〜' + main.end }) : null
  ]));

  const list = el('div', { class: 'dance-list' });
  day.genres.forEach(g => {
    const own = g.start ? g.start + '〜' + g.end : g.time;
    // その日の時間帯と同じなら、行ごとには書かない
    const differs = own && (!main || own !== main.start + '〜' + main.end);
    list.appendChild(el('div', { class: 'dance-row' }, [
      el('span', { class: 'dance-genre', text: g.genre }),
      g.place
        ? el('a', { class: 'dance-place', href: mapLink(g.place), target: '_blank', rel: 'noopener', text: g.place })
        : el('span', { class: 'dance-place is-empty', text: '場所未定' }),
      differs ? el('span', { class: 'dance-own', text: own }) : null
    ]));
  });
  box.appendChild(list);

  // その次も一行だけ
  const after = data.days.find(d => d.date > day.date);
  if (after) {
    const t = danceMainTime(after);
    box.appendChild(el('p', { class: 'dance-note', text: 'その次：' + shortDate(after.date) + (t ? ' ' + t.start + '〜' + t.end : '') }));
  }
}

/** 登録しているスプレッドシートの一覧と、追加する欄 */
function renderPanel(box, data) {
  const sheets = (data && data.sheets) || [];
  const panel = el('div', { class: 'dance-panel', id: 'dancePanel' });
  panel.appendChild(el('p', { class: 'dance-panel-title', text: '登録しているスプレッドシート' }));

  if (!sheets.length) {
    panel.appendChild(el('p', { class: 'dance-note', text: loaded ? 'まだありません' : '読み込み中…' }));
  }
  sheets.forEach(s => {
    panel.appendChild(el('div', { class: 'dance-sheet' + (s.error ? ' is-error' : '') }, [
      el('div', { class: 'dance-sheet-main' }, [
        el('a', { class: 'dance-sheet-name', href: s.url, target: '_blank', rel: 'noopener', text: s.title || '（名前のないスプレッドシート）' }),
        el('span', { class: 'dance-sheet-sub', text: s.error ? '⚠️ ' + s.error : rangeText(s) })
      ]),
      el('button', {
        class: 'dance-sheet-del', type: 'button', 'aria-label': (s.title || 'スプレッドシート') + 'を外す',
        disabled: busy, onclick: () => removeSheet(s.id), text: '外す'
      })
    ]));
  });

  const input = el('input', {
    id: 'danceUrlInput', class: 'dance-url', type: 'url', inputmode: 'url',
    placeholder: 'スプレッドシートの URL を貼る', autocomplete: 'off', disabled: busy
  });
  const add = el('button', {
    class: 'dance-add', type: 'button', disabled: busy, text: busy ? '確かめています…' : '追加',
    onclick: () => addSheet(input.value)
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') add.click(); });
  panel.appendChild(el('div', { class: 'dance-add-row' }, [input, add]));
  if (panelMsg) panel.appendChild(el('p', { class: 'dance-panel-msg', role: 'alert', text: panelMsg }));
  panel.appendChild(el('p', { class: 'dance-note', text:
    '来月のぶんも先に登録できます。各スプレッドシートの「まとめ」タブを読みます。同じ日付が2つのスプレッドシートにあるときは、あとから登録したほうを使います。' }));
  box.appendChild(panel);
}

export function renderDanceCard() {
  const card = $('danceCard');
  const box = $('danceContainer');
  if (!card || !box) return;
  // 登録する入口でもあるので、中身が無くてもカードは出しておく
  card.hidden = false;

  // 入力中の文字は描き直しで消さない
  const typing = $('danceUrlInput');
  const draft = typing ? typing.value : '';
  clear(box);
  const panelBox = $('dancePanelBox');
  if (panelBox) clear(panelBox);

  const data = current;
  if (!data && lastError) {
    box.appendChild(el('p', { class: 'dance-note', text: '練習の予定を読めませんでした：' + lastError }));
  } else if (!data) {
    box.appendChild(el('p', { class: 'dance-note', text: '読み込み中…' }));
  } else {
    renderNext(box, data);
    if (lastError) box.appendChild(el('p', { class: 'dance-note', text: '※ いまは読み直せなかったので、前回の内容です' }));
  }

  // 読めないシートがあるときは、開かなくても気づけるように
  const broken = ((data && data.sheets) || []).filter(s => s.error).length;
  const toggle = $('danceSheetsBtn');
  if (toggle) {
    toggle.textContent = '📄 スプレッドシート' + (broken ? '（⚠️' + broken + '）' : '') + (panelOpen ? ' ▴' : ' ▾');
    toggle.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    toggle.onclick = () => { panelOpen = !panelOpen; panelMsg = ''; renderDanceCard(); };
  }
  if (panelOpen && panelBox) {
    renderPanel(panelBox, data);
    const again = $('danceUrlInput');
    if (again && draft) again.value = draft;
  }
}
