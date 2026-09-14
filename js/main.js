// ============================================================
//  起動はここ1か所だけ
//  以前は window.addEventListener('load') と window.onload の
//  2本が同時に走り、ログイン前でも loadData() が動いていました。
// ============================================================
import { initActions, registerActions } from './actions.js';
import { checkLogin, initAuth } from './auth.js';
import { state, loadAll, startRealtime, on } from './data.js';
import { $, showError } from './util.js';
import { initPhotos, renderGallery } from './photos.js';
import { initDiary, renderDiaries } from './diary.js';
import { initShops, renderShops } from './shops.js';
import { initVoice, renderVoices } from './voice.js';
import { initWeather, fetchWeather } from './weather.js';
import { initAnniversary, renderAnniversaries } from './anniversary.js';
import { initLove, renderLove } from './love.js';
import { initGame } from './game.js';
import { initPush } from './push.js';
import { initSakura } from './sakura.js';
import { initCalendar, calApplyRemote, calApplySettings } from './calendar.js';

const BADGE = {
  photos: 'galleryNewBadge',
  diaries: 'diaryNewBadge',
  replies: 'diaryNewBadge',
  shops: 'shopNewBadge',
  voices: 'voiceNewBadge',
  events: 'calNewBadge'
};

function showBadge(table) {
  const badge = $(BADGE[table]);
  if (!badge) return;
  badge.hidden = false;
}

function hideSplash() {
  const splash = $('splashScreen');
  if (splash) splash.classList.add('hidden');
}

function renderAll() {
  renderGallery();
  renderDiaries();
  renderShops();
  renderVoices();
  renderAnniversaries();
  renderLove();
}

async function boot() {
  initActions();
  initAuth();
  initSakura();

  registerActions({
    'app:reload': () => location.reload(),
    'badge:dismiss': (_a, _b, el) => { el.hidden = true; }
  });

  const status = await checkLogin();
  if (status !== 'ok') { hideSplash(); return; }

  try {
    await loadAll();
  } catch (e) {
    showError('データを読み込めませんでした。通信を確かめて、更新を押してね', e);
    hideSplash();
    return;
  }

  initPhotos();
  initDiary();
  initShops();
  initVoice();
  initWeather();
  initAnniversary();
  initLove();
  initGame();
  renderAll();

  await initCalendar();

  on('remote-insert', ({ table }) => showBadge(table));
  on('settings', row => calApplySettings(row.key, row.value));

  startRealtime({
    onEvents: (type, row) => { calApplyRemote(type, row); showBadge('events'); }
  });

  fetchWeather();
  initPush();

  hideSplash();
}

boot().catch(e => {
  console.error('起動に失敗しました', e);
  showError('起動できませんでした。画面を更新してみてね', e);
  hideSplash();
});
