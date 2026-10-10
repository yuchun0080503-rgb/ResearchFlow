// agent-local.mjs — 不需要任何 API 金鑰、不需要後端的 Research Agent（在瀏覽器裡執行）。
//
// 這一版的 Agent 是「規則式」的：不呼叫任何生成式 AI 模型，所以沒有金鑰、沒有費用。
//   - 判斷範圍：檢查畫布內容有沒有交代「研究對象／情境／結果」，缺哪一項就問哪一項
//   - 研究問題：把小組的回答套進固定句型（草案，學生可以改）
//   - 搜尋證據：直接查 OpenAlex 公開學術資料庫（免費、不需金鑰、允許瀏覽器直接呼叫）
//   - 證據分類：依摘要裡的正向／負向用語做「初步分類」，一律標示為待小組確認，學生可以改列
// 純邏輯都在這個檔案，可以用 node:test 驗證；唯一的網路呼叫是 searchEvidence 裡的 fetch。

import { clampQueries, openAlexUrl, normalizeWork, dedupeWorks, crossrefUrl, normalizeCrossref } from './searchLogic.mjs';

const clean = (items) =>
  (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.text === 'string' && it.text.trim() && !it.text.startsWith('（未能辨識') && !it.text.startsWith('圖示：')) // 沒有指到任何內容的單純圖示不算研究內容
    .map((it) => ({ type: it.type === 'stroke' ? 'stroke' : 'text', text: it.text.trim(), tag: it.tag || '' }));

// ---------------- 判斷範圍 ----------------

// 三個聚焦面向：畫布上出現任何一個線索詞，就當作小組已經交代過這個面向。
const DIMENSIONS = [
  {
    key: 'who', label: '研究對象', question: '你們想聚焦哪一類對象？',
    cues: /國小|小學|國中|高中|中學|大學|研究生|碩士|博士|學童|兒童|青少年|教師|老師|家長|成人|上班族|長者|銀髮|新生|undergraduate|student|teacher/i,
    options: ['國高中生', '大學生', '研究生', '教師'],
  },
  {
    key: 'ctx', label: '研究情境', question: '你們想研究哪一種使用情境？',
    cues: /課堂|上課|自主學習|自學|寫作|報告|作業|考試|備考|線上|遠距|實驗室|職場|家庭|社群|classroom|writing|exam|online/i,
    options: ['課堂學習', '自主學習', '寫作與報告', '考試準備'],
  },
  {
    key: 'out', label: '主要結果', question: '你們最想知道對哪一種結果的影響？',
    cues: /成績|分數|效率|批判思考|思辨|動機|誠信|抄襲|創造力|焦慮|壓力|滿意度|表現|理解|記憶|performance|motivation|critical thinking/i,
    options: ['學習成績', '學習效率', '批判思考', '學術誠信'],
  },
];
const VAGUE = /是否|有沒有|能不能|會不會|好不好|有幫助|有用嗎|比較好|影響/;

export function topicOf(items) {
  const list = clean(items);
  // 自動偵測出來的圖示說明（關係、圈選、強調…）是在描述別的內容，不拿來當主題
  const plain = list.filter((it) => !/^(關係|連結|強調|圈選重點|箭頭指向)：/.test(it.text));
  const first = plain.find((it) => it.type === 'stroke') || plain[0] || list[0];
  return first ? first.text.replace(/^研究主題[:：]\s*/, '').slice(0, 60) : '';
}

export function analyzeScope(rawItems) {
  const items = clean(rawItems);
  if (!items.length) {
    return { tooBroad: true, reasons: ['畫布上還沒有可以判斷的文字內容'], clarifyingQuestions: [], topic: '', draftQuestion: '' };
  }
  const all = items.map((it) => it.text).join('\n');
  const missing = DIMENSIONS.filter((d) => !d.cues.test(all));
  const reasons = missing.map((d) => `沒有說明${d.label}`);
  if (VAGUE.test(all)) reasons.push('使用「是否／有沒有幫助」這類概括的問法，還無法直接拿去搜尋');
  if (!items.some((it) => it.tag === 'counter')) reasons.push('畫布上還沒有反向或限制性的觀點');
  const topic = topicOf(items);
  const asked = items.find((it) => it.tag === 'question');
  return {
    tooBroad: missing.length > 0,
    reasons: missing.length ? reasons : ['研究對象、情境與結果都已經在畫布上交代', ...reasons],
    clarifyingQuestions: missing.map((d) => ({ key: d.key, question: d.question, options: d.options })),
    topic,
    draftQuestion: asked ? asked.text.slice(0, 120) : topic ? `${topic}——會帶來什麼影響？` : '',
  };
}

// ---------------- 研究問題與關鍵字 ----------------

// OpenAlex 以英文文獻為主，所以把常見的中文研究用語對應成英文關鍵字；對不到的就交給學生在下一步自己補。
const TERMS = [
  [/生成式\s*AI|生成式人工智慧|ChatGPT|大型語言模型|LLM/i, 'generative AI'],
  [/人工智慧|(?<![a-z])AI(?![a-z])/i, 'artificial intelligence'],
  [/大學生?|大專生?|undergraduate/i, 'university students'],
  [/高中生?|國中生?|中學生?|國高中生?/, 'secondary school students'],
  [/青少年/, 'adolescents'],
  [/國小|小學|學童|兒童/, 'primary school students'],
  [/研究生|碩士|博士/, 'graduate students'],
  [/教師|老師/, 'teachers'],
  [/學生/, 'students'],
  // 常見的「研究在看什麼」：整個詞組當成一個概念，不要拆成零碎的字（自主／判斷／能力）各自去翻譯
  [/(?:自主|獨立)(?:判斷|思考)(?:的?能力|力)?|判斷的?能力|判斷力|思考的?能力|思考力/, 'independent thinking'],
  [/問題解決|解決問題/, 'problem solving'],
  [/學習動機/, 'learning motivation'],
  [/學習態度/, 'learning attitudes'],
  [/學習成效|學習成果|學習效果/, 'learning outcomes'],
  [/自我效能/, 'self-efficacy'],
  [/自信心?/, 'self-confidence'],
  [/人際關係|人際互動|社交能力/, 'interpersonal relationships'],
  [/溝通能力|表達能力/, 'communication skills'],
  [/認知負荷/, 'cognitive load'],
  [/決策/, 'decision-making'],
  [/隱私/, 'privacy'],
  [/假訊息|假新聞|不實訊息/, 'misinformation'],
  [/媒體識讀|媒體素養/, 'media literacy'],
  [/AI\s*素養|人工智慧素養/i, 'AI literacy'],
  [/數位素養|資訊素養/, 'digital literacy'],
  [/短影音|短影片/, 'short-form video'],
  [/孤獨|寂寞/, 'loneliness'],
  [/時間管理/, 'time management'],
  [/拖延/, 'procrastination'],
  [/學業壓力|課業壓力/, 'academic stress'],
  [/近視|視力/, 'myopia'],
  [/身體意象|容貌焦慮/, 'body image'],
  [/合作學習|小組合作|協作學習/, 'collaborative learning'],
  [/翻轉教室|翻轉教學/, 'flipped classroom'],
  [/遊戲化/, 'gamification'],
  [/程式設計|寫程式|程式教育/, 'programming education'],
  [/倫理|道德/, 'ethics'],
  [/偏見|歧視/, 'bias'],
  [/就業|工作機會|失業/, 'employment'],
  [/環保|環境保護/, 'environmental protection'],
  [/過度依賴/, 'overreliance'],
  [/課堂|上課/, 'classroom learning'],
  [/自主學習|自學/, 'self-directed learning'],
  [/寫作|報告|作業/, 'academic writing'],
  [/考試|備考/, 'exam preparation'],
  [/線上|遠距/, 'online learning'],
  [/成績|分數|表現/, 'academic performance'],
  [/效率/, 'learning efficiency'],
  [/批判思考|思辨/, 'critical thinking'],
  [/動機/, 'motivation'],
  [/誠信|抄襲|作弊/, 'academic integrity'],
  [/依賴/, 'dependency'],
  [/創造力|創意/, 'creativity'],
  [/焦慮|壓力/, 'anxiety'],
  [/社群媒體|社交媒體/, 'social media'],
  [/睡眠品質/, 'sleep quality'],
  [/睡眠/, 'sleep'],
  [/智慧型手機|智慧手機/, 'smartphone'],
  [/手機/, 'mobile phone'],
  [/使用時間|螢幕時間/, 'screen time'],
  [/網路成癮|網路沉迷/, 'internet addiction'],
  [/電玩|線上遊戲|電子遊戲/, 'video games'],
  [/心理健康/, 'mental health'],
  [/憂鬱/, 'depression'],
  [/壓力/, 'stress'],
  [/自尊/, 'self-esteem'],
  [/幸福感/, 'well-being'],
  [/注意力|專注力/, 'attention'],
  [/記憶力?/, 'memory'],
  [/運動/, 'exercise'],
  [/飲食/, 'diet'],
  [/肥胖/, 'obesity'],
  [/霸凌/, 'bullying'],
  [/閱讀理解/, 'reading comprehension'],
  [/閱讀/, 'reading'],
  [/補習/, 'private tutoring'],
  [/雙語/, 'bilingual education'],
  [/英語學習|英文學習/, 'English language learning'],
  [/氣候變遷/, 'climate change'],
  [/永續/, 'sustainability'],
  [/疫情|新冠/, 'COVID-19'],
  [/打工/, 'part-time work'],
  [/同儕/, 'peer influence'],
  [/家長|父母/, 'parents'],
  [/學習/, 'learning'],
];

// 同一批詞，但保留中文原文：[{zh, en}]。中文那一半拿去搜尋中文文獻，英文那一半搜尋國際文獻。
// 畫布上本來就用英文寫的詞 zh 留空。
export function keywordPairs(text) {
  const out = [];
  for (const [re, en] of TERMS) {
    const hit = String(text).match(re);
    // 已經被前面較完整的詞組涵蓋的不重複（有「過度依賴」就不要再加「依賴」）
    if (hit && out.some((p) => p.zh && p.zh.includes(hit[0]))) continue;
    if (hit && !out.some((p) => p.en === en)) out.push({ zh: /[一-鿿]/.test(hit[0]) ? hit[0].replace(/\s+/g, '') : '', en });
  }
  for (const w of String(text).match(/[A-Za-z][A-Za-z-]{3,}/g) || []) {
    const lw = w.toLowerCase();
    if (!out.some((p) => p.en.toLowerCase().includes(lw)) && out.length < 8) out.push({ zh: '', en: lw });
  }
  const specific = out.some((p) => / students$/.test(p.en)), genAI = out.some((p) => p.en === 'generative AI');
  return out.filter((p) => !(specific && p.en === 'students') && !(genAI && p.en === 'artificial intelligence')).slice(0, 8);
}

// 從一段中文（畫布上的論點、要論證的主張）抽出可以當關鍵字的詞。
// 沒有斷詞工具，所以用詞庫做「最長詞優先」的比對：rankOf(詞) 回傳它在常用詞表裡的名次（不在表裡回傳 undefined）。
// 詞表最前面 DOMAIN_WORDS 個是手動加入的研究常用詞（一定保留）；接在後面的 COMMON_WORDS 個是最常見的詞
// （多半是「可能」「因為」這類）不要；下面的功能詞也不要。剩下的依出現順序取前幾個。
const DOMAIN_WORDS = 104, COMMON_WORDS = 150;
const STOP_ZH = new Set('可能 因為 所以 但是 而且 如果 雖然 或者 以及 還是 就是 不是 沒有 這個 那個 這些 那些 我們 他們 你們 自己 大家 什麼 怎麼 為什麼 是否 需要 應該 可以 能夠 已經 正在 比較 非常 真的 確認 產生 造成 導致 使得 提高 提升 降低 減少 增加 改善 變得 變差 變好 使用 進行 認為 覺得 發現 表示 研究 問題 影響 結果 情況 方面 部分 時候 之後 之前 以後 以前 目前 現在 很多 一些 一個 一定 一樣 不同 相關 關係 幫助 有幫助 重要 主要 一般 其他 例如 包括 對於 關於 根據 透過 經過 能力 程度 狀況 狀態 方式 方法 效果 發展 過度 現象 行為 內容 過程 作用 因素 條件 水準 水平 高低 好壞 多少 自主 獨立 判斷 思考'.split(' '));
export function extractZhTerms(text, rankOf, max = 4) {
  const src = String(text || ''), out = [];
  for (const run of src.match(/[一-鿿]+/g) || []) {
    for (let i = 0; i < run.length;) {
      let word = '';
      for (let len = Math.min(4, run.length - i); len >= 2; len--) {
        const cand = run.slice(i, i + len);
        if (rankOf(cand) !== undefined) { word = cand; break; }
      }
      if (!word) { i++; continue; }
      i += word.length;
      const rank = rankOf(word);
      if (!STOP_ZH.has(word) && (rank < DOMAIN_WORDS || rank >= DOMAIN_WORDS + COMMON_WORDS) && !out.includes(word)) out.push(word);
    }
  }
  return out.slice(0, max);
}

// ---------------- 中文關鍵字 → 英文 ----------------
// 順序：內建對照表（研究常用詞）→ 維基百科的中英條目對應（學術名詞最準）→ MyMemory 免費翻譯服務（一般詞句）。
// 三者都不需要金鑰。全部失敗時回傳空字串，這個關鍵字就只用來搜尋中文文獻。
const hasZh = (s) => /[一-鿿]/.test(s);
export async function translateTerm(term, fetchImpl = fetch) {
  const text = String(term || '').trim();
  if (!text || !hasZh(text)) return { en: text, via: '' };
  const known = TERMS.find(([re]) => { const m = text.match(re); return m && m[0].length >= text.replace(/\s+/g, '').length - 1; });
  if (known) return { en: known[1], via: '內建對照表' };
  try {
    const url = 'https://zh.wikipedia.org/w/api.php?' + new URLSearchParams({ action: 'query', titles: text, prop: 'langlinks', lllang: 'en', redirects: '1', converttitles: '1', format: 'json', origin: '*' });
    const res = await fetchImpl(url);
    const page = res.ok ? Object.values((await res.json()).query?.pages || {})[0] : null;
    const title = page?.langlinks?.[0]?.['*'];
    if (title) return { en: title.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase(), via: '維基百科條目對應' };
  } catch { /* 換下一個方法 */ }
  try {
    const res = await fetchImpl('https://api.mymemory.translated.net/get?' + new URLSearchParams({ q: text, langpair: 'zh-TW|en' }));
    const out = res.ok ? (await res.json()).responseData?.translatedText : '';
    if (typeof out === 'string' && out.trim() && !hasZh(out) && !/MYMEMORY WARNING|QUERY LENGTH/i.test(out)) return { en: out.trim().toLowerCase().slice(0, 80), via: '機器翻譯' };
  } catch { /* 都失敗就只搜中文 */ }
  return { en: '', via: '' };
}

// 沒有本機模型時的備援：用 MyMemory 免費翻譯服務把一小段英文摘要翻成繁體中文（每天有額度，所以只在學生展開卡片時才用）
export async function toZh(text, fetchImpl = fetch) {
  const src = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 450);
  if (!src || hasZh(src)) return '';
  try {
    const res = await fetchImpl('https://api.mymemory.translated.net/get?' + new URLSearchParams({ q: src, langpair: 'en|zh-TW' }));
    const out = res.ok ? (await res.json()).responseData?.translatedText : '';
    if (typeof out === 'string' && hasZh(out) && !/MYMEMORY WARNING|QUERY LENGTH/i.test(out)) return out.trim();
  } catch { /* 換下一個 */ }
  // MyMemory 每天的額度用完或連不上時：改用 Google 翻譯的公開端點（同樣不需要金鑰；偶爾會夾雜簡體字）
  const res = await fetchImpl('https://translate.googleapis.com/translate_a/single?' + new URLSearchParams({ client: 'gtx', sl: 'en', tl: 'zh-TW', dt: 't', q: src }));
  const parts = res.ok ? (await res.json())?.[0] : null;
  const out = Array.isArray(parts) ? parts.map((p) => (Array.isArray(p) ? p[0] || '' : '')).join('') : '';
  return hasZh(out) ? out.trim() : '';
}

export function keywordsFrom(text) {
  const out = [];
  for (const [re, en] of TERMS) if (re.test(text) && !out.includes(en)) out.push(en);
  // 畫布上本來就用英文寫的詞（至少 4 個字母）直接保留
  for (const w of text.match(/[A-Za-z][A-Za-z-]{3,}/g) || []) {
    const lw = w.toLowerCase();
    if (!out.some((k) => k.toLowerCase().includes(lw)) && out.length < 8) out.push(lw);
  }
  // 「students」已經被更具體的對象涵蓋時就不用重複
  const specific = out.some((k) => / students$/.test(k));
  return out.filter((k) => !(specific && k === 'students') && !(out.includes('generative AI') && k === 'artificial intelligence')).slice(0, 8);
}

export function proposeQuestion({ items, answers, ownQuestion }) {
  const list = clean(items);
  const ans = (Array.isArray(answers) ? answers : []).filter((a) => a && a.answer);
  const byKey = Object.fromEntries(ans.map((a) => [a.key, a.answer]));
  const topic = topicOf(list) || '這個主題';
  const own = typeof ownQuestion === 'string' ? ownQuestion.trim().slice(0, 300) : '';
  const researchQuestion =
    own ||
    `關於「${topic}」：${byKey.who ? byKey.who : '研究對象'}${byKey.ctx ? `在${byKey.ctx}情境中` : ''}，` +
      `${byKey.out ? `${byKey.out}會受到什麼影響` : '會受到什麼影響'}？同時有哪些限制或反向結果？`;
  const source = [own, ...list.map((it) => it.text), ...ans.map((a) => a.answer)].join('\n');
  // 關鍵字清單以使用者的語言呈現：有中文原文就顯示中文，英文對照放在 kwEn（搜尋國際文獻時用）
  const pairs = keywordPairs(source), kwEn = {};
  const keywords = pairs.map((p) => { if (p.zh) kwEn[p.zh] = p.en; return p.zh || p.en; });
  const strategy = [
    ['研究對象', byKey.who], ['研究情境', byKey.ctx], ['主要結果', byKey.out],
  ].filter((r) => r[1]).map(([label, value]) => ({ label, value }));
  strategy.push({ label: '時間範圍', value: '國際文獻 2020 年至今；中文文獻 2015 年至今' }, { label: '資料來源', value: 'OpenAlex 學術資料庫' });
  return { researchQuestion, keywords, kwEn, strategy };
}

// ---------------- 查證模式 ----------------
// procon「正反例證模式」：題目本身有正反兩面（利弊、爭議、影響好壞）——刻意同時找支持與反向的證據，要求兩邊平衡。
// claim 「主張論證模式」：報告是在論證一個主張——只幫這個主張找證據並分出證據力：直接證據 → 統整性研究 → 成立條件與機制。
//        這個模式「不主動提供反面例證」：搜尋到看法可能不同的文獻先保留不顯示，改成列出「目前主張下可能有的潛在問題」，
//        學生說需要時才去找反面例證當參考（claimIssues／buildQueries 的 'counter'）。
export const MODES = ['procon', 'claim'];
const PROCON_CUES = /正反|利弊|優缺|優點.*缺點|好處.*壞處|贊成|反對|爭議|辯論|兩面|是否應該|該不該|應不應該|比較|vs|VS|影響/;

/**
 * 依專案資料建議預設的查證模式。
 * @param {string} text 報告名稱＋老師要求＋研究領域
 * @returns {{mode:'procon'|'claim', reason:string}}
 */
export function suggestMode(text) {
  const hit = String(text || '').match(PROCON_CUES);
  return hit
    ? { mode: 'procon', reason: `題目或老師要求裡出現「${hit[0]}」，看起來需要同時呈現正反兩面的證據。` }
    : { mode: 'claim', reason: '題目看起來是在說明或論證一個主題，不一定有明確的正反兩方；針對你們的主張逐一深入查證會比較實用。' };
}

/**
 * 主張論證模式：列出「目前主張下可能有的潛在問題」。只看主張的寫法與目前手上證據的組成，不去找反面例證。
 * @param {string} claim 要論證的主張
 * @param {object[]} evidence 目前支持主張的證據（Evidence Map 的項目）
 * @param {number} heldCount 搜尋時遇到、但因為看法可能不同而先保留不顯示的文獻數
 * @returns {string[]}
 */
export function claimIssues(claim, evidence, heldCount = 0) {
  const text = String(claim || ''), ev = Array.isArray(evidence) ? evidence : [], out = [];
  const absolute = text.match(/一定|必然|絕對|所有|全部|都會|都能|完全|永遠|從不|唯一|最/);
  if (absolute) out.push(`主張用了「${absolute[0]}」這種沒有例外的說法，只要出現一個例外就站不住，可以考慮加上適用範圍。`);
  if (/導致|造成|使得|讓|提高|提升|降低|減少|增加|改善|影響|有助於|幫助/.test(text)) out.push('這是一個因果主張。問卷或訪談只能說明「有關聯」，要證明因果需要實驗或長期追蹤的研究。');
  if (!DIMENSIONS[0].cues.test(text)) out.push('主張沒有說明適用的對象，讀者可能會質疑它是不是對每一種人都成立。');
  if (ev.length) {
    const high = ev.filter((e) => e.lv === '高').length, direct = ev.filter((e) => e.d === '直接').length;
    if (!high) out.push('目前的證據裡沒有證據力高的研究（系統性回顧或實驗），論證的基礎還不夠穩。');
    if (direct < Math.ceil(ev.length / 2)) out.push(`只有 ${direct}／${ev.length} 筆證據跟主張直接相符，其餘的研究對象或情境不完全一樣。`);
    const groups = new Set(ev.map((e) => e.p).filter((x) => x && x !== '摘要未說明'));
    if (groups.size === 1) out.push(`證據的研究對象幾乎都是${[...groups][0]}，不一定能推論到其他族群。`);
    const unverified = ev.filter((e) => !e.v).length;
    if (unverified) out.push(`有 ${unverified} 筆證據的來源還沒有驗證。`);
  } else out.push('目前還沒有找到支持這個主張的證據。');
  if (heldCount) out.push(`搜尋時另外遇到 ${heldCount} 篇看法可能不同、或指出限制的研究（目前沒有顯示）。`);
  return out;
}

// 把「要查證的主張」寫成研究問題的草案
export const claimQuestion = (claim) => `「${String(claim || '').trim().slice(0, 80)}」這個主張成立嗎？在什麼條件下成立，又有哪些限制？`;

// ---------------- 查詢怎麼組：讓結果一定跟題目有關 ----------------
// 以前是把關鍵字用空白接起來丟給全文搜尋，只要沾到其中一兩個詞就會被找出來，結果常常離題。
// 現在把關鍵字分成兩種：
//   主題詞（core）：論點／主張本身在講的東西（手機、睡眠）——每一篇結果的「標題或摘要」都必須提到每一個主題詞；
//   範圍詞（scope）：研究對象、情境（高中生、課堂）——用來縮小範圍，找不夠時可以放掉。
// 查詢用布林式，只比對標題與摘要；同義詞用 OR 併在一起（mobile phone OR smartphone），避免因為用詞不同而漏掉。
// 找回來之後再算一次相關度（主題詞出現在標題的比較高），不符合的丟掉，其餘由高到低排。

// 常見研究用語的同義詞（比對時也會用到）。key 一律小寫。
const SYNONYMS = {
  'mobile phone': ['smartphone', 'cellphone', 'cell phone'],
  smartphone: ['mobile phone', 'cellphone'],
  'secondary school students': ['adolescents', 'high school students', 'teenagers'],
  adolescents: ['teenagers', 'adolescence', 'youth'],
  adolescence: ['adolescents', 'teenagers'],
  'screen time': ['usage time', 'duration of use'],
  'internet addiction': ['problematic internet use'],
  'video games': ['gaming'],
  stress: ['perceived stress'],
  depression: ['depressive symptoms'],
  'university students': ['undergraduates', 'college students', 'undergraduate students'],
  'primary school students': ['children', 'elementary school students'],
  'graduate students': ['postgraduate students', 'doctoral students'],
  teachers: ['educators', 'instructors'],
  students: ['learners'],
  'generative ai': ['ChatGPT', 'large language models', 'generative artificial intelligence'],
  'artificial intelligence': ['AI', 'ChatGPT', 'generative AI'],
  'academic performance': ['academic achievement', 'grades', 'GPA'],
  'critical thinking': ['higher-order thinking'],
  'independent thinking': ['critical thinking', 'judgment', 'judgement', 'learner autonomy', 'cognitive offloading', 'decision-making', 'independent judgment'],
  overreliance: ['over-reliance', 'dependence', 'dependency', 'reliance'],
  'problem solving': ['problem-solving'],
  'learning motivation': ['motivation', 'engagement'],
  'learning outcomes': ['academic performance', 'learning performance', 'academic achievement'],
  'self-efficacy': ['self efficacy'],
  'decision-making': ['decision making'],
  misinformation: ['fake news', 'disinformation'],
  'short-form video': ['TikTok', 'short video'],
  loneliness: ['social isolation'],
  'collaborative learning': ['cooperative learning'],
  ethics: ['ethical'],
  'social media': ['social networking sites', 'Instagram'],
  sleep: ['sleep quality', 'sleep duration'],
  anxiety: ['anxious'],
  motivation: ['engagement'],
  'academic integrity': ['plagiarism', 'cheating'],
  dependency: ['overreliance', 'dependence', 'addiction'],
  'online learning': ['e-learning', 'distance learning'],
  'self-directed learning': ['self-regulated learning'],
  'academic writing': ['essay writing', 'writing skills'],
  'classroom learning': ['classroom'],
  'exam preparation': ['test preparation'],
  'learning efficiency': ['learning outcomes'],
  creativity: ['creative thinking'],
  'mental health': ['well-being', 'psychological distress'],
  exercise: ['physical activity'],
};
// 一個關鍵字連同它的同義詞
// 這一次搜尋額外的同義詞（由本機模型 Qwen 規劃搜尋時提供，見 agent-llm.mjs 的 planSearch）。key 一律小寫。
let EXTRA_SYNONYMS = {};
export function setExtraSynonyms(map) {
  EXTRA_SYNONYMS = {};
  for (const [k, v] of Object.entries(map && typeof map === 'object' ? map : {})) if (Array.isArray(v)) EXTRA_SYNONYMS[String(k).trim().toLowerCase()] = v.filter((x) => typeof x === 'string' && x.trim()).slice(0, 4);
}
export const termGroup = (term) => { const key = String(term).trim().toLowerCase(); return [...new Set([String(term).trim(), ...(EXTRA_SYNONYMS[key] || []), ...(SYNONYMS[key] || [])].filter(Boolean))]; };
const quote = (t) => (/\s/.test(t) ? `"${t}"` : t);

// OpenAlex 對布林運算子超過 5 個的查詢有每秒一次的限制，所以每條查詢最多用 5 個 AND／OR：
// 先保證每一組都有一個詞（AND 接起來），剩下的額度再輪流補同義詞。
const MAX_OPS = 5;
export function boolQuery(groups) {
  const gs = groups.map((g) => (Array.isArray(g) ? g : [g]).filter(Boolean)).filter((g) => g.length).slice(0, MAX_OPS + 1);
  if (!gs.length) return '';
  const used = gs.map((g) => [g[0]]);
  let ops = gs.length - 1;
  for (let depth = 1; ops < MAX_OPS; depth++) {
    let added = false;
    for (let i = 0; i < gs.length && ops < MAX_OPS; i++) if (gs[i][depth]) { used[i].push(gs[i][depth]); ops++; added = true; }
    if (!added) break;
  }
  return used.map((g) => (g.length > 1 ? `(${g.map(quote).join(' OR ')})` : quote(g[0]))).join(' AND ');
}

// 各輪額外要求出現的方向用語
const DIRECTION = {
  negative: ['negative', 'risk', 'harm', 'adverse'],
  limits: ['limitations', 'concerns', 'challenges'],
  review: ['systematic review', 'meta-analysis'],
  mechanism: ['mechanism', 'mediating', 'moderating'],
  contrary: ['limitations', 'no significant', 'contrary'],
};

// 每一輪要查什麼。keywords 是英文關鍵字，主題詞排在前面；coreCount 是其中前幾個算主題詞（最多用 3 個）。
//   正反例證模式：第 1 輪找一般／支持方向，第 2 輪刻意找負面與限制，之後找統整性研究。
//   主張論證模式：第 1 輪找直接證據，第 2 輪找統整性研究（系統性回顧、後設分析——證據力最高），第 3 輪找成立條件與機制；
//               round 傳 'counter' 才是找反面例證（只有學生看完潛在問題、表示需要時才會呼叫）。
// 回傳 {kind, queries, core, scope}：queries 是布林查詢（比對標題與摘要），core／scope 給事後的相關度檢查用。
export function buildQueries(keywords, round, mode = 'procon', coreCount = 2) {
  const all = (Array.isArray(keywords) ? keywords : []).filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim());
  if (!all.length) return { kind: 's', queries: [], core: [], scope: [] };
  // 只有一個主題詞時範圍太大，把下一個關鍵字也當成必要條件
  const n = Math.min(3, Math.max(all.length > 1 ? 2 : 1, coreCount));
  const core = all.slice(0, n), scope = all.slice(n, n + 2);
  const C = core.map(termGroup), withScope = scope.length ? [...C, termGroup(scope[0])] : C;
  const plus = (dir) => boolQuery([...C, DIRECTION[dir]]);
  const uniq = (list) => [...new Set(list.filter(Boolean))];
  let kind = 's', queries;
  if (round === 'counter') { kind = 'c'; queries = [plus('contrary'), plus('negative')]; }
  else if (mode === 'claim') queries = round === 0 ? [boolQuery(withScope), boolQuery(C)] : round === 1 ? [plus('review'), boolQuery(withScope)] : [plus('mechanism'), boolQuery(C)];
  else if (round === 0) queries = [boolQuery(withScope), boolQuery(C)];
  else if (round === 1) { kind = 'c'; queries = [plus('negative'), plus('limits')]; }
  else { kind = 'c'; queries = [plus('review'), plus('limits')]; }
  return { kind, queries: uniq(queries), core, scope };
}

// 下一輪（round 從 0 起算）改找什麼方向，給反思的說明用
export function nextDirection(round, mode = 'procon') {
  if (mode === 'claim') return ['直接證據', '統整性研究（系統性回顧、後設分析）', '成立條件與機制'][round] || '擴大範圍的補充證據';
  return ['支持方向', '負面影響與限制', '統整性研究與限制'][round] || '擴大範圍的反向與限制證據';
}

/**
 * 規則式反思（沒有本機模型時使用）：一輪搜尋後證據不夠，決定下一輪怎麼調整。
 *   這一輪切題的文獻很少 → 主題詞太多、條件太嚴：少用一個主題詞（最少 2 個）。
 *   其他情況 → 關鍵字不變，下一輪換方向用語（見 buildQueries 各輪的方向）。
 * @param {{coreCount:number, found:number, round:number, mode?:string, gap?:string}} o round 是「下一輪」的編號（從 0 起算）
 * @returns {{reason:string, coreCount:number}}
 */
export function reflectRule({ coreCount = 2, found = 0, round = 1, mode = 'procon', gap = '' }) {
  const dir = nextDirection(round, mode);
  if (found < 4 && coreCount > 2) return { reason: `${gap ? gap + '。' : ''}上一輪切題的文獻只有 ${found} 篇，條件可能太嚴：下一輪少用一個主題詞，並改找「${dir}」。`, coreCount: coreCount - 1 };
  return { reason: `${gap ? gap + '。' : ''}下一輪改找「${dir}」。`, coreCount };
}

/**
 * 搜尋並在找不到時逐步放寬。先要求全部主題詞都出現；切題的文獻不到 minHits 篇時，
 * 把排在最後的主題詞降為範圍詞再查一次（最少保留 2 個主題詞，只有 1 個時就 1 個）。
 * 所以呼叫端要把最重要、翻譯最可靠的主題詞排在前面。
 * @returns 與 searchEvidence 相同，另外多 relaxed：被降為範圍詞的主題詞（英文）
 */
export async function searchRelaxed({ keywords, coreCount = 2, round, mode, minHits = 4, limit = 10, synonyms, ...rest }, fetchImpl = fetch) {
  setExtraSynonyms(synonyms);
  const start = buildQueries(keywords, round, mode, coreCount).core.length;
  let out = null, n = start, queries = [];
  for (; n >= Math.min(2, start); n--) {
    const plan = buildQueries(keywords, round, mode, n);
    const got = await searchEvidence({ ...rest, ...plan, keywords, limit }, fetchImpl);
    queries = [...queries, ...got.queries.filter((q) => !queries.includes(q))];
    // 放寬後找到的也併進來，但嚴格條件找到的排前面
    out = out ? { ...got, evidence: [...out.evidence, ...got.evidence.filter((e) => !out.evidence.some((x) => x.id === e.id)).map((e) => ({ ...e, rel: '中' }))], dropped: out.dropped + got.dropped, fallback: out.fallback || got.fallback } : got;
    if (out.evidence.filter((e) => e.lang !== 'zh').length >= minHits) break;
  }
  const kept = Math.max(n, Math.min(2, start));
  return { ...out, evidence: out.evidence.slice(0, limit), scanned: Math.min(limit, out.evidence.length), queries, relaxed: buildQueries(keywords, round, mode, start).core.slice(kept) };
}

/**
 * 一篇文獻跟題目的相關度。
 * @returns {{ok:boolean, score:number, coreHit:number, inTitle:number}} ok：每個主題詞（或它的同義詞）都出現在標題或摘要
 */
const hasWord = (text, term) => new RegExp('(?<![a-z0-9])' + String(term).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+') + '(?:e?s)?(?![a-z0-9])').test(text);
export function relevance(work, core, scope = []) {
  const title = String(work.title || '').toLowerCase(), body = String(work.abstract || '').toLowerCase();
  // 以完整的字詞比對：用 includes 的話，「AI」會對到 said、training 裡面的 ai，等於沒有檢查
  const hit = (term, text) => termGroup(term).some((t) => hasWord(text, t));
  let score = 0, coreHit = 0, inTitle = 0;
  for (const c of core) {
    if (hit(c, title)) { score += 3; coreHit++; inTitle++; } else if (hit(c, body)) { score += 1.5; coreHit++; }
  }
  for (const s of scope) score += hit(s, title) ? 1.5 : hit(s, body) ? 0.75 : 0;
  return { ok: coreHit === core.length, score, coreHit, inTitle };
}

// 中文文獻的查詢：直接用中文主題詞（coreZh 個，最多 3 個），各輪加上的方向用語跟英文版對應。
export function buildQueriesZh(keywordsZh, round, mode = 'procon', coreZh = 3) {
  const base = (Array.isArray(keywordsZh) ? keywordsZh : []).filter((k) => typeof k === 'string' && hasZh(k)).slice(0, Math.min(3, Math.max(1, coreZh))).join(' ');
  if (!base) return [];
  if (mode === 'claim') {
    if (round === 0) return [base];
    if (round === 1) return [`${base} 後設分析`, `${base} 文獻回顧`];
    if (round === 'counter') return [`${base} 限制 批評`];
    return [`${base} 影響因素`];
  }
  if (round === 0) return [base];
  if (round === 1) return [`${base} 負面影響`, `${base} 風險`];
  return [`${base} 問題 挑戰`];
}

// ---------------- 證據初步分類 ----------------

const POSITIVE = /\b(improv\w*|enhanc\w*|increas\w*|benefi\w*|effective\w*|positive\w*|higher|gain\w*|promot\w*|facilitat\w*|support\w*|better)\b/gi;
const NEGATIVE = /\b(negative\w*|declin\w*|decreas\w*|risk\w*|harm\w*|dependen\w*|over-?relian\w*|lower|concern\w*|limitation\w*|hinder\w*|anxiety|cheat\w*|plagiari\w*|misconduct|reduc\w*|threat\w*|challeng\w*|worse)\b/gi;
const METHODS = [
  [/meta-analy|systematic review|scoping review|literature review/i, '文獻回顧'],
  [/randomi[sz]ed|quasi-experiment|experiment/i, '實驗研究'],
  [/longitudinal/i, '縱貫研究'],
  [/survey|questionnaire/i, '問卷調查'],
  [/interview|qualitative|focus group/i, '質性研究'],
];
const POPULATIONS = [
  [/undergraduate|university student|college student|higher education/i, '大學生'],
  [/postgraduate|graduate student|doctoral/i, '研究生'],
  [/high school|secondary school|middle school|adolescen/i, '中學生'],
  [/primary school|elementary|children/i, '小學生'],
  [/teacher|educator|instructor/i, '教師'],
];
// 中文摘要用的同一組線索
const POSITIVE_ZH = /提升|提高|改善|增進|促進|有助|助益|正向|正面|有效|顯著優於|顯著高於/g;
const NEGATIVE_ZH = /降低|下降|減少|負面|負向|風險|危害|依賴|成癮|沉迷|焦慮|限制|阻礙|不利|困境|疑慮|隱憂|抄襲|作弊/g;
const METHODS_ZH = [
  [/後設分析|統合分析|系統性回顧|文獻回顧|文獻分析/, '文獻回顧'],
  [/準實驗|實驗組|實驗法|實驗研究|實驗設計/, '實驗研究'],
  [/縱貫|追蹤研究|長期追蹤/, '縱貫研究'],
  [/問卷|調查法|調查研究|量表/, '問卷調查'],
  [/訪談|質性|焦點團體|個案研究/, '質性研究'],
];
const POPULATIONS_ZH = [
  [/大學生|大專|技專校院|高等教育/, '大學生'],
  [/研究生|碩士生|博士生/, '研究生'],
  [/高中|國中|中學|青少年/, '中學生'],
  [/國小|小學|學童|兒童|幼兒/, '小學生'],
  [/教師|師資生|教育人員/, '教師'],
];
const firstMatch = (table, text) => (table.find(([re]) => re.test(text)) || [null, '摘要未說明'])[1];
// 證據力：統整多篇研究的回顧最高，其次是有對照的實驗與長期追蹤，問卷與訪談較低；方法不明就標「不明」。
const LEVELS = { 文獻回顧: '高', 實驗研究: '高', 縱貫研究: '中', 問卷調查: '中', 質性研究: '低' };
export const evidenceLevel = (method) => LEVELS[method] || '不明';
const count = (re, text) => (text.match(re) || []).length;

// work：searchLogic.normalizeWork 的輸出；kind：這篇是哪個方向的查詢找到的（'s'／'c'），正負用語一樣多時用它決定。
// 主張本身是不是在說「變差／有害」這一類負面的事。是的話，發現負面結果的研究其實是「支持」這個主張，方向要反過來判。
const NEGATIVE_CLAIM = /變差|變糟|惡化|降低|下降|減少|減弱|負面|負向|危害|傷害|有害|不利|不足|依賴|成癮|沉迷|焦慮|風險|阻礙|妨礙|干擾|worse|harm|reduc|decreas|negativ|impair|risk/i;
export const isNegativeClaim = (claim) => NEGATIVE_CLAIM.test(String(claim || ''));

// claimNeg：主張本身是負面的（見 isNegativeClaim）——這時負面發現算支持、正面發現算反向。
export function classifyWork(work, kind, keywords = [], claimNeg = false) {
  const text = `${work.title}. ${work.abstract}`;
  const zh = hasZh(work.title) || (work.abstract.match(/[一-鿿]/g) || []).length > work.abstract.length / 4; // 中文文獻用中文的線索詞
  const [POS, NEG, METHOD, POPULATION] = zh ? [POSITIVE_ZH, NEGATIVE_ZH, METHODS_ZH, POPULATIONS_ZH] : [POSITIVE, NEGATIVE, METHODS, POPULATIONS];
  const pos = count(POS, text), neg = count(NEG, text);
  const tone = neg > pos ? 'neg' : pos > neg ? 'pos' : '';
  const k = !tone ? kind : (tone === 'neg') === claimNeg ? 's' : 'c';
  const cue = tone === 'neg' || (!tone && (k === 'c') !== claimNeg) ? NEG : POS;
  const sentences = zh ? work.abstract.split(/(?<=[。！？；])/).filter((s) => s.length > 12) : work.abstract.split(/(?<=[.!?])\s+/).filter((s) => s.length > 30);
  const hit = sentences.filter((s) => { cue.lastIndex = 0; return cue.test(s); }).pop() || sentences[sentences.length - 1] || work.abstract;
  const kws = keywords.filter((x) => typeof x === 'string' && x.trim());
  const matched = kws.filter((kw) => text.toLowerCase().includes(kw.toLowerCase())).length;
  return {
    id: work.id, k, t: work.title, y: work.year || '年份不明', au: work.authors.join(', '), vn: work.venue, url: work.url,
    p: firstMatch(POPULATION, text), m: firstMatch(METHOD, text), lv: evidenceLevel(firstMatch(METHOD, text)), lang: zh ? 'zh' : 'en',
    f: hit.slice(0, 280), l: '尚未判讀：請閱讀原文後由小組補上', c: '', q: work.q,
    sc: kws.length ? `關鍵字符合 ${matched}／${kws.length}` : '未比對',
    d: kws.length && matched >= Math.ceil(kws.length / 2) ? '直接' : '間接',
    v: Boolean(work.doi),
    auto: true, // 規則式初步分類，尚未經小組確認
    _ab: String(work.abstract || '').slice(0, 1200), // 完整一點的摘要：只給本機模型判讀用，判讀完就丟掉，不會存進資料庫
  };
}

// queries／core／scope：buildQueries 的輸出（英文，國際文獻）；zhQueries／keywordsZh：中文查詢與中文關鍵字（中文文獻）。
// 兩邊至少要有一邊。流程：查詢（只比對標題與摘要）→ 丟掉沒有提到全部主題詞的 → 依相關度排序 → 每一輪最多 10 篇（中文最多 4 篇）。
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function searchEvidence({ queries, kind, keywords, core, scope, excludeIds, zhQueries, keywordsZh, coreZh, claimNeg = false, limit = 10 }, fetchImpl = fetch) {
  const en = clampQueries(queries, 300), zh = clampQueries(zhQueries);
  if (!en.length && !zh.length) throw new Error('沒有可用的搜尋關鍵字，請先在上一步新增關鍵字。');
  const run = async (q, opts) => {
    const res = await fetchImpl(openAlexUrl(q, opts));
    if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
    const json = await res.json();
    return (Array.isArray(json.results) ? json.results : []).map((w) => normalizeWork(w, q)).filter(Boolean);
  };
  const coreEn = Array.isArray(core) && core.length ? core : (Array.isArray(keywords) ? keywords : []).slice(0, 2);
  const scopeEn = Array.isArray(scope) ? scope : [];
  const jobs = [...en.map((q) => ({ zh: false, q, opts: { tiab: true, perPage: 15 } })), ...zh.map((q) => ({ zh: true, q, opts: { lang: 'zh', fromYear: 2015 } }))];
  const wait = (ms) => pause(fetchImpl === fetch ? ms : 0);
  // 一條一條查、中間稍微停一下：這是免費的公開服務，不要同時灌好幾個請求。
  // OpenAlex 有每日額度，所以第一條英文查詢就找到夠多切題的文獻時，第二條就不查了。
  const settled = [];
  let enough = false;
  for (const [i, job] of jobs.entries()) {
    if (!job.zh && enough) { settled.push({ ok: true, value: [] }); continue; }
    if (i) await wait(350);
    const result = await run(job.q, job.opts).then((value) => ({ ok: true, value }), () => ({ ok: false, value: [] }));
    settled.push(result);
    if (!job.zh && dedupeWorks(result.value, excludeIds).filter((w) => relevance(w, coreEn, scopeEn).ok).length >= 10) enough = true;
  }
  // 英文查詢全部失敗（多半是 OpenAlex 今天的額度用完了）→ 改查 Crossref
  let fallback = false;
  if (en.length && jobs.every((j, i) => j.zh || !settled[i].ok)) {
    for (const [i, q] of en.slice(0, 2).entries()) {
      if (i) await wait(1100);
      const value = await fetchImpl(crossrefUrl(q)).then(async (res) => {
        if (!res.ok) throw new Error(`Crossref HTTP ${res.status}`);
        return ((await res.json()).message?.items || []).map((it) => normalizeCrossref(it, q)).filter(Boolean);
      }).then((v) => v, () => null);
      if (value) { fallback = true; jobs.push({ zh: false, q }); settled.push({ ok: true, value }); }
    }
  }
  if (settled.every((s) => !s.ok)) throw new Error('無法連線到文獻資料庫（OpenAlex 與 Crossref 都沒有回應），請檢查網路後再試。');
  // 中文：OpenAlex 對中文的比對很寬鬆，所以自己再檢查一次——每個中文主題詞都要出現在標題或摘要，
  // 而且至少有一個出現在標題（只在摘要裡順帶提到的通常不是在研究這個主題）；含日文假名的不要。
  const zhKeys = (Array.isArray(keywordsZh) ? keywordsZh : []).filter(hasZh).slice(0, Math.min(3, Math.max(1, coreZh || 2)));
  const zhScore = (w) => {
    const text = w.title + w.abstract;
    if (/[぀-ヿ]/.test(text) || !zhKeys.length) return -1;
    const inTitle = zhKeys.filter((k) => w.title.includes(k)).length;
    return zhKeys.every((k) => text.includes(k)) && inTitle ? zhKeys.length + inTitle : -1;
  };
  // 同一篇論文有時會以不同編號出現兩次（預印本與正式版），標題一樣的只留一篇
  const byTitle = (list) => { const seen = new Set(); return list.filter((w) => { const t = w.title.toLowerCase().replace(/[^a-z0-9一-鿿]/g, ''); return seen.has(t) ? false : seen.add(t); }); };
  // 被撤稿的論文不要
  const pool = (wantZh) => byTitle(dedupeWorks(settled.flatMap((s, i) => (jobs[i].zh === wantZh ? s.value : [])), excludeIds)).filter((w) => !/\bretracted\b|撤稿/i.test(w.title));
  // 每一輪的第一條查詢最貼近這一輪要找的方向（例如統整性研究、負面結果），它找到的文獻排前面
  const bonus = (w) => (w.q === en[0] ? 1.5 : 0);
  const enRanked = pool(false).map((w) => ({ w, r: relevance(w, coreEn, scopeEn) })).filter((x) => x.r.ok).sort((a, b) => b.r.score + bonus(b.w) - a.r.score - bonus(a.w));
  const zhRanked = pool(true).map((w) => ({ w, n: zhScore(w) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const zhPick = zhRanked.slice(0, 4), enPick = enRanked.slice(0, limit - zhPick.length);
  const evidence = [
    ...enPick.map(({ w, r }) => ({ ...classifyWork(w, kind, [...coreEn, ...scopeEn], claimNeg), src: w.src || 'OpenAlex', sc: `主題詞 ${r.coreHit}／${coreEn.length}（標題 ${r.inTitle}）`, d: r.inTitle === coreEn.length ? '直接' : '間接', rel: r.inTitle === coreEn.length ? '高' : '中' })),
    ...zhPick.map(({ w }) => ({ ...classifyWork(w, kind, zhKeys, claimNeg), rel: zhKeys.every((k) => w.title.includes(k)) ? '高' : '中' })),
  ];
  return { evidence, queries: [...en, ...zh], scanned: evidence.length, fallback, dropped: pool(false).length - enRanked.length + pool(true).length - zhRanked.length };
}

// ---------------- 證據摘要（Level 3）----------------

export function summarizeEvidence(evidence) {
  const ev = Array.isArray(evidence) ? evidence : [];
  const sup = ev.filter((e) => e.k === 's'), con = ev.filter((e) => e.k === 'c');
  const titles = (list) => list.slice(0, 3).map((e) => `《${e.t}》（${e.y}）`).join('、') || '尚無';
  return (
    `目前共 ${ev.length} 筆資料：支持方向 ${sup.length} 筆（${titles(sup)}）；反向／限制方向 ${con.length} 筆（${titles(con)}）。` +
    `其中 ${ev.filter((e) => !e.v).length} 筆來源待驗證、${ev.filter((e) => e.auto).length} 筆的分類尚未經小組確認。結論請由小組自行判斷。`
  );
}
