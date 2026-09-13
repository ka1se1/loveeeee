// ============================================================
//  小さな道具箱
//  ここに innerHTML は出てきません。要素を組み立てて textContent に
//  入れるので、メッセージに <b>test</b> と書いても太字になりません。
// ============================================================

/** getElementById の短縮 */
export function $(id) { return document.getElementById(id); }

/** 子要素を全部外す（innerHTML = '' より安全で速い） */
export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * 要素をつくる。
 *   el('p', { class: 'x', text: 'こんにちは' })
 *   el('div', { id: 'y' }, [childA, childB])
 *   el('button', { text: '押す', onclick: fn })
 * text は必ず textContent に入るので、文字列がHTMLとして解釈されることはありません。
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** 空っぽのときに出す案内 */
export function emptyState(text) {
  return el('div', { class: 'empty-state', text });
}

// ------------------------------------------------------------
//  トースト
// ------------------------------------------------------------
let toastTimer = null;

export function showToast(message, ms = 2600) {
  const box = $('toast');
  if (!box) { console.log(message); return; }
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), ms);
}

/** 失敗を伝える。原因はコンソールに残し、画面には読める言葉だけ出す */
export function showError(message, error) {
  if (error) console.error(message, error);
  showToast(message, 4200);
}

// ------------------------------------------------------------
//  確認ダイアログ
//  confirm() はページ全体を止めるうえ、iOS の PWA で出ないことがあります。
// ------------------------------------------------------------
export function confirmDialog(message, options = {}) {
  const { okText = 'はい', cancelText = 'やめる', danger = true } = options;

  return new Promise(resolve => {
    const previous = document.activeElement;

    const finish = answer => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previous && previous.focus) previous.focus();
      resolve(answer);
    };

    const okBtn = el('button', {
      class: 'dlg-btn ' + (danger ? 'danger' : 'primary'),
      text: okText,
      onclick: () => finish(true)
    });
    const cancelBtn = el('button', {
      class: 'dlg-btn', text: cancelText, onclick: () => finish(false)
    });

    const overlay = el('div', { class: 'dlg-overlay', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'dlg-card' }, [
        el('p', { class: 'dlg-msg', text: message }),
        el('div', { class: 'dlg-actions' }, [cancelBtn, okBtn])
      ])
    ]);
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });

    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    };
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    okBtn.focus();
  });
}

// ------------------------------------------------------------
//  モーダル（index.html にある .modal-overlay）
// ------------------------------------------------------------
export function openModal(id) {
  const node = $(id);
  if (!node) return;
  node.classList.add('active');
  document.body.classList.add('modal-open');
  const first = node.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
}

export function closeModal(id) {
  const node = $(id);
  if (node) node.classList.remove('active');
  if (!document.querySelector('.modal-overlay.active')) {
    document.body.classList.remove('modal-open');
  }
}

// ------------------------------------------------------------
//  日付まわり
// ------------------------------------------------------------
const PAD = n => String(n).padStart(2, '0');

/** 2026/09/13 22:30 のような表示に直す */
export function formatDateTime(value) {
  const d = new Date(value);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}/${PAD(d.getMonth() + 1)}/${PAD(d.getDate())} ${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

export function formatDate(value) {
  const d = new Date(value);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 「たった今」「3分前」のような、近い時間だけやわらかく出す */
export function timeAgo(value) {
  const d = new Date(value);
  if (isNaN(d)) return '';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'たった今';
  if (sec < 3600) return Math.floor(sec / 60) + '分前';
  if (sec < 86400) return Math.floor(sec / 3600) + '時間前';
  if (sec < 86400 * 7) return Math.floor(sec / 86400) + '日前';
  return formatDateTime(value);
}

/** ミリ秒を 1:05 のような長さ表示に */
export function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${PAD(total % 60)}`;
}

// ------------------------------------------------------------
//  そのほか
// ------------------------------------------------------------

/** 保存ボタンなどを押している間、二度押しできないようにする */
export async function withBusy(button, label, work) {
  if (!button) return work();
  const original = button.textContent;
  button.disabled = true;
  if (label) button.textContent = label;
  try { return await work(); }
  finally { button.disabled = false; button.textContent = original; }
}

/** 入力欄の値を、前後の空白を落として取り出す */
export function val(id) {
  const node = $(id);
  return node ? String(node.value || '').trim() : '';
}

export function setVal(id, value) {
  const node = $(id);
  if (node) node.value = value === null || value === undefined ? '' : value;
}

/** 今日を YYYY-MM-DD で。ローカル時刻で出すので日付がずれません */
export function todayISO(date = new Date()) {
  return `${date.getFullYear()}-${PAD(date.getMonth() + 1)}-${PAD(date.getDate())}`;
}
