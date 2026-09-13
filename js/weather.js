// ============================================================
//  今日の天気
//  Open-Meteo を使います。鍵がいらないので、ページに秘密を置かずに済みます。
//  位置情報が取れなければ config.js の場所を使います。
// ============================================================
import { WEATHER_FALLBACK } from './config.js';
import { $, el, clear, showToast } from './util.js';
import { registerActions } from './actions.js';

/* WMO の天気コード → 見た目と、ひとこと */
const CODES = {
  0: ['☀️', '快晴', 'お出かけ日和です。散歩でもどうですか'],
  1: ['🌤️', 'だいたい晴れ', '気持ちのいい一日になりそうです'],
  2: ['⛅', 'ところにより曇り', 'おだやかな空模様です'],
  3: ['☁️', 'くもり', '肌寒く感じるかもしれません'],
  45: ['🌫️', '霧', '見通しが悪いので、移動は気をつけて'],
  48: ['🌫️', '霧', '見通しが悪いので、移動は気をつけて'],
  51: ['🌦️', '霧雨', '折りたたみ傘があると安心です'],
  53: ['🌦️', '霧雨', '折りたたみ傘があると安心です'],
  55: ['🌧️', '霧雨（強め）', '傘を持って出かけてください'],
  56: ['🌧️', '凍る霧雨', '路面がすべりやすいので気をつけて'],
  57: ['🌧️', '凍る霧雨', '路面がすべりやすいので気をつけて'],
  61: ['🌦️', '弱い雨', '傘があると安心です'],
  63: ['🌧️', '雨', '傘を忘れずに'],
  65: ['🌧️', '強い雨', '足元に気をつけて。無理せず'],
  66: ['🌨️', '凍る雨', '路面が凍ります。急がずに'],
  67: ['🌨️', '凍る雨', '路面が凍ります。急がずに'],
  71: ['🌨️', '弱い雪', '暖かくしてお出かけを'],
  73: ['❄️', '雪', '暖かくして、足元に気をつけて'],
  75: ['❄️', '大雪', '無理のない予定にしてください'],
  77: ['🌨️', '雪粒', '暖かくしてお出かけを'],
  80: ['🌦️', 'にわか雨', '急に降るかもしれません。傘を'],
  81: ['🌧️', 'にわか雨', '急に降るかもしれません。傘を'],
  82: ['⛈️', '激しいにわか雨', '外出は気をつけて'],
  85: ['🌨️', 'にわか雪', '暖かくしてお出かけを'],
  86: ['❄️', '強いにわか雪', '無理のない予定にしてください'],
  95: ['⛈️', '雷雨', '外出は控えめに'],
  96: ['⛈️', '雷雨（ひょう）', '外出は控えめに'],
  99: ['⛈️', '激しい雷雨', '外出は控えめに']
};

function look(code) { return CODES[code] || ['🌈', '天気', 'どうぞよい一日を']; }

function message(box, text, className = 'loading-pulse') {
  clear(box);
  box.appendChild(el('div', { class: className, text }));
}

function place() {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve({ ...WEATHER_FALLBACK, exact: false }); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: '現在地', exact: true }),
      () => resolve({ ...WEATHER_FALLBACK, exact: false }),
      { timeout: 6000, maximumAge: 30 * 60 * 1000 }
    );
  });
}

let loading = false;

export async function fetchWeather(fromButton = false) {
  const box = $('weatherContainer');
  if (!box || loading) return;
  loading = true;
  message(box, '天気を読み込み中…');

  try {
    const spot = await place();
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${spot.lat.toFixed(4)}&longitude=${spot.lon.toFixed(4)}`
      + '&current=temperature_2m,weather_code,apparent_temperature'
      + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=auto&forecast_days=1';

    const res = await fetch(url);
    if (!res.ok) throw new Error('天気の取得に失敗: ' + res.status);
    const data = await res.json();

    const current = data.current || {};
    const daily = data.daily || {};
    const [icon, label, advice] = look(current.weather_code);
    const round = n => (n === null || n === undefined) ? '–' : Math.round(n) + '°';

    const sub = [];
    if (daily.temperature_2m_max) sub.push(`最高 ${round(daily.temperature_2m_max[0])}`);
    if (daily.temperature_2m_min) sub.push(`最低 ${round(daily.temperature_2m_min[0])}`);
    if (daily.precipitation_probability_max) {
      sub.push(`降水 ${daily.precipitation_probability_max[0] ?? '–'}%`);
    }

    clear(box);
    box.appendChild(el('div', { class: 'weather-icon', text: icon, 'aria-hidden': 'true' }));
    box.appendChild(el('div', { class: 'weather-label', text: label }));
    box.appendChild(el('div', { class: 'weather-temp', text: round(current.temperature_2m) }));
    if (sub.length) {
      box.appendChild(el('div', { class: 'weather-sub' }, sub.map(t => el('span', { text: t }))));
    }
    box.appendChild(el('p', { class: 'weather-advice', text: advice }));
    box.appendChild(el('div', {
      class: 'weather-loc',
      text: spot.exact ? '現在地の天気' : `${spot.name}の天気（位置情報が使えないため）`
    }));

    if (fromButton) showToast('天気を更新しました');
  } catch (e) {
    console.warn('天気を読み込めませんでした', e);
    clear(box);
    box.appendChild(el('div', { class: 'empty-state', text: '天気を読み込めませんでした。\n🔄 を押すともう一度試します' }));
  } finally {
    loading = false;
  }
}

export function initWeather() {
  registerActions({ 'weather:refresh': () => fetchWeather(true) });
}
