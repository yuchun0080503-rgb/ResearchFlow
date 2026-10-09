# ResearchFlow

多人協作研究畫布 + Research Agent。小組在共同畫布上討論想法，Agent 協助整理研究範圍、搜尋正反證據，最後的判斷由學生決定。

- **不需要任何密碼或 API 金鑰**，也**不需要付費**：只用 Firebase 免費方案（電子郵件登入、Firestore 資料庫、Hosting 網站代管）。
- Agent 是**規則式**的，不呼叫生成式 AI 模型；文獻來自 OpenAlex 公開學術資料庫（免費、免金鑰）。
- 沒有設定 Firebase 時，網頁會自動進入**展示模式**（內建示範資料、不儲存）。

> `src/firebase-config.js` 裡有一個叫 `apiKey` 的欄位。它是 Firebase 用來辨識「這是哪一個專案」的公開代號，
> 不是密碼——所有 Firebase 網站都會把它放在網頁原始碼裡，Google 官方文件也說明它不需要保密。
> 真正的存取控制寫在 `firestore.rules`。

## 給隊友：第一次下載後怎麼開始

這個 GitHub 專案包含完整系統（網頁、資料層、Agent、安全規則、測試），不是只有畫面。
唯一沒有放進來的是 `src/firebase-config.js`（Firebase 連線設定，刻意不進 Git），所以下載後要先產生它，否則網頁只會進入展示模式。

前置：安裝 [Node.js](https://nodejs.org/) 20 以上；請專案擁有者把你的 Google 帳號加進 Firebase 專案（Firebase Console → 專案設定 → 使用者和權限 → 新增成員，角色選「編輯者」）。

```bash
npm install
```

```bash
npx firebase login
```

```bash
npm run config
```

```bash
npm start
```

然後開 `http://localhost:5173`。改完程式後先跑 `npm test`，再用 Git 提交並推送；要更新線上網站時執行 `npm run deploy`。
大家連的是同一個 Firebase 專案，所以本機測試寫入的資料就是線上的真實資料。

## 功能

| 功能 | 說明 |
|---|---|
| 登入 | 電子郵件與密碼（Firebase Authentication 保管密碼，可自行註冊、重設密碼） |
| 研究專案 | 建立專案、用一次性連結邀請組員（Editor／Viewer）或老師（Teacher） |
| 共同畫布 | 手寫、文字、連線、群組、標籤；完成一個操作後同步給所有組員 |
| 自動偵測畫布 | 停筆約 1 秒後自動判斷：圖示（圓圈、方框、箭頭、線、底線）依它圈住或連接的內容寫成一句話；手寫字自動辨識成文字。結果都標示「待確認」 |
| Agent：判斷範圍 | 檢查畫布有沒有交代研究對象／情境／結果，缺哪一項就提出聚焦問題 |
| Agent：研究問題 | 依小組的回答產生研究問題草案與英文搜尋關鍵字（都可以修改） |
| 查證模式 | 每個專案有預設模式：**正反例證模式**（同時找支持與反向證據，要求兩邊平衡）或**主張論證模式**（針對一個主張深入查證：直接證據 → 統整性研究 → 限制與反例）。建立專案後 Agent 會依題目給建議、由 Owner 選擇；每次查證前的確認頁會提示目前模式，也可以臨時切換 |
| Agent：搜尋證據 | 查 OpenAlex，依查證模式決定每一輪找什麼；主張論證模式會標示每篇的證據力（回顧與實驗為高） |
| 證據地圖 | 依摘要用語做支持／反向的初步分類，學生閱讀原文後確認或改列；沒有 DOI 的來源標為待驗證 |
| 老師權限 | 老師唯讀檢視畫布與研究歷程，並設定 AI 權限 Level 0–3 |
| 研究歷程 | 學生操作、Agent 動作、權限拒絕都留下紀錄，寫入後不能修改或刪除 |

AI 權限（新專案預設 Level 2）：0 全部關閉；1 可判斷範圍與搜尋，研究問題由學生自己寫；2 另可產生研究問題草案；3 另可產生證據摘要。
「請 Agent 完成整份報告」在任何 Level 都會被拒絕並留下紀錄。

## 資料夾結構

```
researchflow.html          前端（單一檔案）
dev-server.mjs             本機預覽用的靜態伺服器（npm start）
src/
  db.mjs                    Firebase 資料層：登入、Firestore 讀寫、執行 Agent 前的權限檢查
  agent-local.mjs (+test)   規則式 Agent：判斷範圍、研究問題、OpenAlex 搜尋、證據初步分類
  ink.mjs (+test)           自動偵測手寫內容：圖示的幾何判斷、手寫文字辨識（切字、詞庫校正）
  lexicon-zh.txt            常用詞對照表：研究常用詞＋依詞頻排序的約 4 萬個中文詞（取自 jieba 的詞頻表，MIT 授權）
  searchLogic.mjs (+test)   OpenAlex 查詢網址與書目整理
  harness.mjs (+test)       AI Harness：角色與 AI Level 的判斷
  permissions.mjs (+test)   Owner／Editor／Viewer／Teacher 權限矩陣（與 firestore.rules 保持一致）
  sync.mjs (+test)          畫布同步的純邏輯
  firebase-config.example.js  設定值範本
firestore.rules            Firestore 安全規則（所有硬限制都在這裡，由 Firebase 伺服器強制執行）
firebase.json              rules／hosting 設定
tools/make-config.mjs      產生 src/firebase-config.js（npm run config）
```

## 指令

```bash
npm test
```

```bash
npm start
```

```bash
npm run deploy
```

`npm start` 會在 `http://localhost:5173` 開啟本機預覽；`npm run deploy` 把安全規則與網站發布到 Firebase。

## 權限由誰把關

- **Firestore 安全規則（伺服器端，改前端也繞不過）**：只有成員能讀專案；只有 Owner／Editor 能改畫布與研究狀態；
  AI Level 只有老師改得動（連 Owner 也不行）；研究歷程只能新增且必須是自己的身分。
- **瀏覽器端（`src/db.mjs` 的 guard）**：執行 Agent 前，從 Firestore 讀取老師設定的 AI Level 與自己的角色來判斷。
  這一層跑在使用者的瀏覽器裡，因為系統沒有付費的後端；Agent 本身不使用任何付費資源或金鑰，所以沒有可被盜用的東西。

## 驗證狀態

**已驗證**
- 71 項單元測試全數通過（`npm test`）。
- 展示模式完整流程。
- 連線模式的前端流程：用記憶體內的假資料層取代 Firebase 實際操作過——建立專案、邀請、畫布同步、Agent 全流程、權限拒絕、老師調整 AI Level。
- OpenAlex 搜尋：在瀏覽器裡實際查詢並取得真實文獻。
- 自動偵測：在瀏覽器裡用程式產生的筆畫實測過箭頭關係、底線強調、逐字書寫合併成詞句、換行續寫。
- 中文手寫辨識：用公開的筆順資料（hanzi-writer-data）合成中文詞句來量準確率。工整到略不整齊的筆跡（24 組詞句、含橫寫／直書／不同大小與字距／兩行）全部正確；刻意加入歪斜、大小不一、筆畫變形與連筆的「潦草」筆跡，中度潦草時 144 字錯 11 字，重度潦草時錯 29 字。**這些都是合成筆跡**；真人筆跡只驗證過資料庫裡現有的一筆（手寫的「AI」，辨識正確）。

**尚未驗證（要等 Firebase 專案建立後）**
- `firestore.rules` 還沒有在真實專案上跑過。
- 電子郵件註冊與登入流程還沒有在真實專案上跑過。

## 已知限制

- Agent 是規則式的：聚焦問題的選項是通用的（可用「其他」自行輸入）；中文轉英文關鍵字只涵蓋常見教育研究用語，其餘要自己補。
- 支持／反向的初步分類只看摘要裡的正負向用語，可能分錯，所以一律標示為待確認。
- 中文手寫辨識的做法：平滑筆畫 → 分行 → 嘗試多種「哪幾筆是同一個字」的切法並分別辨識 → 挑整行最合理的切法 → 用常用詞對照表校正（正確的字排在第 2、3 候選時救回來）。寫得很潦草、字與字黏在一起或重疊時仍會認錯，所以結果一律要經過確認，也可以點「其他可能」改選。
- 手寫文字辨識使用 Google Input Tools 的公開手寫端點（免費、免金鑰，筆畫座標會送到 Google）。它不是有服務保證的正式 API，連不上時退回在「確認理解」步驟手動輸入。
- 圖示偵測是幾何規則：只認得圓圈／方框／三角形／直線／箭頭／底線，太小的筆畫（小於約 70px）一律當成文字；畫得太潦草可能認不出來或認錯，所以都要經過確認。
- 邀請連結要手動傳給對方；多人同時改同一個物件時最後寫入的會覆蓋前面的；沒有「誰在線上」的即時顯示。
- 復原（Ctrl+Z）是還原整張畫布的上一個狀態，可能連同組員剛做的修改一起還原。
- 老師是由 Owner 發邀請加入的，系統沒有另外驗證對方真的是老師。

## 第三方資料

- `src/lexicon-zh.txt` 的詞與詞頻順序取自 [jieba](https://github.com/fxsjy/jieba) 的 `dict.txt.big`（MIT License，Copyright (c) 2013 Sun Junyi），只保留 2–4 個字的常用詞，並在最前面加入研究常用詞。
