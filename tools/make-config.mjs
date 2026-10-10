// make-config.mjs — 產生 src/firebase-config.js（npm run config）。
// 這個設定檔刻意不放進 Git（.gitignore），所以每位隊友第一次下載專案後要自己產生一次。
// 前提：已經用 `npx firebase login` 登入，而且你的 Google 帳號已被加入這個 Firebase 專案。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const raw = execFileSync('npx', ['firebase', 'apps:sdkconfig', 'WEB', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' });
const config = JSON.parse(raw).result?.sdkConfig;
if (!config?.projectId) {
  console.error('取不到設定值。請確認已執行 npx firebase login，且你的帳號已被加入 Firebase 專案。');
  process.exit(1);
}
const keys = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
const body = keys.filter((k) => config[k]).map((k) => `  ${k}: ${JSON.stringify(config[k])},`).join('\n');
writeFileSync(
  new URL('../src/firebase-config.js', import.meta.url),
  `// Firebase 專案設定（由 npm run config 產生，不放進 Git）。\n// 這些值是辨識專案用的公開代號，不是密碼；存取控制由 firestore.rules 負責。\nexport const firebaseConfig = {\n${body}\n};\n`,
);
console.log(`已產生 src/firebase-config.js（專案：${config.projectId}）`);
