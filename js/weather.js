// ============================================================
//  天気
//
//  Open-Meteo を使います。鍵がいらないので、ページに秘密を置かずに済みます。
//
//  作り直した理由:
//   ・今日1日ぶんしか取っておらず、「明日のデート、雨？」に答えられなかった
//   ・1日1個の値だけで、「夕方から降る」が言えなかった
//   ・体感温度を取りに行っているのに、表示していなかった
// ============================================================
import { WEATHER_FALLBACK } from './config.js';
import { $, el, clear, showToast } from './util.js';
import { registerActions } from './actions.js';

/* WMO の天気コード → 見た目と呼び名 */
const CODES = {
  0: ['☀️', '快晴'], 1: ['🌤️', 'だいたい晴れ'], 2: ['⛅', 'ところにより曇り'], 3: ['☁️', 'くもり'],
  45: ['🌫️', '霧'], 48: ['🌫️', '霧'],
  51: ['🌦️', '霧雨'], 53: ['🌦️', '霧雨'], 55: ['🌧️', '強い霧雨'],
  56: ['🌧️', '凍る霧雨'], 57: ['🌧️', '凍る霧雨'],
  61: ['🌦️', '弱い雨'], 63: ['🌧️', '雨'], 65: ['🌧️', '強い雨'],
  66: ['🌨️', '凍る雨'], 67: ['🌨️', '凍る雨'],
  71: ['🌨️', '弱い雪'], 73: ['❄️', '雪'], 75: ['❄️', '大雪'], 77: ['🌨️', '雪粒'],
  80: ['🌦️', 'にわか雨'], 81: ['🌧️', 'にわか雨'], 82: ['⛈️', '激しいにわか雨'],
  85: ['🌨️', 'にわか雪'], 86: ['❄️', '強いにわか雪'],
  95: ['⛈️', '雷雨'], 96: ['⛈️', '雷雨'], 99: ['⛈️', '激しい雷雨']
};

function look(code) { return CODES[code] || ['🌈', '天気']; }

/* 一日を4つに分ける */
const BUCKETS = [
  { name: '朝', from: 6, to: 11 },
  { name: '昼', from: 12, to: 16 },
  { name: '夕', from: 17, to: 20 },
  { name: '夜', from: 21, to: 23 }
];

const round = n => (n === null || n === undefined) ? '–' : Math.round(n) + '°';
const pct = n => (n === null || n === undefined) ? '–' : Math.round(n) + '%';
const ymdOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/* ------------------------------------------------------------
   位置
   ------------------------------------------------------------ */
let lastSpot = null;

function place() {
  if (lastSpot) return Promise.resolve(lastSpot);
  return new Promise(resolve => {
    const fallback = { ...WEATHER_FALLBACK, exact: false };
    if (!navigator.geolocation) { resolve(fallback); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        lastSpot = { lat: pos.coords.latitude, lon: pos.coords.longitude, name: '現在地', exact: true };
        resolve(lastSpot);
      },
      () => resolve(fallback),
      { timeout: 6000, maximumAge: 30 * 60 * 1000 }
    );
  });
}

/* ------------------------------------------------------------
   取得
   ------------------------------------------------------------ */
let loading = false;
let data = null;
let fetchedAt = 0;

async function load(spot) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${spot.lat.toFixed(4)}&longitude=${spot.lon.toFixed(4)}`
    + '&current=temperature_2m,apparent_temperature,weather_code'
    + '&hourly=temperature_2m,weather_code,precipitation_probability'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&timezone=auto&forecast_days=8';

  const res = await fetch(url);
  if (!res.ok) throw new Error('天気の取得に失敗: ' + res.status);
  return res.json();
}

/** その日時の1件を引く。hourly.time は "2026-09-14T19:00" の形 */
function hourAt(ymd, hour) {
  if (!data || !data.hourly) return null;
  const i = data.hourly.time.indexOf(`${ymd}T${String(hour).padStart(2, '0')}:00`);
  if (i === -1) return null;
  return {
    temp: data.hourly.temperature_2m[i],
    code: data.hourly.weather_code[i],
    rain: data.hourly.precipitation_probability[i]
  };
}

function dayAt(ymd) {
  if (!data || !data.daily) return null;
  const i = data.daily.time.indexOf(ymd);
  if (i === -1) return null;
  return {
    code: data.daily.weather_code[i],
    temp: data.daily.temperature_2m_max[i],
    max: data.daily.temperature_2m_max[i],
    min: data.daily.temperature_2m_min[i],
    rain: data.daily.precipitation_probability_max[i]
  };
}

/** 時間帯をまとめる。気温は平均、降水は最大、天気はいちばん降りそうな時のもの */
function bucketOf(ymd, bucket) {
  const hours = [];
  for (let h = bucket.from; h <= bucket.to; h++) {
    const got = hourAt(ymd, h);
    if (got) hours.push(got);
  }
  if (!hours.length) return null;
  const temps = hours.map(h => h.temp).filter(t => t !== null && t !== undefined);
  const worst = hours.reduce((a, b) => (b.rain || 0) > (a.rain || 0) ? b : a);
  return {
    temp: temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null,
    rain: Math.max(...hours.map(h => h.rain || 0)),
    code: worst.code
  };
}

/* ------------------------------------------------------------
   描画
   ------------------------------------------------------------ */
function rainNode(rain) {
  return el('div', { class: 'wx-rain' + (rain >= 50 ? ' wet' : ''), text: pct(rain) });
}

function renderNow(box, spot) {
  const cur = data.current || {};
  const [icon, label] = look(cur.weather_code);
  const today = dayAt(ymdOf(new Date()));

  const sub = [];
  if (cur.apparent_temperature !== undefined) sub.push('体感 ' + round(cur.apparent_temperature));
  if (today) sub.push('降水 ' + pct(today.rain));

  box.appendChild(el('div', { class: 'wx-now' }, [
    el('div', { class: 'wx-now-icon', text: icon, 'aria-hidden': 'true' }),
    el('div', { class: 'wx-now-main' }, [
      el('div', { class: 'wx-now-temp', text: round(cur.temperature_2m) }),
      el('div', { class: 'wx-now-label', text: label }),
      sub.length ? el('div', { class: 'wx-now-sub', text: sub.join(' ・ ') }) : null
    ]),
    el('div', { class: 'wx-loc', text: spot.exact ? '現在地' : spot.name })
  ]));
}

function renderBuckets(box) {
  const now = new Date();
  // 夜まで過ぎていたら、明日の時間帯を出す
  const tomorrow = now.getHours() >= 21;
  const ymd = ymdOf(new Date(now.getTime() + (tomorrow ? 86400000 : 0)));

  const cells = BUCKETS.map(b => {
    const got = bucketOf(ymd, b);
    if (!got) return null;
    const past = !tomorrow && now.getHours() > b.to;
    return el('div', { class: 'wx-cell' + (past ? ' past' : '') }, [
      el('div', { class: 'wx-cell-head', text: b.name }),
      el('div', { class: 'wx-cell-icon', text: look(got.code)[0], 'aria-hidden': 'true' }),
      el('div', { class: 'wx-cell-temp', text: round(got.temp) }),
      rainNode(got.rain)
    ]);
  }).filter(Boolean);

  if (!cells.length) return;
  box.appendChild(el('div', { class: 'wx-head', text: tomorrow ? '明日の時間帯' : '今日の時間帯' }));
  box.appendChild(el('div', { class: 'wx-row' }, cells));
}

function renderDays(box) {
  const now = new Date();
  const cells = ['今日', '明日', '明後日'].map((name, i) => {
    const got = dayAt(ymdOf(new Date(now.getTime() + i * 86400000)));
    if (!got) return null;
    return el('div', { class: 'wx-cell' }, [
      el('div', { class: 'wx-cell-head', text: name }),
      el('div', { class: 'wx-cell-icon', text: look(got.code)[0], 'aria-hidden': 'true' }),
      el('div', { class: 'wx-cell-temp' }, [
        el('span', { text: round(got.max) }),
        el('span', { class: 'wx-min', text: ' / ' + round(got.min) })
      ]),
      rainNode(got.rain)
    ]);
  }).filter(Boolean);

  if (!cells.length) return;
  box.appendChild(el('div', { class: 'wx-head', text: 'これから3日' }));
  box.appendChild(el('div', { class: 'wx-row' }, cells));
}

function render(spot) {
  const box = $('weatherContainer');
  if (!box || !data) return;
  clear(box);
  renderNow(box, spot);
  renderBuckets(box);
  renderDays(box);
}

/* ------------------------------------------------------------
   入口
   ------------------------------------------------------------ */
export async function fetchWeather(fromButton = false) {
  const box = $('weatherContainer');
  if (!box || loading) return;
  loading = true;

  if (!data) {
    clear(box);
    box.appendChild(el('div', { class: 'loading-pulse', text: '天気を読み込み中…' }));
  }

  try {
    const spot = await place();
    data = await load(spot);
    fetchedAt = Date.now();
    render(spot);
    if (fromButton) showToast('天気を更新しました');
  } catch (e) {
    console.warn('天気を読み込めませんでした', e);
    if (!data) {
      clear(box);
      box.appendChild(el('div', {
        class: 'empty-state',
        text: '天気を読み込めませんでした。\n🔄 を押すともう一度試します'
      }));
    } else if (fromButton) {
      showToast('天気を更新できませんでした');
    }
  } finally {
    loading = false;
  }
}

export function initWeather() {
  registerActions({ 'weather:refresh': () => fetchWeather(true) });

  // 開きっぱなしだと古いままになるので、戻ってきたときに見直す
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && data && Date.now() - fetchedAt > 30 * 60 * 1000) fetchWeather();
  });
}
