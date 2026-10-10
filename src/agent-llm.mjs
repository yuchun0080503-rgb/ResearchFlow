// agent-llm.mjs — 用本機的 Qwen 模型（經由 llm.mjs／Ollama）做「需要理解」的那幾步。
//
// 規則式的 agent-local.mjs 只會比對字詞，所以會把「自主判斷能力」拆成零碎的詞、把關鍵字翻錯、
// 分不出一篇文獻到底在不在談這個主張。這裡把那幾步交給模型：
//   planSearch   讀題目＋主張＋畫布內容，決定要查什麼：主題詞、範圍詞、學術界實際使用的英文說法與同義詞
//   translate    把一個中文關鍵字翻成論文標題會用的英文（附同義詞）
//   judgeWorks   讀每一篇搜尋到的摘要，判斷跟主張相不相關、支持還是不支持，並用一句中文寫出這篇的發現
//   readInk      看手寫筆跡的圖片，讀成通順的詞句（而不是一個一個單字）
// 每個函式失敗都會丟出錯誤，呼叫端（db.mjs／researchflow.html）要接住並退回規則式的做法。
// 模型只負責「理解與判斷」；搜尋仍然是查真實的學術資料庫，文獻不是模型編的。

import { chatJSON } from './llm.mjs';

const str = { type: 'string' };
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * 規劃搜尋：這個主張要查什麼。
 * @param {object} o
 * @param {string} o.title 專案／報告名稱
 * @param {string} o.claim 要查證的主張或研究問題
 * @param {string[]} [o.notes] 畫布上的其他內容（當背景用）
 * @returns {Promise<{focus:string, keywords:{zh:string,en:string,role:'core'|'scope',synonyms:string[]}[]}>}
 */
export async function planSearch({ title, claim, notes = [] }, fetchImpl) {
  const out = await chatJSON({
    system:
      '你是協助學生查證文獻的研究助理，熟悉教育、心理、社會科學的學術用語。' +
      '任務：根據報告題目與學生要查證的主張，決定到學術資料庫要用哪些關鍵字。\n' +
      '規則：\n' +
      '1. 主題詞（role=core）2 到 3 個：這個主張真正在談的「現象或工具」與「結果」。主張常常省略主詞，要從題目補上（題目是 AI，主張只寫「影響判斷能力」，主題詞就要有 AI）。\n' +
      '2. 範圍詞（role=scope）1 到 2 個：研究對象或情境。題目或主張提到對象（學生、大學生、老人、青少年）就一定要列出來。\n' +
      '3. en 必須是英文論文標題實際會出現的學術用語（1 到 3 個英文單字），依「概念」翻譯，不要逐字翻。例如「自主判斷能力」是 independent thinking，不是 autonomy judgment ability。\n' +
      '4. synonyms 給 1 到 3 個意思幾乎相同的英文學術用語，第一個放最常用的。不要放意思更廣的詞（例如不要把 decision making 當成 critical thinking 的同義詞）。\n' +
      '5. zh 用學生原本的中文說法（繁體）。不要列「影響」「研究」「能力」這類太籠統的詞。\n' +
      '6. focus 用一句繁體中文說明這次要查證的重點。\n' +
      '7. 每一個關鍵字只放一個概念：「人工智慧」和「自主判斷能力」要分成兩個關鍵字，不可以用逗號或頓號寫在同一個裡面。',
    user: `報告題目：${clip(title, 120) || '（未填）'}\n要查證的主張：${clip(claim, 300)}\n畫布上的其他內容：${notes.map((n) => clip(n, 80)).filter(Boolean).slice(0, 8).join('；') || '（無）'}`,
    schema: {
      type: 'object', required: ['focus', 'keywords'],
      properties: {
        focus: str,
        keywords: {
          type: 'array', minItems: 2, maxItems: 5,
          items: { type: 'object', required: ['zh', 'en', 'role', 'synonyms'], properties: { zh: str, en: str, role: { type: 'string', enum: ['core', 'scope'] }, synonyms: { type: 'array', items: str, maxItems: 3 } } },
        },
      },
    },
    maxTokens: 500,
  }, fetchImpl);
  const keywords = normKeywords(out.keywords);
  if (keywords.filter((k) => k.role === 'core').length < 1) throw new Error('模型沒有給出主題詞');
  return { focus: clip(out.focus, 120), keywords };
}

// planSearch／reflectSearch 共用：整理模型給的關鍵字
function normKeywords(list) {
  const seen = new Set();
  // 模型偶爾還是會把兩個概念用逗號寫在一起：拆開成各自的關鍵字
  const split = (list || []).flatMap((k) => {
    const en = String(k.en || '').split(/\s*[,;，、]\s*/).filter(Boolean), zh = String(k.zh || '').split(/\s*[,;，、]\s*/).filter(Boolean);
    return en.length > 1 ? en.map((e, i) => ({ ...k, en: e, zh: zh[i] || '', synonyms: i === en.length - 1 ? k.synonyms : [] })) : [k];
  });
  const keywords = split
    .map((k) => ({ zh: clip(k.zh, 20), en: clip(k.en, 60).toLowerCase(), role: k.role === 'scope' ? 'scope' : 'core', synonyms: (k.synonyms || []).map((s) => clip(s, 60).toLowerCase()).filter((s) => s && /^[\x20-\x7e]+$/.test(s)).slice(0, 3) }))
    .filter((k) => k.en && /^[\x20-\x7e]+$/.test(k.en) && !seen.has(k.en) && seen.add(k.en));
  return keywords;
}

const KW_SCHEMA = {
  type: 'array', minItems: 2, maxItems: 5,
  items: { type: 'object', required: ['zh', 'en', 'role', 'synonyms'], properties: { zh: str, en: str, role: { type: 'string', enum: ['core', 'scope'] }, synonyms: { type: 'array', items: str, maxItems: 3 } } },
};

/**
 * 判斷研究範圍：讀畫布上的內容，看研究對象、情境、結果三個面向有沒有交代清楚；
 * 沒交代的面向，依這個題目提出聚焦問題和 3 到 4 個選項（選項要跟題目有關，不是固定的清單）。
 * @param {object} o
 * @param {string} o.topic 題目
 * @param {{text:string, tag?:string}[]} o.items 畫布上確認過的內容
 * @returns {Promise<{tooBroad:boolean, reasons:string[], clarifyingQuestions:{key:'who'|'ctx'|'out', question:string, options:string[]}[], draftQuestion:string}>}
 */
export async function scopeFocus({ topic, items = [] }, fetchImpl) {
  const out = await chatJSON({
    system:
      '你是協助大學生做小組研究報告的研究助理。學生在白板上討論，你要判斷他們的研究範圍是不是太廣、還不能拿去搜尋文獻。\n' +
      '檢查三個面向有沒有交代：who 研究對象（哪一群人）、ctx 研究情境（在什麼情況下使用或發生）、out 主要結果（想知道對什麼的影響）。\n' +
      '規則：\n' +
      '1. 白板內容已經清楚寫出的面向不要再問。三個都清楚時 tooBroad 為 false、questions 為空陣列。\n' +
      '2. 每個沒交代的面向出一題：question 用一句繁體中文問小組，options 給 3 到 4 個「跟這個題目有關」的具體選項（每個 2 到 8 個字），不要給跟題目無關的通用選項。\n' +
      '3. reasons 用繁體中文簡短列出判斷理由（1 到 3 條）。\n' +
      '4. draftQuestion 用一句繁體中文寫出目前看起來的研究問題草稿。',
    user: `題目：${clip(topic, 120) || '（未填）'}\n白板內容：\n${items.map((it) => '- ' + clip(it.text, 120) + (it.tag ? `（${it.tag}）` : '')).filter(Boolean).slice(0, 14).join('\n')}`,
    schema: {
      type: 'object', required: ['tooBroad', 'reasons', 'questions', 'draftQuestion'],
      properties: {
        tooBroad: { type: 'boolean' }, reasons: { type: 'array', items: str, maxItems: 3 }, draftQuestion: str,
        questions: { type: 'array', maxItems: 3, items: { type: 'object', required: ['key', 'question', 'options'], properties: { key: { type: 'string', enum: ['who', 'ctx', 'out'] }, question: str, options: { type: 'array', items: str, minItems: 2, maxItems: 4 } } } },
      },
    },
    maxTokens: 700,
  }, fetchImpl);
  const seen = new Set();
  const qs = (out.questions || [])
    .filter((q) => ['who', 'ctx', 'out'].includes(q.key) && !seen.has(q.key) && seen.add(q.key))
    .map((q) => ({ key: q.key, question: clip(q.question, 60), options: [...new Set((q.options || []).map((o) => clip(o, 16)).filter(Boolean))].slice(0, 4) }))
    .filter((q) => q.question && q.options.length >= 2);
  const tooBroad = !!out.tooBroad && qs.length > 0;
  return { tooBroad, reasons: (out.reasons || []).map((r) => clip(r, 80)).filter(Boolean).slice(0, 3), clarifyingQuestions: tooBroad ? qs : [], draftQuestion: clip(out.draftQuestion, 120) };
}

/**
 * 依白板內容和小組對聚焦問題的回答，寫出一句可以拿去查文獻的研究問題。
 * @returns {Promise<string>}
 */
export async function draftQuestion({ topic, items = [], answers = [] }, fetchImpl) {
  const out = await chatJSON({
    system: '你是協助大學生做研究報告的研究助理。根據題目、白板內容與小組選定的聚焦方向，寫出一句具體、可以拿去搜尋學術文獻的研究問題（繁體中文，40 字以內）。要包含研究對象、情境與結果；用「如何」「有什麼關聯」「差異為何」這類開放的問法，不要用「會不會」「是否」「嗎」寫成是非題，也不要預設答案。',
    user: `題目：${clip(topic, 120) || '（未填）'}\n白板內容：${items.map((it) => clip(it.text, 80)).filter(Boolean).slice(0, 10).join('；')}\n小組選定的聚焦方向：${answers.map((a) => `${clip(a.question, 30)} → ${clip(a.answer, 40)}`).join('；') || '（無）'}`,
    schema: { type: 'object', required: ['question'], properties: { question: str } },
    maxTokens: 200,
  }, fetchImpl);
  const q = clip(out.question, 120);
  if (!q || !/[\u4e00-\u9fff]/.test(q)) throw new Error('模型沒有給出研究問題');
  return q;
}

/**
 * 反思：一輪搜尋後證據不夠時，看這一輪查了什麼、找到什麼，決定下一輪的關鍵字要怎麼換。
 * @param {object} o
 * @param {string} o.claim 要查證的主張或研究問題
 * @param {string} o.gap 還缺什麼（例如「反向證據只有 1 筆，至少要 3 筆」）
 * @param {{zh:string,en:string,core:boolean,synonyms:string[]}[]} o.keywords 這一輪用的關鍵字
 * @param {string[]} [o.found] 這一輪找到的文獻標題
 * @param {string[]} [o.queries] 已經查過的查詢式
 * @returns {Promise<{reason:string, keywords:{zh:string,en:string,role:'core'|'scope',synonyms:string[]}[]}>}
 */
export async function reflectSearch({ claim, gap, keywords = [], found = [], queries = [] }, fetchImpl) {
  const out = await chatJSON({
    system:
      '你是協助學生查證文獻的研究助理。上一輪學術資料庫搜尋的證據不夠，你要檢討原因並決定下一輪的關鍵字。\n' +
      '規則：\n' +
      '1. 先判斷原因：用詞太窄（論文用的是別的說法）、主題詞太多（條件太嚴）、或方向不對。reason 用一句繁體中文寫出原因和你的調整。\n' +
      '2. keywords 是下一輪完整的關鍵字清單（2 到 5 個）。可以換成學術界更常用的英文說法、補同義詞、把太嚴的主題詞改成範圍詞（role=scope）。\n' +
      '3. 主張的核心概念不能丟掉，不要換成意思不同的詞；不要只是原封不動照抄上一輪。\n' +
      '4. en 是英文論文標題會出現的學術用語（1 到 3 個英文單字），zh 用繁體中文，synonyms 給 1 到 3 個英文同義詞。',
    user: `要查證的主張：${clip(claim, 300)}\n還缺什麼：${clip(gap, 200)}\n上一輪的關鍵字：${keywords.map((k) => `${k.zh || k.en}（${k.en}，${k.core ? '主題詞' : '範圍詞'}${(k.synonyms || []).length ? '，同義詞 ' + k.synonyms.join('/') : ''}）`).join('；')}\n查過的查詢式：${queries.slice(-4).map((q) => clip(q, 160)).join(' ｜ ') || '（無）'}\n上一輪找到的文獻：${found.slice(0, 8).map((t) => clip(t, 100)).join('；') || '（沒有找到）'}`,
    schema: { type: 'object', required: ['reason', 'keywords'], properties: { reason: str, keywords: KW_SCHEMA } },
    maxTokens: 600,
  }, fetchImpl);
  const kws = normKeywords(out.keywords);
  if (kws.filter((k) => k.role === 'core').length < 1) throw new Error('模型沒有給出主題詞');
  const same = kws.length === keywords.length && kws.every((k) => keywords.some((x) => x.en === k.en && !!x.core === (k.role === 'core')));
  if (same) throw new Error('模型沒有調整關鍵字');
  return { reason: clip(out.reason, 160), keywords: kws };
}

/**
 * 把一個中文關鍵字翻成學術英文。context 是題目或主張，讓模型知道這個詞在講什麼。
 * @returns {Promise<{en:string, synonyms:string[]}>}
 */
export async function translate(term, context = '', fetchImpl) {
  const out = await chatJSON({
    system: '你是學術翻譯。把學生給的中文關鍵字翻成英文論文標題實際會使用的學術用語（1 到 3 個英文單字），依概念翻譯、不要逐字翻；另外給 1 到 3 個常用的英文同義詞。只處理這一個關鍵字。',
    user: `關鍵字：${clip(term, 40)}\n它出現的脈絡：${clip(context, 200) || '（無）'}`,
    schema: { type: 'object', required: ['en', 'synonyms'], properties: { en: str, synonyms: { type: 'array', items: str, maxItems: 3 } } },
    maxTokens: 120,
  }, fetchImpl);
  const en = clip(out.en, 60).toLowerCase();
  if (!en || !/^[\x20-\x7e]+$/.test(en)) throw new Error('模型沒有給出英文');
  return { en, synonyms: (out.synonyms || []).map((s) => clip(s, 60).toLowerCase()).filter((s) => s && /^[\x20-\x7e]+$/.test(s)).slice(0, 3) };
}

/**
 * 逐篇判讀搜尋到的文獻。
 * @param {object} o
 * @param {string} o.claim 要查證的主張（或研究問題）
 * @param {{title:string, abstract:string}[]} o.works
 * @returns {Promise<{rel:number, stance:'support'|'counter'|'mixed'|'unclear'|'unrelated', finding:string}[]>} 順序與 works 相同
 *   rel：0 無關、1 只沾到邊、2 相關、3 直接在研究這個主張
 */
export async function judgeWorks({ claim, works }, fetchImpl) {
  const list = (Array.isArray(works) ? works : []).slice(0, 12);
  if (!list.length) return [];
  const out = await chatJSON({
    system:
      '你是協助學生查證文獻的研究助理。學生有一個主張，下面是從學術資料庫找到的文獻（標題與摘要）。請逐篇判讀，標準要嚴格。\n' +
      'rel（相關度）：\n' +
      '3＝這篇直接在研究主張談的事（同樣的現象、同樣或相近的對象）。\n' +
      '2＝主題相同、對象或情境略有不同，可以當佐證。\n' +
      '1＝只有部分用詞相同。對象或領域明顯不同就屬於這一級：主張談學生的學習，文獻談醫療、商業、司法、行銷、公共政策，一律是 1。\n' +
      '0＝無關。\n' +
      'stance（立場）：support＝研究發現支持主張；counter＝發現與主張相反，或指出主張不成立的情況；mixed＝有支持也有相反，或只在特定條件下成立；' +
      'unclear＝摘要只說明研究目的或方法、沒有寫出研究結果，無法判斷；unrelated＝rel 是 0 或 1。\n' +
      '判斷立場要看「研究發現」跟主張的方向是否一致，不是看摘要用了正面還是負面的字。主張說某事會變差，研究也發現變差，就是 support。\n' +
      '主張只說「影響」而沒有說變好或變差時：研究發現確實有影響（不論變好或變差）都算 support，發現沒有影響才是 counter。\n' +
      'finding：用一句繁體中文（30 字以內）寫出這篇研究的主要發現，只能根據摘要；stance 是 unclear 或 unrelated 時 finding 留空字串。\n' +
      '每一篇都要回答，i 是文獻的編號。',
    user: `學生的主張：${clip(claim, 300)}\n\n` + list.map((w, i) => `[${i}] ${clip(w.title, 200)}\n摘要：${clip(w.abstract, 650) || '（沒有摘要）'}`).join('\n\n'),
    schema: {
      type: 'object', required: ['items'],
      properties: { items: { type: 'array', items: { type: 'object', required: ['i', 'rel', 'stance', 'finding'], properties: { i: { type: 'integer' }, rel: { type: 'integer', minimum: 0, maximum: 3 }, stance: { type: 'string', enum: ['support', 'counter', 'mixed', 'unclear', 'unrelated'] }, finding: str } } } },
    },
    maxTokens: 90 * list.length + 100,
    timeout: 300000,
  }, fetchImpl);
  const by = new Map((out.items || []).map((x) => [x.i, x]));
  return list.map((_, i) => {
    const x = by.get(i);
    if (!x) return { rel: -1, stance: 'unrelated', finding: '' }; // -1：模型漏掉這一篇，呼叫端沿用規則式的結果
    const rel = Math.max(0, Math.min(3, Math.round(x.rel)));
    return { rel, stance: rel < 2 ? 'unrelated' : x.stance, finding: clip(x.finding, 80) };
  });
}

/**
 * 搜尋之後的判讀：讓模型讀每一篇摘要，丟掉不切題的，並依研究發現（而不是用字）決定支持或反向。
 * @param {object} o
 * @param {string} o.claim 要查證的主張
 * @param {object[]} o.evidence agent-local 的 classifyWork 產生的項目（含 _ab 摘要）
 * @param {string} o.model 顯示用的模型名稱
 * @returns {Promise<{evidence:object[], removed:number, judged:number}>} evidence 依相關度高到低排，最多 10 篇
 */
export async function refineEvidence({ claim, evidence, model = '' }, fetchImpl) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (!list.length || !String(claim || '').trim()) return { evidence: list, removed: 0, judged: 0 };
  const verdicts = await judgeWorks({ claim, works: list.map((e) => ({ title: e.t, abstract: e._ab || e.f })) }, fetchImpl);
  const kept = [];
  let judged = 0;
  list.forEach((e, i) => {
    const v = verdicts[i];
    if (!v || v.rel < 0) { kept.push({ e, rel: 1.5 }); return; } // 模型漏掉的：保留規則式的結果
    judged++;
    if (v.rel < 2) return; // 不切題：排除
    // 摘要沒有寫出研究結果（unclear）：模型無法判斷立場，沿用規則式的初步分類，並提醒要讀原文
    const unclear = v.stance === 'unclear' || !v.finding;
    kept.push({ rel: v.rel - (unclear ? 0.5 : 0), e: { ...e, k: unclear ? e.k : v.stance === 'support' ? 's' : 'c', mix: v.stance === 'mixed' || undefined, rel: v.rel === 3 ? '高' : '中', d: v.rel === 3 ? '直接' : '間接',
      f: unclear ? '摘要沒有寫出研究結果，需要閱讀原文才能判斷。' : v.finding, fo: e.f, ai: model || 'Qwen', unc: unclear || undefined } });
  });
  kept.sort((a, b) => b.rel - a.rel);
  return { evidence: kept.slice(0, 10).map((x) => x.e), removed: list.length - kept.length, judged };
}

/**
 * 把一篇文獻的英文摘要整理成中文，讓學生不用讀英文就能判斷這篇需不需要。
 * @returns {Promise<string>} 兩三句繁體中文；摘要太短或沒有內容時回傳空字串
 */
export async function summarizeZh(title, abstract, fetchImpl) {
  if (clip(abstract, 1200).length < 60) return '';
  const out = await chatJSON({
    system: '你是協助學生閱讀英文文獻的研究助理。請把下面這篇文獻的摘要整理成繁體中文，兩到三句、80 字以內，依序說明：研究對象與方法、主要發現。只能根據摘要，不要加入摘要沒有的內容；摘要沒有寫結果就照實說「摘要沒有寫出研究結果」。',
    user: `標題：${clip(title, 200)}\n摘要：${clip(abstract, 1200)}`,
    schema: { type: 'object', required: ['zh'], properties: { zh: str } },
    maxTokens: 200, timeout: 90000,
  }, fetchImpl);
  return clip(out.zh, 160);
}

/**
 * 讀手寫筆跡的圖片。hint 是筆跡辨識服務逐字辨識的結果（可能有錯字、缺字），給模型參考。
 * @returns {Promise<string>} 辨識出的文字；看不出來時回傳空字串
 */
export async function readInk(imageBase64, hint = '', fetchImpl) {
  const out = await chatJSON({
    system:
      '這張圖片是學生在白板上的手寫筆跡（白底黑字），內容通常是繁體中文的詞句，也可能夾雜英文或數字，主題多半跟課業報告、研究有關。' +
      '請把整段筆跡讀成一句通順的文字，照原本的書寫順序，不要一個字一個字分開，也不要加上任何說明或標點以外的內容。' +
      '看不清楚的字依上下文判斷最合理的字；完全不是文字（只是線條或塗鴉）就回傳空字串。',
    user: hint ? `另一個逐字辨識工具讀到的是「${clip(hint, 80)}」，它可能有錯字或缺字，僅供參考，請以圖片為準。` : '請讀出圖片中的手寫文字。',
    images: [imageBase64],
    schema: { type: 'object', required: ['text'], properties: { text: str } },
    maxTokens: 120,
    timeout: 90000,
  }, fetchImpl);
  return clip(out.text, 120);
}
