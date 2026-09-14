// ============================================================
//  カレンダー
//  元のコードは品質が高かったので、ロジックはほぼそのまま残し、
//  次の3点だけ作り替えています。
//   1. 保存先が「全データ1行の上書き」→「予定1件ずつの行」
//   2. 生成HTML内の onclick を data-act へ（モジュール化と安全性のため）
//   3. confirm / alert を自前のダイアログとトーストへ
// ============================================================
import { userName } from './supabase.js';
import { state, upsertEvent, deleteEventRow, loadEvents, saveSetting, addPhotos } from './data.js';
import { uploadOnePhoto, photoUrl, renderGallery } from './photos.js';
import { showToast, showError, confirmDialog } from './util.js';
import { registerActions } from './actions.js';

/* 予定の写真は新旧どちらの形でも開けるようにしておく */
function calPhotoFull(p) {
  if (!p) return '';
  if (typeof p === 'string') return p;
  return photoUrl(p.full_path || p.full || '');
}
function calPhotoThumb(p) {
  if (!p) return '';
  if (typeof p === 'string') return p;
  return photoUrl(p.thumb_path || p.thumb || p.full_path || p.full || '');
}

/* 予定から外した写真のファイル片づけ（ギャラリー側と同じ置き場） */
async function calRemovePhotoFiles(p) {
  if (!p || typeof p === 'string') return;
  const path = p.full_path || p.thumb_path;
  if (!path || /^https?:\/\//.test(path)) return;
  const { db } = await import('./supabase.js');
  const { PHOTO_BUCKET } = await import('./config.js');
  const names = [p.full_path, p.thumb_path].filter(x => x && !/^https?:\/\//.test(x));
  const { error } = await db.storage.from(PHOTO_BUCKET).remove([...new Set(names)]);
  if (error) console.warn('写真ファイルの削除に失敗', error);
}

/* 予定の一覧。ここが唯一の持ち主で、DBとは1件ずつやりとりする */
let events = [];

// ラベルは名前も色も編集できる（キーは予定と結び付いているので変えない）
const CAL_DEFAULT_LABELS = [
    { key: 'rose', name: 'ふたり', color: '#ff6b8a' },
    { key: 'coral', name: 'デート', color: '#ff9248' },
    { key: 'amber', name: '大事', color: '#f6b93b' },
    { key: 'mint', name: '学校', color: '#26c281' },
    { key: 'sky', name: '旅行', color: '#3aa3f5' },
    { key: 'indigo', name: '仕事', color: '#7c83fd' },
    { key: 'violet', name: '趣味', color: '#c471ed' },
    { key: 'slate', name: 'その他', color: '#8d99ae' }
];
const CAL_LABEL_MAX = 14;
const CAL_PALETTE = ['#ff6b8a', '#ff4d6d', '#ff9248', '#f6b93b', '#ffd43b', '#a3cb38',
    '#26c281', '#00b8a9', '#3aa3f5', '#4d7cfe', '#7c83fd', '#c471ed',
    '#e056a0', '#b08968', '#8d99ae', '#5a6472'];
let calLabels = CAL_DEFAULT_LABELS.map(l => ({ key: l.key, name: l.name, color: l.color }));

function calLabel(key) {
    return calLabels.find(l => l.key === key) || calLabels[0] ||
        { key: 'rose', name: 'ラベル', color: '#ff6b8a' };
}
function calSetLabels(list) {
    if (Array.isArray(list) && list.length) {
        calLabels = list.filter(l => l && l.key).map(l => ({
            key: String(l.key),
            name: String(l.name || 'ラベル').slice(0, 12),
            color: /^#[0-9a-fA-F]{6}$/.test(l.color || '') ? l.color : '#ff6b8a'
        }));
    }
    if (!calLabels.length) calLabels = CAL_DEFAULT_LABELS.map(l => Object.assign({}, l));
}
// labels 列がまだ無い環境でも動くように、端末側にも控えを置く
function calLoadLocalLabels() {
    try {
        const raw = localStorage.getItem('cal_labels');
        if (raw) calSetLabels(JSON.parse(raw));
    } catch (e) { }
}
function calSaveLocalLabels() {
    try { localStorage.setItem('cal_labels', JSON.stringify(calLabels)); } catch (e) { }
}
/* ---------- メンバー（誰の予定か） ---------- */
const CAL_MEMBER_EMOJI = ['💗', '💙', '🐻', '🐰', '🐣', '🌟', '🍀', '🐼', '🦊', '🐧'];
const CAL_MEMBER_MAX = 8;
let calMembers = [];

function calMember(id) { return calMembers.find(m => m.id === id) || null; }
function calEnsureMembers() {
    if (!Array.isArray(calMembers) || !calMembers.length) {
        calMembers = [
            { id: 'mine', name: calMe(), color: '#ff6b8a', emoji: '💗' },
            { id: 'yours', name: 'パートナー', color: '#4dabf7', emoji: '💙' }
        ];
    }
}
function calSetMembers(list) {
    if (Array.isArray(list) && list.length) {
        calMembers = list.filter(m => m && m.id).map(m => ({
            id: String(m.id),
            name: String(m.name || 'メンバー').slice(0, 12),
            color: /^#[0-9a-fA-F]{6}$/.test(m.color || '') ? m.color : '#ff6b8a',
            emoji: String(m.emoji || '💗').slice(0, 4)
        }));
    }
    calEnsureMembers();
}
function calLoadLocalMembers() {
    try {
        const raw = localStorage.getItem('cal_members');
        if (raw) calSetMembers(JSON.parse(raw));
    } catch (e) { }
    calEnsureMembers();
}
function calSaveLocalMembers() {
    try { localStorage.setItem('cal_members', JSON.stringify(calMembers)); } catch (e) { }
}
// 「自分」がどのメンバーかは端末ごとに覚える
function calMyMemberId() {
    calEnsureMembers();
    try {
        const saved = localStorage.getItem('my_member_id');
        if (saved && calMember(saved)) return saved;
    } catch (e) { }
    const byName = calMembers.find(m => m.name === calMe());
    return byName ? byName.id : calMembers[0].id;
}
function calSetMyMember(id) {
    try { localStorage.setItem('my_member_id', id); } catch (e) { }
}
// 予定に割り当てられたメンバーのアイコン
function calMemberAvatars(ev, cls) {
    return (ev.members || []).map(id => {
        const m = calMember(id);
        if (!m) return '';
        return '<span class="cal-av ' + (cls || '') + '" style="background:' + m.color + '" title="' +
            esc(m.name) + '">' + esc(m.emoji) + '</span>';
    }).join('');
}
function calMemberNames(ev) {
    return (ev.members || []).map(id => { const m = calMember(id); return m ? m.name : null; })
        .filter(Boolean).join('・');
}

const CAL_REPEATS = {
    none: 'くり返さない', daily: '毎日', weekly: '毎週',
    biweekly: '隔週', monthly: '毎月', yearly: '毎年'
};
const CAL_REMINDERS = {
    0: 'なし', 10: '10分前', 30: '30分前', 60: '1時間前',
    180: '3時間前', 1440: '1日前', 2880: '2日前', 10080: '1週間前'
};
const CAL_DOW = ['日', '月', '火', '水', '木', '金', '土']; // getDay() の番号順
// 週のはじまり（0=日曜 / 1=月曜）。ここだけ変えれば全部がついてくる
const CAL_WEEK_START = 1;
// 表示順の曜日番号（月曜はじまりなら [1,2,3,4,5,6,0]）
const CAL_DOW_ORDER = [0, 1, 2, 3, 4, 5, 6].map(i => (i + CAL_WEEK_START) % 7);
// その日が週の何列めか
function calCol(d) { return (d.getDay() - CAL_WEEK_START + 7) % 7; }
// その日を含む週の初日
function calWeekStart(d) { return calAdd(d, -calCol(d)); }

let calView = 'month';
let calCursor = new Date();
let selectedDate = null;
let calSearch = '';
let calSearchOpen = false;
let calLabelFilter = [];
let calMemberFilter = [];
let calFullscreen = false;
let editingEventId = null;
let editingEventIndex = null; // 旧コード互換
let calSheetEvId = null;
let calSheetOcc = null;
let calSheetMode = 'event'; // 'event' = 予定の詳細 / 'day' = その日の一覧
let calSheetDate = null;
let calSheetFrom = null;    // 日別シートから開いたときの戻り先

/* ---------- 小道具 ---------- */
const calPad = n => String(n).padStart(2, '0');
function calYmd(d) { return d.getFullYear() + '-' + calPad(d.getMonth() + 1) + '-' + calPad(d.getDate()); }
function calParse(s) { const p = String(s).split('-').map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1); }
function calAdd(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function calDiff(a, b) { return Math.round((calParse(b) - calParse(a)) / 86400000); }
function calToday() { return calYmd(new Date()); }
function calMin(t) { const p = String(t || '0:00').split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function calMe() { return userName || 'わたし'; }
function calColor(ev) { return calLabel(ev.label).color; }

/** ラベル色を白で薄める。
 *  ラベルの色はふたりが自由に決められるので、そのまま背景にして
 *  文字を載せると読めない色が出ます（#7c83fd は白3.22／黒4.26で
 *  どちらも不足）。薄く敷いて、文字は常に濃い色にします。 */
function calTint(hex, ratio) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
    if (!m) return '#f2ede8';
    const n = parseInt(m[1], 16);
    const mix = v => Math.round(v * ratio + 255 * (1 - ratio));
    const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/* ---------- 日本の祝日 ---------- */
const calHolidayCache = {};
function calNthMonday(y, m, n) {
    const first = new Date(y, m - 1, 1);
    const off = (8 - first.getDay()) % 7;
    return new Date(y, m - 1, 1 + off + (n - 1) * 7);
}
function calHolidays(year) {
    if (calHolidayCache[year]) return calHolidayCache[year];
    const h = {};
    const set = (d, name) => { h[calYmd(d)] = name; };
    set(new Date(year, 0, 1), '元日');
    set(calNthMonday(year, 1, 2), '成人の日');
    set(new Date(year, 1, 11), '建国記念の日');
    set(new Date(year, 1, 23), '天皇誕生日');
    const shun = Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
    set(new Date(year, 2, shun), '春分の日');
    set(new Date(year, 3, 29), '昭和の日');
    set(new Date(year, 4, 3), '憲法記念日');
    set(new Date(year, 4, 4), 'みどりの日');
    set(new Date(year, 4, 5), 'こどもの日');
    set(calNthMonday(year, 7, 3), '海の日');
    set(new Date(year, 7, 11), '山の日');
    const keiro = calNthMonday(year, 9, 3);
    set(keiro, '敬老の日');
    const shuu = Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
    const shuubun = new Date(year, 8, shuu);
    set(shuubun, '秋分の日');
    if (calDiff(calYmd(keiro), calYmd(shuubun)) === 2) set(calAdd(keiro, 1), '国民の休日');
    set(calNthMonday(year, 10, 2), 'スポーツの日');
    set(new Date(year, 10, 3), '文化の日');
    set(new Date(year, 10, 23), '勤労感謝の日');
    // 振替休日
    Object.keys(h).slice().forEach(k => {
        const d = calParse(k);
        if (d.getDay() === 0) {
            let n = calAdd(d, 1);
            while (h[calYmd(n)]) n = calAdd(n, 1);
            h[calYmd(n)] = '振替休日';
        }
    });
    calHolidayCache[year] = h;
    return h;
}
function calHolidayName(dateStr) {
    const y = +dateStr.slice(0, 4);
    return calHolidays(y)[dateStr] || null;
}

/* ---------- データ正規化 ---------- */
function calNormalize(ev) {
    if (!ev.id) ev.id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    if (typeof ev.title !== 'string') ev.title = String(ev.title == null ? '' : ev.title);
    if (typeof ev.note !== 'string') ev.note = String(ev.note == null ? '' : ev.note);
    if (!ev.date) ev.date = calToday();
    if (!ev.endDate || ev.endDate < ev.date) ev.endDate = ev.date;
    if (ev.allDay === undefined) ev.allDay = !ev.start;
    if (!calLabels.some(l => l.key === ev.label)) ev.label = calLabels[0].key;
    if (!CAL_REPEATS[ev.repeat]) ev.repeat = 'none';
    if (!Array.isArray(ev.repeatDows)) ev.repeatDows = [];
    ev.repeatDows = ev.repeatDows.filter(d => d >= 0 && d <= 6);
    if (ev.monthlyMode !== 'nth') ev.monthlyMode = 'date';
    if (typeof ev.repeatUntil !== 'string') ev.repeatUntil = '';
    // 知らないIDでも消さない（相手の端末が先にメンバーを増やしている場合があるため）
    if (!Array.isArray(ev.members)) ev.members = [];
    ev.members = ev.members.filter(id => typeof id === 'string');
    if (!Array.isArray(ev.photos)) ev.photos = [];
    if (!Array.isArray(ev.comments)) ev.comments = [];
    if (!Array.isArray(ev.exdates)) ev.exdates = [];
    if (typeof ev.reminder !== 'number') ev.reminder = 0;
    if (typeof ev.location !== 'string') ev.location = ev.location || '';
    return ev;
}
function calNormalizeAll() {
    calEnsureMembers();
    if (!Array.isArray(events)) events = [];
    events = events.map(calNormalize);
}

/* ---------- 第N曜日の計算（毎月 第2土曜 など） ---------- */
// その月の第何週めか。最終週なら -1（第5◯曜 = 最終◯曜 として扱う）
function calNthIndex(d) {
    const lastDate = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return (d.getDate() + 7 > lastDate) ? -1 : Math.ceil(d.getDate() / 7);
}
function calNthWeekday(y, m, dow, nth) {
    if (nth > 0) {
        const first = new Date(y, m, 1);
        const off = (dow - first.getDay() + 7) % 7;
        const d = new Date(y, m, 1 + off + (nth - 1) * 7);
        return d.getMonth() === m ? d : null;
    }
    const last = new Date(y, m + 1, 0);
    const off = (last.getDay() - dow + 7) % 7;
    return new Date(y, m, last.getDate() - off);
}
function calRepeatText(ev) {
    if (ev.repeat === 'none') return '';
    if (ev.repeat === 'weekly' || ev.repeat === 'biweekly') {
        const base = calParse(ev.date);
        const dows = ev.repeatDows && ev.repeatDows.length ? ev.repeatDows : [base.getDay()];
        return (ev.repeat === 'weekly' ? '毎週' : '隔週') + ' ' +
            dows.slice().sort((a, b) => CAL_DOW_ORDER.indexOf(a) - CAL_DOW_ORDER.indexOf(b))
                .map(d => CAL_DOW[d]).join('・');
    }
    if (ev.repeat === 'monthly' && ev.monthlyMode === 'nth') {
        const base = calParse(ev.date);
        const nth = calNthIndex(base);
        return '毎月 ' + (nth < 0 ? '最終' : '第' + nth) + CAL_DOW[base.getDay()] + '曜';
    }
    return CAL_REPEATS[ev.repeat];
}

/* ---------- 予定の展開（くり返し対応） ---------- */
function calMatches(ev) {
    if (calLabelFilter.length && calLabelFilter.indexOf(ev.label) === -1) return false;
    // メンバー未指定の予定は誰の絞り込みでも表示する
    if (calMemberFilter.length && (ev.members || []).length &&
        !ev.members.some(id => calMemberFilter.indexOf(id) !== -1)) return false;
    if (calSearch) {
        const q = calSearch.toLowerCase();
        const hay = (ev.title + ' ' + (ev.note || '') + ' ' + (ev.location || '') + ' ' +
            (ev.author || '') + ' ' + calMemberNames(ev)).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
    }
    return true;
}
function calPush(out, ev, startDate, span, from, to) {
    const s = startDate, e = calAdd(startDate, span);
    if (e < from || s > to) return;
    const sy = calYmd(s);
    if (ev.exdates.indexOf(sy) !== -1) return;
    out.push({ ev: ev, sYmd: sy, eYmd: calYmd(e), s: s, e: e });
}
function calOccurrences(fromStr, toStr, ignoreFilter) {
    calNormalizeAll();
    const out = [];
    const from = calParse(fromStr), to = calParse(toStr);
    events.forEach(ev => {
        if (!ignoreFilter && !calMatches(ev)) return;
        const span = Math.max(0, calDiff(ev.date, ev.endDate));
        const base = calParse(ev.date);
        const until = ev.repeatUntil ? calParse(ev.repeatUntil) : null;
        const limit = until && until < to ? until : to;
        const guardStart = calAdd(from, -span);
        let cur, g = 0;
        switch (ev.repeat) {
            case 'none':
                calPush(out, ev, base, span, from, to);
                break;
            case 'daily':
                cur = base < guardStart ? new Date(guardStart.getTime()) : new Date(base.getTime());
                while (cur <= limit && g++ < 400) { if (cur >= base) calPush(out, ev, cur, span, from, to); cur = calAdd(cur, 1); }
                break;
            case 'weekly':
            case 'biweekly': {
                // 曜日を複数選べる（月・水・金 など）。未指定なら開始日の曜日
                const step = ev.repeat === 'weekly' ? 7 : 14;
                const dows = ev.repeatDows.length ? ev.repeatDows : [base.getDay()];
                let wk = calWeekStart(base);                   // 基準になる週の初日
                const wkGuard = calAdd(guardStart, -6);
                if (wk < wkGuard) {
                    const k = Math.floor((wkGuard - wk) / (step * 86400000));
                    wk = calAdd(wk, k * step);
                }
                while (wk <= limit && g++ < 400) {
                    for (let di = 0; di < dows.length; di++) {
                        const d = calAdd(wk, (dows[di] - CAL_WEEK_START + 7) % 7);
                        if (d >= base && d <= limit) calPush(out, ev, d, span, from, to);
                    }
                    wk = calAdd(wk, step);
                }
                break;
            }
            case 'monthly': {
                if (ev.monthlyMode === 'nth') {
                    // 「毎月 第2土曜」のくり返し
                    const dow = base.getDay();
                    const nth = calNthIndex(base);
                    for (let i = -1; i < 40; i++) {
                        const ref = new Date(from.getFullYear(), from.getMonth() + i, 1);
                        const d = calNthWeekday(ref.getFullYear(), ref.getMonth(), dow, nth);
                        if (!d || d < base || d > limit) continue;
                        calPush(out, ev, d, span, from, to);
                        if (d > to) break;
                    }
                } else {
                    const dm = base.getDate();
                    let y = from.getFullYear(), m = from.getMonth() - 1;
                    for (let i = 0; i < 40; i++) {
                        const d = new Date(y, m + i, dm);
                        if (d.getDate() !== dm) continue;
                        if (d < base || d > limit) continue;
                        calPush(out, ev, d, span, from, to);
                        if (d > to) break;
                    }
                }
                break;
            }
            case 'yearly':
                for (let y = from.getFullYear() - 1; y <= to.getFullYear() + 1; y++) {
                    const d = new Date(y, base.getMonth(), base.getDate());
                    if (d < base || d > limit) continue;
                    calPush(out, ev, d, span, from, to);
                }
                break;
        }
    });
    return out;
}
function calOccSort(a, b) {
    const da = calDiff(a.sYmd, a.eYmd), db = calDiff(b.sYmd, b.eYmd);
    if (da !== db) return db - da;
    if (a.sYmd !== b.sYmd) return a.sYmd < b.sYmd ? -1 : 1;
    const aa = a.ev.allDay ? 0 : 1, bb = b.ev.allDay ? 0 : 1;
    if (aa !== bb) return aa - bb;
    return calMin(a.ev.start) - calMin(b.ev.start);
}
function calTimeText(ev) {
    if (ev.allDay) return '終日';
    return (ev.start || '') + (ev.end ? '<br>' + ev.end : '');
}

/* ---------- 描画：シェル ---------- */
function calMonthTitle() {
    if (calView === 'list') return { main: '予定リスト', sub: 'UPCOMING' };
    if (calView === 'week') {
        const ws = calWeekStart(calCursor);
        const we = calAdd(ws, 6);
        return {
            main: (ws.getMonth() + 1) + '/' + ws.getDate() + ' - ' + (we.getMonth() + 1) + '/' + we.getDate(),
            sub: ws.getFullYear() + ''
        };
    }
    return { main: (calCursor.getMonth() + 1) + '月', sub: calCursor.getFullYear() + '' };
}
function calRenderShell() {
    const t = calMonthTitle();
    let h = '';
    h += '<div class="cal-toolbar">';
    h += '<div class="cal-nav">';
    h += '<button data-act="prev">‹</button>';
    h += '<div class="cal-title" data-act="today"><small>' + esc(t.sub) + '</small>' + esc(t.main) + '</div>';
    h += '<button data-act="next">›</button>';
    h += '</div>';
    h += '<div class="cal-seg">';
    ['month', 'week', 'list'].forEach(v => {
        const nm = { month: '月', week: '週', list: 'リスト' }[v];
        h += '<button class="' + (calView === v ? 'on' : '') + '" data-act="view" data-arg="' + v + '">' + nm + '</button>';
    });
    h += '</div>';
    h += '<button class="cal-today-btn" data-act="today">今日</button>';
    h += '</div>';

    if (calSearchOpen) {
        h += '<div class="cal-searchbar"><span>🔍</span>' +
            '<input id="calSearchInput" type="search" placeholder="予定を検索..." value="' + esc(calSearch) + '" oninput="calOnSearch(this.value)">' +
            '<span data-act="closesearch" style="cursor:pointer;color:#6b5d61;">✕</span></div>';
    }

    h += '<div class="cal-chips">';
    h += '<div class="cal-chip ' + (calLabelFilter.length === 0 ? 'on' : '') + '" data-act="label" data-arg="__all">すべて</div>';
    calLabels.forEach(l => {
        const on = calLabelFilter.indexOf(l.key) !== -1;
        h += '<div class="cal-chip ' + (on ? 'on' : '') + '" data-act="label" data-arg="' + esc(l.key) + '">' +
            '<span class="dot" style="background:' + l.color + '"></span>' + esc(l.name) + '</div>';
    });
    h += '<div class="cal-chip cal-chip-edit" data-act="editlabels">⚙️ ラベル編集</div>';
    h += '</div>';

    // 誰の予定かで絞り込む
    h += '<div class="cal-chips cal-chips-member">';
    h += '<div class="cal-chip ' + (calMemberFilter.length === 0 ? 'on' : '') + '" data-act="member" data-arg="__all">👥 みんな</div>';
    calMembers.forEach(m => {
        const on = calMemberFilter.indexOf(m.id) !== -1;
        h += '<div class="cal-chip ' + (on ? 'on' : '') + '" data-act="member" data-arg="' + esc(m.id) + '">' +
            '<span class="cal-av" style="background:' + m.color + '">' + esc(m.emoji) + '</span>' + esc(m.name) + '</div>';
    });
    h += '<div class="cal-chip cal-chip-edit" data-act="editmembers">⚙️ メンバー</div>';
    h += '</div>';

    h += calRenderNextBanner();
    h += '<div id="calBody"></div>';
    return h;
}
function calRenderNextBanner() {
    if (calSearch) return '';
    const today = calToday();
    const occ = calOccurrences(today, calYmd(calAdd(new Date(), 400)))
        .filter(o => o.eYmd >= today)
        .sort((a, b) => a.sYmd < b.sYmd ? -1 : a.sYmd > b.sYmd ? 1 : calMin(a.ev.start) - calMin(b.ev.start))[0];
    if (!occ) return '';
    const d = Math.max(0, calDiff(today, occ.sYmd));
    const cd = d === 0 ? 'TODAY' : d === 1 ? '明日' : d;
    const sub = d === 0 || d === 1 ? '' : '日後';
    const dt = calParse(occ.sYmd);
    const when = (dt.getMonth() + 1) + '/' + dt.getDate() + '(' + CAL_DOW[dt.getDay()] + ')' +
        (occ.ev.allDay ? ' 終日' : ' ' + (occ.ev.start || ''));
    return '<div class="cal-next" data-act="ev" data-arg="' + occ.ev.id + '" data-arg2="' + occ.sYmd + '">' +
        '<div class="cd"><b>' + cd + '</b><span>' + sub + '</span></div>' +
        '<div class="tx"><b>' + esc(occ.ev.title) + '</b><span>' + when +
        (occ.ev.location ? ' · 📍' + esc(occ.ev.location) : '') + '</span></div>' +
        '<div style="flex:0 0 auto;color:#6b5d61;">›</div></div>';
}

/* ---------- 描画：メイン ---------- */
function renderCalendar() {
    const container = document.getElementById('calendarContainer');
    if (!container) return;
    calNormalizeAll();
    container.innerHTML = calRenderShell();
    calRenderBody();
    calBindContainer(container);
    calScheduleReminders();
}
function calRenderBody() {
    const body = document.getElementById('calBody');
    if (!body) return;
    if (calView === 'month') body.innerHTML = calRenderMonth() + calRenderDayPanel();
    else if (calView === 'week') body.innerHTML = calRenderWeek();
    else body.innerHTML = calRenderList();
    if (calView === 'week') calScrollWeek();
}

/* ---------- 月ビュー ---------- */
function calLayoutLanes(items, weekStartYmd) {
    const lanes = [];
    const res = [];
    items.slice().sort(calOccSort).forEach(o => {
        const col = Math.max(0, calDiff(weekStartYmd, o.sYmd));
        const endCol = Math.min(6, calDiff(weekStartYmd, o.eYmd));
        if (endCol < 0 || col > 6) return;
        let lane = 0;
        while (lane < 40) {
            if (!lanes[lane]) lanes[lane] = [];
            const clash = lanes[lane].some(r => !(endCol < r[0] || col > r[1]));
            if (!clash) { lanes[lane].push([col, endCol]); break; }
            lane++;
        }
        res.push({ o: o, col: col, endCol: endCol, span: endCol - col + 1, lane: lane });
    });
    return res;
}
function calRenderMonth() {
    const y = calCursor.getFullYear(), m = calCursor.getMonth();
    const first = new Date(y, m, 1);
    const gridStart = calWeekStart(first);
    const last = new Date(y, m + 1, 0);
    const gridEnd = calAdd(last, 6 - calCol(last));
    const weeks = (calDiff(calYmd(gridStart), calYmd(gridEnd)) + 1) / 7;
    const occs = calOccurrences(calYmd(gridStart), calYmd(gridEnd));
    const maxLanes = calFullscreen ? 5 : 3;
    const LH = 17;
    const today = calToday();

    // 1周目：各週のレーンを計算して行の高さを揃える
    const rows = [];
    for (let w = 0; w < weeks; w++) {
        const ws = calAdd(gridStart, w * 7);
        const wsY = calYmd(ws);
        const weY = calYmd(calAdd(ws, 6));
        const placed = calLayoutLanes(occs.filter(o => !(o.eYmd < wsY || o.sYmd > weY)), wsY);
        const overflowCount = [0, 0, 0, 0, 0, 0, 0];
        placed.filter(p => p.lane >= maxLanes).forEach(p => {
            for (let c = p.col; c <= p.endCol; c++) overflowCount[c]++;
        });
        const hasOverflow = overflowCount.some(n => n > 0);
        const usedLanes = Math.min(maxLanes, placed.reduce((a, p) => Math.max(a, p.lane + 1), 0));
        rows.push({ ws, wsY, placed, overflowCount, hasOverflow, usedLanes });
        // 以前はここで全週の最大をとり、それを全部の週に当てていました。
        // 1週でも予定が重なると、空の週まで同じ高さになります。
        // 週ごとに必要なぶんだけにします。
        // 予定が無い週も、指で押せるだけの高さは残します
        rows[rows.length - 1].h = usedLanes
            ? usedLanes * LH + (hasOverflow ? 14 : 0)
            : 12;
    }

    let h = '<div class="cal-dow">';
    CAL_DOW_ORDER.forEach(dw => {
        h += '<div class="' + (dw === 0 ? 'sun' : dw === 6 ? 'sat' : '') + '">' + CAL_DOW[dw] + '</div>';
    });
    h += '</div><div class="cal-month" id="calMonthGrid">';

    for (let w = 0; w < weeks; w++) {
        const r = rows[w];
        const ws = r.ws;
        const placed = r.placed;

        h += '<div class="cal-week"><div class="cal-week-nums">';
        for (let i = 0; i < 7; i++) {
            const d = calAdd(ws, i);
            const ds = calYmd(d);
            const hol = calHolidayName(ds);
            const cls = ['cal-daycell'];
            if (d.getDay() === 0) cls.push('sun');
            if (d.getDay() === 6) cls.push('sat');
            if (hol) cls.push('hol');
            if (d.getMonth() !== m) cls.push('out');
            if (ds === today) cls.push('today');
            if (ds === selectedDate) cls.push('sel');
            h += '<div class="' + cls.join(' ') + '" data-act="day" data-arg="' + ds + '">' +
                '<div class="cal-daynum">' + d.getDate() + '</div>' +
                (hol ? '<div class="cal-holname">' + esc(hol) + '</div>' : '') +
                '</div>';
        }
        h += '</div>';

        const vis = placed.filter(p => p.lane < maxLanes);
        const overflowCount = r.overflowCount;
        const usedLanes = r.usedLanes;

        h += '<div class="cal-lanes" style="height:' + r.h + 'px">';

        // 日付の数字の行しか押せないと、マスの下半分を触っても反応せず
        // 押しづらい。チップの後ろに、日付を選ぶための受け皿を敷きます。
        // チップはこの後に置くので、チップの上をタップしたときは
        // そちらが優先されます。
        h += '<div class="cal-taps">';
        for (let i = 0; i < 7; i++) {
            const td = calYmd(calAdd(ws, i));
            h += '<div class="cal-tap' + (td === selectedDate ? ' sel' : '') +
                '" data-act="day" data-arg="' + td + '"></div>';
        }
        h += '</div>';
        vis.forEach(p => {
            const ev = p.o.ev;
            const c = calColor(ev);
            const multi = p.o.sYmd !== p.o.eYmd;
            const timedStyle = (!ev.allDay && !multi);
            const left = (p.col / 7 * 100).toFixed(4);
            const width = (p.span / 7 * 100).toFixed(4);
            // 誰の予定かを絵文字で先頭に出す
            const who = (ev.members || []).map(id => {
                const mb = calMember(id); return mb ? mb.emoji : '';
            }).join('').slice(0, 4);
            const title = (who ? who : '') + esc(ev.title);
            const label = timedStyle
                ? '<span class="tdot" style="background:' + c + '"></span>' + title
                : title;
            h += '<div class="cal-chipev ' + (timedStyle ? 'timed' : '') +
                '" style="left:calc(' + left + '% + 1px);width:calc(' + width + '% - 2px);top:' + (p.lane * LH) + 'px;background:' + calTint(c, .22) + ';border-left:3px solid ' + c + '"' +
                '>' + label + '</div>';
        });
        if (r.hasOverflow) {
            for (let c = 0; c < 7; c++) {
                if (!overflowCount[c]) continue;
                h += '<div class="cal-more" style="left:' + (c / 7 * 100).toFixed(4) + '%;width:' + (100 / 7).toFixed(4) + '%;top:' + (usedLanes * LH) + 'px"' +
                    ' data-act="day" data-arg="' + calYmd(calAdd(ws, c)) + '">+' + overflowCount[c] + '</div>';
            }
        }
        h += '</div></div>';
    }
    h += '</div>';
    return h;
}

/* ---------- 選択日パネル ---------- */
function calRenderDayPanel() {
    const ds = selectedDate || calToday();
    const occs = calOccurrences(ds, ds).sort(calOccSort);
    const d = calParse(ds);
    const hol = calHolidayName(ds);
    const diff = calDiff(calToday(), ds);
    const cdText = diff === 0 ? '今日' : diff > 0 ? 'あと' + diff + '日' : Math.abs(diff) + '日前';

    let h = '<div class="cal-daypanel"><div class="cal-daypanel-head">';
    h += '<b>' + (d.getMonth() + 1) + '月' + d.getDate() + '日 (' + CAL_DOW[d.getDay()] + ')' +
        (hol ? ' · ' + esc(hol) : '') + '</b>';
    h += '<span>' + cdText + ' · ' + occs.length + '件</span>';
    h += '</div>';
    if (!occs.length) {
        h += '<div class="cal-empty">予定はまだないよ 🌸<br>' +
            '<button class="cal-quick-add" data-act="add" data-arg="' + ds + '" ' +
            'style="margin-top:10px;border:none;background:#c2185b;color:#fff;font-weight:700;font-size:12px;padding:8px 18px;border-radius:999px;cursor:pointer;">＋ 予定を追加</button></div>';
    } else {
        occs.forEach(o => { h += calEventRow(o); });
        h += '<button data-act="add" data-arg="' + ds + '" style="width:100%;border:1px dashed #ffc9d4;background:#fff;color:#d81b60;font-weight:700;font-size:12px;padding:10px;border-radius:14px;cursor:pointer;">＋ この日に追加</button>';
    }
    h += '</div>';
    return h;
}
function calEventRow(o) {
    const ev = o.ev;
    const multi = o.sYmd !== o.eYmd;
    let time;
    if (multi) {
        const s = calParse(o.sYmd), e = calParse(o.eYmd);
        time = (s.getMonth() + 1) + '/' + s.getDate() + '<br>↓<br>' + (e.getMonth() + 1) + '/' + e.getDate();
    } else time = calTimeText(ev);
    const meta = [];
    if (ev.location) meta.push('📍' + esc(ev.location));
    if (ev.repeat !== 'none') meta.push('🔁' + esc(calRepeatText(ev)));
    if (ev.photos && ev.photos.length) meta.push('📷' + ev.photos.length);
    if (ev.comments.length) meta.push('💬' + ev.comments.length);
    if (ev.reminder) meta.push('🔔' + CAL_REMINDERS[ev.reminder]);
    const avatars = calMemberAvatars(ev);
    const strip = (ev.photos && ev.photos.length)
        ? '<div class="cal-ev-photos">' + ev.photos.slice(0, 4).map(p =>
            '<img loading="lazy" decoding="async" src="' + esc(calPhotoThumb(p)) + '" alt="">').join('') + '</div>'
        : '';
    return '<div class="cal-ev" data-act="ev" data-arg="' + ev.id + '" data-arg2="' + o.sYmd + '">' +
        '<div class="bar" style="background:' + calColor(ev) + '"></div>' +
        '<div class="time">' + time + '</div>' +
        '<div class="body"><b>' + esc(ev.title) +
        (avatars ? '<span class="cal-avs">' + avatars + '</span>' : '') + '</b>' + strip +
        (ev.note ? '<div style="font-size:11px;color:#6b5d61;margin-top:2px;white-space:pre-wrap;">' + esc(ev.note.slice(0, 60)) + (ev.note.length > 60 ? '…' : '') + '</div>' : '') +
        (meta.length ? '<div class="meta"><span>' + meta.join('</span><span>') + '</span></div>' : '') +
        '</div></div>';
}

/* ---------- 週ビュー ---------- */
function calRenderWeek() {
    const ws = calWeekStart(calCursor);
    const wsY = calYmd(ws), weY = calYmd(calAdd(ws, 6));
    const today = calToday();
    const occs = calOccurrences(wsY, weY);
    const HH = 44;

    let h = '<div class="cal-wk-head"><div></div>';
    for (let i = 0; i < 7; i++) {
        const d = calAdd(ws, i), ds = calYmd(d);
        const cls = ['h'];
        if (d.getDay() === 0) cls.push('sun');
        if (d.getDay() === 6) cls.push('sat');
        if (calHolidayName(ds)) cls.push('hol');
        if (ds === today) cls.push('today');
        h += '<div class="' + cls.join(' ') + '" data-act="dayjump" data-arg="' + ds + '">' +
            '<small>' + CAL_DOW[d.getDay()] + '</small><b>' + d.getDate() + '</b></div>';
    }
    h += '</div>';

    // 終日 / 複数日
    const allday = occs.filter(o => o.ev.allDay || o.sYmd !== o.eYmd);
    const placed = calLayoutLanes(allday, wsY);
    const lanes = placed.reduce((a, p) => Math.max(a, p.lane + 1), 0);
    h += '<div class="cal-wk-allday"><div class="lbl">終日</div>' +
        '<div class="cal-lanes" style="height:' + Math.max(16, lanes * 17 + 3) + 'px">';
    placed.forEach(p => {
        const ev = p.o.ev;
        h += '<div class="cal-chipev" style="left:calc(' +
            (p.col / 7 * 100).toFixed(4) + '% + 1px);width:calc(' + (p.span / 7 * 100).toFixed(4) + '% - 2px);top:' +
            (p.lane * 17 + 2) + 'px;background:' + calTint(calColor(ev), .22) + ';border-left:3px solid ' + calColor(ev) + '" data-act="ev" data-arg="' + ev.id +
            '" data-arg2="' + p.o.sYmd + '">' + esc(ev.title) + '</div>';
    });
    h += '</div></div>';

    // 時間グリッド
    h += '<div class="cal-wk-scroll" id="calWkScroll"><div class="cal-wk-hours">';
    for (let hr = 0; hr < 24; hr++) h += '<div class="hr">' + hr + ':00</div>';
    h += '</div><div class="cal-wk-cols" style="height:' + (24 * HH) + 'px">';

    for (let i = 0; i < 7; i++) {
        const ds = calYmd(calAdd(ws, i));
        const timed = occs.filter(o => !o.ev.allDay && o.sYmd === o.eYmd && o.sYmd === ds)
            .sort((a, b) => calMin(a.ev.start) - calMin(b.ev.start));
        // 重なりを列分割
        const clusters = [];
        timed.forEach(o => {
            const s = calMin(o.ev.start);
            const rawE = o.ev.end ? calMin(o.ev.end) : s + 60;
            const e = Math.max(s + 30, rawE);
            const last = clusters[clusters.length - 1];
            if (last && last.end > s) { last.items.push({ o, s, e }); last.end = Math.max(last.end, e); }
            else clusters.push({ end: e, items: [{ o, s, e }] });
        });
        h += '<div class="cal-wk-col" data-act="dayjump" data-arg="' + ds + '">';
        clusters.forEach(cl => {
            const n = cl.items.length;
            cl.items.forEach((it, idx) => {
                const top = it.s / 60 * HH;
                const height = Math.max(16, (it.e - it.s) / 60 * HH - 2);
                const w = 100 / n;
                h += '<div class="cal-wk-ev" style="top:' + top.toFixed(1) +
                    'px;height:' + height.toFixed(1) + 'px;left:calc(' + (idx * w).toFixed(2) + '% + 1px);width:calc(' + w.toFixed(2) +
                    '% - 2px);background:' + calTint(calColor(it.o.ev), .22) + ';border-left:3px solid ' + calColor(it.o.ev) + '" data-act="ev" data-arg="' + it.o.ev.id + '" data-arg2="' + ds + '">' +
                    '<b>' + esc(it.o.ev.start) + '</b>' + esc(it.o.ev.title) + '</div>';
            });
        });
        if (ds === today) {
            const now = new Date();
            const top = (now.getHours() * 60 + now.getMinutes()) / 60 * HH;
            h += '<div class="cal-now-line" style="top:' + top.toFixed(1) + 'px"></div>';
        }
        h += '</div>';
    }
    h += '</div></div>';
    return h;
}
function calScrollWeek() {
    const el = document.getElementById('calWkScroll');
    if (!el) return;
    const now = new Date();
    const target = calView === 'week' ? Math.max(0, (now.getHours() - 2) * 44) : 7 * 44;
    el.scrollTop = target;
}

/* ---------- リストビュー ---------- */
/* ---------- リストビュー ----------
   以前は1年先まで（検索時は前後1年）を一度に展開していました。
   週3回のくり返しが1件あるだけで156件になり、予定4件のときに
   高さ 20,538px・DOM 3,059要素・描画 514ms でした。
   ここでは3か月ぶんだけ出し、「もっと見る」で延ばします。
   ---------------------------------------------------------- */
// 日数だけで区切ると、くり返しの多さ次第で件数が読めません。
// 展開する範囲（日数）と、実際に出す件数の両方で抑えます。
const CAL_LIST_STEP_DAYS = 90;
const CAL_LIST_STEP_ROWS = 50;
let calListDays = CAL_LIST_STEP_DAYS;
let calListRows = CAL_LIST_STEP_ROWS;

function calResetList() {
    calListDays = CAL_LIST_STEP_DAYS;
    calListRows = CAL_LIST_STEP_ROWS;
}

function calRenderList() {
    const from = calSearch ? calYmd(calAdd(new Date(), -365)) : calToday();
    const to = calYmd(calAdd(new Date(), calListDays));
    const all = calOccurrences(from, to).sort((a, b) =>
        a.sYmd < b.sYmd ? -1 : a.sYmd > b.sYmd ? 1 : calMin(a.ev.start) - calMin(b.ev.start));

    if (!all.length) {
        // まだ先に予定があるかもしれないので、そのときは延ばせるようにする
        const more = calListDays < 365
            ? '<button class="cal-list-more" data-act="listmore">もっと先まで見る</button>'
            : '';
        return '<div class="cal-empty">' +
            (calSearch ? '見つからなかったよ 🔍' : 'これからの予定はまだないよ 🌸') + '</div>' + more;
    }

    const occs = all.slice(0, calListRows);
    const byDate = {};
    occs.forEach(o => { (byDate[o.sYmd] = byDate[o.sYmd] || []).push(o); });
    const today = calToday();
    let h = '', lastMonth = '';

    Object.keys(byDate).sort().forEach(ds => {
        const mon = ds.slice(0, 7);
        if (mon !== lastMonth) {
            lastMonth = mon;
            h += '<div class="cal-mon-sep">' + ds.slice(0, 4) + '年 ' + (+ds.slice(5, 7)) + '月</div>';
        }
        const d = calParse(ds);
        const cls = ['cal-list-date'];
        if (d.getDay() === 0) cls.push('sun');
        if (d.getDay() === 6) cls.push('sat');
        if (calHolidayName(ds)) cls.push('hol');
        if (ds === today) cls.push('today');
        h += '<div class="cal-list-day"><div class="' + cls.join(' ') + '">' +
            '<b>' + d.getDate() + '</b><small>' + CAL_DOW[d.getDay()] + '</small></div>' +
            '<div class="cal-list-items">';
        byDate[ds].sort(calOccSort).forEach(o => { h += calEventRow(o); });
        h += '</div></div>';
    });

    // まだ先があるか、件数で打ち切ったなら、続きを見られるようにする
    const more = all.length > occs.length || calListDays < 365;
    if (more) {
        h += '<button class="cal-list-more" data-act="listmore">' +
            'もっと見る（いま' + occs.length + '件）</button>';
    } else {
        h += '<div class="cal-list-note">これで全部です（' + occs.length + '件）</div>';
    }
    return h;
}

/* ---------- 操作 ---------- */
function calHandleAct(t) {
    const act = t.dataset.act, arg = t.dataset.arg, arg2 = t.dataset.arg2;
    if (act === 'prev') calStep(-1);
    else if (act === 'next') calStep(1);
    else if (act === 'today') calGoToday();
    else if (act === 'listmore') calListMore();
    else if (act === 'view') calSetView(arg);
    else if (act === 'label') calToggleLabel(arg);
    else if (act === 'closesearch') { calSearchOpen = false; calSearch = ''; renderCalendar(); }
    else if (act === 'editlabels') openLabelModal();
    else if (act === 'editmembers') openMemberModal();
    else if (act === 'member') calToggleMemberFilter(arg);
    // 日付をタップしたら、下の予定一覧を切りかえるだけにします。
    // 毎回シートがせり上がると、見たいだけのときに邪魔になるためです。
    // （週ビューの dayjump は下にパネルが無いので、そちらはシートのまま）
    else if (act === 'day') { selectedDate = arg; renderCalendar(); }
    else if (act === 'dayjump') { calCursor = calParse(arg); renderCalendar(); openDaySheet(arg); }
    else if (act === 'add') openEventModal(arg);
    else if (act === 'ev') openEventDetail(arg, arg2);
    else if (act === 'picklabel') calPickLabel(arg);
    else if (act === 'formmember') calToggleFormMember(arg);
    else if (act === 'formdow') calToggleFormDow(Number(arg));
    else if (act === 'backtoday') calBackToDay();
    else if (act === 'editev') editEvent(arg);
    else if (act === 'delev') deleteEvent(arg, arg2);
    else if (act === 'evphoto') calOpenEventPhoto(Number(arg));
    else if (act === 'addcomment') calAddComment();
    else if (act === 'daystep') calDayStep(Number(arg));
    else if (act === 'addon') { closeCalSheet(); openEventModal(arg); }
    else if (act === 'mpalette') calToggleMemberPalette(Number(arg));
    else if (act === 'setme') { calSetMyMember(arg); calRenderMemberEditor(); }
    else if (act === 'delmember') calDeleteMember(Number(arg));
    else if (act === 'mcolor') calPickMemberColor(Number(arg), arg2);
    else if (act === 'memoji') calPickMemberEmoji(Number(arg), arg2);
    else if (act === 'lpalette') calToggleLabelPalette(Number(arg));
    else if (act === 'dellabel') calDeleteLabel(Number(arg));
    else if (act === 'lcolor') calPickLabelColor(Number(arg), arg2);
}
// ボトムシート内の予定もタップできるようにする
function calBindSheet() {
    const sheet = document.getElementById('calSheetBody');
    if (!sheet || sheet._calBound) return;
    sheet._calBound = true;
}
function calBindContainer(container) {
    if (container._calBound) return;
    container._calBound = true;
    // スワイプで月/週めくり。
    // カレンダーの升目の上で始めたときだけ効かせる。
    // ラベルやメンバーの行は横スクロールしたいので、めくりの対象にしない。
    const SWIPE_ZONE = '.cal-month, .cal-wk-head, .cal-wk-allday, .cal-wk-cols';
    let sx = 0, sy = 0, swiping = false;
    container.addEventListener('touchstart', e => {
        swiping = calView !== 'list' &&
            e.touches.length === 1 &&
            !!e.target.closest(SWIPE_ZONE);
        if (!swiping) return;
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
    }, { passive: true });
    container.addEventListener('touchmove', e => {
        // 2本指になったらピンチなので、めくりは取り消す
        if (e.touches.length > 1) swiping = false;
    }, { passive: true });
    container.addEventListener('touchend', e => {
        if (!swiping) return;
        swiping = false;
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.8) calStep(dx < 0 ? 1 : -1);
    }, { passive: true });
}
function calStep(n) {
    if (calView === 'week') calCursor = calAdd(calCursor, 7 * n);
    else if (calView === 'list') calCursor = calAdd(calCursor, 30 * n);
    else calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + n, 1);
    renderCalendar();
}
function calGoToday() {
    calCursor = new Date();
    selectedDate = calToday();
    renderCalendar();
}
function calSetView(v) { calResetList(); calView = v; renderCalendar(); }
function calListMore() {
    calListRows += CAL_LIST_STEP_ROWS;
    calListDays = Math.min(365, calListDays + CAL_LIST_STEP_DAYS);
    renderCalendar();
}
function calToggleMemberFilter(id) {
    if (id === '__all') calMemberFilter = [];
    else {
        const i = calMemberFilter.indexOf(id);
        if (i === -1) calMemberFilter.push(id); else calMemberFilter.splice(i, 1);
    }
    renderCalendar();
}
function calToggleLabel(k) {
    if (k === '__all') calLabelFilter = [];
    else {
        const i = calLabelFilter.indexOf(k);
        if (i === -1) calLabelFilter.push(k); else calLabelFilter.splice(i, 1);
    }
    renderCalendar();
}
let calSearchTimer = null;
function calOnSearch(v) {
    calResetList();
    calSearch = v;
    clearTimeout(calSearchTimer);
    calSearchTimer = setTimeout(calRenderBody, 180);
}
function toggleCalSearch() {
    calSearchOpen = !calSearchOpen;
    if (!calSearchOpen) calSearch = '';
    renderCalendar();
    if (calSearchOpen) {
        const i = document.getElementById('calSearchInput');
        if (i) i.focus();
    }
}
function toggleCalFullscreen() {
    calFullscreen = !calFullscreen;
    const card = document.getElementById('calendarCard');
    card.classList.toggle('cal-fs', calFullscreen);
    document.body.classList.toggle('cal-locked', calFullscreen);
    const fab = document.getElementById('calFab');
    if (fab) fab.classList.toggle('show', calFullscreen);
    const btn = document.getElementById('calFsBtn');
    if (btn) btn.innerHTML = calFullscreen ? '✕' : '⛶';
    if (calFullscreen) window.scrollTo(0, 0);
    renderCalendar();
}
// 旧API互換
function prevMonth() { calStep(-1); }
function nextMonth() { calStep(1); }
function onDateClick(ds) { selectedDate = ds; renderCalendar(); }

/* ---------- 予定フォーム ---------- */
let calFormLabel = 'rose';
function calFillLabelSwatches() {
    const box = document.getElementById('eventLabelBox');
    if (!box) return;
    if (!calLabels.some(l => l.key === calFormLabel)) calFormLabel = calLabels[0].key;
    box.innerHTML = calLabels.map(l =>
        '<div class="sw ' + (l.key === calFormLabel ? 'on' : '') + '" title="' + esc(l.name) +
        '" style="background:' + l.color + '" data-act="picklabel" data-arg="' + esc(l.key) + '"></div>'
    ).join('') +
        '<div class="sw sw-edit" title="ラベルを編集" data-act="editlabels">⚙️</div>';
    const nm = document.getElementById('eventLabelName');
    if (nm) nm.textContent = calLabel(calFormLabel).name;
}
function calPickLabel(k) { calFormLabel = k; calFillLabelSwatches(); }

/* 誰の予定か（複数選べる） */
let calFormMembers = [];
function calFillMemberPicker() {
    const box = document.getElementById('eventMemberBox');
    if (!box) return;
    calEnsureMembers();
    box.innerHTML = calMembers.map(m => {
        const on = calFormMembers.indexOf(m.id) !== -1;
        return '<div class="cal-mpick' + (on ? ' on' : '') + '" style="' +
            (on ? 'background:' + m.color + ';border-color:' + m.color : 'border-color:' + m.color + '55') +
            '" data-act="formmember" data-arg="' + esc(m.id) + '">' +
            '<span class="cal-av" style="background:' + m.color + '">' + esc(m.emoji) + '</span>' +
            esc(m.name) + '</div>';
    }).join('') +
        '<div class="cal-mpick edit" data-act="editmembers">⚙️ 編集</div>';
}
function calToggleFormMember(id) {
    const i = calFormMembers.indexOf(id);
    if (i === -1) calFormMembers.push(id); else calFormMembers.splice(i, 1);
    calFillMemberPicker();
}

/* くり返しの詳細（曜日えらび・毎月のしかた・終了日） */
let calFormDows = [];
function calFillRepeatOptions() {
    const rep = document.getElementById('eventRepeat').value;
    const wrap = document.getElementById('eventRepeatDetail');
    const dowBox = document.getElementById('eventDowBox');
    const monthlyBox = document.getElementById('eventMonthlyBox');
    const untilBox = document.getElementById('eventUntilBox');
    if (!wrap) return;

    wrap.style.display = rep === 'none' ? 'none' : 'block';
    dowBox.style.display = (rep === 'weekly' || rep === 'biweekly') ? 'block' : 'none';
    monthlyBox.style.display = rep === 'monthly' ? 'block' : 'none';
    untilBox.style.display = rep === 'none' ? 'none' : 'block';

    if (rep === 'weekly' || rep === 'biweekly') {
        if (!calFormDows.length) {
            const d = document.getElementById('eventDateInput').value;
            if (d) calFormDows = [calParse(d).getDay()];
        }
        document.getElementById('eventDows').innerHTML = CAL_DOW_ORDER.map(dw =>
            '<div class="cal-dowpick' + (calFormDows.indexOf(dw) !== -1 ? ' on' : '') +
            (dw === 0 ? ' sun' : dw === 6 ? ' sat' : '') +
            '" data-act="formdow" data-arg="' + dw + '">' + CAL_DOW[dw] + '</div>').join('');
    }
    if (rep === 'monthly') {
        const d = document.getElementById('eventDateInput').value;
        const base = calParse(d || calToday());
        const nth = calNthIndex(base);
        document.getElementById('eventMonthlyNthLabel').textContent =
            (nth < 0 ? '最終' : '第' + nth) + CAL_DOW[base.getDay()] + '曜日';
        document.getElementById('eventMonthlyDateLabel').textContent = base.getDate() + '日';
    }
}
function calToggleFormDow(i) {
    const k = calFormDows.indexOf(i);
    if (k === -1) calFormDows.push(i);
    else if (calFormDows.length > 1) calFormDows.splice(k, 1);
    calFillRepeatOptions();
}
function calToggleAllDay() {
    const on = document.getElementById('eventAllDay').checked;
    document.getElementById('eventTimeRow').style.display = on ? 'none' : 'flex';
}
function calQuickDate(kind) {
    const el = document.getElementById('eventDateInput');
    const base = new Date();
    let d = base;
    if (kind === 'tomorrow') d = calAdd(base, 1);
    if (kind === 'weekend') { const off = (6 - base.getDay() + 7) % 7 || 7; d = calAdd(base, off); }
    if (kind === 'nextweek') d = calAdd(base, 7);
    el.value = calYmd(d);
    const e2 = document.getElementById('eventEndDateInput');
    if (!e2.value || e2.value < el.value) e2.value = el.value;
}
function openEventModal(dateStr) {
    editingEventId = null;
    editingEventIndex = null;
    const d = dateStr || selectedDate || calToday();
    document.getElementById('eventModalTitle').textContent = '予定を追加 📅';
    document.getElementById('eventDateInput').value = d;
    document.getElementById('eventEndDateInput').value = d;
    document.getElementById('eventTitleInput').value = '';
    document.getElementById('eventNoteInput').value = '';
    document.getElementById('eventLocationInput').value = '';
    document.getElementById('eventAllDay').checked = true;
    document.getElementById('eventStartTime').value = '19:00';
    document.getElementById('eventEndTime').value = '21:00';
    document.getElementById('eventRepeat').value = 'none';
    document.getElementById('eventReminder').value = '0';
    document.getElementById('eventUntil').value = '';
    document.getElementById('eventMonthlyMode').value = 'date';
    calFormLabel = calLabels[0].key;
    calFormMembers = [calMyMemberId()];   // 自分を初期選択
    calFormDows = [calParse(d).getDay()];
    calFillLabelSwatches();
    calFillMemberPicker();
    calFillRepeatOptions();
    calToggleAllDay();
    document.getElementById('eventDeleteBtn').style.display = 'none';
    document.getElementById('eventModal').classList.add('active');
}
function editEvent(idOrIdx) {
    const ev = typeof idOrIdx === 'number' ? events[idOrIdx] : events.find(x => x.id === idOrIdx);
    if (!ev) return;
    calNormalize(ev);
    editingEventId = ev.id;
    document.getElementById('eventModalTitle').textContent = '予定を編集 ✏️';
    document.getElementById('eventDateInput').value = ev.date;
    document.getElementById('eventEndDateInput').value = ev.endDate;
    document.getElementById('eventTitleInput').value = ev.title || '';
    document.getElementById('eventNoteInput').value = ev.note || '';
    document.getElementById('eventLocationInput').value = ev.location || '';
    document.getElementById('eventAllDay').checked = !!ev.allDay;
    document.getElementById('eventStartTime').value = ev.start || '19:00';
    document.getElementById('eventEndTime').value = ev.end || '21:00';
    document.getElementById('eventRepeat').value = ev.repeat;
    document.getElementById('eventReminder').value = String(ev.reminder || 0);
    document.getElementById('eventUntil').value = ev.repeatUntil || '';
    document.getElementById('eventMonthlyMode').value = ev.monthlyMode || 'date';
    calFormLabel = ev.label;
    calFormMembers = (ev.members || []).slice();
    calFormDows = (ev.repeatDows && ev.repeatDows.length)
        ? ev.repeatDows.slice() : [calParse(ev.date).getDay()];
    calFillLabelSwatches();
    calFillMemberPicker();
    calFillRepeatOptions();
    calToggleAllDay();
    document.getElementById('eventDeleteBtn').style.display = 'block';
    closeCalSheet();
    document.getElementById('eventModal').classList.add('active');
}
function closeEventModal() {
    document.getElementById('eventModal').classList.remove('active');
    editingEventId = null;
    editingEventIndex = null;
}
async function saveEvent() {
    const date = document.getElementById('eventDateInput').value;
    let endDate = document.getElementById('eventEndDateInput').value || date;
    const title = document.getElementById('eventTitleInput').value.trim();
    const note = document.getElementById('eventNoteInput').value;
    const location = document.getElementById('eventLocationInput').value.trim();
    const allDay = document.getElementById('eventAllDay').checked;
    const start = document.getElementById('eventStartTime').value;
    const end = document.getElementById('eventEndTime').value;
    const repeat = document.getElementById('eventRepeat').value;
    const reminder = parseInt(document.getElementById('eventReminder').value, 10) || 0;
    const repeatUntil = document.getElementById('eventUntil').value || '';
    const monthlyMode = document.getElementById('eventMonthlyMode').value === 'nth' ? 'nth' : 'date';
    const repeatDows = (repeat === 'weekly' || repeat === 'biweekly')
        ? calFormDows.slice().sort((a, b) => a - b) : [];
    const members = calFormMembers.slice();

    if (!date || !title) { showToast('日付とタイトルを入れてね'); return; }
    if (endDate < date) endDate = date;
    if (!allDay && end && start && end < start) { showToast('終了時刻が開始より前になっています'); return; }

    const saveBtn = document.querySelector('#eventModal .btn-save');
    saveBtn.textContent = '保存中…';
    saveBtn.disabled = true;
    try {
        if (editingEventId) {
            const ev = events.find(x => x.id === editingEventId);
            if (ev) Object.assign(ev, {
                date, endDate, title, note, location, allDay,
                start: allDay ? '' : start, end: allDay ? '' : end,
                repeat, reminder, label: calFormLabel,
                repeatDows, monthlyMode, repeatUntil, members,
                updatedBy: calMe(), updatedAt: new Date().toISOString()
            });
        } else {
            events.push(calNormalize({
                date, endDate, title, note, location, allDay,
                start: allDay ? '' : start, end: allDay ? '' : end,
                repeat, reminder, label: calFormLabel,
                repeatDows, monthlyMode, repeatUntil, members,
                author: calMe(), createdAt: new Date().toISOString(),
                photos: [], comments: [], exdates: []
            }));
        }
        selectedDate = date;
        calCursor = calParse(date);
        await calPersist();
        closeEventModal();
        renderCalendar();
        if (reminder) calAskNotifyPermission();
    } finally {
        saveBtn.innerText = '保存';
        saveBtn.disabled = false;
    }
}
async function deleteEvent(idOrIdx, dateStr) {
    const ev = typeof idOrIdx === 'number' ? events[idOrIdx] : events.find(x => x.id === idOrIdx);
    if (!ev) return;
    if (ev.repeat !== 'none' && dateStr) {
        const onlyThis = await confirmDialog('くり返しの予定です。この日だけ削除しますか？', { okText: 'この日だけ', cancelText: 'すべて対象', danger: false });
        if (onlyThis) {
            ev.exdates.push(dateStr);
            await calPersist();
            closeCalSheet();
            renderCalendar();
            return;
        }
        if (!await confirmDialog('すべてのくり返しを削除しますか？')) return;
    } else if (!await confirmDialog('この予定を削除しますか？')) return;
    const i = events.indexOf(ev);
    if (i !== -1) events.splice(i, 1);
    // ギャラリーにも他の予定にも無い写真は、ファイルごと片づける
    for (const ph of (ev.photos || [])) {
        const stillUsed = state.photos.some(q => calPhotoFull(q) === calPhotoFull(ph)) ||
            events.some(e2 => (e2.photos || []).some(q => calPhotoFull(q) === calPhotoFull(ph)));
        if (!stillUsed) await calRemovePhotoFiles(ph);
    }
    await calPersist();
    closeCalSheet();
    closeEventModal();
    renderCalendar();
}
function deleteEventFromForm() {
    if (editingEventId) deleteEvent(editingEventId, null);
}

/* ---------- ボトムシート（日別 / 予定詳細） ---------- */
function calOpenSheet() {
    calRenderSheet();
    calBindSheet();
    document.getElementById('calSheet').classList.add('active');
    document.getElementById('calSheet').querySelector('.cal-sheet-panel').scrollTop = 0;
    document.body.classList.add('cal-locked');
}
// 日付タップ → その日の予定をぜんぶ表示
function openDaySheet(dateStr) {
    calSheetMode = 'day';
    calSheetDate = dateStr;
    calSheetEvId = null;
    calSheetFrom = null;
    selectedDate = dateStr;
    calOpenSheet();
}
function calDayStep(n) {
    openDaySheet(calYmd(calAdd(calParse(calSheetDate), n)));
    calCursor = calParse(calSheetDate);
    renderCalendar();
}
function openEventDetail(id, dateStr) {
    const ev = events.find(x => x.id === id);
    if (!ev) return;
    calSheetFrom = calSheetMode === 'day' ? calSheetDate : null;
    calSheetMode = 'event';
    calSheetEvId = id;
    calSheetOcc = dateStr || ev.date;
    calOpenSheet();
}
function calBackToDay() {
    if (calSheetFrom) openDaySheet(calSheetFrom);
    else closeCalSheet();
}
function closeCalSheet() {
    const s = document.getElementById('calSheet');
    if (s) s.classList.remove('active');
    if (!calFullscreen) document.body.classList.remove('cal-locked');
    calSheetEvId = null;
    calSheetMode = 'event';
    calSheetFrom = null;
}
function calRenderSheet() {
    if (calSheetMode === 'day') return calRenderDaySheet();
    const ev = events.find(x => x.id === calSheetEvId);
    const box = document.getElementById('calSheetBody');
    if (!ev || !box) return;
    const ds = calSheetOcc;
    const span = calDiff(ev.date, ev.endDate);
    const sD = calParse(ds), eD = calAdd(sD, span);
    const diff = calDiff(calToday(), ds);
    const cd = diff === 0 ? '今日！' : diff === 1 ? '明日！' : diff > 0 ? 'あと' + diff + '日' : Math.abs(diff) + '日前';
    const fmt = d => (d.getMonth() + 1) + '月' + d.getDate() + '日(' + CAL_DOW[d.getDay()] + ')';
    let when = fmt(sD);
    if (span > 0) when += ' 〜 ' + fmt(eD);
    if (!ev.allDay) when += '　' + (ev.start || '') + (ev.end ? ' 〜 ' + ev.end : '');
    else when += '　終日';

    let h = '';
    if (calSheetFrom) {
        const bd = calParse(calSheetFrom);
        h += '<div class="cal-sheet-back" data-act="backtoday">‹ ' +
            (bd.getMonth() + 1) + '月' + bd.getDate() + '日の予定にもどる</div>';
    }
    h += '<div class="cal-detail-label" style="background:' + calTint(calColor(ev), .22) + ';border-left:3px solid ' + calColor(ev) + '">● ' + esc(calLabel(ev.label).name) + '</div>';
    h += '<div class="cal-detail-title">' + esc(ev.title) +
        '<span class="cal-cd-badge">' + cd + '</span></div>';
    h += '<div style="height:10px"></div>';
    h += '<div class="cal-row"><span class="ic">🕒</span><div>' + esc(when) + '</div></div>';
    if ((ev.members || []).length) {
        h += '<div class="cal-row"><span class="ic">👥</span><div class="cal-who">' +
            (ev.members || []).map(id => {
                const m = calMember(id);
                return m ? '<span class="cal-who-tag" style="background:' + m.color + '22;color:' + m.color + '">' +
                    '<span class="cal-av" style="background:' + m.color + '">' + esc(m.emoji) + '</span>' +
                    esc(m.name) + '</span>' : '';
            }).join('') + '</div></div>';
    }
    if (ev.repeat !== 'none') {
        h += '<div class="cal-row"><span class="ic">🔁</span><div>' + esc(calRepeatText(ev)) +
            (ev.repeatUntil ? '（' + esc(ev.repeatUntil) + 'まで）' : '') + '</div></div>';
    }
    if (ev.location) {
        h += '<div class="cal-row"><span class="ic">📍</span><div>' + esc(ev.location) +
            ' <a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ev.location) +
            '" target="_blank" rel="noopener">地図で見る ›</a></div></div>';
    }
    if (ev.reminder) h += '<div class="cal-row"><span class="ic">🔔</span><div>' + CAL_REMINDERS[ev.reminder] + 'に通知</div></div>';
    if (ev.note) h += '<div class="cal-row"><span class="ic">📝</span><div style="white-space:pre-wrap;">' + esc(ev.note) + '</div></div>';
    if (ev.author) h += '<div class="cal-row"><span class="ic">👤</span><div>' + esc(ev.author) + ' が作成</div></div>';

    h += '<div class="cal-sheet-actions">';
    h += '<button class="cal-btn-main" data-act="editev" data-arg="' + ev.id + '">✏️ 編集</button>';
    h += '</div>';
    h += '<div class="cal-sheet-actions"><button class="cal-btn-danger" data-act="delev" data-arg="' + ev.id + '" data-arg2="' + ds + '">🗑️ 削除</button></div>';

    // 思い出の写真
    h += '<div class="cal-sec-head">📷 思い出の写真 (' + ev.photos.length + ')</div>';
    if (ev.photos.length) {
        h += '<div class="cal-ev-gallery">' + ev.photos.map((p, i) =>
            '<img loading="lazy" decoding="async" src="' + esc(calPhotoThumb(p)) + '" alt="" ' +
            'data-act="evphoto" data-arg="' + i + '">').join('') + '</div>';
    } else {
        h += '<div class="cal-photo-empty">この日の写真をここに残しておけるよ 📸</div>';
    }
    h += '<div class="cal-photo-tools">' +
        '<label class="cal-photo-add" id="calEvPhotoAdd">＋ 写真を追加' +
        '<input type="file" accept="image/*" multiple hidden data-act-change="evphotos"></label>' +
        '<label class="cal-photo-share"><input type="checkbox" id="calPhotoToGallery" ' +
        (calPhotoShareDefault ? 'checked' : '') + ' data-act-change="shareflag">' +
        'ギャラリーにも追加</label></div>';

    h += '<div class="cal-sec-head">💬 コメント (' + ev.comments.length + ')</div>';
    h += '<div style="margin-top:10px;">';
    if (!ev.comments.length) h += '<div style="font-size:11.5px;color:#6b5d61;margin-bottom:8px;">まだコメントはないよ。ひとこと残してみよう！</div>';
    ev.comments.forEach(c => {
        h += '<div class="cal-cmt"><div class="av">' + esc((c.author || '?').slice(0, 1)) + '</div>' +
            '<div><div class="who">' + esc(c.author || '') + ' · ' + calAgo(c.at) + '</div>' +
            '<div class="bub">' + esc(c.text) + '</div></div></div>';
    });
    h += '</div>';
    h += '<div class="cal-cmt-input"><input id="calCmtInput" type="text" placeholder="コメントを書く..." ' +
        '><button data-act="addcomment">送信</button></div>';
    box.innerHTML = h;
}
/* ---------- 日別シート（その日の予定をぜんぶ） ---------- */
function calRenderDaySheet() {
    const box = document.getElementById('calSheetBody');
    if (!box) return;
    const ds = calSheetDate;
    const d = calParse(ds);
    const hol = calHolidayName(ds);
    const diff = calDiff(calToday(), ds);
    const cd = diff === 0 ? '今日' : diff === 1 ? '明日' : diff > 0 ? 'あと' + diff + '日' : Math.abs(diff) + '日前';
    // 日別シートでは絞り込みを無視して「ぜんぶ」出す
    const keep = calLabelFilter, keepM = calMemberFilter, keepQ = calSearch;
    calLabelFilter = []; calMemberFilter = []; calSearch = '';
    const occs = calOccurrences(ds, ds).sort(calOccSort);
    calLabelFilter = keep; calMemberFilter = keepM; calSearch = keepQ;

    const dowCls = d.getDay() === 0 || hol ? 'sun' : d.getDay() === 6 ? 'sat' : '';
    let h = '';
    h += '<div class="cal-daysheet-head">' +
        '<button class="nav" data-act="daystep" data-arg="-1">‹</button>' +
        '<div class="ttl"><b class="' + dowCls + '">' + (d.getMonth() + 1) + '月' + d.getDate() + '日 (' + CAL_DOW[d.getDay()] + ')</b>' +
        '<small>' + (hol ? esc(hol) + ' · ' : '') + cd + ' · ' + occs.length + '件</small></div>' +
        '<button class="nav" data-act="daystep" data-arg="1">›</button>' +
        '</div>';

    if (!occs.length) {
        h += '<div class="cal-empty" style="padding:34px 0;">この日はまだ予定なし 🌸</div>';
    } else {
        const hidden = occs.filter(o => {
            if (keep.length && keep.indexOf(o.ev.label) === -1) return true;
            if (keepM.length && (o.ev.members || []).length &&
                !o.ev.members.some(id => keepM.indexOf(id) !== -1)) return true;
            return false;
        }).length;
        if (hidden) h += '<div class="cal-daysheet-note">絞り込み中の ' + hidden + '件 もふくめて表示しています</div>';
        occs.forEach(o => { h += calEventRow(o); });
    }
    h += '<button class="cal-daysheet-add" data-act="addon" data-arg="' + ds + '">＋ この日に予定を追加</button>';
    box.innerHTML = h;
}

/* ---------- 予定の思い出写真 ---------- */
let calPhotoShareDefault = true;
let calEvPhotoIndex = null;

async function calAddEventPhotos(input) {
    const ev = events.find(x => x.id === calSheetEvId);
    if (!ev || !input.files || !input.files.length) return;
    const files = Array.from(input.files);
    const toGallery = (document.getElementById('calPhotoToGallery') || {}).checked;
    const btn = document.getElementById('calEvPhotoAdd');
    const label = btn ? btn.firstChild : null;
    input.disabled = true;
    let okCount = 0;
    const galleryRows = [];
    for (let i = 0; i < files.length; i++) {
        if (label) label.nodeValue = '追加中... (' + (i + 1) + '/' + files.length + ')';
        try {
            const rec = await uploadOnePhoto(files[i], files[i].name);
            rec.eventId = ev.id;
            // 待っている間に相手の更新で events が入れ替わっているかもしれない
            const cur = events.find(x => x.id === rec.eventId);
            if (!cur) throw new Error('予定が見つからなくなりました');
            if (!Array.isArray(cur.photos)) cur.photos = [];
            cur.photos.push(rec);
            if (toGallery) galleryRows.push({
                full_path: rec.full_path, thumb_path: rec.thumb_path,
                w: rec.w, h: rec.h, author_name: rec.author_name, created_by: rec.created_by
            });
            okCount++;
        } catch (e) { console.error('写真の追加に失敗', e); }
    }
    input.value = '';
    input.disabled = false;
    if (okCount) {
        if (galleryRows.length) {
            try { await addPhotos(galleryRows); }
            catch (e) { showError('ギャラリーへの追加に失敗しました', e); }
        }
        await calPersist();
        calRenderSheet();
        renderCalendar();
        if (toGallery) renderGallery();
        showToast(okCount + '枚を予定に追加しました📷');
    } else {
        calRenderSheet();
        showToast('追加できませんでした🥲');
    }
}

function calOpenEventPhoto(i) {
    const ev = events.find(x => x.id === calSheetEvId);
    if (!ev || !ev.photos[i]) return;
    calEvPhotoIndex = i;
    document.getElementById('calPhotoViewerImg').src = calPhotoFull(ev.photos[i]);
    document.getElementById('calPhotoViewerCount').textContent = (i + 1) + ' / ' + ev.photos.length;
    document.getElementById('calPhotoViewer').style.display = 'flex';
}
function calCloseEventPhoto() {
    document.getElementById('calPhotoViewer').style.display = 'none';
    calEvPhotoIndex = null;
}
function calStepEventPhoto(n) {
    const ev = events.find(x => x.id === calSheetEvId);
    if (!ev || calEvPhotoIndex === null || !ev.photos.length) return;
    calOpenEventPhoto((calEvPhotoIndex + n + ev.photos.length) % ev.photos.length);
}
async function calDeleteEventPhoto() {
    const ev = events.find(x => x.id === calSheetEvId);
    if (!ev || calEvPhotoIndex === null) return;
    const p = ev.photos[calEvPhotoIndex];
    const inGallery = state.photos.some(q => calPhotoFull(q) === calPhotoFull(p));
    if (!await confirmDialog('この写真を予定から外しますか？' + (inGallery ? '（ギャラリーの分は残ります）' : ''))) return;
    ev.photos.splice(calEvPhotoIndex, 1);
    if (!inGallery) await calRemovePhotoFiles(p);   // どこにも残らないならファイルも消す
    calCloseEventPhoto();
    await calPersist();
    calRenderSheet();
    renderCalendar();
    showToast('写真を外しました🗑️');
}

/* ---------- メンバーの編集 ---------- */
let calMemberDraft = [];
function openMemberModal() {
    calEnsureMembers();
    calMemberDraft = calMembers.map(m => ({ id: m.id, name: m.name, color: m.color, emoji: m.emoji }));
    calMemberPaletteOpen = -1;
    calRenderMemberEditor();
    document.getElementById('memberModal').classList.add('active');
}
function closeMemberModal() {
    document.getElementById('memberModal').classList.remove('active');
}
let calMemberPaletteOpen = -1;
function calToggleMemberPalette(i) {
    calMemberPaletteOpen = calMemberPaletteOpen === i ? -1 : i;
    calRenderMemberEditor();
}
function calPickMemberColor(i, c) {
    calMemberDraft[i].color = c;
    calRenderMemberEditor();
}
function calPickMemberEmoji(i, e) {
    calMemberDraft[i].emoji = e;
    calMemberPaletteOpen = -1;
    calRenderMemberEditor();
}
function calRenderMemberEditor() {
    const box = document.getElementById('memberEditList');
    if (!box) return;
    const me = calMyMemberId();
    const used = {};
    events.forEach(e => (e.members || []).forEach(id => { used[id] = (used[id] || 0) + 1; }));
    box.innerHTML = calMemberDraft.map((m, i) =>
        '<div class="cal-lbl-row">' +
        '<button class="cal-lbl-color" style="background:' + m.color + '" ' +
        'data-act="mpalette" data-arg="' + i + '">' + esc(m.emoji) + '</button>' +
        '<input class="cal-lbl-name" type="text" maxlength="12" value="' + esc(m.name) +
        '" placeholder="なまえ" oninput="calMemberDraft[' + i + '].name=this.value">' +
        '<button class="cal-me-btn' + (m.id === me ? ' on' : '') + '" ' +
        'data-act="setme" data-arg="' + esc(m.id) + '">' +
        (m.id === me ? '自分' : 'これが自分') + '</button>' +
        '<button class="cal-lbl-del" data-act="delmember" data-arg="' + i + '" ' +
        (calMemberDraft.length <= 1 ? 'disabled' : '') + '>🗑</button>' +
        '<span class="cal-lbl-count">' + (used[m.id] ? used[m.id] + '件' : '') + '</span>' +
        (calMemberPaletteOpen === i
            ? '<div class="cal-lbl-palette">' + CAL_PALETTE.map(c =>
                '<div class="sw' + (c.toLowerCase() === m.color.toLowerCase() ? ' on' : '') +
                '" style="background:' + c + '" data-act="mcolor" data-arg="' + i + '" data-arg2="' + c + '"></div>').join('') +
            '</div><div class="cal-emoji-palette">' + CAL_MEMBER_EMOJI.map(e =>
                '<div class="em' + (e === m.emoji ? ' on' : '') + '" data-act="memoji" data-arg="' + i + '" data-arg2="' + e + '">' +
                e + '</div>').join('') + '</div>'
            : '') +
        '</div>').join('');
    const add = document.getElementById('memberAddBtn');
    if (add) add.style.display = calMemberDraft.length >= CAL_MEMBER_MAX ? 'none' : 'block';
}
function calAddMember() {
    if (calMemberDraft.length >= CAL_MEMBER_MAX) return;
    const id = 'mb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    calMemberDraft.push({
        id: id, name: 'メンバー',
        color: CAL_PALETTE[(calMemberDraft.length * 3) % CAL_PALETTE.length],
        emoji: CAL_MEMBER_EMOJI[calMemberDraft.length % CAL_MEMBER_EMOJI.length]
    });
    calMemberPaletteOpen = -1;
    calRenderMemberEditor();
}
async function calDeleteMember(i) {
    if (calMemberDraft.length <= 1) return;
    const m = calMemberDraft[i];
    const n = events.filter(e => (e.members || []).indexOf(m.id) !== -1).length;
    if (n && !await confirmDialog('「' + m.name + '」の予定が' + n + '件あります。予定は残して、割り当てだけ外しますか？', { okText: '外す', danger: false })) return;
    calMemberDraft.splice(i, 1);
    calMemberPaletteOpen = -1;
    calRenderMemberEditor();
}
async function saveMembers() {
    const btn = document.getElementById('memberSaveBtn');
    btn.textContent = '保存中…';
    btn.disabled = true;
    try {
        const gone = calMembers.filter(m => !calMemberDraft.some(d => d.id === m.id)).map(m => m.id);
        calSetMembers(calMemberDraft.map(m => ({
            id: m.id, name: (m.name || '').trim() || 'メンバー', color: m.color, emoji: m.emoji
        })));
        if (gone.length) {
            events.forEach(e => {
                e.members = (e.members || []).filter(id => gone.indexOf(id) === -1);
            });
        }
        calMemberFilter = calMemberFilter.filter(id => calMember(id));
        calSaveLocalMembers();
        await saveSetting('members', calMembers);
        await calPersist();
        closeMemberModal();
        calFillMemberPicker();
        renderCalendar();
    } finally {
        btn.innerText = '保存';
        btn.disabled = false;
    }
}

/* ---------- ラベルの編集 ---------- */
let calLabelDraft = [];
function openLabelModal() {
    calLabelDraft = calLabels.map(l => ({ key: l.key, name: l.name, color: l.color }));
    calRenderLabelEditor();
    document.getElementById('labelModal').classList.add('active');
}
function closeLabelModal() {
    document.getElementById('labelModal').classList.remove('active');
}
function calRenderLabelEditor() {
    const box = document.getElementById('labelEditList');
    if (!box) return;
    const used = {};
    events.forEach(e => { used[e.label] = (used[e.label] || 0) + 1; });
    box.innerHTML = calLabelDraft.map((l, i) => {
        const n = used[l.key] || 0;
        return '<div class="cal-lbl-row">' +
            '<button class="cal-lbl-color" style="background:' + l.color + '" data-act="lpalette" data-arg="' + i + '">' +
            (calLabelPaletteOpen === i ? '×' : '') + '</button>' +
            '<input class="cal-lbl-name" type="text" maxlength="12" value="' + esc(l.name) +
            '" placeholder="ラベル名" oninput="calLabelDraft[' + i + '].name=this.value">' +
            '<span class="cal-lbl-count">' + (n ? n + '件' : '') + '</span>' +
            '<button class="cal-lbl-del" data-act="dellabel" data-arg="' + i + '" ' +
            (calLabelDraft.length <= 1 ? 'disabled' : '') + '>🗑</button>' +
            (calLabelPaletteOpen === i
                ? '<div class="cal-lbl-palette">' + CAL_PALETTE.map(c =>
                    '<div class="sw' + (c.toLowerCase() === l.color.toLowerCase() ? ' on' : '') +
                    '" style="background:' + c + '" data-act="lcolor" data-arg="' + i + '" data-arg2="' + c + '"></div>').join('') +
                '</div>'
                : '') +
            '</div>';
    }).join('');
    const add = document.getElementById('labelAddBtn');
    if (add) add.style.display = calLabelDraft.length >= CAL_LABEL_MAX ? 'none' : 'block';
}
let calLabelPaletteOpen = -1;
function calToggleLabelPalette(i) {
    calLabelPaletteOpen = calLabelPaletteOpen === i ? -1 : i;
    calRenderLabelEditor();
}
function calPickLabelColor(i, c) {
    calLabelDraft[i].color = c;
    calLabelPaletteOpen = -1;
    calRenderLabelEditor();
}
function calAddLabel() {
    if (calLabelDraft.length >= CAL_LABEL_MAX) return;
    const key = 'lb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const c = CAL_PALETTE[calLabelDraft.length % CAL_PALETTE.length];
    calLabelDraft.push({ key: key, name: '新しいラベル', color: c });
    calLabelPaletteOpen = -1;
    calRenderLabelEditor();
}
async function calDeleteLabel(i) {
    if (calLabelDraft.length <= 1) return;
    const l = calLabelDraft[i];
    const n = events.filter(e => e.label === l.key).length;
    const fallback = calLabelDraft[i === 0 ? 1 : 0];
    if (n && !await confirmDialog('「' + l.name + '」の予定が' + n + '件あります。「' + fallback.name + '」に付けかえて削除しますか？')) return;
    calLabelDraft.splice(i, 1);
    calLabelPaletteOpen = -1;
    calRenderLabelEditor();
}
async function calResetLabels() {
    if (!await confirmDialog('ラベルを最初の状態にもどしますか？', { okText: 'もどす', danger: false })) return;
    calLabelDraft = CAL_DEFAULT_LABELS.map(l => ({ key: l.key, name: l.name, color: l.color }));
    calLabelPaletteOpen = -1;
    calRenderLabelEditor();
}
async function saveLabels() {
    const btn = document.getElementById('labelSaveBtn');
    btn.textContent = '保存中…';
    btn.disabled = true;
    try {
        const gone = calLabels.filter(l => !calLabelDraft.some(d => d.key === l.key)).map(l => l.key);
        calSetLabels(calLabelDraft.map(l => ({
            key: l.key, name: (l.name || '').trim() || 'ラベル', color: l.color
        })));
        // 消えたラベルの予定は先頭のラベルへ付けかえる
        if (gone.length) {
            events.forEach(e => { if (gone.indexOf(e.label) !== -1) e.label = calLabels[0].key; });
        }
        calLabelFilter = calLabelFilter.filter(k => calLabels.some(l => l.key === k));
        calSaveLocalLabels();
        await saveSetting('labels', calLabels);
        await calPersist();
        closeLabelModal();
        calFillLabelSwatches();
        renderCalendar();
    } finally {
        btn.innerText = '保存';
        btn.disabled = false;
    }
}

function calAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    const m = Math.floor((now - d) / 60000);
    if (m < 1) return 'たった今';
    if (m < 60) return m + '分前';
    if (m < 1440) return Math.floor(m / 60) + '時間前';
    if (m < 10080) return Math.floor(m / 1440) + '日前';
    return (d.getMonth() + 1) + '/' + d.getDate();
}
async function calAddComment() {
    const input = document.getElementById('calCmtInput');
    const text = input.value.trim();
    if (!text) return;
    const ev = events.find(x => x.id === calSheetEvId);
    if (!ev) return;
    ev.comments.push({ author: calMe(), text: text, at: new Date().toISOString() });
    input.value = '';
    calRenderSheet();
    await calPersist();
    renderCalendar();
}

/* ---------- リマインダー通知 ---------- */
/** リマインダーを設定したのに通知がオフなら、そのままでは届かないと伝える */
function calAskNotifyPermission() {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
        showToast('通知がオフです。ホームの「🔔 通知」からオンにすると、この知らせが届きます', 6000);
    }
}
/* ------------------------------------------------------------
   リマインダー

   以前はここで setTimeout を仕掛けていました。つまりアプリを
   開きっぱなしにしていないと発火しません。「1週間前に知らせて」と
   設定しても、1週間ずっと開いていないと来ませんでした。

   くり返しの展開（毎週の複数曜日・隔週・第◯曜日・除外日など）の
   正しい実装はこのファイルにあります。サーバーにもう一度書くと
   2つがずれるので、ここで展開した結果だけを共有の設定に置き、
   送るのはサーバー側（notify-reminders）に任せます。
   ------------------------------------------------------------ */
const CAL_REMINDER_DAYS = 60;    // 何日先まで用意しておくか
let calLastReminders = '';

function calBuildReminders() {
    const out = [];
    const now = Date.now();
    const occs = calOccurrences(calToday(), calYmd(calAdd(new Date(), CAL_REMINDER_DAYS)), true);

    occs.forEach(o => {
        const ev = o.ev;
        if (!ev.reminder) return;
        const d = calParse(o.sYmd);
        // 終日の予定は、その日の朝9時を基準にする
        const at = ev.allDay
            ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0)
            : new Date(d.getFullYear(), d.getMonth(), d.getDate(),
                Math.floor(calMin(ev.start) / 60), calMin(ev.start) % 60);
        const fire = at.getTime() - ev.reminder * 60000;
        if (fire <= now) return;

        out.push({
            id: ev.id + ':' + o.sYmd,
            at: new Date(fire).toISOString(),
            title: ev.title || '予定',
            date: o.sYmd,
            when: ev.allDay ? '終日' : (ev.start || ''),
            before: ev.reminder,
            location: ev.location || ''
        });
    });

    return out.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0).slice(0, 300);
}

let calReminderTimer = null;

/** 何度呼ばれてもまとめて1回だけ実行する（描画のたびに走らせない） */
function calScheduleReminders() {
    clearTimeout(calReminderTimer);
    calReminderTimer = setTimeout(calPushReminders, 800);
}

async function calPushReminders() {
    let list;
    try { list = calBuildReminders(); }
    catch (e) { console.warn('リマインダーを組み立てられませんでした', e); return; }

    // 中身が変わっていなければ書かない（ふたりの端末が同じ内容を
    // 書き合うので、無駄な通信を減らします）
    const now = JSON.stringify(list);
    if (now === calLastReminders) return;
    calLastReminders = now;

    try { await saveSetting('reminders', list); }
    catch (e) { console.warn('リマインダーを保存できませんでした', e); }
}

/* ============================================================
   保存：変わった予定だけを書き込む
   以前は「全データを1行にまとめて上書き」していたため、
   ふたりが同時に触ると片方の変更が消えていました。
   ここでは前回の内容と見くらべて、差があるものだけ送ります。
   ============================================================ */
const calSnapshot = new Map();

function calRemember() {
  calSnapshot.clear();
  events.forEach(ev => calSnapshot.set(ev.id, JSON.stringify(ev)));
}

async function calPersist() {
  const jobs = [];
  const alive = new Set();

  for (const ev of events) {
    alive.add(ev.id);
    const now = JSON.stringify(ev);
    if (calSnapshot.get(ev.id) !== now) {
      jobs.push(upsertEvent(ev).then(() => calSnapshot.set(ev.id, now)));
    }
  }
  for (const id of [...calSnapshot.keys()]) {
    if (!alive.has(id)) {
      jobs.push(deleteEventRow(id).then(() => calSnapshot.delete(id)));
    }
  }

  const results = await Promise.allSettled(jobs);
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) showError('予定を保存できませんでした。通信を確かめてね', failed[0].reason);
}

/* ============================================================
   相手の変更を受け取る（1件ずつ差分で当てる）
   ============================================================ */
export function calApplyRemote(type, row) {
  if (!row || !row.id) return;
  const i = events.findIndex(e => e.id === row.id);
  if (type === 'DELETE') {
    if (i !== -1) events.splice(i, 1);
    calSnapshot.delete(row.id);
  } else {
    const ev = calNormalize(row.data);
    if (i === -1) events.push(ev); else events[i] = ev;
    calSnapshot.set(ev.id, JSON.stringify(ev));
  }
  renderCalendar();
  if (calSheetEvId || (calSheetMode === 'day' && calSheetDate)) calRenderSheet();
  calScheduleReminders();
}

export function calApplySettings(key, value) {
  if (key === 'labels') { calSetLabels(value); calSaveLocalLabels(); }
  if (key === 'members') { calSetMembers(value); calSaveLocalMembers(); }
  renderCalendar();
}

/* ============================================================
   起動
   ============================================================ */
export async function initCalendar() {
  // 共有設定（無ければ端末の控え）
  if (Array.isArray(state.settings.labels) && state.settings.labels.length) calSetLabels(state.settings.labels);
  else calLoadLocalLabels();
  if (Array.isArray(state.settings.members) && state.settings.members.length) calSetMembers(state.settings.members);
  else calLoadLocalMembers();

  try {
    const rows = await loadEvents();
    events = rows;
  } catch (e) {
    showError('予定を読み込めませんでした', e);
    events = [];
  }
  calNormalizeAll();
  calRemember();

  selectedDate = calToday();
  renderCalendar();
  calScheduleReminders();

  // 画面に置いてあるボタンからの呼び出し口
  registerActions({
    'cal:search': toggleCalSearch,
    'cal:fullscreen': toggleCalFullscreen,
    'cal:add': () => openEventModal(),
    'cal:closeEvent': closeEventModal,
    'cal:saveEvent': saveEvent,
    'cal:deleteEvent': deleteEventFromForm,
    'cal:quickDate': arg => calQuickDate(arg),
    'cal:closeSheet': closeCalSheet,
    'cal:addLabel': calAddLabel,
    'cal:resetLabels': calResetLabels,
    'cal:closeLabels': closeLabelModal,
    'cal:saveLabels': saveLabels,
    'cal:addMember': calAddMember,
    'cal:closeMembers': closeMemberModal,
    'cal:saveMembers': saveMembers,
    'cal:photoClose': calCloseEventPhoto,
    'cal:photoDelete': calDeleteEventPhoto,
    'cal:photoStep': arg => calStepEventPhoto(Number(arg))
  });

  // カレンダーが自前で作った要素（data-act）をまとめて受ける
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (t) calHandleAct(t);
  });
  document.addEventListener('change', e => {
    const t = e.target.closest('[data-act-change]');
    if (!t) return;
    if (t.dataset.actChange === 'evphotos') calAddEventPhotos(t);
    if (t.dataset.actChange === 'shareflag') calPhotoShareDefault = t.checked;
  });
  // コメント欄は Enter でも送れるように
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'calCmtInput') calAddComment();
  });
  const dateInput = document.getElementById('eventDateInput');
  if (dateInput) dateInput.addEventListener('change', calFillRepeatOptions);
  const repeatSel = document.getElementById('eventRepeat');
  if (repeatSel) repeatSel.addEventListener('change', calFillRepeatOptions);
  const allDay = document.getElementById('eventAllDay');
  if (allDay) allDay.addEventListener('change', calToggleAllDay);
}

export { renderCalendar };
