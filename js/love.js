// ============================================================
//  ハート
//
//  直したところ:
//   ・「読んで、足して、書きもどす」をやめました。
//     ふたりが同時に押すと、片方のぶんが消えていたためです。
//     いまは DB 側で足す RPC(bump_counter) を呼びます。
//   ・連打ぶんは少しまとめてから1回で送ります（通信を減らすため）
// ============================================================
import { state, bumpLove, on } from './data.js';
import { $, el, showError } from './util.js';
import { registerActions } from './actions.js';

let pending = 0;       // まだ送っていないぶん
let flushTimer = null;
let sending = false;

export function renderLove() {
  const node = $('loveCountDisplay');
  if (node) node.textContent = String(state.love + pending);
}

/* ---------- 飛んでいくハート ---------- */
function flyHeart() {
  const button = document.querySelector('.love-float-btn');
  if (!button) return;
  const box = button.getBoundingClientRect();

  const heart = el('div', {
    class: 'flying-heart', text: '💖', 'aria-hidden': 'true',
    style: {
      left: (box.left + box.width / 2 - 12 + (Math.random() * 24 - 12)) + 'px',
      top: (box.top - 10) + 'px'
    }
  });
  document.body.appendChild(heart);
  setTimeout(() => heart.remove(), 1100);
}

/* ---------- 送信 ---------- */
async function flush() {
  flushTimer = null;
  if (sending || !pending) return;

  const by = pending;
  pending = 0;
  sending = true;
  try {
    await bumpLove(by);       // 戻り値で state.love が更新されます
  } catch (e) {
    // 送れなかったぶんは戻して、次の機会に送ります
    pending += by;
    showError('ハートを送れませんでした。通信を確かめてね', e);
  } finally {
    sending = false;
    renderLove();
    if (pending) flushTimer = setTimeout(flush, 800);
  }
}

function send() {
  pending++;
  renderLove();
  flyHeart();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 600);
}

export function initLove() {
  registerActions({ 'love:send': send });

  // 相手が押したぶんも、その場で数字に出す
  on('love', renderLove);

  // 送りそびれたまま閉じないように
  window.addEventListener('pagehide', () => { if (pending) flush(); });

  renderLove();
}
