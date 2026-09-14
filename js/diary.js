// ============================================================
//  メッセージ（旧: 交換日記）と返信
//
//  直したところ:
//   ・本文は textContent に入れる。<b>test</b> は文字のまま出る
//   ・返信は diaries の中の配列ではなく replies の行。同時に書いても消えない
//   ・削除は id
// ============================================================
import { userId, userName } from './supabase.js';
import { state, addDiary, removeDiary, addReply, removeReply, on } from './data.js';
import {
  $, el, clear, emptyState, val, setVal, showToast, showError,
  confirmDialog, openModal, closeModal, withBusy
} from './util.js';
import { registerActions } from './actions.js';
import { notifyPartner } from './push.js';

/* ------------------------------------------------------------
   表示（会話として見せる）

   これまではふたりの発言が同じ見た目で、新しい順に並んでいました。
   自分と相手が区別できず、会話を下から上に読むことになっていました。
   ここでは古い順に積み、自分は右・相手は左に寄せます。
   ------------------------------------------------------------ */

/** 表示名で自分かどうかを見る。
 *  移行してきた古いメッセージは created_by が全部おなじ（移行した人）なので、
 *  created_by だけで判断すると全部が片側に寄ってしまいます。
 *  そのため author 名を先に見ます。 */
function norm(s) { return String(s || '').trim(); }

function isMine(row) {
  const me = norm(userName);
  const author = norm(row.author);
  if (me && author) return author === me;
  return row.created_by === userId;
}

function dayKey(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayLabel(value) {
  const d = new Date(value);
  const today = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return '今日';
  const yesterday = new Date(today.getTime() - 86400000);
  if (same(d, yesterday)) return '昨日';
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  const year = d.getFullYear() === today.getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日（${wd}）`;
}

function clockLabel(value) {
  const d = new Date(value);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** メッセージと返信を1本の流れにまとめ、古い順に並べる */
function timeline() {
  const items = state.diaries.map(d => ({ kind: 'diary', row: d, at: d.created_at }));
  for (const r of state.replies) {
    const parent = state.diaries.find(d => d.id === r.diary_id);
    items.push({ kind: 'reply', row: r, parent, at: r.created_at });
  }
  return items.sort((a, b) => new Date(a.at) - new Date(b.at));
}

/** 吹き出し1つ。押すと操作が出る */
function lineNode(item, tools = true) {
  const { kind, row, parent } = item;
  const bubble = el('div', {
    class: 'chat-bubble',
    role: 'button',
    tabindex: '0',
    'data-action': 'chat:toggle'
  });

  if (kind === 'reply' && parent) {
    bubble.appendChild(el('div', {
      class: 'chat-quote',
      text: `${parent.author || '?'}：${(parent.content || '').replace(/\s+/g, ' ')}`
    }));
  }
  bubble.appendChild(document.createTextNode(row.content || ''));

  // ホームの抜粋では操作を出さない（読むだけの場所なので）
  if (!tools) {
    bubble.removeAttribute('data-action');
    bubble.removeAttribute('role');
    bubble.removeAttribute('tabindex');
    return el('div', { class: 'chat-line-wrap' }, [
      el('div', { class: 'chat-line' }, [
        bubble,
        el('time', { class: 'chat-time', datetime: row.created_at, text: clockLabel(row.created_at) })
      ])
    ]);
  }

  const toolRow = el('div', { class: 'chat-tools' }, [
    el('button', {
      class: 'btn-chip', text: '返信',
      'data-action': 'reply:open',
      'data-arg': kind === 'reply' ? row.diary_id : row.id
    }),
    el('button', {
      class: 'btn-chip danger', text: '削除',
      'data-action': kind === 'reply' ? 'reply:delete' : 'diary:delete',
      'data-arg': row.id
    })
  ]);

  return el('div', { class: 'chat-line-wrap' }, [
    el('div', { class: 'chat-line' }, [
      bubble,
      el('time', { class: 'chat-time', datetime: row.created_at, text: clockLabel(row.created_at) })
    ]),
    toolRow
  ]);
}

/** 吹き出しの並びを、指定の入れ物に組み立てる。
 *  ホームの抜粋（tools なし）と、専用画面の本体（tools あり）で共用します。 */
function buildInto(box, items, { tools, days }) {
  let lastDay = null, group = null, lastSide = null, lastAuthor = null;

  for (const item of items) {
    if (days) {
      const day = dayKey(item.at);
      if (day !== lastDay) {
        box.appendChild(el('div', { class: 'chat-day', text: dayLabel(item.at) }));
        lastDay = day;
        group = null;
      }
    }

    const mine = isMine(item.row);
    const side = mine ? 'me' : 'them';
    const author = norm(item.row.author);

    // 同じ人が続けて話しているあいだは、名前を出さずにまとめる
    if (!group || side !== lastSide || author !== lastAuthor) {
      group = el('div', { class: 'chat-group ' + side });
      if (!mine) group.appendChild(el('div', { class: 'chat-name', text: author || '?' }));
      box.appendChild(group);
      lastSide = side;
      lastAuthor = author;
    }
    group.appendChild(lineNode(item, tools));
  }
}

/** ホームのカード。直近ぶんだけの抜粋で、操作は付けません */
const PREVIEW = 3;

export function renderDiaries() {
  const box = $('diaryListContainer');
  const all = timeline();

  if (box) {
    clear(box);
    box.className = 'chat chat-preview';
    if (!all.length) {
      box.appendChild(emptyState('まだメッセージがありません。\n右上の＋から書いてみてください'));
    } else {
      buildInto(box, all.slice(-PREVIEW), { tools: false, days: false });
      box.appendChild(el('button', {
        class: 'chat-open-btn',
        text: all.length > PREVIEW ? `すべて見る（${all.length}件）` : '会話を開く',
        'data-action': 'chat:open'
      }));
    }
  }

  // 専用画面を開いているあいだは、そちらも合わせて描き直す
  if (isChatOpen()) renderChat({ keepScroll: true });
}

/* ------------------------------------------------------------
   会話の専用画面
   ------------------------------------------------------------ */
const PAGE = 30;          // 遡るときの1回ぶん
let showing = PAGE;

/* 裏のページを本当に止める。
   iOS の Safari は body の overflow:hidden ではスクロールを止められません。
   止まっていないと、キーボードを開いた拍子に裏のページが動き、
   固定したはずの会話画面がずれて、その隙間から後ろが見えます。
   body 自体を position:fixed にして、いた位置を top で保持します。 */
let savedScroll = 0;

function lockPage() {
  savedScroll = window.scrollY || document.documentElement.scrollTop || 0;
  const b = document.body;
  b.style.position = 'fixed';
  b.style.top = -savedScroll + 'px';
  b.style.left = '0';
  b.style.right = '0';
  b.style.width = '100%';
  b.classList.add('chat-open');
}

function unlockPage() {
  const b = document.body;
  b.classList.remove('chat-open');
  b.style.position = '';
  b.style.top = '';
  b.style.left = '';
  b.style.right = '';
  b.style.width = '';
  window.scrollTo(0, savedScroll);   // 元いた場所に戻す
}

function isChatOpen() {
  const screen = $('chatScreen');
  return !!screen && screen.classList.contains('open');
}

function renderChat({ keepScroll } = {}) {
  const list = $('chatList');
  const scroller = $('chatScroll');
  if (!list || !scroller) return;

  const before = scroller.scrollHeight;
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;

  clear(list);
  const all = timeline();

  const count = $('chatHeadCount');
  if (count) count.textContent = all.length ? `${all.length}件` : '';

  if (!all.length) {
    list.appendChild(emptyState('まだメッセージがありません。\n下の欄に書いて送ってみてください'));
    return;
  }

  const take = Math.min(showing, all.length);
  const shown = all.slice(all.length - take);
  const hidden = all.length - shown.length;

  if (hidden > 0) {
    list.appendChild(el('button', {
      class: 'chat-more',
      text: `以前のメッセージを見る（残り${hidden}件）`,
      onclick: () => {
        // 遡ったとき、いま読んでいた位置がずれないようにする
        const keep = scroller.scrollHeight - scroller.scrollTop;
        showing += PAGE;
        renderChat({ keepScroll: true });
        scroller.scrollTop = scroller.scrollHeight - keep;
      }
    }));
  }

  buildInto(list, shown, { tools: true, days: true });

  // 開いたとき・新しい発言が来たときは、いちばん下を見せる
  if (!keepScroll || atBottom) scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop += scroller.scrollHeight - before;
}

function openChat() {
  const screen = $('chatScreen');
  if (!screen) return;
  showing = PAGE;
  resetScreenBox();
  screen.classList.add('open');
  lockPage();
  fitKeyboard();
  renderChat();
  const badge = $('diaryNewBadge');
  if (badge) badge.hidden = true;
  // 自動でフォーカスはしません。iOS ではキーボードが勝手に出たり
  // 出なかったりして、画面の高さが安定しないためです。
}

function closeChat() {
  const screen = $('chatScreen');
  if (screen) screen.classList.remove('open');
  resetScreenBox();
  unlockPage();
}

/** キーボードのぶんだけ、会話画面の内側に余白を作る。
 *
 *  ここで height を書きかえてはいけません。.chat-screen は inset:0 で
 *  画面全体を覆っており、height を足すと bottom が無視されて要素が
 *  画面の途中で終わり、その下から後ろのホーム画面が見えてしまいます。
 *  覆うのはやめず、内側に余白を作るのが正解です。 */
function fitKeyboard() {
  const screen = $('chatScreen');
  if (!screen || !screen.classList.contains('open')) return;
  const vv = window.visualViewport;
  if (!vv) return;

  // いま実際に見えている範囲を測って、そこにぴったり重ねる。
  // 「画面全体を覆っているはず」と決めつけるのをやめ、測った値に従います。
  // top と height を出すので、bottom は必ず auto にします。
  // （top・bottom・height が揃うと bottom が無視され、要素が途中で
  //   終わってしまいます。最初の不具合はこれが原因でした）
  screen.style.top = vv.offsetTop + 'px';
  screen.style.left = vv.offsetLeft + 'px';
  screen.style.width = vv.width + 'px';
  screen.style.height = vv.height + 'px';
  screen.style.bottom = 'auto';
  screen.style.right = 'auto';
  screen.style.paddingBottom = '';
  screen.style.transform = '';

  const keyboardUp = vv.height < window.innerHeight - 80;
  document.body.classList.toggle('keyboard-up', keyboardUp);

  if (keyboardUp) {
    const scroller = $('chatScroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
}

/** 会話画面に付けた位置の指定を、すべて元に戻す */
function resetScreenBox() {
  const screen = $('chatScreen');
  if (!screen) return;
  for (const p of ['top', 'left', 'right', 'bottom', 'width', 'height', 'paddingBottom', 'transform']) {
    screen.style[p] = '';
  }
  document.body.classList.remove('keyboard-up');
}

/** 入力欄の高さを中身に合わせる */
function growInput() {
  const input = $('chatInput');
  if (!input) return;
  const scroller = $('chatScroll');
  // 入力欄が伸びるとスクロール領域が縮み、見ていた最新の発言が隠れてしまう。
  // 下を見ていたなら、伸ばしたあとも下に留める。
  const atBottom = scroller &&
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;

  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';

  const send = $('chatSend');
  if (send) send.disabled = !input.value.trim();
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

async function sendFromChat() {
  const input = $('chatInput');
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;

  const author = userName || 'わたし';
  const send = $('chatSend');
  if (send) send.disabled = true;

  let row;
  try {
    row = await addDiary({ author, content, created_by: userId });
  } catch (e) {
    showError('メッセージを送れませんでした', e);
    if (send) send.disabled = false;
    return;
  }

  if (!state.diaries.some(d => d.id === row.id)) state.diaries.unshift(row);
  input.value = '';
  growInput();
  renderDiaries();
  renderChat();
  notifyPartner('メッセージが届きました💌', `${author}: ${content.slice(0, 60)}`);
}

async function deleteDiary(id) {
  if (!await confirmDialog('このメッセージを削除しますか？\n返信もいっしょに消えます。')) return;
  try { await removeDiary(id); }
  catch (e) { showError('削除できませんでした', e); return; }

  const i = state.diaries.findIndex(d => d.id === id);
  if (i !== -1) state.diaries.splice(i, 1);
  // 返信は DB 側で連鎖削除されるので、手元も揃えておく
  for (let k = state.replies.length - 1; k >= 0; k--) {
    if (state.replies[k].diary_id === id) state.replies.splice(k, 1);
  }
  renderDiaries();
  showToast('削除しました🗑️');
}

/* ------------------------------------------------------------
   返信
   ------------------------------------------------------------ */
let replyTo = null;

function openReply(diaryId) {
  const diary = state.diaries.find(d => d.id === diaryId);
  if (!diary) return;
  replyTo = diaryId;
  const title = $('replyModalTitle');
  if (title) title.textContent = `${diary.author || '?'} への返信`;
  setVal('replyContentInput', '');
  openModal('replyModal');
}

function closeReply() {
  replyTo = null;
  closeModal('replyModal');
}

async function saveReply(_arg, _event, button) {
  if (!replyTo) return;
  const author = userName || 'わたし';
  const content = val('replyContentInput');
  if (!content) { showToast('内容を書いてね'); return; }

  const diaryId = replyTo;
  await withBusy(button, '送信中…', async () => {
    let row;
    try {
      row = await addReply({ diary_id: diaryId, author, content, created_by: userId });
    } catch (e) {
      showError('返信を送れませんでした', e);
      return;
    }
    if (!state.replies.some(r => r.id === row.id)) state.replies.push(row);
    closeReply();
    renderDiaries();
    showToast('返信しました💬');
    notifyPartner('返信が届きました💬', `${author}: ${content.slice(0, 60)}`);
  });
}

async function deleteReply(id) {
  if (!await confirmDialog('この返信を削除しますか？')) return;
  try { await removeReply(id); }
  catch (e) { showError('削除できませんでした', e); return; }
  const i = state.replies.findIndex(r => r.id === id);
  if (i !== -1) state.replies.splice(i, 1);
  renderDiaries();
}

/* ------------------------------------------------------------
   起動
   ------------------------------------------------------------ */
export function initDiary() {
  registerActions({
    'chat:open': openChat,
    'chat:close': closeChat,
    'chat:send': sendFromChat,
    'diary:delete': deleteDiary,
    'reply:open': openReply,
    'reply:close': closeReply,
    'reply:save': saveReply,
    'reply:delete': deleteReply,
    // 吹き出しを押したときだけ「返信 / 削除」を出す。
    // 常に ✕ を並べておくと、消す操作が一番目立ってしまうため。
    'chat:toggle': (_arg, _event, node) => {
      const wrap = node.closest('.chat-line-wrap');
      if (!wrap) return;
      const open = wrap.classList.contains('open');
      document.querySelectorAll('.chat-line-wrap.open').forEach(n => n.classList.remove('open'));
      if (!open) wrap.classList.add('open');
    }
  });

  const input = $('chatInput');
  if (input) {
    input.addEventListener('input', growInput);
    // iOS は2回目以降のキーボード表示で resize を出さないことがあるので、
    // 触られたタイミングでも合わせ直す（少し遅らせるのは、キーボードが
    // 出きってからでないと高さが取れないため）
    input.addEventListener('focus', () => {
      fitKeyboard();
      setTimeout(fitKeyboard, 120);
      setTimeout(fitKeyboard, 400);
    });
    input.addEventListener('blur', () => setTimeout(fitKeyboard, 120));
    // スマホでは Enter は改行。送信は右のボタンか Ctrl/⌘+Enter で。
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendFromChat(); }
    });
    growInput();
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitKeyboard);
    window.visualViewport.addEventListener('scroll', fitKeyboard);
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isChatOpen()) closeChat();
  });

  on('diaries', renderDiaries);
}
