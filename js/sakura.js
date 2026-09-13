// ============================================================
//  背景に舞う花びら
//  以前は花びらの数だけ DOM 要素を作っていたので、端末が熱くなりました。
//  ここでは canvas 1枚に描きます。
//  「動きを減らす」設定の人には出しません。
// ============================================================

const COUNT = 26;
const COLORS = ['rgba(255,183,197,0.85)', 'rgba(255,209,220,0.8)', 'rgba(255,235,238,0.85)'];

let canvas = null;
let ctx = null;
let petals = [];
let frame = null;
let width = 0;
let height = 0;

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function makePetal(atTop) {
  return {
    x: Math.random() * width,
    y: atTop ? -20 - Math.random() * height : Math.random() * height,
    r: 5 + Math.random() * 7,
    speed: 0.4 + Math.random() * 0.9,
    drift: (Math.random() - 0.5) * 0.6,
    angle: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 0.02,
    color: COLORS[Math.floor(Math.random() * COLORS.length)]
  };
}

function drawPetal(p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);
  ctx.fillStyle = p.color;
  ctx.beginPath();
  // 花びら1枚ぶんのふくらみ
  ctx.ellipse(0, 0, p.r, p.r * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function tick() {
  ctx.clearRect(0, 0, width, height);
  for (const p of petals) {
    p.y += p.speed;
    p.x += p.drift + Math.sin(p.y / 55) * 0.4;
    p.angle += p.spin;

    if (p.y - p.r > height) { p.y = -p.r; p.x = Math.random() * width; }
    if (p.x < -20) p.x = width + 20;
    if (p.x > width + 20) p.x = -20;

    drawPetal(p);
  }
  frame = requestAnimationFrame(tick);
}

function start() {
  if (frame) return;
  frame = requestAnimationFrame(tick);
}

function stop() {
  if (!frame) return;
  cancelAnimationFrame(frame);
  frame = null;
}

export function initSakura() {
  canvas = document.getElementById('sakura');
  if (!canvas || !canvas.getContext) return;

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { canvas.style.display = 'none'; return; }

  ctx = canvas.getContext('2d');
  resize();
  petals = Array.from({ length: COUNT }, () => makePetal(false));
  start();

  window.addEventListener('resize', resize);
  // 裏に回っているあいだは描かない（電池のため）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else start();
  });
}
