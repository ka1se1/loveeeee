// ============================================================
//  共有ギャラリー
//
//  直したところ:
//   ・写真は外部サービス（ImgBB）ではなく Supabase Storage に置く
//   ・上げる前に縮める。3MBの写真をそのまま送らない
//   ・サムネを別に作るので、一覧が軽い
//   ・削除は「何番目か」ではなく id。並びが変わっても違う写真は消えない
// ============================================================
import { db, userId, userName } from './supabase.js';
import { PHOTO_BUCKET, PHOTO_MAX_EDGE, THUMB_MAX_EDGE, PHOTO_QUALITY, GALLERY_PREVIEW } from './config.js';
import { state, addPhotos, removePhoto, on } from './data.js';
import { $, el, clear, emptyState, showToast, showError, confirmDialog, formatDate } from './util.js';
import { registerActions } from './actions.js';
import { notifyPartner } from './push.js';

/* ------------------------------------------------------------
   URL
   ------------------------------------------------------------ */
const urlCache = new Map();

/** Storage のパスから表示用のURLを作る。移行前の外部URLはそのまま通す */
export function photoUrl(path) {
  if (!path) return '';
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  if (urlCache.has(path)) return urlCache.get(path);
  const { data } = db.storage.from(PHOTO_BUCKET).getPublicUrl(path);
  const url = data ? data.publicUrl : '';
  urlCache.set(path, url);
  return url;
}

const fullUrl = p => photoUrl(p.full_path || p.orig_url || '');
const thumbUrl = p => photoUrl(p.thumb_path || p.full_path || p.orig_url || '');

/* ------------------------------------------------------------
   縮小
   ------------------------------------------------------------ */
async function decode(file) {
  // createImageBitmap のほうが速いが、対応していない形式もあるので保険を持つ
  try { return await createImageBitmap(file); }
  catch (e) {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読めませんでした')); };
      img.src = url;
    });
  }
}

function shrink(source, maxEdge) {
  const sw = source.width, sh = source.height;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);

  return new Promise(resolve => {
    canvas.toBlob(blob => resolve({ blob, w, h }), 'image/jpeg', PHOTO_QUALITY);
  });
}

function newPath(suffix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${userId}/${Date.now()}-${rand}${suffix}.jpg`;
}

async function put(path, blob) {
  const { error } = await db.storage.from(PHOTO_BUCKET)
    .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
  if (error) throw error;
  return path;
}

/**
 * 1枚を上げて、DBに入れる直前の形で返す。
 * カレンダー（予定の思い出写真）からも呼ばれます。
 */
export async function uploadOnePhoto(file) {
  let full, thumb;
  try {
    const image = await decode(file);
    full = await shrink(image, PHOTO_MAX_EDGE);
    thumb = await shrink(image, THUMB_MAX_EDGE);
    if (image.close) image.close();
  } catch (e) {
    // 読めない形式（HEIC など）は、縮めずにそのまま上げる
    console.warn('縮小できなかったので元のまま上げます', e);
    full = { blob: file, w: null, h: null };
    thumb = null;
  }

  const fullPath = await put(newPath(''), full.blob);
  let thumbPath = null;
  if (thumb) {
    try { thumbPath = await put(newPath('-t'), thumb.blob); }
    catch (e) { console.warn('サムネの保存に失敗（本体はあります）', e); }
  }

  return {
    full_path: fullPath,
    thumb_path: thumbPath,
    w: full.w, h: full.h,
    author_name: userName || null,
    created_by: userId
  };
}

/* ------------------------------------------------------------
   アップロード（ギャラリーの＋ボタン）
   ------------------------------------------------------------ */
let uploading = false;

function setUploading(text) {
  const box = $('uploadLoading');
  if (!box) return;
  if (text) { box.textContent = text; box.style.display = 'flex'; }
  else box.style.display = 'none';
}

async function onPick(_arg, _event, input) {
  if (uploading) return;
  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length) return;

  uploading = true;
  const rows = [];
  const failed = [];

  try {
    for (let i = 0; i < files.length; i++) {
      setUploading(`アップロード中… (${i + 1}/${files.length})`);
      try { rows.push(await uploadOnePhoto(files[i])); }
      catch (e) { console.error('写真を上げられませんでした', files[i].name, e); failed.push(files[i].name); }
    }

    if (rows.length) {
      const saved = await addPhotos(rows);
      // リアルタイムの通知より先に自分の画面へ映す
      for (const row of saved) {
        if (!state.photos.some(p => p.id === row.id)) state.photos.unshift(row);
      }
      renderGallery();
      showToast(`${saved.length}枚を追加しました📷`);
      notifyPartner('写真が増えました📷', `${userName || 'パートナー'}が${saved.length}枚追加しました`);
    }
    if (failed.length) showToast(`${failed.length}枚は追加できませんでした🥲`, 4000);
  } catch (e) {
    showError('写真を保存できませんでした', e);
  } finally {
    uploading = false;
    setUploading(null);
  }
}

/* ------------------------------------------------------------
   表示
   ------------------------------------------------------------ */
let expanded = false;

function makeImg(photo, className) {
  return el('img', {
    class: className,
    src: thumbUrl(photo),
    alt: photo.author_name ? `${photo.author_name}の写真` : '思い出の写真',
    loading: 'lazy',
    decoding: 'async',
    'data-action': 'photo:open',
    'data-arg': photo.id
  });
}

export function renderGallery() {
  const grid = $('galleryGrid');
  if (!grid) return;
  clear(grid);

  const photos = state.photos;
  if (!photos.length) {
    grid.appendChild(emptyState('まだ写真がありません。\n右上の＋から追加してみてください'));
    return;
  }

  const shown = expanded ? photos : photos.slice(0, GALLERY_PREVIEW);
  shown.forEach(p => grid.appendChild(makeImg(p, '')));

  if (photos.length > GALLERY_PREVIEW) {
    grid.appendChild(el('div', { class: 'gallery-foot' }, [
      el('button', {
        class: expanded ? 'gallery-sub-btn' : 'gallery-main-btn',
        text: expanded ? '閉じる' : `すべて見る（${photos.length}枚）`,
        onclick: () => { expanded = !expanded; renderGallery(); }
      })
    ]));
  }
}

/* ------------------------------------------------------------
   ビューア
   ------------------------------------------------------------ */
let viewerId = null;

function viewerIndex() {
  return state.photos.findIndex(p => p.id === viewerId);
}

function openViewer(id) {
  const photo = state.photos.find(p => p.id === id);
  if (!photo) return;
  viewerId = id;
  const img = $('viewerImg');
  if (img) {
    img.src = fullUrl(photo);
    img.alt = photo.author_name
      ? `${photo.author_name}が${formatDate(photo.created_at)}に追加した写真`
      : '思い出の写真';
  }
  const viewer = $('photoViewer');
  if (viewer) viewer.style.display = 'flex';
  document.body.classList.add('modal-open');
}

function closeViewer() {
  const viewer = $('photoViewer');
  if (viewer) viewer.style.display = 'none';
  const img = $('viewerImg');
  if (img) img.src = '';
  viewerId = null;
  document.body.classList.remove('modal-open');
}

function step(by) {
  const photos = state.photos;
  if (!photos.length) { closeViewer(); return; }
  const i = viewerIndex();
  if (i === -1) { closeViewer(); return; }
  openViewer(photos[(i + by + photos.length) % photos.length].id);
}

async function deleteCurrent() {
  const photo = state.photos.find(p => p.id === viewerId);
  if (!photo) return;
  if (!await confirmDialog('この写真を削除しますか？\nふたりの画面から消えます。')) return;

  const id = photo.id;
  const i = viewerIndex();
  try {
    await removePhoto(id);
  } catch (e) {
    showError('写真を削除できませんでした', e);
    return;
  }

  const at = state.photos.findIndex(p => p.id === id);
  if (at !== -1) state.photos.splice(at, 1);

  // ファイルも片づける。失敗しても行は消えているので、続けます。
  const names = [photo.full_path, photo.thumb_path]
    .filter(x => x && !/^https?:/.test(x));
  if (names.length) {
    db.storage.from(PHOTO_BUCKET).remove(names)
      .then(({ error }) => { if (error) console.warn('ファイルの削除に失敗', error); })
      .catch(e => console.warn('ファイルの削除に失敗', e));
  }

  renderGallery();
  if (state.photos.length) openViewer(state.photos[Math.min(i, state.photos.length - 1)].id);
  else closeViewer();
  showToast('写真を削除しました🗑️');
}

/* ------------------------------------------------------------
   起動
   ------------------------------------------------------------ */
export function initPhotos() {
  registerActions({
    'photo:pick': () => { const input = $('photoUpload'); if (input) input.click(); },
    'photo:upload': onPick,
    'photo:open': arg => openViewer(arg),
    'photo:close': closeViewer,
    'photo:prev': () => step(-1),
    'photo:next': () => step(1),
    'photo:delete': deleteCurrent
  });

  // 相手が追加・削除したときに描き直す
  on('photos', () => {
    renderGallery();
    if (viewerId && viewerIndex() === -1) closeViewer();
  });

  document.addEventListener('keydown', e => {
    if (!viewerId) return;
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
}
