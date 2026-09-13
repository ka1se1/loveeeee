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
  confirmDialog, openModal, closeModal, withBusy, timeAgo
} from './util.js';
import { registerActions } from './actions.js';
import { notifyPartner } from './push.js';

/* ------------------------------------------------------------
   表示
   ------------------------------------------------------------ */
function repliesOf(diaryId) {
  return state.replies
    .filter(r => r.diary_id === diaryId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function replyNode(reply) {
  return el('div', { class: 'reply-entry' }, [
    el('button', {
      class: 'btn-delete-reply', text: '✕',
      'aria-label': '返信を削除', 'data-action': 'reply:delete', 'data-arg': reply.id
    }),
    el('div', { class: 'reply-header' }, [
      el('span', { class: 'reply-author', text: reply.author || '?' }),
      el('span', { class: 'reply-date', text: timeAgo(reply.created_at) })
    ]),
    el('div', { text: reply.content || '' })
  ]);
}

function diaryNode(diary) {
  const replies = repliesOf(diary.id);
  const children = [
    el('button', {
      class: 'btn-delete-diary', text: '✕',
      'aria-label': 'メッセージを削除', 'data-action': 'diary:delete', 'data-arg': diary.id
    }),
    el('div', { class: 'diary-header' }, [
      el('span', { class: 'diary-author', text: diary.author || '?' }),
      el('span', { class: 'diary-date', text: timeAgo(diary.created_at) })
    ]),
    el('div', { class: 'diary-content', text: diary.content || '' })
  ];

  if (replies.length) {
    children.push(el('div', { class: 'reply-list' }, replies.map(replyNode)));
  }

  children.push(el('div', { class: 'diary-actions' }, [
    el('button', {
      class: 'btn-reply',
      text: replies.length ? `💬 返信する（${replies.length}）` : '💬 返信する',
      'data-action': 'reply:open', 'data-arg': diary.id
    })
  ]));

  return el('div', { class: 'diary-entry' }, children);
}

export function renderDiaries() {
  const box = $('diaryListContainer');
  if (!box) return;
  clear(box);

  if (!state.diaries.length) {
    box.appendChild(emptyState('まだメッセージがありません。\n右上の＋から書いてみてください'));
    return;
  }
  state.diaries.forEach(d => box.appendChild(diaryNode(d)));
}

/* ------------------------------------------------------------
   メッセージを書く
   ------------------------------------------------------------ */
function openDiary() {
  setVal('diaryAuthorInput', userName || '');
  setVal('diaryContentInput', '');
  openModal('diaryModal');
}

async function saveDiary(_arg, _event, button) {
  const author = val('diaryAuthorInput') || userName || 'わたし';
  const content = val('diaryContentInput');
  if (!content) { showToast('内容を書いてね'); return; }

  await withBusy(button, '保存中…', async () => {
    let row;
    try {
      row = await addDiary({ author, content, created_by: userId });
    } catch (e) {
      showError('メッセージを保存できませんでした', e);
      return;
    }
    if (!state.diaries.some(d => d.id === row.id)) state.diaries.unshift(row);
    closeModal('diaryModal');
    renderDiaries();
    showToast('メッセージを送りました💌');
    notifyPartner('メッセージが届きました💌', `${author}: ${content.slice(0, 60)}`);
  });
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
  setVal('replyAuthorInput', userName || '');
  setVal('replyContentInput', '');
  openModal('replyModal');
}

function closeReply() {
  replyTo = null;
  closeModal('replyModal');
}

async function saveReply(_arg, _event, button) {
  if (!replyTo) return;
  const author = val('replyAuthorInput') || userName || 'わたし';
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
    'diary:open': openDiary,
    'diary:close': () => closeModal('diaryModal'),
    'diary:save': saveDiary,
    'diary:delete': deleteDiary,
    'reply:open': openReply,
    'reply:close': closeReply,
    'reply:save': saveReply,
    'reply:delete': deleteReply
  });

  on('diaries', renderDiaries);
}
