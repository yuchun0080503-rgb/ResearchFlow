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

// 每一輪要查什麼：第 1 輪找一般／支持方向，第 2 輪刻意找負面與限制，之後做探索性補搜。
// 一律用「小組目前確認的關鍵字」組成，所以學生在介面上增刪關鍵字會直接改變搜尋結果。
export function buildQueries(keywords, round) {
  const base = (Array.isArray(keywords) ? keywords : []).filter((k) => typeof k === 'string' && k.trim()).slice(0, 4).join(' ');
  if (!base) return { kind: 's', queries: [] };
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
    p: firstMatch(POPULATIONS, text), m: firstMatch(METHODS, text),
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
