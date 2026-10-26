/**
 * 把 index.html + data.js 合并成一个可分发的单文件 HTML
 * 用法：node build-single.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'index.html');
const dataPath = path.join(__dirname, 'data.js');
const outPath = path.join(__dirname, 'TRAE社区1024全家福.html');

const [html, data] = await Promise.all([
  fs.readFile(htmlPath, 'utf8'),
  fs.readFile(dataPath, 'utf8'),
]);

const tag = '<script src="data.js"></script>';
if (!html.includes(tag)) throw new Error('未找到 data.js 引用，index.html 结构可能已变');

const out = html.replace(tag, '<script>\n' + data + '</script>');
await fs.writeFile(outPath, out, 'utf8');

const mb = (Buffer.byteLength(out) / 1024 / 1024).toFixed(2);
console.log(`已生成单文件：${path.basename(outPath)}（${mb} MB）`);
