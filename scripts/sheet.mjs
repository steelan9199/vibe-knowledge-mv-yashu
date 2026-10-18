#!/usr/bin/env node
/**
 * 九宫格检查版 —— 一次把整片的关键帧铺在一张图上，用来看「镜头之间顺不顺」。
 *
 *   node scripts/sheet.mjs --html out/story.html                    # 自动按分镜中点取九帧
 *   node scripts/sheet.mjs --html out/story.html --frames 0.05,0.2,0.5 --cols 3
 *   node scripts/sheet.mjs --html out/story.html --hide grain,fiber,lyric
 *
 * 为什么不一张一张看：镜头之间的色彩连贯、景深骨架、字幕落位，
 * 只有并排放在一起才看得出来。单帧永远是对的，连起来才叫片子。
 *
 * 拼图交给 ffmpeg，不自己算像素（Pillow 在这个沙箱里写不了文件）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const html = path.resolve(arg('html', path.join(ROOT, 'out', 'story.html')));
const storyPath = path.resolve(arg('story', path.join(ROOT, 'assets', 'story.example.json')));
const hide = arg('hide', 'grain,fiber');   // 检查版默认关掉颗粒，免得看不到色阶
const out = path.resolve(arg('out', path.join(ROOT, 'out', 'sheet.png')));
const FFMPEG = arg('ffmpeg', 'ffmpeg');

if (!existsSync(html)) { console.error('[sheet] 找不到 ' + html); process.exit(1); }

/* 关键帧：默认取每镜的中点。分镜里只写了 dur，start 要累加 */
let times = [];
const fr = arg('frames', '');
if (fr) {
  times = fr.split(',').map(Number);
} else {
  const ST = JSON.parse(readFileSync(storyPath, 'utf8'));
  const DUR = Number(ST.duration) || ST.scenes.reduce((a, s) => a + Number(s.dur), 0);
  let acc = 0;
  for (const s of ST.scenes) {
    times.push((acc + Number(s.dur) * Number(arg('at', 0.5))) / DUR);
    acc += Number(s.dur);
  }
}
times = times.map(v => Math.max(0, Math.min(1, v)));

const cols = Number(arg('cols', 3));
const rows = Math.ceil(times.length / cols);
const tmp = path.join(ROOT, 'out', '_sheet');
mkdirSync(tmp, { recursive: true });

const shot = path.join(ROOT, 'scripts', 'shot.mjs');
let ok = 0;
times.forEach((t, i) => {
  const f = path.join(tmp, `f${String(i).padStart(2, '0')}.png`);
  const r = spawnSync(process.execPath, [shot, '--html', html, '--t', t.toFixed(4),
    '--hide', hide, '--out', f], { stdio: 'ignore', timeout: 60000 });
  if (r.status === 0 && existsSync(f)) ok++;
  else console.error(`[sheet] 第 ${i + 1} 帧失败 t=${t.toFixed(4)}`);
});
if (!ok) { console.error('[sheet] 一帧都没出来'); process.exit(1); }

const tile = `scale=640:360,tile=${cols}x${rows}:padding=6:color=0x0a0a0c`;
const r = spawnSync(FFMPEG, ['-y', '-start_number', '0', '-i', path.join(tmp, 'f%02d.png'),
  '-filter_complex', tile, '-frames:v', '1', out],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
if (!existsSync(out)) {
  console.error(r.stderr?.toString().slice(0, 900) || '[sheet] ffmpeg 没产出');
  process.exit(1);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`[sheet] ${ok}/${times.length} 帧 → ${out}`);
