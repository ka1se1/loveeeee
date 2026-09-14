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

const PAGE = 20;          // 最初に見せる件数
let showing = PAGE;

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
function lineNode(item) {
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

  const tools = el('div', { class: 'chat-tools' }, [
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
    tools
  ]);
}

export function renderDiaries() {
  const box = $('diaryListContainer');
  if (!box) return;
  clear(box);
  box.className = 'chat';

  const all = timeline();
  if (!all.length) {
    box.appendChild(emptyState('まだメッセージがありません。\n右上の＋から書いてみてください'));
    return;
  }

  // 多いときは新しいほうだけ。ページ全体が長くなりすぎないように。
  // showing そのものを減らしてはいけません。件数が少ないときに書きかえてしまうと、
  // あとからメッセージが増えても増えたぶんが出なくなります。
  const take = Math.min(showing, all.length);
  const shown = all.slice(all.length - take);
  const hidden = all.length - shown.length;

  if (hidden > 0) {
    box.appendChild(el('button', {
      class: 'chat-more',
      text: `以前のメッセージを見る（残り${hidden}件）`,
      onclick: () => { showing += PAGE; renderDiaries(); }
    }));
  }

  let lastDay = null;
  let group = null;
  let lastSide = null;
  let lastAuthor = null;

  for (const item of shown) {
    const day = dayKey(item.at);
    if (day !== lastDay) {
      box.appendChild(el('div', { class: 'chat-day', text: dayLabel(item.at) }));
      lastDay = day;
      group = null;
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
    group.appendChild(lineNode(item));
  }
}

/* ------------------------------------------------------------
   メッセージを書く
   ------------------------------------------------------------ */
function openDiary() {
  // 名前は聞きません。ログインしているのだから、誰が書いたかは分かっています。
  setVal('diaryContentInput', '');
  openModal('diaryModal');
}

async function saveDiary(_arg, _event, button) {
  const author = userName || 'わたし';
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
    'diary:open': openDiary,
    'diary:close': () => closeModal('diaryModal'),
    'diary:save': saveDiary,
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

  on('diaries', renderDiaries);
}
