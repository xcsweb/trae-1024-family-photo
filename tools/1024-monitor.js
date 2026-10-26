#!/usr/bin/env node
/*
 * 1024 盖楼 · 实时监控提醒（只监控，不发帖）
 * 话题：https://forum.trae.cn/t/topic/325833
 *
 * 提醒方式（同时触发，确保你不会漏掉）：
 *   1. 声音：Windows 系统提示音连响 6 次 + 中文语音播报（有中文语音才播）
 *   2. 终端：窗口标题改写 + 大字横幅
 *   3. 持续：停在警戒区里每 ALERT_REPEAT_MS 再响一次，直到楼层越过
 *
 * 有效回复怎么判（模板取自活动帖 1 楼原文）：
 *   一条回复要命中下面 5 段标题里的 >= MIN_SECTIONS 段（默认 3，容忍漏写/写错格式）：
 *     #我是1024Builder# / 现在的我： / 自我介绍： /
 *     我和 TRAE 一起做成了： / 未来，我想继续和 TRAE Build：
 *   引用块会被先剔除（防止"引用了模板的灌水楼"被误判）；
 *   官方账号、人工判废黑名单、同账号多条只算最早一条。
 *
 * 用法：
 *   node 1024-monitor.js           开始监控
 *   node 1024-monitor.js --status  看一次当前楼层
 *   node 1024-monitor.js --test    先试一下提醒效果
 *
 * 环境变量：
 *   ALERT_AT         默认 126（=目标楼层-2）：有效楼层到 126 预警、到 127 立刻发
 *   TRIGGER_MODE     valid = 按「有效楼层数」触发（默认，官方按有效回复统计）
 *                    raw   = 按「显示楼层号」触发
 *                    both  = 两个都盯
 *   POLL_MS          常规轮询间隔，默认 1200ms（进警戒区自动提速到 400ms）
 *   ALERT_REPEAT_MS  警戒区内重复提醒间隔，默认 15000ms
 *   NO_SOUND=1       关声音，只留终端横幅
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'https://forum.trae.cn';
const TOPIC_ID = 325833;
const PAGE_SIZE = 20;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const LOG_FILE = path.join(__dirname, '1024-alert.log');

const TARGET = toInt(process.env.TARGET, 128);
const ALERT_AT = toInt(process.env.ALERT_AT, TARGET - 2);
// raw = 只盯显示楼层号 / valid = 只盯有效楼层数 / both = 两个都盯
// 官方按「有效回复」统计楼层，所以默认走 valid
const MODE = ['raw', 'valid', 'both'].includes(process.env.TRIGGER_MODE)
  ? process.env.TRIGGER_MODE
  : 'valid';
const WATCH = MODE === 'both' ? ['raw', 'valid'] : [MODE];
const POLL_MS = toInt(process.env.POLL_MS, 1200);
const ALERT_POLL_MS = Math.min(400, POLL_MS);
const ALERT_REPEAT_MS = toInt(process.env.ALERT_REPEAT_MS, 15000);
const NO_SOUND = process.env.NO_SOUND === '1';

// 官方账号（非参与）
const STAFF = new Set(['TRAE-小阳', 'TRAE_小飞']);
// 已人工核实为无效的楼层号（灌水 / 无关 / 重复 / 系统动作）
const BLACKLIST = new Set([
  2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 16, 19, 20, 21, 22, 24, 25, 28, 30, 31,
  33, 34, 38, 49, 53, 55, 57, 61, 62, 64,
]);
// 官方模板（活动帖 1 楼原文）的 5 个段标题：回复要"复制以下模板并填写"
const SECTIONS = [
  { label: '#我是1024Builder#', re: /#\s*我\s*是\s*1024\s*Builder/i },
  { label: '现在的我：', re: /现在(的)?我\s*[：:]/ },
  { label: '自我介绍：', re: /自我介绍\s*[：:]/ },
  { label: '我和 TRAE 一起做成了：', re: /我和\s*TRAE\s*一起做成了/i },
  { label: '未来，我想继续和 TRAE Build：', re: /未来[，,]?\s*我想继续和\s*TRAE\s*Build/i },
];
// 命中段数达到这个值就算符合官方格式（默认 3，容忍手写时漏段/写错格式）
const MIN_SECTIONS = toInt(process.env.MIN_SECTIONS, 3);

/* ------------------------------------------------------------------ */

function toInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 先剥掉引用块，避免"引用了模板或别人楼层的灌水回复"被误判成有效
function stripHtml(h) {
  return String(h || '')
    .replace(/<aside[^>]*class="[^"]*quote[^"]*"[^>]*>[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
function log(...a) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${a.join(' ')}`;
  console.log(line);
  return line;
}

/** 中文按 2 列宽计算，保证横幅对齐 */
const dispWidth = (s) => [...s].reduce((n, ch) => n + (/[\u1100-\uFFFD]/.test(ch) ? 2 : 1), 0);
function banner(lines) {
  const w = Math.max(...lines.map(dispWidth)) + 2;
  const pad = (s) => s + ' '.repeat(w - dispWidth(s) - 1);
  console.log('╔' + '═'.repeat(w) + '╗');
  for (const s of lines) console.log('║ ' + pad(s) + '║');
  console.log('╚' + '═'.repeat(w) + '╝');
}

/* ------------------------- 声音提醒 ------------------------- */

const TMP = path.join(os.tmpdir(), 'trae-1024-alert');
const PS1 = path.join(TMP, 'alert.ps1');
const MSG = path.join(TMP, 'msg.txt');

function ensureAlertScript() {
  fs.mkdirSync(TMP, { recursive: true });
  const ps = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$msg = (Get-Content -LiteralPath '${MSG.replace(/'/g, "''")}' -Encoding UTF8 -Raw).Trim()`,
    '1..6 | ForEach-Object { [System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 320 }',
    'try {',
    '  Add-Type -AssemblyName System.Speech',
    '  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "  $s.Speak($msg)",
    '} catch {}',
    'Start-Sleep -Milliseconds 400',
    '1..3 | ForEach-Object { [System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 320 }',
  ].join('\r\n');
  // 带 BOM，保证 PowerShell 5 能正确读中文
  fs.writeFileSync(PS1, '\uFEFF' + ps + '\r\n', 'utf8');
}

function playSound(text) {
  process.stdout.write('\x07\x07\x07'); // 终端响铃（终端有开 bell 就能听到）
  if (NO_SOUND) return;
  try {
    fs.writeFileSync(MSG, text + '\n', 'utf8');
    const c = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    c.unref();
  } catch (_) {
    /* 声音失败不影响监控 */
  }
}

/* ------------------------- 拉取 + 判废 ------------------------- */

async function apiJson(url) {
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return res.json();
      lastErr = new Error(`HTTP ${res.status} ${url}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      lastErr = e;
    }
    await sleep(500 * i);
  }
  throw lastErr;
}

/** 增量拉取：只抓「当前最新那一页」及之后的新页 */
class TopicState {
  constructor() {
    this.posts = new Map();
    this.highest = 0;
  }
  async init() {
    const first = await apiJson(`${BASE}/t/${TOPIC_ID}.json?page=1`);
    this.highest = first.highest_post_number || 0;
    const pages = Math.ceil(this.highest / PAGE_SIZE) || 1;
    for (const p of first.post_stream.posts) this.posts.set(p.post_number, p);
    for (let pg = 2; pg <= pages; pg++) {
      const r = await apiJson(`${BASE}/t/${TOPIC_ID}.json?page=${pg}`);
      for (const p of r.post_stream.posts) this.posts.set(p.post_number, p);
      if ((r.highest_post_number || 0) > this.highest) this.highest = r.highest_post_number;
    }
    return this;
  }
  async poll() {
    let pg = Math.floor((this.highest - 1) / PAGE_SIZE) + 1;
    while (true) {
      const r = await apiJson(`${BASE}/t/${TOPIC_ID}.json?page=${pg}`);
      for (const p of r.post_stream.posts) this.posts.set(p.post_number, p);
      const h = r.highest_post_number || this.highest;
      if (h > this.highest) this.highest = h;
      if (pg >= Math.ceil(this.highest / PAGE_SIZE)) break;
      pg++;
    }
    return this.highest;
  }
  /** 命中官方模板的段数 */
  static sectionHits(p) {
    const txt = stripHtml(p.cooked);
    return SECTIONS.filter((s) => s.re.test(txt)).length;
  }
  /** 单楼判定（不含同账号去重） */
  judge(p) {
    if (p.post_number <= 1) return { ok: false, hits: 0, note: '活动帖 1 楼' };
    if (p.post_type !== 1) return { ok: false, hits: 0, note: '系统动作' };
    if (STAFF.has(p.username)) return { ok: false, hits: 0, note: '官方账号' };
    const hits = TopicState.sectionHits(p);
    if (BLACKLIST.has(p.post_number)) return { ok: false, hits, note: `人工判废（命中 ${hits} 段）` };
    if (hits < MIN_SECTIONS) return { ok: false, hits, note: `灌水/无关，只命中 ${hits}/${SECTIONS.length} 段` };
    return { ok: true, hits, note: `符合官方模板，命中 ${hits}/${SECTIONS.length} 段` };
  }
  validNums() {
    // 有效 = 命中官方模板段标题 >= MIN_SECTIONS；同账号多条只留最早一条（官方：每账号仅计 1 次有效参与）
    const seenUser = new Set();
    const out = [];
    for (const p of [...this.posts.values()].sort((a, b) => a.post_number - b.post_number)) {
      if (!this.judge(p).ok) continue;
      if (seenUser.has(p.username)) continue;
      seenUser.add(p.username);
      out.push(p.post_number);
    }
    return out;
  }
}

/* ------------------------- 主流程 ------------------------- */

function fireAlert(modes, c) {
  const urgent = modes.some((m) => c[m] >= ALERT_AT + 1);
  const who = modes.map((m) => `${m === 'raw' ? '显示' : '有效'} ${c[m]}`).join(' / ');
  const mine = modes.includes('raw')
    ? `第 ${Math.max(...modes.map((m) => c[m])) + 1} 楼`
    : `第 ${c.valid + 1} 个有效回复`;
  const text = urgent
    ? `注意，${who}，你发出去就是${mine}，立刻发`
    : `提醒，${who}，下一位就是${mine}，先把回帖内容准备好`;
  process.title = urgent ? `!! ${who} · 立刻发 !!` : `1024 ${who} · 准备发`;
  banner(
    urgent
      ? [`【 立刻发！】${who}`, `你发出去就是${mine} —— 现在就点发送`, `（Ctrl+C 停止监控）`]
      : [`【 预警 】${who}`, `下一位就是${mine} —— 先准备好回帖内容`, `（Ctrl+C 停止监控）`]
  );
  playSound(text);
  fs.appendFileSync(LOG_FILE, log(text) + '\r\n', 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const c = { raw: 0, valid: 0 };

  if (args.includes('--test')) {
    ensureAlertScript();
    log('试一下提醒效果：');
    fireAlert(WATCH, { raw: ALERT_AT + 1, valid: ALERT_AT + 1 });
    return;
  }

  const st = await new TopicState().init();
  const valid = st.validNums();
  c.raw = st.highest;
  c.valid = valid.length;

  if (args.includes('--status')) {
    log(`显示楼层=${c.raw}  有效楼层=${c.valid}  提醒线=${ALERT_AT}  口径=${MODE}`);
    log(`有效楼层号：${valid.join(',')}`);
    const dist = {};
    for (const p of st.posts.values()) {
      if (p.post_number <= 1 || p.post_type !== 1 || STAFF.has(p.username)) continue;
      const h = TopicState.sectionHits(p);
      dist[h] = (dist[h] || 0) + 1;
    }
    log(
      '各楼命中官方模板段数分布：' +
        Object.keys(dist)
          .sort((a, b) => b - a)
          .map((k) => `${k}段=${dist[k]}`)
          .join('  ')
    );
    const last = st.posts.get(st.highest);
    if (last) log(`最新 #${st.highest} ${last.username} → ${st.judge(last).note}`);
    return;
  }

  ensureAlertScript();
  log('监控中（Ctrl+C 停止）');
  log(`显示楼层=${c.raw}  有效楼层=${c.valid}  提醒线=${ALERT_AT}  口径=${MODE}`);

  const lastAlert = { raw: Date.now(), valid: Date.now() };
  for (const m of WATCH) if (c[m] >= ALERT_AT) fireAlert([m], c);

  while (true) {
    const near = WATCH.some((m) => c[m] >= ALERT_AT - 2);
    await sleep(near ? ALERT_POLL_MS : POLL_MS);

    try {
      await st.poll();
    } catch (e) {
      log('拉取失败，重试：' + e.message);
      continue;
    }
    const vn = st.validNums();
    const changed = { raw: st.highest !== c.raw, valid: vn.length !== c.valid };
    c.raw = st.highest;
    c.valid = vn.length;

    if (changed.raw) {
      const newest = st.posts.get(st.highest);
      log(
        `显示楼层=${c.raw}  有效楼层=${c.valid}` +
          (newest ? `  | 最新 #${st.highest} ${newest.username} → ${st.judge(newest).note}` : '')
      );
    }

    // 一次循环只响一次，避免两个口径同时越线时重复打扰
    const need = [];
    let repeat = false;
    for (const m of WATCH) {
      if (c[m] < ALERT_AT) continue;
      if (changed[m]) need.push(m);
      else if (Date.now() - lastAlert[m] > ALERT_REPEAT_MS) repeat = true;
    }
    if (need.length) {
      fireAlert(need, c);
      for (const m of need) lastAlert[m] = Date.now();
    } else if (repeat) {
      fireAlert(WATCH.filter((m) => c[m] >= ALERT_AT), c);
      for (const m of WATCH) lastAlert[m] = Date.now();
    }
  }
}

main().catch((e) => {
  log('出错：' + e.message);
  process.exit(1);
});
