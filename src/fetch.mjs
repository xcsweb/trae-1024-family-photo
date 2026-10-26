/**
 * 抓取 TRAE 论坛公开数据，为「社区 1024 合影」生成 data.js
 *
 * 数据来源优先级：
 *   1. 玩法一盖楼帖 (topic 325833) 的全部回帖者
 *   2. 玩法二「1024Builder作品秀」标签下所有作品帖的回帖者
 *   3. 用户目录按发帖数排序（即"经常发消息的"活跃用户）
 *   4. 全站热门帖的参与者（兜底补人）
 *
 * 用法：
 *   node fetch.mjs                 # 默认 96px 头像，最多 600 人
 *   node fetch.mjs --size=120 --max=800 --delay=80
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_JS = path.join(__dirname, 'data.js');
const CACHE_DIR = path.join(__dirname, '.avatar-cache');

const BASE = 'https://forum.trae.cn';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TOPIC_PLAY1 = 325833;
const TAG_PLAY2 = ['109-tag/109', encodeURIComponent('1024Builder作品秀')];

const argv = process.argv.slice(2);
const opt = (key, def) => {
  const hit = argv.find((a) => a === `--${key}` || a.startsWith(`--${key}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? 'true' : hit.slice(eq + 1);
};

const AVATAR_SIZE = Number(opt('size', 96));
const MAX_USERS = Number(opt('max', 600));
const DELAY = Number(opt('delay', 70));
const ACTIVE_MIN_POSTS = Number(opt('min-posts', 3));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[fetch]', ...a);

/** 带重试的 JSON 请求；4xx 直接返回 null 不重试 */
async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (res.status === 422 && i < tries - 1) {
        log(`限流 422，退避重试 ${url}`);
        await sleep(2500 * (i + 1));
        continue;
      }
      if (res.status >= 400 && res.status < 500) {
        log(`skip ${res.status} ${url}`);
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) {
        log(`fail ${url} :: ${e.message}`);
        return null;
      }
      await sleep(500 * (i + 1));
    }
  }
  return null;
}

/** 归一化一条用户记录 */
function makeUser(username, displayName, title, postCount, avatarTemplate, source) {
  if (!username || !avatarTemplate) return null;
  return {
    username,
    name: (displayName || '').trim() || username,
    title: (title || '').trim(),
    postCount: Number.isFinite(postCount) ? postCount : null,
    avatarTemplate,
    source,
  };
}

/* ---------------- 来源 1：玩法一盖楼帖 ---------------- */

async function fetchTopicPosts(topicId) {
  const first = await getJSON(`${BASE}/t/${topicId}.json`);
  if (!first?.post_stream) return [];
  const stream = first.post_stream.stream || [];
  const posts = [...(first.post_stream.posts || [])];
  const have = new Set(posts.map((p) => p.id));
  const missing = stream.filter((id) => !have.has(id));

  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const qs = chunk.map((id) => `post_ids[]=${id}`).join('&');
    const j = await getJSON(`${BASE}/t/${topicId}/posts.json?${qs}`);
    if (j?.post_stream?.posts) posts.push(...j.post_stream.posts);
    await sleep(DELAY);
  }
  return posts;
}

async function sourcePlay1() {
  const posts = await fetchTopicPosts(TOPIC_PLAY1);
  log(`玩法一帖  取到 ${posts.length} 条回帖`);
  const out = [];
  for (const p of posts) {
    const u = makeUser(
      p.username,
      p.name,
      p.user_title,
      null, // play1 回帖不单独提供发帖数，由 active 来源合并补齐
      p.avatar_template,
      'play1'
    );
    if (u) out.push(u);
  }
  return out;
}

/* ---------------- 来源 2：玩法二作品帖 ---------------- */

async function sourcePlay2() {
  let topics = [];
  for (const slug of TAG_PLAY2) {
    const j = await getJSON(`${BASE}/tag/${slug}.json`);
    const list = j?.topic_list?.topics;
    if (list?.length) {
      topics = list;
      log(`玩法二标签 ${slug} 找到 ${list.length} 个作品帖`);
      break;
    }
  }
  if (!topics.length) {
    log('玩法二标签暂无可读数据（可能还没有人发作品帖）');
    return [];
  }

  const out = [];
  for (const t of topics.slice(0, 30)) {
    const posts = await fetchTopicPosts(t.id);
    for (const p of posts) {
      const u = makeUser(p.username, p.name, p.user_title, null, p.avatar_template, 'play2');
      if (u) out.push(u);
    }
    await sleep(DELAY);
  }
  log(`玩法二作品帖共取到 ${out.length} 条回帖`);
  return out;
}

/* ---------------- 来源 3：用户目录（按发帖数） ---------------- */

async function sourceDirectory(maxPages = 12) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const j = await getJSON(
      `${BASE}/directory_items.json?period=all&order=post_count&page=${page}`
    );
    const items = j?.directory_items;
    if (!items?.length) break;
    for (const it of items) {
      const user = it.user || {};
      const posts = it.post_count ?? user.post_count;
      if (posts != null && posts < ACTIVE_MIN_POSTS) continue;
      const u = makeUser(
        user.username,
        user.name,
        user.user_title || user.title,
        posts,
        user.avatar_template,
        'active'
      );
      if (u) out.push(u);
    }
    await sleep(DELAY);
  }
  log(`用户目录取到 ${out.length} 位活跃用户`);
  return out;
}

/* ---------------- 来源 4：全站热门帖参与者 ---------------- */

async function sourceHotTopics(limit = 40) {
  const list = await getJSON(`${BASE}/top.json?period=all`);
  const topics = list?.topic_list?.topics || [];
  const out = [];
  for (const t of topics.slice(0, limit)) {
    const j = await getJSON(`${BASE}/t/${t.id}.json`);
    const ps = j?.details?.participants || [];
    for (const p of ps) {
      const u = makeUser(
        p.username,
        p.name,
        p.primary_group_name,
        p.post_count,
        p.avatar_template,
        'hot'
      );
      if (u) out.push(u);
    }
    await sleep(DELAY);
  }
  log(`热门帖参与者取到 ${out.length} 条`);
  return out;
}

/* ---------------- 头像下载 + 本地缓存 ---------------- */

async function loadAvatar(template) {
  const rel = template.replace('{size}', String(AVATAR_SIZE));
  const url = rel.startsWith('http') ? rel : BASE + rel;
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const bin = path.join(CACHE_DIR, `${key}.bin`);
  const meta = path.join(CACHE_DIR, `${key}.json`);

  try {
    const [buf, m] = await Promise.all([fs.readFile(bin), fs.readFile(meta, 'utf8')]);
    return { dataUrl: `data:${JSON.parse(m).mime};base64,${buf.toString('base64')}` };
  } catch {
    /* 未命中缓存，走网络 */
  }

  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: `${BASE}/` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mime = (res.headers.get('content-type') || 'image/png').split(';')[0];
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(bin, buf);
      await fs.writeFile(meta, JSON.stringify({ mime, url }));
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
    } catch (e) {
      if (i === 2) {
        log(`头像失败 ${url} :: ${e.message}`);
        return null;
      }
      await sleep(400 * (i + 1));
    }
  }
  return null;
}

/* ---------------- 重档：每人近期主题帖（标题 / 赞 / 回复） ---------------- */

const TOPIC_CACHE_DIR = path.join(__dirname, '.topic-cache');
const TAG_PLAY2_SLUG = '109-tag';

/** 从一位用户创建的帖子里挑出 2~3 条最有代表性的，供「TA 做了什么」展示 */
function pickTopics(list) {
  if (!list || !list.length) return [];
  const withKind = list.map((t) => ({
    t: t.t,
    l: t.l | 0,
    r: t.r | 0,
    k: (t.g || []).indexOf(TAG_PLAY2_SLUG) >= 0 ? 'play2' : 'topic',
    i: t.i,
  }));
  // 参赛作品优先，其余按发布时间倒序（列表本身已是倒序）
  const play2 = withKind.filter((x) => x.k === 'play2');
  const rest = withKind.filter((x) => x.k !== 'play2');
  const out = [...play2, ...rest].slice(0, play2.length ? 3 : 2);
  // 太长的标题截断，控制 data.js 体积
  return out.map((x) => ({
    t: x.t.length > 42 ? x.t.slice(0, 42) + '…' : x.t,
    l: x.l, r: x.r, k: x.k, i: x.i,
  }));
}

async function loadUserTopics(username) {
  const key = crypto.createHash('sha1').update(username).digest('hex').slice(0, 16);
  const file = path.join(TOPIC_CACHE_DIR, `${key}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    /* 未命中，走网络 */
  }
  const j = await getJSON(`${BASE}/topics/created-by/${encodeURIComponent(username)}.json`);
  if (!j) return null;                    // 网络/限流失败：null 表示"没抓到"，与"确实没发帖"区分
  const list = (j.topic_list?.topics || []).map((t) => ({
    i: t.id,
    t: t.title || '',
    l: t.like_count,
    r: t.posts_count,
    g: (t.tags || []).map((x) => x.slug),
  }));
  await fs.mkdir(TOPIC_CACHE_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(list));
  return list;
}

/** 重档模式：读现有 data.js，补齐每个人的 w 字段后写回（头像下载全部命中缓存，很快） */
async function enrich() {
  log('重档模式：为每位 Builder 抓取近期主题帖');
  const raw = await fs.readFile(OUT_JS, 'utf8');
  const payload = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const users = payload.users;

  let i = 0, got = 0, empty = 0, fail = 0, cached = 0;
  for (const u of users) {
    i++;
    const key = crypto.createHash('sha1').update(u.u).digest('hex').slice(0, 16);
    const hitCache = await fs
      .access(path.join(TOPIC_CACHE_DIR, `${key}.json`))
      .then(() => true)
      .catch(() => false);
    if (hitCache) cached++;

    const list = await loadUserTopics(u.u);
    if (list === null) {
      fail++;
      u.w = null;                          // null = 抓取失败，前端走轻档兜底
    } else {
      u.w = pickTopics(list);
      if (u.w.length) got++; else empty++;
    }
    if (!hitCache) await sleep(DELAY);
    if (i % 25 === 0) {
      log(`进度 ${i}/${users.length} · 有帖 ${got} · 无帖 ${empty} · 失败 ${fail}`);
    }
    // 失败率过高就收手，避免被限流锁死
    if (i >= 60 && fail / i > 0.5) {
      log('失败率过高，提前结束重档抓取，剩余用户走轻档兜底');
      break;
    }
  }

  payload.enrichedAt = new Date().toISOString();
  const js = `/* 由 fetch.mjs 自动生成，请勿手改 · ${payload.generatedAt} · 重档 ${payload.enrichedAt} */\nwindow.__COMMUNITY_PHOTO__ = ${JSON.stringify(
    payload
  )};\n`;
  await fs.writeFile(OUT_JS, js, 'utf8');
  const mb = (Buffer.byteLength(js) / 1024 / 1024).toFixed(2);
  log(`重档完成：有帖 ${got} · 无帖 ${empty} · 失败 ${fail} · 缓存命中 ${cached} · data.js ${mb} MB`);
}

/** 真实上传头像：avatar_template 指向 /user_avatar/... 路径；letter_avatar（默认字母头像）不含该路径 */
const hasRealAvatar = (u) => (u.avatarTemplate || '').includes('/user_avatar/');

/* ---------------- 主流程 ---------------- */

async function main() {
  if (opt('enrich', 'false') === 'true') { await enrich(); return; }
  log(`开始抓取 · 头像尺寸 ${AVATAR_SIZE}px · 上限 ${MAX_USERS} 人`);

  const [play1, play2, directory, hot] = [
    await sourcePlay1(),
    await sourcePlay2(),
    await sourceDirectory(),
    await sourceHotTopics(),
  ];

  const merged = [];
  const seen = new Set();
  const pushAll = (arr) => {
    for (const u of arr) {
      const k = u.username.toLowerCase();
      if (seen.has(k)) {
        const prev = merged.find((m) => m.username.toLowerCase() === k);
        if (prev) {
          if (prev.postCount == null && u.postCount != null) prev.postCount = u.postCount;
          if (!prev.title && u.title) prev.title = u.title;
        }
        continue;
      }
      seen.add(k);
      merged.push(u);
    }
  };

  // 按优先级合并：玩法一 → 玩法二 → 活跃用户 → 热门帖
  pushAll(play1);
  pushAll(play2);
  pushAll(directory);
  pushAll(hot);

  log(`去重后共 ${merged.length} 位用户`);

  // 超出上限时优先保留玩法一/玩法二；其余来源（活跃用户、热门帖）里先取有真实上传头像者
  // （组内仍按发帖数降序，与原排序一致），不足 600 人再用字母头像用户按发帖数补足
  let picked = merged;
  if (merged.length > MAX_USERS) {
    const priority = merged.filter((u) => u.source === 'play1' || u.source === 'play2');
    const rest = merged.filter((u) => u.source !== 'play1' && u.source !== 'play2');
    const byPosts = (a, b) => (b.postCount ?? -1) - (a.postCount ?? -1);
    const realAvatar = rest.filter((u) => hasRealAvatar(u)).sort(byPosts);
    const letterAvatar = rest.filter((u) => !hasRealAvatar(u)).sort(byPosts);
    picked = [...priority, ...realAvatar, ...letterAvatar].slice(0, MAX_USERS);
    log(`按上限截断为 ${picked.length} 位（真实头像优先）`);
  }

  const users = [];
  let done = 0;
  for (const u of picked) {
    const av = await loadAvatar(u.avatarTemplate);
    done++;
    if (done % 25 === 0) log(`下载头像 ${done}/${picked.length}`);
    if (!av) continue;
    users.push({
      u: u.username,
      n: u.name,
      t: u.title || '',
      p: u.postCount,
      s: u.source,
      a: av.dataUrl,
    });
    await sleep(DELAY);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    avatarSize: AVATAR_SIZE,
    source: `${BASE}/t/${TOPIC_PLAY1}`,
    tag: '1024Builder作品秀',
    users,
  };

  const js = `/* 由 fetch.mjs 自动生成，请勿手改 · ${payload.generatedAt} */\nwindow.__COMMUNITY_PHOTO__ = ${JSON.stringify(
    payload
  )};\n`;
  await fs.writeFile(OUT_JS, js, 'utf8');

  const mb = (Buffer.byteLength(js) / 1024 / 1024).toFixed(2);
  log(`完成：${users.length} 位 Builder 入镜，data.js 体积 ${mb} MB`);
}

main().catch((e) => {
  console.error('[fetch] 中断：', e);
  process.exit(1);
});
