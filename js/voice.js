// ============================================================
//  ボイスメッセージ
//
//  直したところ:
//   ・voices バケットを非公開にしました。URLを知っていても他人は聞けません。
//     聞くときだけ、その場で署名付きURLを発行します。
//   ・DBに持つのは URL ではなく Storage のパス
// ============================================================
import { db, userId, userName } from './supabase.js';
import { VOICE_BUCKET, VOICE_URL_TTL, VOICE_MAX_MS } from './config.js';
import { state, addVoice, removeVoice, on } from './data.js';
import {
  $, el, clear, emptyState, showToast, showError,
  confirmDialog, timeAgo, formatDuration
} from './util.js';
import { registerActions } from './actions.js';
import { notifyPartner } from './push.js';

/* ------------------------------------------------------------
   署名付きURL（期限つき）
   ------------------------------------------------------------ */
// path -> { url, expires }。url が null なのは「作れなかった」印です。
// 作れなかったものも覚えておかないと、描き直すたびに永久に試し続けてしまいます。
const signed = new Map();
let fetching = false;

function entry(path) {
  const hit = signed.get(path);
  return hit && hit.expires > Date.now() ? hit : null;
}

function cachedUrl(path) {
  const hit = entry(path);
  return hit ? hit.url : null;
}

/** 足りないぶんのURLをまとめて作る。1つでも新しく作れたら true */
async function signMissing(paths) {
  const need = [...new Set(paths.filter(p => p && !entry(p)))];
  if (!need.length || fetching) return false;
  fetching = true;

  const expires = Date.now() + Math.max(60, VOICE_URL_TTL - 60) * 1000;
  try {
    const { data, error } = await db.storage.from(VOICE_BUCKET)
      .createSignedUrls(need, VOICE_URL_TTL);
    if (error) throw error;

    let made = 0;
    const got = new Map((data || []).map(row => [row.path, row.signedUrl || null]));
    for (const path of need) {
      const url = got.get(path) || null;
      signed.set(path, { url, expires });
      if (url) made++;
    }
    return made > 0;
  } catch (e) {
    console.warn('ボイスのURLを作れませんでした', e);
    // しばらく間を置いてから再挑戦する
    const retryAt = Date.now() + 30 * 1000;
    need.forEach(path => signed.set(path, { url: null, expires: retryAt }));
    return false;
  } finally {
    fetching = false;
  }
}

/* ------------------------------------------------------------
   表示
   ------------------------------------------------------------ */
function voiceNode(voice) {
  // 移行前の公開URLがそのまま入っていることがあるので、その場合はそれを使う
  const url = /^https?:/.test(voice.path || '') ? voice.path : cachedUrl(voice.path);
  const meta = [timeAgo(voice.created_at), formatDuration(voice.duration_ms)]
    .filter(Boolean).join(' ・ ');

  return el('div', { class: 'voice-entry' }, [
    el('div', { class: 'voice-header' }, [
      el('span', { class: 'voice-author', text: `🎤 ${voice.author || '?'}` }),
      el('span', { class: 'voice-meta', text: meta })
    ]),
    url
      ? el('audio', { class: 'voice-audio', controls: true, preload: 'none', src: url })
      : el('div', { class: 'voice-meta', text: '読み込み中…' }),
    el('button', {
      class: 'btn-chip danger voice-delete', text: '削除',
      'data-action': 'voice:delete', 'data-arg': voice.id
    })
  ]);
}

export function renderVoices() {
  const box = $('voiceListContainer');
  if (!box) return;
  clear(box);

  if (!state.voices.length) {
    box.appendChild(emptyState('まだボイスメッセージがありません。\n下のマイクを押すと録音できます'));
    return;
  }

  state.voices.forEach(v => box.appendChild(voiceNode(v)));

  // 足りないURLを作って、できたらもう一度だけ描き直す
  const paths = state.voices.map(v => v.path).filter(p => p && !/^https?:/.test(p));
  signMissing(paths).then(updated => { if (updated) renderVoices(); });
}

/* ------------------------------------------------------------
   録音
   ------------------------------------------------------------ */
let recorder = null;
let chunks = [];
let startedAt = 0;
let stopTimer = null;
let tickTimer = null;

function setStatus(text) {
  const node = $('recordStatus');
  if (node) node.textContent = text;
}

function setRecordingUI(on) {
  const btn = $('recordBtn');
  if (btn) {
    btn.classList.toggle('recording', on);
    btn.textContent = on ? '⏹' : '🎤';
    btn.setAttribute('aria-label', on ? '録音をとめる' : '録音する');
  }
}

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function extensionFor(mime) {
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  return 'webm';
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast('このブラウザでは録音できません');
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showError('マイクを使えませんでした。ブラウザの設定で許可してね', e);
    return;
  }

  const mime = pickMime();
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e) {
    stream.getTracks().forEach(t => t.stop());
    showError('録音をはじめられませんでした', e);
    return;
  }

  chunks = [];
  startedAt = Date.now();

  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(tickTimer);
    clearTimeout(stopTimer);
    setRecordingUI(false);
    const duration = Date.now() - startedAt;
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    recorder = null;
    chunks = [];
    if (duration < 700 || !blob.size) { setStatus('短すぎました。もう一度どうぞ'); return; }
    await upload(blob, duration);
  };

  recorder.start();
  setRecordingUI(true);

  tickTimer = setInterval(() => {
    const left = Math.max(0, Math.ceil((VOICE_MAX_MS - (Date.now() - startedAt)) / 1000));
    setStatus(`録音中… もう一度押すと終わります（あと${left}秒）`);
  }, 250);
  stopTimer = setTimeout(() => { if (recorder && recorder.state === 'recording') recorder.stop(); }, VOICE_MAX_MS);
}

async function upload(blob, duration) {
  const author = ($('voiceAuthorInput') && $('voiceAuthorInput').value.trim()) || userName || 'わたし';
  const ext = extensionFor(blob.type || '');
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  setStatus('送信中…');
  try {
    const { error } = await db.storage.from(VOICE_BUCKET)
      .upload(path, blob, { contentType: blob.type || 'audio/webm', upsert: false });
    if (error) throw error;

    const row = await addVoice({ author, path, duration_ms: duration, created_by: userId });
    if (!state.voices.some(v => v.id === row.id)) state.voices.unshift(row);
    renderVoices();
    setStatus('タップして録音（最長90秒）');
    showToast('ボイスメッセージを送りました🎤');
    notifyPartner('ボイスメッセージが届きました🎤', `${author}から ${formatDuration(duration)}`);
  } catch (e) {
    showError('ボイスメッセージを送れませんでした', e);
    setStatus('タップして録音（最長90秒）');
  }
}

function toggle() {
  if (recorder && recorder.state === 'recording') recorder.stop();
  else startRecording();
}

/* ------------------------------------------------------------
   削除
   ------------------------------------------------------------ */
async function remove(id) {
  const voice = state.voices.find(v => v.id === id);
  if (!voice) return;
  if (!await confirmDialog('このボイスメッセージを削除しますか？')) return;

  try { await removeVoice(id); }
  catch (e) { showError('削除できませんでした', e); return; }

  const i = state.voices.findIndex(v => v.id === id);
  if (i !== -1) state.voices.splice(i, 1);
  signed.delete(voice.path);

  if (voice.path && !/^https?:/.test(voice.path)) {
    db.storage.from(VOICE_BUCKET).remove([voice.path])
      .then(({ error }) => { if (error) console.warn('音声ファイルの削除に失敗', error); })
      .catch(e => console.warn('音声ファイルの削除に失敗', e));
  }

  renderVoices();
  showToast('削除しました🗑️');
}

/* ------------------------------------------------------------
   起動
   ------------------------------------------------------------ */
export function initVoice() {
  registerActions({ 'voice:toggle': toggle, 'voice:delete': remove });

  const nameInput = $('voiceAuthorInput');
  if (nameInput && !nameInput.value) nameInput.value = userName || '';

  on('voices', renderVoices);

  // 録音したまま画面を離れても、マイクは止める
  window.addEventListener('pagehide', () => {
    if (recorder && recorder.state === 'recording') recorder.stop();
  });
}
