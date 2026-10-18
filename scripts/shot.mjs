#!/usr/bin/env node
/**
 * 单帧探针 —— 排查美术问题专用，比视频管线快一个数量级。
 *
 *   node scripts/shot.mjs --html out/story.html --t 0.37 --out out/a.png
 *   node scripts/shot.mjs --html out/story.html --t 0.37 --crop 0,790,960,230 --out out/sea.png
 *   node scripts/shot.mjs --html out/story.html --t 0.37 --scale 0.5 --out out/half.png
 *   node scripts/shot.mjs --html out/story.html --t 0.37 --hide grain,fiber,.crowd --out out/b.png
 *
 * 为什么要有 --crop / --scale：一张 1920×1080 进上下文约 1.5k token，而且从读入那一轮起
 * 之后每轮都要重发。480×270 的局部只要 ~170 token。改局部就只看局部，全幅只在「整镜构图」看一次。
 *
 * 依赖页面支持两个调试参数（papercut.html 已内置）：
 *   ?t=<0..1>      定格到归一化时刻（全片归一化，不是镜内进度！）
 *   ?hide=a,b,.c   id 或 CSS 选择器（.crowd / [data-paper]），逐个关闭用于二分定位
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const has = k => argv.includes('--' + k);

if (has('help') || has('h')) {
  console.log(`
单帧探针
  --html <file>        必填，story.html
  --t <0..1>           全片归一化时刻（默认 0）
  --crop x,y,w,h       裁真实像素区域后再出图（强烈建议：局部问题只看局部）
  --scale <k>          缩放倍数。0.5 = 半幅（~690tok）；2 = 整数倍放大查 1:1 细节
  --hide <列表>        逗号分隔，支持 id(grain) 与选择器(.crowd / [data-paper])
  --out <file>         输出 png（默认 out/shot.png）
  --ffmpeg <path>      ffmpeg 路径（默认 PATH 里的 ffmpeg）
`);
  process.exit(0);
}

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

const fail = m => { console.error('\n[shot] ' + m + '\n'); process.exit(1); };

const html = arg('html');
if (!html) fail('缺少 --html');
if (!existsSync(html)) fail('找不到文件：' + html);

const browser = arg('browser') || EDGE.find(p => existsSync(p));
if (!browser) fail('找不到 Edge / Chrome');

const t = arg('t', '0');
const hide = arg('hide', '');
const out = path.resolve(arg('out', 'out/shot.png'));
mkdirSync(path.dirname(out), { recursive: true });

const crop = arg('crop', '');
const scale = arg('scale', '');
const FFMPEG = arg('ffmpeg', 'ffmpeg');

/* 出图后的处理链：crop → scale。放 ffmpeg 里做，不动引擎，不动布局 */
const post = [];
if (crop) {
  const p = crop.split(',').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isFinite(n))) fail('--crop 要写成 x,y,w,h（真实像素）');
  post.push(`crop=${p[2]}:${p[3]}:${p[0]}:${p[1]}`);
}
if (scale) {
  const k = Number(scale);
  if (!Number.isFinite(k) || k <= 0) fail('--scale 要是正数');
  // 放大查细节时用 neighbor 保住纸的硬边；缩小时用 lanczos 免得细线糊掉
  post.push(`scale=trunc(iw*${k}):trunc(ih*${k}):flags=${k > 1 ? 'neighbor' : 'lanczos'}`);
}

const url = 'file:///' + path.resolve(html).replace(/\\/g, '/') +
  '?t=' + encodeURIComponent(t) + (hide ? '&hide=' + encodeURIComponent(hide) : '');

const raw = post.length ? out.replace(/\.png$/i, '') + '.raw.png' : out;
const t0 = Date.now();
const r = spawnSync(browser, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1920,1080',
  '--virtual-time-budget=6000',
  '--screenshot=' + raw,
  url,
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 40000 });

if (!existsSync(raw)) {
  console.error(r.stderr?.toString().slice(0, 800) || '');
  fail('截图未生成');
}

if (post.length) {
  const f = spawnSync(FFMPEG, ['-y', '-i', raw, '-vf', post.join(','), out],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  rmSync(raw, { force: true });
  if (!existsSync(out)) {
    console.error(f.stderr?.toString().slice(0, 600) || '');
    fail('ffmpeg 后处理失败：' + post.join(','));
  }
}

/* 把「这张图值多少 token」直接打出来——读之前就知道贵不贵 */
const size = statSync(out).size;
const d = readFileSync(out);            // PNG 头固定：宽高在 IHDR 的 16/20 字节偏移
const w = d.length > 24 ? d.readUInt32BE(16) : 0;
const h = d.length > 24 ? d.readUInt32BE(20) : 0;
const tok = Math.min(1600, Math.ceil(w * h / 750));
const base = Math.min(1600, Math.ceil(1920 * 1080 / 750));
console.log(`ok  ${out}  ${(Date.now() - t0)}ms  ${w}×${h}  ${(size / 1024).toFixed(0)}KB  ~${tok}tok` +
  (tok < base ? `  (整帧 ~${base}tok，省 ${(100 - tok / base * 100).toFixed(0)}%)` : '') +
  `  t=${t}` + (hide ? `  hide=${hide}` : ''));
if (!post.length) console.log('提示：整帧进上下文很贵。改局部请加 --crop x,y,w,h；看整镜构图加 --scale 0.5');
