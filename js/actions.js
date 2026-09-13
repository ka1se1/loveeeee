// ============================================================
//  クリックの受け口をひとつにまとめる
//
//  以前は生成したHTMLの中に onclick="..." が99箇所ありました。
//  文字列でコードを書くと、名前の取り違えに気づけず、
//  データがそのままコードとして走る危険もあります。
//
//  ここでは document で1回だけ受けて、data-action の名前で振り分けます。
//    <button data-action="shop:save">保存</button>
//    <button data-action="photo:delete" data-arg="123">削除</button>
//    <input  data-action-change="photo:upload">
//
//  data-stop が付いた要素より上には、クリックを伝えません。
//  （写真ビューアの黒い背景を押したら閉じる、画像を押しても閉じない、という形）
// ============================================================
import { showError } from './util.js';

const handlers = new Map();

/** 使える動作を登録する。あとから上書きもできる */
export function registerActions(map) {
  for (const [name, fn] of Object.entries(map)) {
    if (typeof fn !== 'function') continue;
    handlers.set(name, fn);
  }
}

function run(name, arg, event, node) {
  const fn = handlers.get(name);
  if (!fn) {
    // 登録忘れは黙って無視せず、コンソールに残す
    console.warn('未登録の動作です:', name);
    return;
  }
  let result;
  try {
    result = fn(arg, event, node);
  } catch (e) {
    showError('うまく動きませんでした', e);
    return;
  }
  if (result && typeof result.catch === 'function') {
    result.catch(e => showError('うまく動きませんでした', e));
  }
}

function onClick(event) {
  // data-action か data-stop の、いちばん近いほうを見る
  const node = event.target.closest('[data-action],[data-stop]');
  if (!node) return;
  const name = node.dataset.action;
  if (!name) return;            // data-stop だけ → ここで止める
  run(name, node.dataset.arg, event, node);
}

function onChange(event) {
  const node = event.target.closest('[data-action-change]');
  if (!node) return;
  run(node.dataset.actionChange, node.dataset.arg, event, node);
}

let started = false;

export function initActions() {
  if (started) return;
  started = true;
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
}
