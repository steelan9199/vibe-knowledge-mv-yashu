#!/usr/bin/env node
/**
 * tok.mjs —— 一条片子的 token 账单。
 *
 *   node scripts/tok.mjs                    # 默认取本项目最近一次会话
 *   node scripts/tok.mjs <sessionId>        # 只写 id 也行
 *   node scripts/tok.mjs <路径.jsonl>
 *   node scripts/tok.mjs --compare <a> <b>  # 两条会话并排比
 *
 * 说明（踩过一次，记下来）：
 *  - 每次请求的真实用量藏在 `providerData.rawUsage` 里，function_call / message / model-usage
 *    三种记录都带，同一次请求会重复出现 —— 必须按 messageId 去重，否则算出来翻倍。
 *  - 图片**不落盘**：转录里读图的结果只剩文字位，所以「读了几张图、多大」量不到。
 *    图片成本只能靠纪律控制（shot.mjs --crop / --scale）。
 *  - 转录在压缩轮转时会裁剪，早期记录可能已丢；基线要用一整条新片子来测。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`
token 账单
  node scripts/tok.mjs [sessionId 或 .jsonl 路径]
  node scripts/tok.mjs --compare <a> <b>
不给参数 = 本项目最近修改的那个 jsonl。
`);
  process.exit(0);
}

const PROJ = path.join(os.homedir(), '.workbuddy', 'projects');
function newestJsonl() {
  if (!existsSync(PROJ)) throw new Error('找不到转录目录 ' + PROJ);
  let best = null;
  for (const d of readdirSync(PROJ)) {
    const dir = path.join(PROJ, d);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      const m = statSync(p).mtimeMs;
      if (!best || m > best.m) best = { m, p };
    }
  }
  return best && best.p;
}

function resolve(spec) {
  if (!spec) return newestJsonl();
  if (existsSync(spec)) return path.resolve(spec);
  const cand = path.join(PROJ, 'd-software-workBuddyWorkspace', spec.replace(/\.jsonl$/, '') + '.jsonl');
  if (existsSync(cand)) return cand;
  throw new Error('找不到会话：' + spec);
}

function audit(file) {
  const used = new Map();          // messageId → rawUsage（去重）
  const ret = new Map();           // 工具名 → {n, bytes}
  const call = new Map();
  const big = [];
  let lines = 0, bytes = 0;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    lines++; bytes += line.length;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const pd = rec.providerData || {};
    const u = pd.rawUsage;
    if (u && pd.messageId && !used.has(pd.messageId)) used.set(pd.messageId, u);

    if (rec.type === 'function_call') {
      const e = call.get(rec.name) || { n: 0, bytes: 0 };
      e.n++; e.bytes += JSON.stringify(pd.arguments ?? rec.arguments ?? '').length;
      call.set(rec.name, e);
    }
    if (rec.type === 'function_call_result') {
      const b = JSON.stringify(rec.output ?? '').length;
      const e = ret.get(rec.name) || { n: 0, bytes: 0 };
      e.n++; e.bytes += b;
      ret.set(rec.name, e);
      big.push({ name: rec.name, b });
    }
  }

  let pin = 0, pout = 0, preas = 0, phit = 0, pmiss = 0;
  for (const u of used.values()) {
    pin += u.prompt_tokens || 0;
    pout += u.completion_tokens || 0;
    preas += u.completion_tokens_details?.reasoning_tokens || 0;
    phit += u.prompt_cache_hit_tokens || 0;
    pmiss += u.prompt_cache_miss_tokens || 0;
  }
  const retBytes = [...ret.values()].reduce((a, e) => a + e.bytes, 0);
  const callBytes = [...call.values()].reduce((a, e) => a + e.bytes, 0);
  big.sort((a, b) => b.b - a.b);
  return { file, lines, bytes, req: used.size, pin, pout, preas, phit, pmiss,
    ret, call, retBytes, callBytes, big };
}

const fmt = n => n.toLocaleString('en-US');
const k = n => (n / 1024).toFixed(0) + 'KB';

function report(a) {
  console.log(`\n会话  ${path.basename(a.file)}   (${(a.bytes / 1024 / 1024).toFixed(2)}MB / ${a.lines} 条)`);
  console.log(`请求  ${a.req} 次`);
  if (!a.req) console.log('  ⚠ 没有 usage 记录（会话太旧或刚开），只能看下面的体积账');
  console.log(`输入  ${fmt(a.pin)}  tok   其中缓存命中 ${a.phit ? (a.phit / Math.max(1, a.pin) * 100).toFixed(1) + '%' : '-'}`);
  console.log(`输出  ${fmt(a.pout)}  tok   其中思考 ${fmt(a.preas)} (${a.pout ? (a.preas / a.pout * 100).toFixed(0) : 0}%)`);
  console.log(`合计  ${fmt(a.pin + a.pout)}  tok`);
  console.log(`\n工具返回  ${k(a.retBytes)} ≈ ${fmt(Math.round(a.retBytes / 3))} tok（中文按 3 字节/tok 估）`);
  const rows = [...a.ret.entries()].sort((x, y) => y[1].bytes - x[1].bytes).slice(0, 8);
  for (const [name, e] of rows) {
    console.log(`  ${name.padEnd(12)} ${String(e.n).padStart(3)} 次  ${k(e.bytes).padStart(7)}` +
      `  ${(e.bytes / a.retBytes * 100).toFixed(0).padStart(3)}%`);
  }
  console.log(`工具入参  ${k(a.callBytes)}` + (a.callBytes > a.retBytes * .6 ? '   ← 入参比返回还重，Edit/Write 的大段文本要收着写' : ''));
  if (a.big.length) {
    console.log('最大返回  ' + a.big.slice(0, 5).map(x => `${x.name} ${k(x.b)}`).join(' / '));
  }
  console.log('');
}

const ci = argv.indexOf('--compare');
if (ci >= 0) {
  const A = audit(resolve(argv[ci + 1]));
  const B = audit(resolve(argv[ci + 2]));
  report(A); report(B);
  if (A.pin + A.pout > 0 && B.pin + B.pout > 0) {
    const ta = A.pin + A.pout, tb = B.pin + B.pout;
    console.log(`对比  ${fmt(ta)} → ${fmt(tb)}   ${((tb - ta) / ta * 100).toFixed(1)}%` +
      (tb < ta * .6 ? '   ✓ 达标（目标：降 40% 以上）' : '   ✗ 未达标'));
  }
} else {
  report(audit(resolve(argv.find(a => !a.startsWith('--')))));
}
