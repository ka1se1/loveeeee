// ============================================================
//  お絵かき伝言ゲーム（作り直し）
//  直したところ:
//   ・subscribe 完了を待ってから送る（500ms 待ちの当てずっぽうをやめた）
//   ・役は乱数で自動決定。ふたりとも同じボタンでよい（デッドロック解消）
//   ・ラウンドごとに描く人と当てる人が入れ替わる
//   ・線は1本ずつ送らず、1フレームぶんまとめて送る
// ============================================================
import { db } from './supabase.js';
import { GAME_CANVAS, GAME_ROUND_SEC } from './config.js';
import { $, el, clear, showToast } from './util.js';
import { registerActions } from './actions.js';
import { DRAW_WORDS } from './words.js';

const SIZE = GAME_CANVAS;
const myToken = Math.random().toString(36).slice(2) + Date.now().toString(36);

let channel = null;
let peerToken = null;
let round = 0;
let role = null;          // 'drawer' | 'guesser' | null
let currentWord = '';
let timer = null;
let timeLeft = GAME_ROUND_SEC;
let ctx = null;           // いま描画に使っている 2d コンテキスト

/* ---------- お題 ---------- */
async function randomWord() {
  if (Math.random() < 0.3) {
    try {
      const id = Math.floor(Math.random() * 1010) + 1;
      const res = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${id}/`);
      if (res.ok) {
        const data = await res.json();
        const ja = data.names.find(n => n.language.name === 'ja-Hrkt' || n.language.name === 'ja');
        if (ja && ja.name) return ja.name;
      }
    } catch (e) { console.warn('ポケモンAPIに繋がりませんでした', e); }
  }
  return DRAW_WORDS[Math.floor(Math.random() * DRAW_WORDS.length)];
}

/* ---------- 画面の出し分け ---------- */
function show(which) {
  ['gameStartScreen', 'waitingScreen', 'drawerScreen', 'guesserScreen'].forEach(id => {
    const node = $(id);
    if (node) node.style.display = (id === which) ? 'block' : 'none';
  });
}

function setStatus(text) {
  const node = $('waitingText');
  if (node) node.textContent = text;
}

/* ---------- 接続 ---------- */
function send(event, payload = {}) {
  if (channel) channel.send({ type: 'broadcast', event, payload: { ...payload, from: myToken } });
}

function connect() {
  if (channel) db.removeChannel(channel);
  peerToken = null;
  channel = db.channel('draw-game', { config: { broadcast: { self: false }, private: true } });

  channel
    .on('broadcast', { event: 'hello' }, ({ payload }) => {
      if (payload.from === myToken) return;
      const isNew = !peerToken;
      peerToken = payload.from;
      // 相手が後から来た場合、こちらの存在を知らせ返す
      if (payload.reply !== false) send('hello', { reply: false });
      if (isNew) beginMatch();
    })
    .on('broadcast', { event: 'round_start' }, ({ payload }) => {
      round = payload.round;
      startRound(payload.drawer === myToken ? 'drawer' : 'guesser');
    })
    .on('broadcast', { event: 'strokes' }, ({ payload }) => {
      if (role !== 'guesser' || !ctx) return;
      drawSegments(ctx, payload.segments);
    })
    .on('broadcast', { event: 'clear' }, () => { if (ctx) ctx.clearRect(0, 0, SIZE, SIZE); })
    .on('broadcast', { event: 'guess' }, ({ payload }) => {
      if (role !== 'drawer') return;
      const correct = normalize(payload.text) === normalize(currentWord);
      appendGuess(payload.text, correct);
      if (correct) {
        stopTimer();
        send('round_end', { correct: true, word: currentWord });
        endRound(true, currentWord);
      }
    })
    .on('broadcast', { event: 'round_end' }, ({ payload }) => {
      if (role !== 'guesser') return;
      stopTimer();
      endRound(payload.correct, payload.word);
    })
    .on('broadcast', { event: 'bye' }, () => {
      showToast('相手がゲームを抜けました');
      leave();
    })
    .subscribe(status => {
      // ここが肝心。SUBSCRIBED になってから初めて送る
      if (status === 'SUBSCRIBED') send('hello');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setStatus('接続できませんでした。もう一度お試しください');
      }
    });
}

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '');
}

/* ---------- 役の決定 ---------- */
function beginMatch() {
  // ふたりとも同じ規則で決めるので、通信なしで結論が一致する
  if (myToken < peerToken) {
    round = 1;
    nextRoundAsDrawer();
  } else {
    setStatus('お題を準備しています…');
  }
}

async function nextRoundAsDrawer() {
  currentWord = await randomWord();
  send('round_start', { round, drawer: myToken });
  startRound('drawer');
}

function startRound(newRole) {
  role = newRole;
  const overlay = $('roundEndOverlay');
  if (overlay) overlay.remove();

  if (role === 'drawer') {
    show('drawerScreen');
    $('drawWord').textContent = currentWord;
    clear($('guessDisplay'));
    $('guessDisplay').appendChild(el('p', { class: 'guess-hint', text: '相手の答えがここに出ます' }));
    setupCanvas($('drawCanvas'), true);
  } else {
    show('guesserScreen');
    setupCanvas($('watchCanvas'), false);
    $('guessInput').value = '';
  }
  startTimer();
}

/* ---------- キャンバス ---------- */
let drawing = false;
let queue = [];
let frame = null;
let last = null;

function setupCanvas(canvas, interactive) {
  ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, SIZE, SIZE);
  if (!interactive || canvas.dataset.bound) return;
  canvas.dataset.bound = '1';

  const pos = e => {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return {
      x: (p.clientX - r.left) * (SIZE / r.width),
      y: (p.clientY - r.top) * (SIZE / r.height)
    };
  };

  const start = e => { e.preventDefault(); drawing = true; last = pos(e); };
  const move = e => {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    const seg = [last.x, last.y, p.x, p.y];
    drawSegments(ctx, [seg]);
    queue.push(seg);
    if (!frame) frame = requestAnimationFrame(flush);   // 1フレームぶんまとめて送る
    last = p;
  };
  const end = () => { drawing = false; flush(); };

  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', end);
}

function flush() {
  frame = null;
  if (!queue.length) return;
  send('strokes', { segments: queue });
  queue = [];
}

function drawSegments(context, segments) {
  context.strokeStyle = '#333';
  context.lineWidth = 3;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  for (const [x0, y0, x1, y1] of segments) {
    context.moveTo(x0, y0);
    context.lineTo(x1, y1);
  }
  context.stroke();
}

function clearCanvas() {
  if (ctx) ctx.clearRect(0, 0, SIZE, SIZE);
  send('clear');
}

/* ---------- 回答 ---------- */
function appendGuess(text, correct) {
  const box = $('guessDisplay');
  const hint = box.querySelector('.guess-hint');
  if (hint) hint.remove();
  const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  box.appendChild(el('div', {
    class: 'guess-line' + (correct ? ' correct' : ''),
    text: `${time}  ${text}${correct ? '  正解' : ''}`
  }));
  box.scrollTop = box.scrollHeight;
}

function sendGuess() {
  const input = $('guessInput');
  const text = input.value.trim();
  if (!text) return;
  send('guess', { text });
  input.value = '';
}

/* ---------- タイマー ---------- */
function startTimer() {
  stopTimer();
  timeLeft = GAME_ROUND_SEC;
  paintTimer();
  timer = setInterval(() => {
    timeLeft--;
    paintTimer();
    if (timeLeft <= 0) {
      stopTimer();
      if (role === 'drawer') {
        send('round_end', { correct: false, word: currentWord });
        endRound(false, currentWord);
      }
    }
  }, 1000);
}
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
function paintTimer() {
  [$('gameTimer'), $('gameTimerGuesser')].forEach(node => {
    if (!node) return;
    node.textContent = timeLeft + '秒';
    node.classList.toggle('hurry', timeLeft <= 10);
  });
}

/* ---------- ラウンド終了 ---------- */
function endRound(correct, word) {
  const existing = $('roundEndOverlay');
  if (existing) existing.remove();

  const overlay = el('div', { id: 'roundEndOverlay', class: 'round-end' + (correct ? ' win' : '') }, [
    el('div', { class: 'round-end-icon', text: correct ? '🎉' : '⏰', 'aria-hidden': 'true' }),
    el('h2', { class: 'round-end-title', text: correct ? '正解' : '時間切れ' }),
    el('p', { class: 'round-end-word', text: `答え：${word}` }),
    el('p', { class: 'round-end-sub', text: '次は役を交代します' }),
    el('button', { class: 'round-end-next', text: '次のお題へ', onclick: goNextRound }),
    el('button', { class: 'round-end-quit', text: 'ゲームを終える', onclick: leave })
  ]);
  document.body.appendChild(overlay);
}

async function goNextRound() {
  const overlay = $('roundEndOverlay');
  if (overlay) overlay.remove();
  round++;
  // 押した人が次の描く人になる（どちらが押しても成立する）
  currentWord = await randomWord();
  send('round_start', { round, drawer: myToken });
  send('clear');
  startRound('drawer');
}

/* ---------- 出入り ---------- */
function join() {
  show('waitingScreen');
  setStatus('相手が来るのを待っています…');
  connect();
}

function leave() {
  stopTimer();
  const overlay = $('roundEndOverlay');
  if (overlay) overlay.remove();
  if (channel) { send('bye'); db.removeChannel(channel); channel = null; }
  role = null; peerToken = null; currentWord = ''; round = 0; ctx = null;
  show('gameStartScreen');
}

/* ---------- 画面の切り替え ---------- */
function openGame() {
  $('homeScreen').style.display = 'none';
  $('gameScreen').style.display = 'block';
  document.body.classList.add('in-game');
  window.scrollTo(0, 0);
}
function closeGame() {
  leave();
  $('gameScreen').style.display = 'none';
  $('homeScreen').style.display = 'block';
  document.body.classList.remove('in-game');
  window.scrollTo(0, 0);
}

export function initGame() {
  registerActions({
    'game:open': openGame,
    'game:home': closeGame,
    'game:join': join,
    'game:leave': leave,
    'game:clear': clearCanvas,
    'game:guess': sendGuess
  });

  const input = $('guessInput');
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') sendGuess(); });
  window.addEventListener('pagehide', () => { if (channel) send('bye'); });
}
