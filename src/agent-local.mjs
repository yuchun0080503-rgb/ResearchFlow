// agent-local.mjs — 不需要任何 API 金鑰、不需要後端的 Research Agent（在瀏覽器裡執行）。
//
// 這一版的 Agent 是「規則式」的：不呼叫任何生成式 AI 模型，所以沒有金鑰、沒有費用。
//   - 判斷範圍：檢查畫布內容有沒有交代「研究對象／情境／結果」，缺哪一項就問哪一項
//   - 研究問題：把小組的回答套進固定句型（草案，學生可以改）
//   - 搜尋證據：直接查 OpenAlex 公開學術資料庫（免費、不需金鑰、允許瀏覽器直接呼叫）
//   - 證據分類：依摘要裡的正向／負向用語做「初步分類」，一律標示為待小組確認，學生可以改列
// 純邏輯都在這個檔案，可以用 node:test 驗證；唯一的網路呼叫是 searchEvidence 裡的 fetch。

import { clampQueries, openAlexUrl, normalizeWork, dedupeWorks } from './searchLogic.mjs';

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
  [/大學|undergraduate/i, 'university students'],
  [/高中|國中|中學|國高中/, 'secondary school students'],
  [/國小|小學|學童|兒童/, 'primary school students'],
  [/研究生|碩士|博士/, 'graduate students'],
  [/教師|老師/, 'teachers'],
  [/學生/, 'students'],
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
  [/睡眠/, 'sleep'],
  [/學習/, 'learning'],
];

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
  const keywords = keywordsFrom(source);
  const strategy = [
    ['研究對象', byKey.who], ['研究情境', byKey.ctx], ['主要結果', byKey.out],
  ].filter((r) => r[1]).map(([label, value]) => ({ label, value }));
  strategy.push({ label: '時間範圍', value: '2020 年至今' }, { label: '資料來源', value: 'OpenAlex 學術資料庫（有摘要的期刊論文）' });
  return { researchQuestion, keywords, strategy };
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

// 每一輪要查什麼。一律用「小組目前確認的關鍵字」組成，所以學生在介面上增刪關鍵字會直接改變搜尋結果。
//   正反例證模式：第 1 輪找一般／支持方向，第 2 輪刻意找負面與限制，之後做探索性補搜。
//   主張論證模式：第 1 輪找直接證據，第 2 輪找統整性研究（系統性回顧、後設分析——證據力最高），第 3 輪找成立條件與機制；
//               round 傳 'counter' 才是找反面例證（只有學生看完潛在問題、表示需要時才會呼叫）。
export function buildQueries(keywords, round, mode = 'procon') {
  const base = (Array.isArray(keywords) ? keywords : []).filter((k) => typeof k === 'string' && k.trim()).slice(0, 4).join(' ');
  if (!base) return { kind: 's', queries: [] };
  if (mode === 'claim') {
    if (round === 0) return { kind: 's', queries: [base, `${base} evidence`] };
    if (round === 1) return { kind: 's', queries: [`${base} systematic review`, `${base} meta-analysis`] };
    if (round === 'counter') return { kind: 'c', queries: [`${base} limitations`, `${base} criticism contrary evidence`] };
    return { kind: 's', queries: [`${base} mechanism`, `${base} moderators conditions`] };
  }
  if (round === 0) return { kind: 's', queries: [base, `${base} benefits effectiveness`] };
  if (round === 1) return { kind: 'c', queries: [`${base} negative effects`, `${base} risks limitations`] };
  return { kind: 'c', queries: [`${base} challenges concerns`, `${base} systematic review`] };
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
const firstMatch = (table, text) => (table.find(([re]) => re.test(text)) || [null, '摘要未說明'])[1];
// 證據力：統整多篇研究的回顧最高，其次是有對照的實驗與長期追蹤，問卷與訪談較低；方法不明就標「不明」。
const LEVELS = { 文獻回顧: '高', 實驗研究: '高', 縱貫研究: '中', 問卷調查: '中', 質性研究: '低' };
export const evidenceLevel = (method) => LEVELS[method] || '不明';
const count = (re, text) => (text.match(re) || []).length;

// work：searchLogic.normalizeWork 的輸出；kind：這篇是哪個方向的查詢找到的（'s'／'c'），正負用語一樣多時用它決定。
export function classifyWork(work, kind, keywords = []) {
  const text = `${work.title}. ${work.abstract}`;
  const pos = count(POSITIVE, text), neg = count(NEGATIVE, text);
  const k = neg > pos ? 'c' : pos > neg ? 's' : kind;
  const cue = k === 'c' ? NEGATIVE : POSITIVE;
  const sentences = work.abstract.split(/(?<=[.!?])\s+/).filter((s) => s.length > 30);
  const hit = sentences.filter((s) => { cue.lastIndex = 0; return cue.test(s); }).pop() || sentences[sentences.length - 1] || work.abstract;
  const kws = keywords.filter((x) => typeof x === 'string' && x.trim());
  const matched = kws.filter((kw) => text.toLowerCase().includes(kw.toLowerCase())).length;
  return {
    id: work.id, k, t: work.title, y: work.year || '年份不明', au: work.authors.join(', '), vn: work.venue, url: work.url,
    p: firstMatch(POPULATIONS, text), m: firstMatch(METHODS, text), lv: evidenceLevel(firstMatch(METHODS, text)),
    f: hit.slice(0, 280), l: '尚未判讀：請閱讀原文後由小組補上', c: '', q: work.q,
    sc: kws.length ? `關鍵字符合 ${matched}／${kws.length}` : '未比對',
    d: kws.length && matched >= Math.ceil(kws.length / 2) ? '直接' : '間接',
    v: Boolean(work.doi),
    auto: true, // 規則式初步分類，尚未經小組確認
  };
}

export async function searchEvidence({ queries, kind, keywords, excludeIds }, fetchImpl = fetch) {
  const qs = clampQueries(queries);
  if (!qs.length) throw new Error('沒有可用的搜尋關鍵字，請先在上一步新增英文關鍵字。');
  const settled = await Promise.allSettled(qs.map(async (q) => {
    const res = await fetchImpl(openAlexUrl(q));
    if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
    const json = await res.json();
    return (Array.isArray(json.results) ? json.results : []).map((w) => normalizeWork(w, q)).filter(Boolean);
  }));
  if (settled.every((s) => s.status === 'rejected')) throw new Error('無法連線到文獻資料庫（OpenAlex），請檢查網路後再試。');
  const works = dedupeWorks(settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : [])), excludeIds).slice(0, 8);
  return { evidence: works.map((w) => classifyWork(w, kind, keywords)), queries: qs, scanned: works.length };
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
