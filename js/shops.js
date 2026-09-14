// ============================================================
//  お店リスト
//
//  直したところ:
//   ・「いいね」は shops 行の配列ではなく shop_likes の行。
//     ふたりが同時に押しても、片方のいいねが消えることがなくなりました。
//   ・削除は id
// ============================================================
import { userId, userName } from './supabase.js';
import { state, saveShop, removeShop, toggleLike, on } from './data.js';
import {
  $, el, clear, emptyState, val, setVal, showToast, showError,
  confirmDialog, openModal, closeModal, withBusy
} from './util.js';
import { registerActions } from './actions.js';
import { notifyPartner } from './push.js';

const PER_PAGE = 4;

/* ------------------------------------------------------------
   いいね
   ------------------------------------------------------------ */
function likesOf(shopId) { return state.shopLikes.filter(l => l.shop_id === shopId); }
function likedByMe(shopId) { return state.shopLikes.some(l => l.shop_id === shopId && l.user_id === userId); }

/* ------------------------------------------------------------
   表示
   ------------------------------------------------------------ */
function shopNode(shop) {
  const likes = likesOf(shop.id);
  const mine = likedByMe(shop.id);
  const both = likes.length >= 2;

  const children = [];
  if (both) children.push(el('div', { class: 'shop-both-tag', text: '💞 ふたりとも行きたい' }));

  children.push(el('h3', { class: 'shop-title', text: shop.name || '名称未設定' }));
  if (shop.note) children.push(el('div', { class: 'shop-note', text: shop.note }));

  // よく使うもの（行きたい／お店を見る）を横に並べる。
  // Instagram は全幅の派手な帯をやめ、同じ大きさの小さなボタンにします。
  const main = [
    el('button', {
      class: 'btn-chip like' + (mine ? ' on' : ''),
      text: likes.length ? `♥ ${likes.length}` : '♡ 行きたい',
      'aria-pressed': mine ? 'true' : 'false',
      'data-action': 'shop:like', 'data-arg': shop.id
    })
  ];
  if (shop.insta) {
    main.push(el('a', {
      class: 'insta-link', text: '📷 Instagram',
      href: shop.insta, target: '_blank', rel: 'noopener noreferrer'
    }));
  }
  // 編集と削除はふだん使うものではないので、同じ行の右端に小さく置く。
  // 行を増やすと、めったに使わない操作のために高さを使うことになります。
  main.push(el('div', { class: 'shop-manage' }, [
    el('button', { text: '編集', 'data-action': 'shop:edit', 'data-arg': shop.id }),
    el('button', { class: 'danger', text: '削除', 'data-action': 'shop:delete', 'data-arg': shop.id })
  ]));

  children.push(el('div', { class: 'shop-card-actions' }, main));

  return el('div', { class: 'shop-card' + (both ? ' shop-both' : '') }, children);
}

export function renderShops() {
  const box = $('shopListContainer');
  if (!box) return;
  clear(box);

  if (!state.shops.length) {
    box.appendChild(emptyState('まだお店がありません。\n右上の＋から追加してみてください'));
    return;
  }

  // 横スクロールで1ページずつ。1ページに4件入れます。
  for (let i = 0; i < state.shops.length; i += PER_PAGE) {
    const page = el('div', { class: 'shop-page' });
    state.shops.slice(i, i + PER_PAGE).forEach(s => page.appendChild(shopNode(s)));
    box.appendChild(page);
  }
}

/* ------------------------------------------------------------
   追加・編集
   ------------------------------------------------------------ */
let editingId = null;

function openShop(id) {
  const shop = id ? state.shops.find(s => s.id === id) : null;
  editingId = shop ? shop.id : null;

  const title = $('shopModalTitle');
  if (title) title.textContent = shop ? 'お店を編集' : 'お店を追加';
  setVal('shopNameInput', shop ? shop.name : '');
  setVal('shopInstaInput', shop ? shop.insta : '');
  setVal('shopNoteInput', shop ? shop.note : '');
  openModal('shopModal');
}

function closeShop() {
  editingId = null;
  closeModal('shopModal');
}

async function save(_arg, _event, button) {
  const name = val('shopNameInput');
  if (!name) { showToast('店名を入れてね'); return; }

  const insta = val('shopInstaInput');
  if (insta && !/^https?:\/\//i.test(insta)) {
    showToast('Instagram の URL は https:// からはじめてね');
    return;
  }

  const row = { name, insta, note: val('shopNoteInput') };
  if (editingId) row.id = editingId;
  else row.created_by = userId;

  const isNew = !editingId;
  await withBusy(button, '保存中…', async () => {
    let saved;
    try { saved = await saveShop(row); }
    catch (e) { showError('お店を保存できませんでした', e); return; }

    const i = state.shops.findIndex(s => s.id === saved.id);
    if (i === -1) state.shops.unshift(saved); else state.shops[i] = saved;

    closeShop();
    renderShops();
    showToast(isNew ? 'お店を追加しました🍽' : '保存しました');
    if (isNew) notifyPartner('行きたいお店が増えました🍽', `${userName || 'パートナー'}が「${name}」を追加しました`);
  });
}

async function remove(id) {
  const shop = state.shops.find(s => s.id === id);
  if (!shop) return;
  if (!await confirmDialog(`「${shop.name}」を削除しますか？`)) return;

  try { await removeShop(id); }
  catch (e) { showError('削除できませんでした', e); return; }

  const i = state.shops.findIndex(s => s.id === id);
  if (i !== -1) state.shops.splice(i, 1);
  for (let k = state.shopLikes.length - 1; k >= 0; k--) {
    if (state.shopLikes[k].shop_id === id) state.shopLikes.splice(k, 1);
  }
  renderShops();
  showToast('削除しました🗑️');
}

async function like(id) {
  const wasLiked = likedByMe(id);
  try { await toggleLike(id, wasLiked); }
  catch (e) { showError('いいねを保存できませんでした', e); return; }

  // 手元も合わせておく（リアルタイムでも同じ結果になります）
  const at = state.shopLikes.findIndex(l => l.shop_id === id && l.user_id === userId);
  if (wasLiked) { if (at !== -1) state.shopLikes.splice(at, 1); }
  else if (at === -1) state.shopLikes.push({ shop_id: id, user_id: userId });

  renderShops();
  if (!wasLiked && likesOf(id).length >= 2) showToast('ふたりとも行きたいお店です💞');
}

/* ------------------------------------------------------------
   起動
   ------------------------------------------------------------ */
export function initShops() {
  registerActions({
    'shop:open': () => openShop(null),
    'shop:edit': openShop,
    'shop:close': closeShop,
    'shop:save': save,
    'shop:delete': remove,
    'shop:like': like
  });

  on('shops', renderShops);
}
