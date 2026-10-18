#!/usr/bin/env node
/**
 * probe.mjs —— 改代码前先看数。
 *
 * 浪的「尖不尖」「高不高」「会不会翻层」这三件事，肉眼判断的准确率极低：
 * 本片曾为一个「浪峰尖齿」的问题连改 10 轮、方向全错，根因只是漏了 cap 一个参数。
 * 如果把参数算出来的几何量先打印出来，那一轮只需要一次。
 *
 *   node scripts/probe.mjs --layers '[{"y":810,"amp":9,"cap":52,"teeth":18,"seed":420}]'
 *   node scripts/probe.mjs --gap 62 --amp 10 --cap 50 --teeth 15 --seed 421 --y 872
 *   node scripts/probe.mjs --layers "$(cat out/sea.json)" --w 1920
 *
 * 算法逐行抄自 assets/papercut.html 的 rng() 与 scallopPath()，
 * 包括 rng 的调用顺序 —— 顺序错一位，算出来的就不是那条浪了。
 */

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
海面几何探针（改 amp/cap/gap/teeth 之前先跑一次）
  --layers <json>  层数组，每项 {y,amp,cap,teeth,seed}；缺省字段用下面单层参数
  --y --amp --cap --teeth --seed   单层模式
  --gap <px>       层距；不给则由相邻两层的 y 差推出
  --w <px>         画宽（默认 1920，竖屏填 1080）
`);
  process.exit(0);
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/* 与引擎逐字一致：确定性伪随机，同 seed 同序列 */
function rng(seed) {
  let s = (seed | 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; };
}

const W = Number(arg('w', 1920));
let layers = [];
const raw = arg('layers', '');
if (raw) {
  try {
    const j = JSON.parse(raw);
    layers = Array.isArray(j) ? j : [j];
  } catch (e) {
    console.error('[probe] --layers 不是合法 JSON：' + e.message);
    process.exit(1);
  }
} else {
  layers = [{
    y: Number(arg('y', 810)), amp: Number(arg('amp', 10)), cap: Number(arg('cap', 0)) || null,
    teeth: Number(arg('teeth', 15)), seed: Number(arg('seed', 420)),
  }];
}

const FORCE_GAP = Number(arg('gap', 0)) || null;

/** 复刻 scallopPath 的采样：返回每道浪的实际高度（含 cap 软顶） */
function heights(L, w) {
  const r = rng(L.seed);
  const A0 = clamp(L.amp * 6.0, 20, 190);
  const n = L.teeth || Math.max(5, Math.round(w / 165));
  const ws = [];
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = .78 + Math.pow(r(), 1.2) * 1.75; ws.push(v); sum += v; }
  const d0 = w * (.03 + r() * .07);              // 采样从画面外起
  const ph1 = r() * 6.283, ph2 = r() * 6.283, ph3 = r() * 6.283;
  const f1 = .62 + r() * .46, f2 = 1.5 + r() * 1.2;
  const swell = i => {
    const s = .5 + .5 * Math.sin(i * f1 + ph1);
    const t = .5 + .5 * Math.sin(i * f2 + ph2);
    return Math.pow(s, 1.5) * (.45 + .55 * t);
  };
  let x = -d0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const dx = (w + d0) * ws[i] / sum;
    const rawH = A0 * (.10 + swell(i) * 1.28);
    const a = L.cap ? L.cap * Math.tanh(rawH / L.cap) : rawH;
    r();                                          // 浪尖水平抖动（位置，不影响高度）
    x += dx;
    r();                                          // 基线抖动
    out.push({ i, h: a, raw: rawH, dx });
  }
  return { A0, n, arr: out, ph3 };
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 1) => Number(v).toFixed(n);

console.log(`\n画宽 ${W}  |  cap = 层距 × 0.74~0.85 是安全区；浪尖实高 ≤ 层距 × 0.85 才不会翻层\n`);
console.log(pad('层', 3) + pad('y', 7) + pad('层距', 7) + pad('amp', 6) + pad('A0', 6) +
  pad('cap', 6) + pad('实高max', 9) + pad('实高均值', 9) + pad('max/层距', 10) +
  pad('弧宽', 7) + pad('teeth', 7) + '判定');

const notes = [];
layers.forEach((L, k) => {
  const gap = FORCE_GAP || (layers[k + 1] ? Math.abs(layers[k + 1].y - L.y) : null);
  const { A0, n, arr } = heights({ ...L, cap: L.cap || null }, W);
  const hs = arr.map(o => o.h);
  const mx = Math.max(...hs), avg = hs.reduce((a, b) => a + b, 0) / hs.length;
  const arc = W / n;
  const verdict = [];

  if (!L.cap) verdict.push('✗ 没给 cap（A0 全量放出，浪高到层距的 3~4 倍）');
  if (gap) {
    const ratio = Math.max(...arr.map(o => o.raw)) / gap;
    if (mx > gap * .85) verdict.push(`✗ 实高/层距=${num(mx / gap, 2)} > .85，近层浪尖会翻到上层基线`);
    else if (mx > gap * .80) verdict.push(`! 实高/层距=${num(mx / gap, 2)}，贴着上限`);
    if (L.cap && L.cap / gap > .85) verdict.push(`! cap/层距=${num(L.cap / gap, 2)} > .85`);
    if (avg < gap * .18) verdict.push(`! 均值只有层距的 ${num(avg / gap * 100, 0)}%，海会读成一马平川`);
    if (ratio > 4) verdict.push(`✗ raw 峰值到层距的 ${num(ratio, 1)} 倍，cap 在替你兜底——先改 amp`);
  }
  if (n < W / 300) verdict.push(`✗ 一屏只有 ${n} 道弧（< ${Math.round(W / 300)}），会读成土丘`);
  /* 弧装不下浪：浪尖到谷的水平距离约 0.30 弧宽，比浪高还短就一定是尖的。
     判据用均值不用峰值——一片浪里偶尔冒一道高的不算病，整层都高才是。 */
  if (avg > arc * .30) verdict.push(`! 均值浪高 ${num(avg, 0)}px > 峰谷水平距 ${num(arc * .30, 0)}px，几何上装不下圆，会发尖`);

  console.log(pad(k, 3) + pad(num(L.y, 0), 7) + pad(gap ? num(gap, 0) : '-', 7) +
    pad(num(L.amp, 1), 6) + pad(num(A0, 0), 6) + pad(L.cap ? num(L.cap, 0) : '-', 6) +
    pad(num(mx, 0), 9) + pad(num(avg, 0), 9) +
    pad(gap ? num(mx / gap, 2) : '-', 10) + pad(num(arc, 0), 7) + pad(n, 7) +
    (verdict.length ? verdict.join(' ') : 'ok'));
  if (verdict.length) notes.push(`第 ${k} 层：` + verdict.join(' '));
});

if (notes.length) {
  console.log('\n结论：');
  notes.forEach(s => console.log('  ' + s));
  console.log('\n先按上面的数改参数，再看图。改完复跑本脚本，数不对就别截图。');
} else {
  console.log('\n结论：几何全部在安全区。此时图里若还是「不好看」，问题不在浪的参数上，');
  console.log('      去查层数/色差/母题（船、鲸、人）与构图的对照关系，不要在 amp 上继续微调。');
}
