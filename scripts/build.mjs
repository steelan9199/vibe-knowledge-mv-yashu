#!/usr/bin/env node
/**
 * build.mjs — 把 story.json 装进剪纸引擎，产出单文件 HTML
 *
 * 用法：
 *   node scripts/build.mjs                                    # 用示例分镜
 *   node scripts/build.mjs --story ./story.json               # 指定分镜
 *   node scripts/build.mjs --story ./story.json --out ./out/story.html
 *
 * 为什么要这一步：引擎的 9 个场景原语是固定代码，story.json 只描述
 * 「第几秒到第几秒是什么镜头、唱哪句词」。渲染器只吃单文件 HTML。
 *
 * 关键处理：把 <base href="./"> 换成 assets 目录的绝对 file:// 地址，
 * 否则 HTML 输出到 out/ 之后会加载不到 fonts/（字体静默回退，成片全毁）。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const ENGINE = path.join(ASSETS, 'papercut.html');

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) o[a.slice(2)] = true;
    else { o[a.slice(2)] = v; i++; }
  }
  return o;
}
const args = parseArgs(process.argv);
const storyPath = path.resolve(args.story && args.story !== true
  ? args.story : path.join(ASSETS, 'story.example.json'));
const outPath = path.resolve(args.out && args.out !== true
  ? args.out : path.join(ROOT, 'out', 'story.html'));

if (!existsSync(ENGINE)) { console.error(`[build] 找不到引擎：${ENGINE}`); process.exit(1); }
if (!existsSync(storyPath)) { console.error(`[build] 找不到分镜：${storyPath}`); process.exit(1); }

const STORY = JSON.parse(readFileSync(storyPath, 'utf8'));

/* ---------------- 校验：能在这里拦住的错，不要留到渲染 40 分钟后 ---------------- */
const VALID = ['sail', 'night', 'miss', 'brave', 'dock', 'leave', 'thanks', 'eyes', 'end'];
const errs = [], warns = [];

if (!Array.isArray(STORY.scenes) || !STORY.scenes.length) errs.push('scenes 为空');

let sum = 0;
(STORY.scenes || []).forEach((s, i) => {
  if (!VALID.includes(s.type)) errs.push(`第 ${i + 1} 镜 type="${s.type}" 不在 ${VALID.join('/')}`);
  const d = Number(s.dur);
  if (!(d > 0)) errs.push(`第 ${i + 1} 镜 dur 非法：${s.dur}`);
  else sum += d;
});
if (!(STORY.duration > 0)) warns.push(`未给 duration，按各镜 dur 之和 ${sum.toFixed(2)}s`);
const DUR = Number(STORY.duration) > 0 ? Number(STORY.duration) : sum;
if (Math.abs(DUR - sum) > 0.05) warns.push(`duration(${DUR}) 与各镜之和(${sum.toFixed(2)}) 差 ${(DUR - sum).toFixed(2)}s`);

/* ---------------- 时长与镜数闸口 ----------------
 * 本技能只做 28–62s 的歌曲片段。上限不是审美问题：超过 62s 要么镜数超 14（原语只有 9 种，
 * 必然重复自己），要么单镜拉到 5s 以上（层叠动效一次播完就静止）。下限同理——九镜弧缺环，
 * 色彩剧本从暖暮回不到冷夜，整片读成"只做了一半"。
 * 这两条都要在构建时拦住，不要等 40 分钟渲染完才发现。
 */
const N_SC = (STORY.scenes || []).length;
if (DUR > 62) errs.push(`duration ${DUR.toFixed(1)}s 超过 62s 上限：先切一段 30–60s 再来做`);
if (DUR > 0 && DUR < 27) warns.push(`duration ${DUR.toFixed(1)}s 短于 28s：九镜弧展不开，建议切够 28s 以上`);
if (N_SC < 9) errs.push(`只有 ${N_SC} 镜：九镜弧缺环，色彩剧本会断`);
if (N_SC > 16) errs.push(`${N_SC} 镜超过 16 镜上限：原语只有 9 种，再多就是重复自己`);

/* 变体：同类型连续两镜必须给变体，否则渲染出两张一样的图 */
const VK = ['zoom', 'flip', 'panX', 'panY'];
const hasVar = s => VK.some(k => s[k] != null && s[k] !== false && s[k] !== 0);
(STORY.scenes || []).forEach((s, i) => {
  if (s.zoom != null) {
    const z = Number(s.zoom);
    if (!(z >= 1 && z <= 1.45)) errs.push(`第 ${i + 1} 镜 zoom=${s.zoom} 越界：只能 1–1.45（<1 会露黑边，>1.45 只剩画心 69%）`);
  }
  if (i > 0 && (STORY.scenes[i - 1].type === s.type) && !hasVar(s)) {
    errs.push(`第 ${i}/${i + 1} 镜同为 ${s.type} 且没给变体：会渲染成两张一样的图，加 zoom/flip/panX/panY`);
  }
});

// end 自带淡出，只能收尾
(STORY.scenes || []).forEach((s, i) => {
  if (s.type === 'end' && i !== N_SC - 1) errs.push(`第 ${i + 1} 镜用了 end，但 end 自带淡出，只能做最后一镜`);
});

// 歌词：必须落在时长内，且不要重叠
const LYR = Array.isArray(STORY.lyrics) ? STORY.lyrics : [];
LYR.forEach((L, i) => {
  if (!String(L.text || '').trim()) errs.push(`第 ${i + 1} 句歌词为空`);
  if (!(Number(L.start) >= 0)) errs.push(`第 ${i + 1} 句 start 非法`);
  if (!(Number(L.end) > Number(L.start))) errs.push(`第 ${i + 1} 句 end<=start`);
  if (Number(L.end) > DUR + 0.3) errs.push(`第 ${i + 1} 句 end(${L.end}) 超出时长(${DUR})`);
});
for (let i = 1; i < LYR.length; i++) {
  if (Number(LYR[i].start) < Number(LYR[i - 1].end)) {
    warns.push(`第 ${i} / ${i + 1} 句时间重叠：${LYR[i - 1].end} > ${LYR[i].start}`);
  }
}
if (!LYR.length) warns.push('lyrics 为空，本片将没有字幕');

if (errs.length) {
  console.error('[build] 分镜有错，已阻止构建：');
  errs.forEach(e => console.error('  ✗ ' + e));
  process.exit(1);
}
warns.forEach(w => console.warn('  ! ' + w));
warns.length = 0;

/* ---------------- 拍点体检 ----------------
 * 每镜的 update() 里，动效窗口必须落在这一镜自己的拍数之内。
 * 曾经踩过的坑：第 9 镜只有 3.6 拍，却写了「第 6.4 拍开始淡出」，
 * 结果淡出永远不触发，成片结尾直接硬切。这类错误肉眼要在
 * 40 分钟渲染之后才发现，必须在这里静态拦下。
 */
const BPM = Number(STORY.bpm) || 128;
const BEAT = 60 / BPM;
const FN = { sail: 'scSail', night: 'scNight', miss: 'scMiss', brave: 'scBrave',
  dock: 'scDock', leave: 'scLeave', thanks: 'scThanks', eyes: 'scEyes', end: 'scEnd' };
const engineSrc = readFileSync(ENGINE, 'utf8');

function sceneBody(name) {
  const i = engineSrc.indexOf(`function ${name}(`);
  if (i < 0) return '';
  const rest = engineSrc.slice(i + 10);
  const j = rest.search(/\n(?=function |\/\* )/);
  return j < 0 ? rest : rest.slice(0, j);
}

console.log(`[build] 拍点 ${BPM} BPM，一拍 ${BEAT.toFixed(3)}s`);
console.log('[build]   #  镜头      时长    拍数   动效窗口（写死的数字）');
STORY.scenes.forEach((s, i) => {
  const d = Number(s.dur);
  const nb = d / BEAT;
  const body = sceneBody(FN[s.type] || '');
  const lits = [];
  // prog(b, A, ...) 里的字面量 A：只查写死的数字，at(u) 已经自适应
  for (const m of body.matchAll(/prog\(\s*b\s*,\s*(-?[\d.]+)\s*,/g)) lits.push(Number(m[1]));
  for (const m of body.matchAll(/prog\(\s*b\s*,\s*-?[\d.]+\s*,\s*(-?[\d.]+)\s*\)/g)) lits.push(Number(m[1]));
  const over = lits.filter(v => v > nb + 0.15);
  const flag = over.length ? `  ⚠ 超出 ${nb.toFixed(2)} 拍：${over.join(', ')}` : '';
  console.log(`[build]  ${String(i + 1).padStart(2)}  ${s.type.padEnd(7)} ${d.toFixed(2).padStart(6)}s ${nb.toFixed(2).padStart(6)}${flag}`);
  if (nb < 1.5) warns.push(`第 ${i + 1} 镜只有 ${nb.toFixed(2)} 拍，动效来不及播，建议 dur ≥ ${(BEAT * 2).toFixed(2)}s`);
  if (over.length) warns.push(`第 ${i + 1} 镜(${s.type}) 有窗口写到第 ${Math.max(...over)} 拍，超出本镜 ${nb.toFixed(2)} 拍 → 该动效不会播完`);
});
if (warns.length) {
  console.warn('[build] 需要注意：');
  warns.forEach(w => console.warn('  ! ' + w));
}

/* ---------------- 注入 ---------------- */
let html = readFileSync(ENGINE, 'utf8');

// 字体路径：固定指向 assets，与输出位置无关
const assetsURL = pathToFileURL(ASSETS + path.sep).href;
html = html.replace('<base href="./">', `<base href="${assetsURL}">`);

// JSON 中不能出现 </script>，否则脚本块被提前闭合
const payload = JSON.stringify(STORY).replace(/<\/script/gi, '<\\/script');
const MARK = '/*__STORY__*/null/*__STORY__*/';
if (!html.includes(MARK)) {
  console.error('[build] 引擎里找不到 story 注入标记，说明 papercut.html 被改坏了');
  process.exit(1);
}
html = html.replace(MARK, payload);

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
const avg = (DUR / N_SC).toFixed(2);
const want = Math.max(9, Math.min(16, Math.round(DUR / 3.4)));
console.log(`[build] OK  ${LYR.length} 句词 / ${N_SC} 镜 / ${DUR.toFixed(2)}s / 平均 ${avg}s 每镜（建议 ${want} 镜）`);
if (Math.abs(want - N_SC) >= 2) {
  console.log(`[build] 提示：${DUR.toFixed(1)}s 配 ${N_SC} 镜平均 ${avg}s，${avg > 4.2 ? '单镜偏长，动效播完会静止' : '单镜偏短，层叠来不及展开'}`);
}
console.log(`[build] 输出 ${outPath}  (${kb} KB)`);
console.log(`[build] 渲染：node scripts/render.mjs --html "${outPath}" --aspect wide --fps ${STORY.fps || 30} --duration ${DUR.toFixed(2)}`);
