// ============================================================
//  データ層
//  ・保存は「変わった1行だけ」。全部まとめて上書きすることは二度としない。
//  ・リアルタイムは INSERT / UPDATE / DELETE を配列に差分で当てる。
//  ・添字ではなく id で消す。並びが変わっても違うものを消さない。
// ============================================================
import { db, userId } from './supabase.js';

/** 画面が見ているデータ。中身は入れ替えず、常に同じ配列を使いまわす */
export const state = {
  photos: [],
  diaries: [],
  replies: [],      // { id, diary_id, ... }
  shops: [],
  shopLikes: [],    // { shop_id, user_id }
  voices: [],
  anniversaries: [],
  settings: {},     // { labels: [...], members: [...] }
  love: 0
};

// ---------- ごく小さな購読の仕組み ----------
const listeners = new Map();
export function on(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
}
export function emit(key, payload) {
  (listeners.get(key) || []).forEach(fn => {
    try { fn(payload); } catch (e) { console.error('描画に失敗:', key, e); }
  });
}

// ---------- 共通の読み書き ----------
function byNewest(a, b) { return new Date(b.created_at) - new Date(a.created_at); }

async function selectAll(table, order = 'created_at') {
  const { data, error } = await db.from(table).select('*').order(order, { ascending: false });
  if (error) throw error;
  return data || [];
}

/** 配列の中身だけ入れ替える（参照を保つ） */
function replace(arr, next) { arr.length = 0; arr.push(...next); }

export async function loadAll() {
  const [photos, diaries, replies, shops, likes, voices, anniversaries, settings, counter] =
    await Promise.all([
      selectAll('photos'),
      selectAll('diaries'),
      db.from('replies').select('*').order('created_at', { ascending: true }).then(r => r.data || []),
      selectAll('shops'),
      db.from('shop_likes').select('*').then(r => r.data || []),
      selectAll('voices'),
      db.from('anniversaries').select('*').then(r => r.data || []),
      db.from('settings').select('*').then(r => r.data || []),
      db.from('counters').select('value').eq('key', 'love').maybeSingle().then(r => r.data)
    ]);

  replace(state.photos, photos);
  replace(state.diaries, diaries);
  replace(state.replies, replies);
  replace(state.shops, shops);
  replace(state.shopLikes, likes);
  replace(state.voices, voices);
  replace(state.anniversaries, anniversaries);
  state.settings = Object.fromEntries(settings.map(s => [s.key, s.value]));
  state.love = counter ? Number(counter.value) : 0;
}

// ---------- 写真 ----------
export async function addPhotos(rows) {
  const { data, error } = await db.from('photos').insert(rows).select();
  if (error) throw error;
  return data;
}
export async function updatePhoto(id, patch) {
  const { error } = await db.from('photos').update(patch).eq('id', id);
  if (error) throw error;
}
export async function removePhoto(id) {
  const { error } = await db.from('photos').delete().eq('id', id);
  if (error) throw error;
}

// ---------- メッセージ ----------
export async function addDiary(row) {
  const { data, error } = await db.from('diaries').insert(row).select().single();
  if (error) throw error;
  return data;
}
export async function removeDiary(id) {
  const { error } = await db.from('diaries').delete().eq('id', id);
  if (error) throw error;
}
export async function addReply(row) {
  const { data, error } = await db.from('replies').insert(row).select().single();
  if (error) throw error;
  return data;
}
export async function removeReply(id) {
  const { error } = await db.from('replies').delete().eq('id', id);
  if (error) throw error;
}

// ---------- お店 ----------
export async function saveShop(row) {
  const { data, error } = await db.from('shops').upsert(row).select().single();
  if (error) throw error;
  return data;
}
export async function removeShop(id) {
  const { error } = await db.from('shops').delete().eq('id', id);
  if (error) throw error;
}
/** いいねは行の追加/削除。配列の読み書きではないので同時押しでも消えない */
export async function toggleLike(shopId, liked) {
  if (liked) {
    const { error } = await db.from('shop_likes').delete()
      .eq('shop_id', shopId).eq('user_id', userId);
    if (error) throw error;
  } else {
    const { error } = await db.from('shop_likes')
      .upsert({ shop_id: shopId, user_id: userId });
    if (error) throw error;
  }
}

// ---------- ボイス ----------
export async function addVoice(row) {
  const { data, error } = await db.from('voices').insert(row).select().single();
  if (error) throw error;
  return data;
}
export async function removeVoice(id) {
  const { error } = await db.from('voices').delete().eq('id', id);
  if (error) throw error;
}

// ---------- 予定 ----------
export async function upsertEvent(ev) {
  const { error } = await db.from('events')
    .upsert({ id: ev.id, data: ev, updated_by: userId, updated_at: new Date().toISOString() });
  if (error) throw error;
}
export async function deleteEventRow(id) {
  const { error } = await db.from('events').delete().eq('id', id);
  if (error) throw error;
}
export async function loadEvents() {
  const { data, error } = await db.from('events').select('*');
  if (error) throw error;
  return (data || []).map(r => r.data);
}

// ---------- 記念日 ----------
export async function addAnniversary(row) {
  const { data, error } = await db.from('anniversaries').insert(row).select().single();
  if (error) throw error;
  return data;
}
export async function removeAnniversary(id) {
  const { error } = await db.from('anniversaries').delete().eq('id', id);
  if (error) throw error;
}

// ---------- 設定（ラベル・メンバー） ----------
export async function saveSetting(key, value) {
  const { error } = await db.from('settings')
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}

// ---------- ハート ----------
/** 読んで足して書くのではなく、DB 側で足す。同時押しでも数が落ちない */
export async function bumpLove(by) {
  const { data, error } = await db.rpc('bump_counter', { p_key: 'love', p_by: by });
  if (error) throw error;
  state.love = Number(data);
  return state.love;
}

// ============================================================
//  リアルタイム
// ============================================================
const TABLES = {
  photos: { arr: () => state.photos, key: 'photos', sort: byNewest },
  diaries: { arr: () => state.diaries, key: 'diaries', sort: byNewest },
  replies: { arr: () => state.replies, key: 'diaries', sort: (a, b) => new Date(a.created_at) - new Date(b.created_at) },
  shops: { arr: () => state.shops, key: 'shops', sort: byNewest },
  shop_likes: { arr: () => state.shopLikes, key: 'shops', sort: null },
  voices: { arr: () => state.voices, key: 'voices', sort: byNewest },
  anniversaries: { arr: () => state.anniversaries, key: 'anniversaries', sort: null }
};

function sameRow(a, b) {
  if (a.id && b.id) return a.id === b.id;
  // shop_likes は複合キー
  return a.shop_id === b.shop_id && a.user_id === b.user_id;
}

function applyChange(table, payload) {
  const spec = TABLES[table];
  if (!spec) return;
  const arr = spec.arr();
  const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
  if (!row) return;

  const i = arr.findIndex(x => sameRow(x, row));
  if (payload.eventType === 'DELETE') {
    if (i !== -1) arr.splice(i, 1);
  } else if (i === -1) {
    arr.push(row);
    if (spec.sort) arr.sort(spec.sort);
  } else {
    arr[i] = row;
  }

  // 自分以外が足したものだけ NEW を出す（shop_likes は user_id で見る）
  const mine = (row.created_by || row.user_id) === userId;
  emit(spec.key, { type: payload.eventType, row, mine });
  if (payload.eventType === 'INSERT' && !mine) emit('remote-insert', { table, row });
}

let channel = null;

export function startRealtime({ onEvents } = {}) {
  if (channel) db.removeChannel(channel);
  channel = db.channel('shared-data');

  for (const table of Object.keys(TABLES)) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table },
      payload => applyChange(table, payload));
  }

  // 予定はカレンダー側が自分で配列を持っているので、そちらに渡す
  channel.on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, payload => {
    if (!onEvents) return;
    const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
    onEvents(payload.eventType, row, row && row.updated_by === userId);
  });

  channel.on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, payload => {
    const row = payload.new;
    if (!row) return;
    state.settings[row.key] = row.value;
    emit('settings', row);
  });

  channel.on('postgres_changes', { event: '*', schema: 'public', table: 'counters' }, payload => {
    if (payload.new && payload.new.key === 'love') {
      state.love = Number(payload.new.value);
      emit('love', state.love);
    }
  });

  channel.subscribe(status => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      console.warn('リアルタイム接続が切れました。5秒後に繋ぎ直します:', status);
      setTimeout(() => startRealtime({ onEvents }), 5000);
    }
  });
}
