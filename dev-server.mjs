// dev-server.mjs — 本機預覽用的靜態檔案伺服器（不需要 npm install）：npm start → http://localhost:5173
// 只是把這個資料夾的檔案送給瀏覽器；資料與 Agent 仍然連到你的 Firebase 專案（或在沒設定時進入展示模式）。
// 本機開發時請用這個網址，不要直接雙擊開啟 html 檔（file:// 無法載入模組，也不能登入）。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = normalize(join(ROOT, path === '/' ? 'researchflow.html' : path));
  // 不送出資料夾以外的檔案，也不送出隱藏檔與 node_modules
  const rel = file.startsWith(ROOT) ? file.slice(ROOT.length) : null;
  if (rel === null || rel.split(sep).some((part) => part.startsWith('.') || part === 'node_modules')) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`ResearchFlow 本機預覽：http://localhost:${PORT}`));
