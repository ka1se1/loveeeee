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
//  スプレッドシートのアドレスはコードに書いていません。
//  窓口がログインした人にだけ返します。
// ============================================================
import { db } from './supabase.js';
import { $, el, clear } from './util.js';

const CACHE_KEY = 'dance_cache_v1';
const WD = ['日', '月', '火', '水', '木', '金', '土'];

let current = null;   // { genres, days, sheetUrl, fetchedAt }
let lastError = '';

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
  if (current) renderDanceCard();
  return current;
}

export function danceData() { return current; }

export async function loadDance() {
  if (!current) current = readCache();
  try {
    const { data, error } = await db.functions.invoke('dance-schedule');
    if (error) {
      // 窓口が返した理由（共有が切られた など）を読んで出す
      let msg = error.message;
      try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (e) { }
      throw new Error(msg);
    }
    if (!data || !Array.isArray(data.days)) throw new Error('練習の予定を読めませんでした');
    current = data;
    lastError = '';
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) { }
  } catch (e) {
    console.warn('練習場所を取れませんでした', e);
    lastError = String(e && e.message || e);
  }
  renderDanceCard();
  return current;
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

function untilLabel(ymd) {
  const n = daysUntil(ymd);
  return n <= 0 ? '今日' : n === 1 ? '明日' : n === 2 ? '明後日' : 'あと' + n + '日';
}

export function renderDanceCard() {
  const card = $('danceCard');
  const box = $('danceContainer');
  if (!card || !box) return;
  clear(box);

  const data = current;
  const day = nextDay(data);

  // 一度も取れていなくて、理由があるときは、黙って消さずに理由を出す
  if (!data) {
    card.hidden = !lastError;
    if (lastError) box.appendChild(el('p', { class: 'dance-note', text: '練習の予定を読めませんでした：' + lastError }));
    return;
  }
  card.hidden = false;

  const link = $('danceSheetLink');
  if (link) {
    if (data.sheetUrl) { link.href = data.sheetUrl; link.hidden = false; }
    else link.hidden = true;
  }

  if (!day) {
    box.appendChild(el('p', { class: 'dance-note', text: 'スプレッドシートに、これからの練習はまだありません' }));
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

  if (lastError) {
    box.appendChild(el('p', { class: 'dance-note', text: '※ いまは読み直せなかったので、前回の内容です' }));
  }
}
