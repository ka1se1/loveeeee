// ============================================================
//  記念日
//   ・毎年の記念日 / 誕生日 … 次に来る日までの日数
//   ・カウントダウン（1回だけ）… その日までの日数。過ぎたら「終わりました」
//  当日はお祝いの画面を出します（1日1回だけ）。
// ============================================================
import { userId } from './supabase.js';
import { state, addAnniversary, removeAnniversary, on } from './data.js';
import {
  $, el, clear, emptyState, val, setVal, showToast, showError,
  confirmDialog, openModal, closeModal, withBusy, todayISO
} from './util.js';
import { registerActions } from './actions.js';

const DAY = 24 * 60 * 60 * 1000;

const TYPE_ICON = { anniversary: '📅', birthday: '🎂', countdown: '⏰' };

/** 日付だけのDateにする（時刻のせいで1日ずれるのを防ぐ） */
function dateOnly(value) {
  const s = String(value || '').slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysBetween(from, to) { return Math.round((to - from) / DAY); }

/**
 * 次に来る日と、そこまでの日数。
 * 毎年くり返すものは、今年ぶんが過ぎていれば来年を見ます。
 */
function nextOccurrence(item) {
  const base = dateOnly(item.date);
  if (!base) return null;
  const now = today();

  if (item.type === 'countdown') {
    return { date: base, days: daysBetween(now, base), repeats: false };
  }

  let next = new Date(now.getFullYear(), base.getMonth(), base.getDate());
  if (next < now) next = new Date(now.getFullYear() + 1, base.getMonth(), base.getDate());
  return { date: next, days: daysBetween(now, next), repeats: true };
}

function countLabel(item, occurrence) {
  if (!occurrence) return '';
  if (occurrence.days === 0) return '今日🎉';
  if (occurrence.days < 0) return '終わりました';
  return `あと${occurrence.days}日`;
}

function dateLabel(item, occurrence) {
  const base = dateOnly(item.date);
  if (!base) return '';
  const icon = TYPE_ICON[item.type] || '📅';
  const md = `${base.getMonth() + 1}月${base.getDate()}日`;

  if (item.type === 'countdown') return `${icon} ${base.getFullYear()}年${md}`;
  const years = occurrence ? occurrence.date.getFullYear() - base.getFullYear() : 0;
  if (item.type === 'birthday' && years > 0) return `${icon} ${md}（${years}歳になります）`;
  if (years > 0) return `${icon} ${md}（${years}周年）`;
  return `${icon} ${md}`;
}

/* ------------------------------------------------------------
   表示
   ------------------------------------------------------------ */
export function renderAnniversaries() {
  const list = $('anniversaryList');
  const daysNode = $('anniversaryDays');

  // 上の「Days ◯ 日」は、いちばん古い「毎年の記念日」からの通算日数。
  // 誕生日を混ぜると生まれてからの日数になってしまうので、種類で絞ります。
  if (daysNode) {
    const oldest = state.anniversaries
      .filter(a => a.type === 'anniversary')
      .map(a => dateOnly(a.date))
      .filter(Boolean)
      .sort((a, b) => a - b)[0];
    daysNode.textContent = oldest ? String(daysBetween(oldest, today())) : '-';
  }

  if (!list) return;
  clear(list);

  if (!state.anniversaries.length) {
    list.appendChild(emptyState('記念日を追加すると、ここに残り日数が出ます'));
    return;
  }

  const rows = state.anniversaries
    .map(item => ({ item, occurrence: nextOccurrence(item) }))
    .filter(r => r.occurrence)
    .sort((a, b) => {
      // 過ぎたカウントダウンは下へ
      const pa = a.occurrence.days < 0 ? 1 : 0;
      const pb = b.occurrence.days < 0 ? 1 : 0;
      return pa - pb || a.occurrence.days - b.occurrence.days;
    });

  rows.forEach(({ item, occurrence }) => {
    list.appendChild(el('div', { class: 'anniv-row' + (occurrence.days === 0 ? ' today' : '') }, [
      el('div', { class: 'anniv-main' }, [
        el('div', { class: 'anniv-title', text: item.title || '記念日' }),
        el('div', { class: 'anniv-date', text: dateLabel(item, occurrence) })
      ]),
      el('div', { class: 'anniv-right' }, [
        el('span', { class: 'anniv-count', text: countLabel(item, occurrence) }),
        el('button', {
          class: 'anniv-del', text: '✕', 'aria-label': `${item.title || '記念日'}を削除`,
          'data-action': 'anniv:delete', 'data-arg': item.id
        })
      ])
    ]));
  });

  maybeCelebrate(rows.filter(r => r.occurrence.days === 0).map(r => r.item));
}

/* ------------------------------------------------------------
   お祝い（1日1回だけ）
   ------------------------------------------------------------ */
const SEEN_KEY = 'anniv_celebrated';

function alreadyCelebrated() {
  try { return localStorage.getItem(SEEN_KEY) === todayISO(); }
  catch (e) { return false; }
}

function markCelebrated() {
  try { localStorage.setItem(SEEN_KEY, todayISO()); } catch (e) { }
}

function maybeCelebrate(todays) {
  if (!todays.length || alreadyCelebrated() || $('celebrationScreen')) return;
  markCelebrated();

  const item = todays[0];
  const icon = item.type === 'birthday' ? '🎂' : '🎉';

  const overlay = el('div', { id: 'celebrationScreen', class: 'celebration' }, [
    el('div', { class: 'celebration-icon', text: icon, 'aria-hidden': 'true' }),
    el('h1', { class: 'celebration-title', text: item.type === 'birthday' ? 'おめでとう' : '記念日です' }),
    el('div', { class: 'celebration-sub', text: item.title || '記念日' }),
    el('button', {
      class: 'celebration-close', text: 'ありがとう',
      onclick: () => { overlay.remove(); petals.forEach(p => p.remove()); }
    })
  ]);

  const petals = [];
  for (let i = 0; i < 24; i++) {
    const petal = el('div', {
      class: 'celebration-petal', text: i % 3 === 0 ? '🌸' : (i % 3 === 1 ? '💖' : '✨'),
      'aria-hidden': 'true',
      style: {
        left: Math.random() * 100 + 'vw',
        fontSize: (14 + Math.random() * 16) + 'px',
        animationDuration: (4 + Math.random() * 4) + 's',
        animationDelay: (Math.random() * 3) + 's'
      }
    });
    petals.push(petal);
    document.body.appendChild(petal);
  }

  document.body.appendChild(overlay);
  setTimeout(() => petals.forEach(p => p.remove()), 12000);
}

/* ------------------------------------------------------------
   追加と削除
   ------------------------------------------------------------ */
function open() {
  setVal('annivTitleInput', '');
  setVal('annivDateInput', todayISO());
  const type = $('annivTypeInput');
  if (type) type.value = 'anniversary';
  openModal('anniversaryModal');
}

async function save(_arg, _event, button) {
  const title = val('annivTitleInput');
  const date = val('annivDateInput');
  const type = $('annivTypeInput') ? $('annivTypeInput').value : 'anniversary';

  if (!title) { showToast('タイトルを入れてね'); return; }
  if (!date) { showToast('日付を選んでね'); return; }

  await withBusy(button, '保存中…', async () => {
    let row;
    try { row = await addAnniversary({ title, date, type, created_by: userId }); }
    catch (e) { showError('記念日を保存できませんでした', e); return; }

    if (!state.anniversaries.some(a => a.id === row.id)) state.anniversaries.push(row);
    closeModal('anniversaryModal');
    renderAnniversaries();
    showToast('記念日を追加しました📅');
  });
}

async function remove(id) {
  const item = state.anniversaries.find(a => a.id === id);
  if (!item) return;
  if (!await confirmDialog(`「${item.title}」を削除しますか？`)) return;

  try { await removeAnniversary(id); }
  catch (e) { showError('削除できませんでした', e); return; }

  const i = state.anniversaries.findIndex(a => a.id === id);
  if (i !== -1) state.anniversaries.splice(i, 1);
  renderAnniversaries();
  showToast('削除しました🗑️');
}

/* ------------------------------------------------------------
   起動
   ------------------------------------------------------------ */
export function initAnniversary() {
  registerActions({
    'anniv:open': open,
    'anniv:close': () => closeModal('anniversaryModal'),
    'anniv:save': save,
    'anniv:delete': remove
  });

  on('anniversaries', renderAnniversaries);

  // 日付が変わっても開きっぱなしのことがあるので、1時間ごとに数え直す
  setInterval(renderAnniversaries, 60 * 60 * 1000);
}
